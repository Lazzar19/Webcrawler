const { crawl } = require("../src/crawler/crawl");
const { FetchError } = require("../src/crawler/http-client");
const { createRobotsManager, productToken } = require("../src/crawler/robots-manager");

const EXAMPLE = [
  "User-agent: *",
  "Disallow: /private",
  "",
  "User-agent: WebcrawlerBot",
  "Allow: /secret/public",
  "Disallow: /secret",
  "Crawl-delay: 2",
].join("\n");

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function reply(url, options, { statusCode, body = "", location = null, contentType = "text/plain" }) {
  const read = statusCode >= 200 && statusCode < 300 && options.wantBody({ statusCode, contentType });
  return {
    url,
    statusCode,
    contentType,
    location,
    body: read ? body : null,
    byteLength: read ? Buffer.byteLength(body) : null,
    attempts: 1,
    durationMs: 0,
  };
}

function managerFor(fetchImpl, { userAgent = "WebcrawlerBot/1.0", respectRobots = true } = {}) {
  const requested = [];
  const http = {
    async get(url, options) {
      requested.push(url);
      await options.beforeAttempt();
      return fetchImpl(url, options, requested.length);
    },
  };
  return {
    requested,
    robots: createRobotsManager({ http, userAgent, respectRobots }),
  };
}

test("the product token stops at the first slash or space", () => {
  expect(productToken("WebcrawlerBot/1.0 (+https://github.com/Lazzar19/webcrawler)")).toBe("WebcrawlerBot");
  expect(productToken("Other Bot/1.0")).toBe("Other");
  expect(productToken("PlainToken")).toBe("PlainToken");
});

test("the token group does not inherit the star group, and crawl-delay becomes the later gap", async () => {
  const { robots } = managerFor(replyArguments(EXAMPLE));
  const secret = await robots.check("https://example.com/secret", { beforeAttempt: async () => {} });
  const visible = await robots.check("https://example.com/secret/public");
  const hidden = await robots.check("https://example.com/private");
  const root = await robots.check("https://example.com/");

  expect(secret).toEqual({ allowed: false, reason: "robots" });
  expect(visible).toEqual({ allowed: true });
  expect(hidden).toEqual({ allowed: true });
  expect(root).toEqual({ allowed: true });
  expect(robots.gapMs("https://example.com", 200)).toBe(2000);
  expect(robots.gapMs("https://example.com", 3000)).toBe(3000);
  expect(robots.summaries()).toEqual([
    {
      origin: "https://example.com",
      statusCode: 200,
      outcome: "parsed",
      errorKind: null,
    },
  ]);
});

function replyArguments(body, statusCode = 200) {
  return (_url, options) => reply("https://example.com/robots.txt", options, { statusCode, body });
}

test("a crawl-delay above 10 seconds is capped and a smaller one is ignored", async () => {
  const large = managerFor(replyArguments("User-agent: *\nCrawl-delay: 30\n"));
  await large.robots.check("https://example.com/", { beforeAttempt: async () => {} });
  expect(large.robots.gapMs("https://example.com", 200)).toBe(10000);

  const small = managerFor(replyArguments("User-agent: *\nCrawl-delay: 0.1\n"));
  await small.robots.check("https://example.com/", { beforeAttempt: async () => {} });
  expect(small.robots.gapMs("https://example.com", 200)).toBe(200);
});

test("an empty robots file allows every path and leaves the gap alone", async () => {
  const { robots } = managerFor(replyArguments(""));
  const decision = await robots.check("https://example.com/anywhere", { beforeAttempt: async () => {} });
  expect(decision).toEqual({ allowed: true });
  expect(robots.gapMs("https://example.com", 200)).toBe(200);
});

test("a star group applies when the token has no group of its own", async () => {
  const { robots } = managerFor(
    replyArguments("User-agent: *\nDisallow: /\nCrawl-delay: 9\n"),
    { userAgent: "OtherBot/1.0" },
  );
  const decision = await robots.check("https://example.com/", { beforeAttempt: async () => {} });
  expect(decision).toEqual({ allowed: false, reason: "robots" });
  expect(robots.gapMs("https://example.com", 200)).toBe(9000);
});

test("the token match ignores case", async () => {
  const { robots } = managerFor(replyArguments(EXAMPLE), { userAgent: "webcrawlerbot/1.0" });
  const decision = await robots.check("https://example.com/secret", { beforeAttempt: async () => {} });
  expect(decision).toEqual({ allowed: false, reason: "robots" });
});

test.each([
  [404, "allow-all", null],
  [403, "allow-all", null],
  [429, "unavailable", "http-status"],
  [500, "unavailable", "http-status"],
  [503, "unavailable", "http-status"],
  [304, "unavailable", "http-status"],
  [100, "unavailable", "http-status"],
])("status %s is %s", async (statusCode, outcome, errorKind) => {
  const { robots, requested } = managerFor(replyArguments("", statusCode));
  const decision = await robots.check("https://example.com/page", { beforeAttempt: async () => {} });
  expect(requested).toEqual(["https://example.com/robots.txt"]);
  expect(robots.summaries()).toEqual([
    { origin: "https://example.com", statusCode, outcome, errorKind },
  ]);
  expect(robots.gapMs("https://example.com", 200)).toBe(200);
  if (outcome === "unavailable") {
    expect(decision).toEqual({ allowed: false, reason: "robots-unavailable" });
  } else {
    expect(decision).toEqual({ allowed: true });
  }
});

test("a network failure fail-closes with the fetch kind and a null status", async () => {
  const { robots } = managerFor(() => {
    throw new FetchError("dns", "fetch failed (ENOTFOUND)", 1);
  });
  const decision = await robots.check("https://example.com/", { beforeAttempt: async () => {} });
  expect(decision).toEqual({ allowed: false, reason: "robots-unavailable" });
  expect(robots.summaries()).toEqual([
    {
      origin: "https://example.com",
      statusCode: null,
      outcome: "unavailable",
      errorKind: "dns",
    },
  ]);
});

test("only the worker that starts the fetch calls beforeAttempt", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let starter = 0;
  let waiter = 0;
  const { robots, requested } = managerFor(async (_url, options) => {
    await gate;
    return reply("https://example.com/robots.txt", options, { statusCode: 200, body: "" });
  });

  const first = robots.check("https://example.com/a", {
    async beforeAttempt() {
      starter += 1;
    },
  });
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  const second = robots.check("https://example.com/b", {
    async beforeAttempt() {
      waiter += 1;
    },
  });
  expect(requested).toEqual(["https://example.com/robots.txt"]);
  release();
  await Promise.all([first, second]);
  expect(requested).toEqual(["https://example.com/robots.txt"]);
  expect(starter).toBe(1);
  expect(waiter).toBe(0);
});

test("a robots redirect may leave the host and a sixth hop is not requested", async () => {
  const { robots, requested } = managerFor((url, options) => {
    const path = new URL(url).pathname;
    if (path === "/robots.txt") {
      return reply(url, options, { statusCode: 302, location: "https://cdn.example/1" });
    }
    const hop = Number(path.slice(1));
    if (hop < 6) {
      return reply(url, options, { statusCode: 302, location: `https://cdn.example/${hop + 1}` });
    }
    return reply(url, options, { statusCode: 200, body: "User-agent: *\nDisallow: /\n" });
  });

  const decision = await robots.check("https://example.com/", { beforeAttempt: async () => {} });
  expect(decision).toEqual({ allowed: false, reason: "robots-unavailable" });
  expect(requested).toEqual([
    "https://example.com/robots.txt",
    "https://cdn.example/1",
    "https://cdn.example/2",
    "https://cdn.example/3",
    "https://cdn.example/4",
    "https://cdn.example/5",
  ]);
  expect(robots.summaries()).toEqual([
    {
      origin: "https://example.com",
      statusCode: null,
      outcome: "unavailable",
      errorKind: "redirect-limit",
    },
  ]);
});

test("a repeated robots hop is a redirect loop and is not requested again", async () => {
  const { robots, requested } = managerFor((url, options) => {
    if (new URL(url).pathname === "/robots.txt") {
      return reply(url, options, { statusCode: 302, location: "/again" });
    }
    return reply(url, options, { statusCode: 302, location: "/robots.txt" });
  });
  const decision = await robots.check("https://example.com/page", { beforeAttempt: async () => {} });
  expect(decision.reason).toBe("robots-unavailable");
  expect(requested).toEqual([
    "https://example.com/robots.txt",
    "https://example.com/again",
  ]);
  expect(robots.summaries()[0].errorKind).toBe("redirect-loop");
});

test.each([
  ["missing Location", null],
  ["userinfo", "http://user:pw@example.com/robots.txt"],
  ["ftp", "ftp://files.example/robots.txt"],
  ["unparseable", "http://["],
])("a robots redirect with %s is bad-redirect", async (_label, location) => {
  const { robots, requested } = managerFor((url, options) => reply(url, options, {
    statusCode: 302,
    location,
  }));
  const decision = await robots.check("https://example.com/", { beforeAttempt: async () => {} });
  expect(decision).toEqual({ allowed: false, reason: "robots-unavailable" });
  expect(requested).toEqual(["https://example.com/robots.txt"]);
  expect(robots.summaries()[0].errorKind).toBe("bad-redirect");
});

test("respectRobots false does not fetch and does not apply crawl-delay", async () => {
  const { robots, requested } = managerFor(() => {
    throw new Error("robots.txt was fetched");
  }, { respectRobots: false });
  const decision = await robots.check("https://example.com/secret", { beforeAttempt: async () => {} });
  expect(decision).toEqual({ allowed: true });
  expect(requested).toEqual([]);
  expect(robots.gapMs("https://example.com", 200)).toBe(200);
  expect(robots.summaries()).toEqual([
    {
      origin: "https://example.com",
      statusCode: null,
      outcome: "not-checked",
      errorKind: null,
    },
  ]);
});

test("a disallowed start URL is not requested and keeps the page fields empty", async () => {
  const requested = [];
  const result = await crawl(
    {
      startUrl: "https://example.com/",
      maxDepth: 0,
      concurrency: 1,
      minIntervalMs: 0,
    },
    {
      logger,
      httpClient: {
        async get(url, options) {
          await options.beforeAttempt();
          requested.push(url);
          return reply(url, options, {
            statusCode: 200,
            body: "User-agent: *\nDisallow: /\n",
          });
        },
      },
    },
  );

  expect(requested).toEqual(["https://example.com/robots.txt"]);
  expect(result.pages[0]).toMatchObject({
    state: "skipped",
    skipReason: "robots",
    attempts: 0,
    waitedMs: null,
    errorKind: null,
  });
  expect(result.counts.reserved).toBe(1);
  expect(result.robots).toEqual([
    {
      origin: "https://example.com",
      statusCode: 200,
      outcome: "parsed",
      errorKind: null,
    },
  ]);
});

test("a redirect into a disallowed path is not requested", async () => {
  const requested = [];
  const result = await crawl(
    {
      startUrl: "https://example.com/",
      maxDepth: 1,
      concurrency: 1,
      minIntervalMs: 0,
    },
    {
      logger,
      httpClient: {
        async get(url, options) {
          await options.beforeAttempt();
          requested.push(new URL(url).pathname);
          if (new URL(url).pathname === "/robots.txt") {
            return reply(url, options, {
              statusCode: 200,
              body: "User-agent: *\nDisallow: /secret\n",
            });
          }
          return reply(url, options, {
            statusCode: 302,
            location: "/secret",
            contentType: "text/html",
          });
        },
      },
    },
  );

  expect(requested).toEqual(["/robots.txt", "/"]);
  expect(result.pages[0]).toMatchObject({
    state: "skipped",
    skipReason: "robots",
    attempts: 1,
  });
});

test("a missing robots file allows the page", async () => {
  const result = await crawl(
    {
      startUrl: "https://example.com/page",
      maxDepth: 0,
      concurrency: 1,
      minIntervalMs: 0,
    },
    {
      logger,
      httpClient: {
        async get(url, options) {
          await options.beforeAttempt();
          if (new URL(url).pathname === "/robots.txt") {
            return reply(url, options, { statusCode: 404 });
          }
          return reply(url, options, {
            statusCode: 200,
            contentType: "text/html",
            body: "<html></html>",
          });
        },
      },
    },
  );

  expect(result.pages[0].state).toBe("ok");
  expect(result.robots).toEqual([
    {
      origin: "https://example.com",
      statusCode: 404,
      outcome: "allow-all",
      errorKind: null,
    },
  ]);
});

test("robots.txt 500 skips the origin", async () => {
  const requested = [];
  const result = await crawl(
    {
      startUrl: "https://example.com/",
      maxDepth: 0,
      concurrency: 1,
      minIntervalMs: 0,
    },
    {
      logger,
      httpClient: {
        async get(url, options) {
          await options.beforeAttempt();
          requested.push(url);
          return reply(url, options, { statusCode: 500 });
        },
      },
    },
  );

  expect(requested).toEqual(["https://example.com/robots.txt"]);
  expect(result.pages[0]).toMatchObject({
    state: "skipped",
    skipReason: "robots-unavailable",
    attempts: 0,
    waitedMs: null,
    errorKind: null,
  });
  expect(result.robots[0]).toMatchObject({
    outcome: "unavailable",
    errorKind: "http-status",
    statusCode: 500,
  });
});

test("two workers share one robots.txt fetch", async () => {
  let robotsCalls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const pending = crawl(
    {
      startUrl: "https://example.com/",
      maxDepth: 1,
      maxPages: 2,
      concurrency: 2,
      minIntervalMs: 0,
    },
    {
      logger,
      httpClient: {
        async get(url, options) {
          await options.beforeAttempt();
          const path = new URL(url).pathname;
          if (path === "/robots.txt") {
            robotsCalls += 1;
            await gate;
            return reply(url, options, { statusCode: 404 });
          }
          const body = path === "/" ? '<a href="/next"></a>' : "<html></html>";
          return reply(url, options, { statusCode: 200, contentType: "text/html", body });
        },
      },
    },
  );

  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  expect(robotsCalls).toBe(1);
  release();
  const result = await pending;
  expect(robotsCalls).toBe(1);
  expect(result.pages.map((page) => page.state)).toEqual(["ok", "ok"]);
});
