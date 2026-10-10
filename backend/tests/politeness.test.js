const { crawl } = require("../src/crawler/crawl");
const { createHttpClient } = require("../src/crawler/http-client");
const { createPolitenessGate } = require("../src/crawler/politeness");

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function steppingClock(start = 0) {
  let time = start;
  const sleeps = [];
  return {
    now: () => time,
    sleeps,
    jump(ms) {
      time += ms;
    },
    sleep(ms) {
      sleeps.push(ms);
      time += ms;
      return Promise.resolve();
    },
  };
}

function gateFor(clock, { perOriginLimit = 1, minIntervalMs = 200, gapMs = () => minIntervalMs, fatalSignal } = {}) {
  return createPolitenessGate({
    clock,
    perOriginLimit,
    minIntervalMs,
    robots: { gapMs: (_origin, fallback) => gapMs(fallback) },
    fatalSignal,
  });
}

function plainResponse(url, status = 200, body = "", headers = {}) {
  const values = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  return {
    url,
    status,
    headers: {
      get(name) {
        return values.get(name.toLowerCase()) ?? null;
      },
    },
    body: body === null ? null : {
      cancel() {
        return Promise.resolve();
      },
      getReader() {
        const encoded = new TextEncoder().encode(body);
        let done = false;
        return {
          async read() {
            if (done) {
              return { done: true, value: undefined };
            }
            done = true;
            return { done: false, value: encoded };
          },
          cancel() {
            return Promise.resolve();
          },
        };
      },
    },
  };
}

test("a full origin waits in FIFO order and a release wakes only the next worker", async () => {
  const gate = gateFor(steppingClock(), { perOriginLimit: 1, minIntervalMs: 0 });
  const origin = "https://example.com";
  const first = await gate.acquire(origin);
  const order = [];
  const second = gate.acquire(origin).then((lease) => {
    order.push("second");
    return lease;
  });
  const third = gate.acquire(origin).then((lease) => {
    order.push("third");
    return lease;
  });

  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  expect(order).toEqual([]);
  first.release();
  const secondLease = await second;
  expect(order).toEqual(["second"]);
  secondLease.release();
  await third;
  expect(order).toEqual(["second", "third"]);
});

test("another origin is not blocked by a full lease", async () => {
  const gate = gateFor(steppingClock(), { perOriginLimit: 1, minIntervalMs: 0 });
  await gate.acquire("https://example.com");
  const other = await gate.acquire("https://other.example");
  expect(other).toBeDefined();
});

test("fatal-stop does not hand out a lease that is still held", async () => {
  const fatal = new AbortController();
  const gate = gateFor(steppingClock(), { perOriginLimit: 1, minIntervalMs: 0, fatalSignal: fatal.signal });
  const holder = await gate.acquire("https://example.com");
  let granted = false;
  const waiting = gate.acquire("https://example.com").then(() => {
    granted = true;
  });
  fatal.abort();
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  expect(granted).toBe(false);
  holder.release();
  await waiting;
});

test("nextAllowedAt is claimed before the wait, and a later start keeps the gap", async () => {
  const clock = steppingClock(0);
  const gate = gateFor(clock, { perOriginLimit: 2, minIntervalMs: 200 });
  const origin = "https://example.com";
  const first = await gate.acquire(origin);
  const second = await gate.acquire(origin);
  await first.beforeAttempt();
  await second.beforeAttempt();
  clock.jump(50);
  first.release();
  const third = await gate.acquire(origin);
  await third.beforeAttempt();

  expect(clock.sleeps).toEqual([200, 150]);
  expect(clock.now()).toBe(400);
});

test("crawl-delay replaces a smaller gap only after robots.txt is parsed", async () => {
  const clock = steppingClock(0);
  let parsed = false;
  const gate = gateFor(clock, {
    perOriginLimit: 1,
    minIntervalMs: 200,
    gapMs: (fallback) => (parsed ? 2000 : fallback),
  });
  const lease = await gate.acquire("https://example.com");
  await lease.beforeAttempt();
  parsed = true;
  await lease.beforeAttempt();

  expect(clock.sleeps).toEqual([2000]);
  expect(clock.now()).toBe(2000);
});

test("a missing crawl-delay leaves the gap at minIntervalMs", async () => {
  const clock = steppingClock(0);
  const gate = gateFor(clock, { perOriginLimit: 1, minIntervalMs: 200, gapMs: (fallback) => fallback });
  const lease = await gate.acquire("https://example.com");
  await lease.beforeAttempt();
  await lease.beforeAttempt();
  expect(clock.sleeps).toEqual([200]);
});

test("fatal-stop ends a politeness wait without throwing", async () => {
  const fatal = new AbortController();
  let releaseSleep;
  const clock = {
    now: () => 0,
    sleep() {
      return new Promise((resolve) => {
        releaseSleep = resolve;
      });
    },
  };
  const gate = gateFor(clock, { perOriginLimit: 1, minIntervalMs: 200, fatalSignal: fatal.signal });
  const lease = await gate.acquire("https://example.com");
  await lease.beforeAttempt();
  const pending = lease.beforeAttempt();
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  expect(typeof releaseSleep).toBe("function");
  fatal.abort();
  await pending;
  releaseSleep();
});

test("backoff that already passed the gap is not followed by another full gap", async () => {
  const clock = steppingClock(0);
  const gate = gateFor(clock, { perOriginLimit: 1, minIntervalMs: 200 });
  const lease = await gate.acquire("https://example.com");
  const starts = [];
  const http = createHttpClient({
    fetchImpl() {
      starts.push(clock.now());
      if (starts.length === 1) {
        clock.jump(10);
        const error = new Error("The operation was aborted due to timeout");
        error.name = "TimeoutError";
        throw error;
      }
      return plainResponse("https://example.com/", 200, "<html></html>", {
        "content-type": "text/html",
      });
    },
    clock,
    userAgent: "WebcrawlerBot/1.0",
    timeoutMs: 1000,
    retryCount: 1,
    retryBaseDelayMs: 500,
  });

  await http.get("https://example.com/", {
    maxBytes: 1000,
    beforeAttempt: () => lease.beforeAttempt(),
    wantBody: () => true,
  });

  expect(starts).toEqual([0, 510]);
  expect(clock.sleeps).toEqual([500]);
});

test("a backoff that ends inside the gap still waits for the gap", async () => {
  const clock = steppingClock(0);
  const gate = gateFor(clock, { perOriginLimit: 1, minIntervalMs: 1000 });
  const lease = await gate.acquire("https://example.com");
  const starts = [];
  const http = createHttpClient({
    fetchImpl() {
      starts.push(clock.now());
      if (starts.length === 1) {
        const error = new Error("The operation was aborted due to timeout");
        error.name = "TimeoutError";
        throw error;
      }
      return plainResponse("https://example.com/", 200, null);
    },
    clock,
    userAgent: "WebcrawlerBot/1.0",
    timeoutMs: 1000,
    retryCount: 1,
    retryBaseDelayMs: 500,
  });

  await http.get("https://example.com/", {
    maxBytes: 100,
    beforeAttempt: () => lease.beforeAttempt(),
    wantBody: () => false,
  });

  expect(starts).toEqual([0, 1000]);
  expect(clock.sleeps).toEqual([500, 500]);
});

test("the page that triggered robots.txt waits out the parsed crawl-delay", async () => {
  const clock = steppingClock(0);
  const requested = [];
  const result = await crawl(
    {
      startUrl: "https://example.com/",
      maxDepth: 0,
      concurrency: 1,
      perOriginLimit: 1,
      minIntervalMs: 200,
    },
    {
      clock,
      logger,
      httpClient: {
        async get(url, options) {
          await options.beforeAttempt();
          requested.push({ path: new URL(url).pathname, at: clock.now() });
          if (new URL(url).pathname === "/robots.txt") {
            return {
              url,
              statusCode: 200,
              contentType: "text/plain",
              location: null,
              body: "User-agent: *\nCrawl-delay: 2\n",
              byteLength: 10,
              attempts: 1,
              durationMs: 0,
            };
          }
          return {
            url,
            statusCode: 200,
            contentType: "text/html",
            location: null,
            body: "<html></html>",
            byteLength: 13,
            attempts: 1,
            durationMs: 0,
          };
        },
      },
    },
  );

  expect(requested).toEqual([
    { path: "/robots.txt", at: 0 },
    { path: "/", at: 2000 },
  ]);
  expect(result.pages[0].waitedMs).toBe(2000);
  expect(result.pages[0].state).toBe("ok");
});

test("perOriginLimit 1 still finishes a crawl that fetches robots.txt", async () => {
  let timer;
  const result = await Promise.race([
    crawl(
      {
        startUrl: "https://example.com/",
        maxDepth: 0,
        concurrency: 1,
        perOriginLimit: 1,
        minIntervalMs: 0,
      },
      {
        logger,
        httpClient: {
          async get(url, options) {
            await options.beforeAttempt();
            if (new URL(url).pathname === "/robots.txt") {
              return {
                url,
                statusCode: 404,
                contentType: "text/plain",
                location: null,
                body: null,
                byteLength: null,
                attempts: 1,
                durationMs: 0,
              };
            }
            return {
              url,
              statusCode: 200,
              contentType: "text/html",
              location: null,
              body: "<html></html>",
              byteLength: 13,
              attempts: 1,
              durationMs: 0,
            };
          },
        },
      },
    ),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("crawl deadlocked")), 1000);
    }),
  ]);
  clearTimeout(timer);

  expect(result.pages[0].state).toBe("ok");
});
