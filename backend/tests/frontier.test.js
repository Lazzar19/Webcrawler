const { crawl } = require("../src/crawler/crawl");

function htmlResponse(body, contentType = "text/html; charset=utf-8") {
  return {
    statusCode: 200,
    contentType,
    location: null,
    body,
  };
}

function clientFor(routes) {
  const requested = [];
  return {
    requested,
    async get(url, options) {
      await options.beforeAttempt();
      requested.push(url);
      const path = new URL(url).pathname;
      const route = routes[path];
      if (typeof route === "function") {
        return route(url, options);
      }
      const page = route ?? htmlResponse("");
      const statusCode = page.statusCode ?? 200;
      const contentType = page.contentType ?? "text/html";
      const read = options.wantBody({ statusCode, contentType });
      return {
        url,
        statusCode,
        contentType,
        location: page.location ?? null,
        body: read ? page.body ?? "" : null,
        byteLength: read ? Buffer.byteLength(page.body ?? "") : null,
        attempts: 1,
        durationMs: 0,
      };
    },
  };
}

function crawlSite(routes, config) {
  const http = clientFor(routes);
  const result = crawl(
    {
      startUrl: "https://example.com/",
      minIntervalMs: 0,
      ...config,
    },
    { httpClient: http }
  );
  return { http, result };
}

test("a cycle creates one record per key", async () => {
  const { result } = crawlSite(
    {
      "/pageA": htmlResponse('<a href="/pageB"></a>'),
      "/pageB": htmlResponse('<a href="/pageA"></a>'),
    },
    { startUrl: "https://example.com/pageA", maxDepth: 3, concurrency: 2 }
  );
  const pages = (await result).pages;
  expect(pages.map((page) => page.canonicalUrl)).toEqual([
    "https://example.com/pageA",
    "https://example.com/pageB",
  ]);
  expect(pages.every((page) => page.state === "ok")).toBe(true);
  expect(pages[1].discoveredFrom).toBe("https://example.com/pageA");
});

test("a non-html response is skipped and contributes no links", async () => {
  const { http, result } = crawlSite(
    {
      "/file": htmlResponse("{}", "application/json"),
    },
    { startUrl: "https://example.com/file", maxDepth: 3 }
  );
  const crawlResult = await result;
  expect(crawlResult.pages).toEqual([
    expect.objectContaining({
      canonicalUrl: "https://example.com/file",
      state: "skipped",
      skipReason: "non-html",
      attempts: 1,
    }),
  ]);
  expect(http.requested).toEqual(["https://example.com/file"]);
});

test("html with a charset parameter is fetched", async () => {
  const { result } = crawlSite(
    {
      "/": htmlResponse("<html></html>"),
    },
    { maxDepth: 1 }
  );
  const pages = (await result).pages;
  expect(pages[0].state).toBe("ok");
  expect(pages[0].canonicalUrl).toBe("https://example.com/");
});

test("an external link is an other-origin record and is not fetched", async () => {
  const { http, result } = crawlSite(
    {
      "/": htmlResponse('<a href="https://external.com/page"></a>'),
    },
    { maxDepth: 3 }
  );
  const pages = (await result).pages;
  expect(pages.map((page) => [page.canonicalUrl, page.state, page.skipReason])).toEqual([
    ["https://example.com/", "ok", null],
    ["https://external.com/page", "skipped", "other-origin"],
  ]);
  expect(http.requested).toEqual(["https://example.com/"]);
});

test("maxDepth is inclusive and the next link is depth-limit", async () => {
  const { http, result } = crawlSite(
    {
      "/": htmlResponse('<a href="/page2"></a>'),
      "/page2": htmlResponse('<a href="/page3"></a>'),
      "/page3": htmlResponse(""),
    },
    { maxDepth: 1, concurrency: 2 }
  );
  const pages = (await result).pages;
  expect(pages.map((page) => [page.canonicalUrl, page.state, page.skipReason])).toEqual([
    ["https://example.com/", "ok", null],
    ["https://example.com/page2", "ok", null],
    ["https://example.com/page3", "skipped", "depth-limit"],
  ]);
  expect(http.requested).toEqual(["https://example.com/", "https://example.com/page2"]);
});

test("maxDepth 0 fetches only the start URL", async () => {
  const { http, result } = crawlSite(
    {
      "/": htmlResponse('<a href="/next"></a>'),
    },
    { maxDepth: 0 }
  );
  const pages = (await result).pages;
  expect(pages.map((page) => page.skipReason)).toEqual([null, "depth-limit"]);
  expect(http.requested).toEqual(["https://example.com/"]);
});

test("maxPages counts fetch reservations", async () => {
  const { http, result } = crawlSite(
    {
      "/": htmlResponse('<a href="/a"></a><a href="/b"></a>'),
      "/a": htmlResponse(""),
      "/b": htmlResponse(""),
    },
    { maxPages: 2, maxDepth: 2, concurrency: 1 }
  );
  const pages = (await result).pages;
  expect(pages.map((page) => [page.canonicalUrl, page.state, page.skipReason])).toEqual([
    ["https://example.com/", "ok", null],
    ["https://example.com/a", "ok", null],
    ["https://example.com/b", "skipped", "page-limit"],
  ]);
  expect(http.requested).toEqual(["https://example.com/", "https://example.com/a"]);
  expect((await result).counts.reserved).toBe(2);
});

test("the first reserved spelling is requested", async () => {
  const { http, result } = crawlSite(
    {
      "/": htmlResponse('<a href="/a/"></a><a href="/a"></a><a href="/search?q=b%20a"></a>'),
      "/a/": htmlResponse(""),
      "/a": htmlResponse(""),
      "/search": htmlResponse(""),
    },
    { maxDepth: 1, concurrency: 1 }
  );
  await result;
  expect(http.requested).toContain("https://example.com/a/");
  expect(http.requested).not.toContain("https://example.com/a");
  expect(http.requested).toContain("https://example.com/search?q=b%20a");
});

test("commit order follows dequeue order when a later page responds first", async () => {
  let releaseB;
  const holdB = new Promise((resolve) => {
    releaseB = resolve;
  });
  const routes = {
    "/": htmlResponse('<a href="/c"></a><a href="/b"></a>'),
    "/b": async () => {
      await holdB;
      return htmlResponse('<a href="/x"></a><a href="/y"></a>');
    },
    "/c": htmlResponse('<a href="/x"></a><a href="/z"></a>'),
    "/x": htmlResponse(""),
    "/y": htmlResponse(""),
    "/z": htmlResponse(""),
  };
  const http = {
    async get(url, options) {
      await options.beforeAttempt();
      const path = new URL(url).pathname;
      const route = routes[path];
      const page = typeof route === "function" ? await route() : route;
      const read = options.wantBody({
        statusCode: 200,
        contentType: "text/html",
      });
      return {
        url,
        statusCode: 200,
        contentType: "text/html",
        location: null,
        body: read ? page.body : null,
        byteLength: read ? Buffer.byteLength(page.body) : null,
        attempts: 1,
        durationMs: 0,
      };
    },
  };

  const pending = crawl(
    {
      startUrl: "https://example.com/",
      maxDepth: 2,
      maxPages: 4,
      concurrency: 2,
      minIntervalMs: 0,
    },
    { httpClient: http }
  );
  await new Promise((resolve) => setImmediate(resolve));
  releaseB();
  const pages = (await pending).pages;

  expect(pages.map((page) => page.canonicalUrl)).toEqual([
    "https://example.com/",
    "https://example.com/b",
    "https://example.com/c",
    "https://example.com/x",
    "https://example.com/y",
    "https://example.com/z",
  ]);
  expect(pages.find((page) => page.canonicalUrl === "https://example.com/x").discoveredFrom).toBe(
    "https://example.com/b"
  );
  expect(pages.filter((page) => page.skipReason === "page-limit").map((page) => page.canonicalUrl)).toEqual([
    "https://example.com/y",
    "https://example.com/z",
  ]);
});

test("an unclassified error rejects with the same object and does not hang", async () => {
  const boom = new Error("boom");
  const http = {
    async get(url, options) {
      await options.beforeAttempt();
      if (new URL(url).pathname === "/boom") {
        throw boom;
      }
      const read = options.wantBody({ statusCode: 200, contentType: "text/html" });
      const body = '<a href="/boom"></a><a href="/ok"></a>';
      return {
        url,
        statusCode: 200,
        contentType: "text/html",
        location: null,
        body: read ? body : null,
        byteLength: read ? Buffer.byteLength(body) : null,
        attempts: 1,
        durationMs: 0,
      };
    },
  };

  const pending = crawl(
    {
      startUrl: "https://example.com/",
      maxDepth: 1,
      concurrency: 2,
      minIntervalMs: 0,
    },
    { httpClient: http }
  );
  await expect(pending).rejects.toBe(boom);
});

test("a redirect alias does not consume a page slot and is requested", async () => {
  const { http, result } = crawlSite(
    {
      "/": {
        statusCode: 302,
        location: "/target",
        contentType: "text/html",
        body: "",
      },
      "/target": htmlResponse('<a href="/extra"></a>'),
      "/extra": htmlResponse(""),
    },
    { maxPages: 1, maxDepth: 2 }
  );
  const crawlResult = await result;
  expect(http.requested).toEqual(["https://example.com/", "https://example.com/target"]);
  expect(crawlResult.counts.reserved).toBe(1);
  expect(crawlResult.pages.map((page) => [page.canonicalUrl, page.state, page.skipReason, page.finalUrl])).toEqual([
    ["https://example.com/", "ok", null, "https://example.com/target"],
    ["https://example.com/extra", "skipped", "page-limit", null],
  ]);
});

test("a redirect onto an existing key is duplicate and is not requested", async () => {
  const { http, result } = crawlSite(
    {
      "/": htmlResponse('<a href="/a"></a>'),
      "/a": {
        statusCode: 302,
        location: "/",
        contentType: "text/html",
        body: "",
      },
    },
    { maxDepth: 2, concurrency: 1 }
  );
  const pages = (await result).pages;
  expect(http.requested).toEqual(["https://example.com/", "https://example.com/a"]);
  expect(pages.find((page) => page.canonicalUrl === "https://example.com/a").skipReason).toBe(
    "duplicate"
  );
});

test("an off-origin redirect is not requested", async () => {
  const { http, result } = crawlSite(
    {
      "/": {
        statusCode: 302,
        location: "https://other.example/a",
        contentType: "text/html",
        body: "",
      },
    },
    { maxDepth: 2 }
  );
  const pages = (await result).pages;
  expect(http.requested).toEqual(["https://example.com/"]);
  expect(pages[0].skipReason).toBe("redirect-off-origin");
});

test("a redirect loop fails without another request", async () => {
  const { http, result } = crawlSite(
    {
      "/": {
        statusCode: 302,
        location: "/again",
        contentType: "text/html",
        body: "",
      },
      "/again": {
        statusCode: 302,
        location: "/",
        contentType: "text/html",
        body: "",
      },
    },
    { maxDepth: 2 }
  );
  const pages = (await result).pages;
  expect(http.requested).toEqual(["https://example.com/", "https://example.com/again"]);
  expect(pages[0].errorKind).toBe("redirect-loop");
});

test("an interrupt does not cut a retry sleep short", async () => {
  const signal = new AbortController();
  let calls = 0;
  let releaseSleep;
  const pending = crawl(
    {
      startUrl: "http://example.com/",
      concurrency: 1,
      maxPages: 1,
      maxDepth: 0,
      retryCount: 1,
      retryBaseDelayMs: 500,
    },
    {
      fetchImpl() {
        calls += 1;
        if (calls === 1) {
          const error = new TypeError("fetch failed");
          error.cause = { code: "ECONNRESET" };
          throw error;
        }
        return new Response("<html></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      },
      clock: {
        now: () => 1_700_000_000_000,
        sleep() {
          return new Promise((resolve) => {
            releaseSleep = resolve;
          });
        },
      },
      signal: signal.signal,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    },
  );

  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  expect(typeof releaseSleep).toBe("function");
  signal.abort();
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  expect(calls).toBe(1);
  releaseSleep();
  const result = await pending;
  expect(calls).toBe(2);
  expect(result.stopReason).toBe("interrupted");
  expect(result.pages[0].state).toBe("ok");
  expect(result.pages[0].attempts).toBe(2);
});
