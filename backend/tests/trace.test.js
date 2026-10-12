const { crawl } = require("../src/crawler/crawl");
const { createHttpClient } = require("../src/crawler/http-client");
const { formatTrace } = require("../src/crawler/trace");
const { createFixtureServer } = require("./fixtures/server");

const clock = {
  now: () => 0,
  sleep() {
    return Promise.resolve();
  },
};

function html(body) {
  return (_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  };
}

function collect() {
  const lines = [];
  return {
    lines,
    trace(event, fields) {
      lines.push(formatTrace(event, fields));
    },
  };
}

async function withServer(routes, run) {
  const server = createFixtureServer({ routes });
  await server.listen();
  try {
    return await run(server);
  } finally {
    await server.close();
  }
}

function crawlAt(server, config, trace, signal) {
  return crawl(
    {
      startUrl: `${server.origin}/`,
      minIntervalMs: 0,
      concurrency: 1,
      respectRobots: false,
      ...config,
    },
    { clock, trace, signal },
  );
}

test("trace lines use the event fields and quote a message that has a space", () => {
  expect(formatTrace("crawl-start", { url: "https://example.com/" })).toBe(
    "[trace] crawl-start url=https://example.com/\n",
  );
  expect(formatTrace("commit", { sequence: 0, state: "ok" })).toBe(
    "[trace] commit sequence=0 state=ok\n",
  );
  expect(formatTrace("fatal", { message: "socket exploded" })).toBe(
    '[trace] fatal message="socket exploded"\n',
  );
  expect(formatTrace("robots-check", { url: "https://example.com/", allowed: true })).toBe(
    "[trace] robots-check url=https://example.com/ allowed=true\n",
  );
});

test("values outside the character rule are quoted, and a newline becomes a space", () => {
  expect(formatTrace("skipped", { url: "https://example.com/a_b-c", reason: "depth-limit" })).toBe(
    "[trace] skipped url=https://example.com/a_b-c reason=depth-limit\n",
  );
  expect(formatTrace("fatal", { message: "bad\r\nline" })).toBe(
    '[trace] fatal message="bad line"\n',
  );
  expect(formatTrace("fatal", { message: "ok\n" })).toBe(
    '[trace] fatal message="ok "\n',
  );
  expect(formatTrace("fatal", { message: 'say "hi"' })).toBe(
    '[trace] fatal message="say \\"hi\\""\n',
  );
});

test("a URL with userinfo is rewritten to that origin, and extra fields are dropped", () => {
  const line = formatTrace("attempt-start", {
    url: "https://user:secret@example.com/private?q=1",
    attempt: 1,
    body: "<html>secret</html>",
    Cookie: "session=1",
    Authorization: "Bearer secret",
  });

  expect(line).toBe('[trace] attempt-start url="https://***@example.com/" attempt=1\n');
  expect(line).not.toContain("secret");
  expect(line).not.toContain("private");
  expect(line).not.toContain("session");
  expect(line).not.toContain("Bearer");
  expect(line).not.toContain("<html>");
});

test("a depth-limit and an other-origin link are skipped without take or commit", async () => {
  const traced = collect();
  await withServer(
    {
      "/": html('<a href="/docs"></a><a href="https://external.example/x"></a>'),
    },
    async (server) => {
      const result = await crawlAt(server, { maxDepth: 0 }, traced.trace);
      const origin = server.origin;
      expect(result.counts).toEqual({
        reserved: 1,
        queued: 0,
        fetched: 1,
        ok: 1,
        skipped: 2,
        failed: 0,
      });
      expect(traced.lines).toEqual([
        formatTrace("crawl-start", { url: `${origin}/` }),
        formatTrace("reserved", { url: `${origin}/`, depth: 0, reason: "start" }),
        formatTrace("take", { url: `${origin}/`, depth: 0, sequence: 0 }),
        formatTrace("robots-check", { url: `${origin}/`, allowed: true }),
        formatTrace("attempt-start", { url: `${origin}/`, attempt: 1 }),
        formatTrace("links", { url: `${origin}/`, discovered: 2 }),
        formatTrace("skipped", { url: `${origin}/docs`, reason: "depth-limit" }),
        formatTrace("skipped", { url: "https://external.example/x", reason: "other-origin" }),
        formatTrace("commit", { sequence: 0, state: "ok" }),
        formatTrace("crawl-stop", { reason: "completed" }),
      ]);
      expect(traced.lines.filter((line) => line.startsWith("[trace] take")).length).toBe(1);
      expect(traced.lines.filter((line) => line.includes("/docs") && line.startsWith("[trace] commit"))).toEqual([]);
    },
  );
});

test("concurrency 1 finishes one page's events before the next take", async () => {
  const traced = collect();
  await withServer(
    {
      "/": html('<a href="/docs"></a>'),
      "/docs": html(""),
    },
    async (server) => {
      await crawlAt(server, { maxDepth: 1, concurrency: 1 }, traced.trace);
      const origin = server.origin;
      const names = traced.lines.map((line) => line.split(" ")[1]);
      expect(names).toEqual([
        "crawl-start",
        "reserved",
        "take",
        "robots-check",
        "attempt-start",
        "links",
        "reserved",
        "commit",
        "take",
        "robots-check",
        "attempt-start",
        "links",
        "commit",
        "crawl-stop",
      ]);
      expect(traced.lines).toContain(formatTrace("commit", { sequence: 0, state: "ok" }));
      expect(traced.lines.indexOf(formatTrace("commit", { sequence: 0, state: "ok" }))).toBeLessThan(
        traced.lines.indexOf(formatTrace("take", { url: `${origin}/docs`, depth: 1, sequence: 1 })),
      );
    },
  );
});

test("a duplicate discovery emits nothing", async () => {
  const traced = collect();
  await withServer(
    {
      "/": html('<a href="/docs"></a><a href="/docs"></a>'),
      "/docs": html(""),
    },
    async (server) => {
      await crawlAt(server, { maxDepth: 1 }, traced.trace);
      const reservedDocs = traced.lines.filter((line) => line.includes("/docs") && line.startsWith("[trace] reserved"));
      expect(reservedDocs).toEqual([
        formatTrace("reserved", { url: `${server.origin}/docs`, depth: 1, reason: "discovered" }),
      ]);
    },
  );
});

test("a robots refusal commits skipped and does not emit skipped or a page fetch", async () => {
  const traced = collect();
  await withServer(
    {
      "/robots.txt": (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nDisallow: /secret\n");
      },
      "/": html('<a href="/docs"></a><a href="/secret"></a>'),
      "/docs": html(""),
      "/secret": html("nope"),
    },
    async (server) => {
      const result = await crawlAt(server, { maxDepth: 1, respectRobots: true }, traced.trace);
      const origin = server.origin;
      expect(result.pages.find((page) => page.canonicalUrl === `${origin}/secret`).state).toBe("skipped");
      expect(server.requests.some((request) => request.path === "/secret")).toBe(false);
      expect(traced.lines).toEqual([
        formatTrace("crawl-start", { url: `${origin}/` }),
        formatTrace("reserved", { url: `${origin}/`, depth: 0, reason: "start" }),
        formatTrace("take", { url: `${origin}/`, depth: 0, sequence: 0 }),
        formatTrace("attempt-start", { url: `${origin}/robots.txt`, attempt: 1 }),
        formatTrace("robots-check", { url: `${origin}/`, allowed: true }),
        formatTrace("attempt-start", { url: `${origin}/`, attempt: 1 }),
        formatTrace("links", { url: `${origin}/`, discovered: 2 }),
        formatTrace("reserved", { url: `${origin}/docs`, depth: 1, reason: "discovered" }),
        formatTrace("reserved", { url: `${origin}/secret`, depth: 1, reason: "discovered" }),
        formatTrace("commit", { sequence: 0, state: "ok" }),
        formatTrace("take", { url: `${origin}/docs`, depth: 1, sequence: 1 }),
        formatTrace("robots-check", { url: `${origin}/docs`, allowed: true }),
        formatTrace("attempt-start", { url: `${origin}/docs`, attempt: 1 }),
        formatTrace("links", { url: `${origin}/docs`, discovered: 0 }),
        formatTrace("commit", { sequence: 1, state: "ok" }),
        formatTrace("take", { url: `${origin}/secret`, depth: 1, sequence: 2 }),
        formatTrace("robots-check", { url: `${origin}/secret`, allowed: false, reason: "robots" }),
        formatTrace("commit", { sequence: 2, state: "skipped" }),
        formatTrace("crawl-stop", { reason: "completed" }),
      ]);
    },
  );
});

test("a requested redirect emits redirect and a second robots check", async () => {
  const traced = collect();
  await withServer(
    {
      "/": html('<a href="/go"></a>'),
      "/go": (_req, res) => {
        res.writeHead(302, { location: "/land" });
        res.end();
      },
      "/land": html(""),
    },
    async (server) => {
      await crawlAt(server, { maxDepth: 1 }, traced.trace);
      const origin = server.origin;
      expect(traced.lines).toContain(formatTrace("redirect", {
        from: `${origin}/go`,
        to: `${origin}/land`,
        status: 302,
      }));
      expect(traced.lines).toContain(formatTrace("robots-check", {
        url: `${origin}/land`,
        allowed: true,
      }));
    },
  );
});

test("an off-origin redirect is not a redirect event", async () => {
  const traced = collect();
  await withServer(
    {
      "/": html('<a href="/go"></a>'),
      "/go": (_req, res) => {
        res.writeHead(302, { location: "https://external.example/land" });
        res.end();
      },
    },
    async (server) => {
      await crawlAt(server, { maxDepth: 1 }, traced.trace);
      expect(traced.lines.some((line) => line.startsWith("[trace] redirect"))).toBe(false);
    },
  );
});

test("the first fatal is followed by commit and crawl-stop, then the same error", async () => {
  const traced = collect();
  const httpClient = {
    async get() {
      throw new Error("socket exploded");
    },
  };
  const crawlPromise = crawl(
    {
      startUrl: "https://example.com/",
      minIntervalMs: 0,
      concurrency: 1,
      respectRobots: false,
    },
    { clock, httpClient, trace: traced.trace },
  );

  await expect(crawlPromise).rejects.toThrow("socket exploded");
  expect(traced.lines).toEqual([
    formatTrace("crawl-start", { url: "https://example.com/" }),
    formatTrace("reserved", { url: "https://example.com/", depth: 0, reason: "start" }),
    formatTrace("take", { url: "https://example.com/", depth: 0, sequence: 0 }),
    formatTrace("robots-check", { url: "https://example.com/", allowed: true }),
    formatTrace("fatal", { message: "socket exploded" }),
    formatTrace("commit", { sequence: 0, state: "fetching" }),
    formatTrace("crawl-stop", { reason: "fatal" }),
  ]);
});

test("an already aborted signal stops before take and reports interrupted", async () => {
  const traced = collect();
  const signal = AbortSignal.abort();
  await withServer(
    { "/": html("") },
    async (server) => {
      const result = await crawlAt(server, {}, traced.trace, signal);
      expect(result.stopReason).toBe("interrupted");
      expect(traced.lines.map((line) => line.split(" ")[1])).toEqual([
        "crawl-start",
        "reserved",
        "crawl-stop",
      ]);
      expect(traced.lines.at(-1)).toBe(formatTrace("crawl-stop", { reason: "interrupted" }));
    },
  );
});

test("a throwing sink is logged once and leaves the crawl result in place", async () => {
  const errors = [];
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error(error) {
      errors.push(error);
    },
  };
  await withServer({ "/": html("<p>ok</p>") }, async (server) => {
    const result = await crawl(
      {
        startUrl: `${server.origin}/`,
        minIntervalMs: 0,
        concurrency: 1,
        respectRobots: false,
      },
      {
        clock,
        logger,
        trace() {
          throw new Error("sink broke");
        },
      },
    );

    expect(result.stopReason).toBe("completed");
    expect(result.pages[0].state).toBe("ok");
    expect(result.pages[0].errorMessage).toBeNull();
    expect(errors.map((error) => error.message)).toEqual(["sink broke"]);
  });
});

test("a throwing sink does not replace the original fatal rejection", async () => {
  const errors = [];
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error(error) {
      errors.push(error);
    },
  };

  await expect(crawl(
    {
      startUrl: "https://example.com/",
      minIntervalMs: 0,
      concurrency: 1,
      respectRobots: false,
    },
    {
      clock,
      logger,
      httpClient: {
        async get() {
          throw new Error("socket exploded");
        },
      },
      trace() {
        throw new Error("sink broke");
      },
    },
  )).rejects.toThrow("socket exploded");
  expect(errors.map((error) => error.message)).toEqual(["sink broke"]);
});

test("a retry wait emits retry, and a wait above 5000 ms does not", async () => {
  const events = [];
  const trace = (event, fields) => events.push({ event, ...fields });
  let calls = 0;
  const http = createHttpClient({
    fetchImpl() {
      calls += 1;
      const status = calls === 1 ? 500 : 200;
      return {
        status,
        headers: { get: () => (status === 200 ? "text/html" : null) },
        async text() {
          return "";
        },
        body: null,
      };
    },
    clock,
    userAgent: "Bot",
    timeoutMs: 1000,
    retryCount: 1,
    trace,
  });

  await http.get("https://example.com/a", {
    maxBytes: 100,
    async beforeAttempt() {},
    wantBody() {
      return false;
    },
  });
  expect(events).toEqual([
    { event: "attempt-start", url: "https://example.com/a", attempt: 1 },
    { event: "retry", url: "https://example.com/a", next: 2, wait: 500, status: 500 },
    { event: "attempt-start", url: "https://example.com/a", attempt: 2 },
  ]);

  const quiet = [];
  const capped = createHttpClient({
    fetchImpl() {
      return {
        status: 503,
        headers: {
          get(name) {
            return name === "retry-after" ? "9" : null;
          },
        },
        body: null,
      };
    },
    clock,
    userAgent: "Bot",
    timeoutMs: 1000,
    retryCount: 1,
    trace(event) {
      quiet.push(event);
    },
  });
  await capped.get("https://example.com/b", {
    maxBytes: 100,
    async beforeAttempt() {},
    wantBody() {
      return false;
    },
  });
  expect(quiet).toEqual(["attempt-start"]);
});
