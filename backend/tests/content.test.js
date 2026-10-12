jest.mock("../src/crawler/url-policy", () => {
  const actual = jest.requireActual("../src/crawler/url-policy");
  return {
    ...actual,
    extractLinks(html, pageUrl, logger) {
      if (html === "THROW") {
        throw new Error("parse failed");
      }
      return actual.extractLinks(html, pageUrl, logger);
    },
  };
});

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
      const page = routes[path] ?? htmlResponse("");
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
      respectRobots: false,
      concurrency: 1,
      maxDepth: 2,
      ...config,
    },
    { httpClient: http }
  );
  return { http, result };
}

function pageAt(result, pathname) {
  return result.pages.find((page) => new URL(page.requestedUrl).pathname === pathname);
}

const shared = '<a href="/child"></a>';

test("the second committed copy of a body reserves no links and keeps the fetch", async () => {
  const { http, result } = crawlSite({
    "/": htmlResponse('<a href="/a"></a><a href="/b"></a>'),
    "/a": htmlResponse(shared),
    "/b": htmlResponse(shared),
    "/child": htmlResponse("<p>child</p>"),
  });
  const crawlResult = await result;
  const first = pageAt(crawlResult, "/a");
  const second = pageAt(crawlResult, "/b");
  const child = pageAt(crawlResult, "/child");

  expect(first.state).toBe("ok");
  expect(second.state).toBe("skipped");
  expect(second.skipReason).toBe("duplicate-content");
  expect(second.statusCode).toBe(200);
  expect(second.contentType).toBe("text/html; charset=utf-8");
  expect(second.byteLength).toBe(Buffer.byteLength(shared));
  expect(second.attempts).toBe(1);
  expect(second.finalUrl).toBe("https://example.com/b");
  expect(child.discoveredFrom).toBe("https://example.com/a");
  expect(crawlResult.pages.filter((page) => page.canonicalUrl.endsWith("/child"))).toHaveLength(1);
  expect(http.requested).toEqual([
    "https://example.com/",
    "https://example.com/a",
    "https://example.com/b",
    "https://example.com/child",
  ]);
});

test("an empty body has a hash, and a different body does not share it", async () => {
  const { result } = crawlSite({
    "/": htmlResponse('<a href="/a"></a><a href="/b"></a><a href="/c"></a>'),
    "/a": htmlResponse(""),
    "/b": htmlResponse(""),
    "/c": htmlResponse("<p>c</p>"),
  });
  const crawlResult = await result;

  expect(pageAt(crawlResult, "/a").state).toBe("ok");
  expect(pageAt(crawlResult, "/b").skipReason).toBe("duplicate-content");
  expect(pageAt(crawlResult, "/b").byteLength).toBe(0);
  expect(pageAt(crawlResult, "/c").state).toBe("ok");
});

test("a non-html body and a failed page do not enter the hash set", async () => {
  const { result } = crawlSite({
    "/": htmlResponse('<a href="/notes.txt"></a><a href="/gone"></a><a href="/page"></a><a href="/page2"></a>'),
    "/notes.txt": htmlResponse("<p>same</p>", "text/plain"),
    "/gone": { statusCode: 500, contentType: "text/html", body: "<p>same</p>" },
    "/page": htmlResponse("<p>same</p>"),
    "/page2": htmlResponse("<p>same</p>"),
  });
  const crawlResult = await result;

  expect(pageAt(crawlResult, "/notes.txt").skipReason).toBe("non-html");
  expect(pageAt(crawlResult, "/gone").errorKind).toBe("http-status");
  expect(pageAt(crawlResult, "/page").state).toBe("ok");
  expect(pageAt(crawlResult, "/page2").skipReason).toBe("duplicate-content");
});

test("a parse failure does not enter the hash set", async () => {
  const { result } = crawlSite({
    "/": htmlResponse('<a href="/bad"></a><a href="/bad2"></a><a href="/ok"></a>'),
    "/bad": htmlResponse("THROW"),
    "/bad2": htmlResponse("THROW"),
    "/ok": htmlResponse("<p>ok</p>"),
  });
  const crawlResult = await result;

  expect(pageAt(crawlResult, "/bad").errorKind).toBe("parse");
  expect(pageAt(crawlResult, "/bad2").errorKind).toBe("parse");
  expect(pageAt(crawlResult, "/bad").skipReason).toBeNull();
  expect(pageAt(crawlResult, "/bad2").skipReason).toBeNull();
  expect(pageAt(crawlResult, "/ok").state).toBe("ok");
});

test("--no-dedupe-content leaves both copies ok and still reserves the link", async () => {
  const { result } = crawlSite(
    {
      "/": htmlResponse('<a href="/a"></a><a href="/b"></a>'),
      "/a": htmlResponse(shared),
      "/b": htmlResponse(shared),
      "/child": htmlResponse("<p>child</p>"),
    },
    { dedupeContent: false }
  );
  const crawlResult = await result;

  expect(pageAt(crawlResult, "/a").state).toBe("ok");
  expect(pageAt(crawlResult, "/b").state).toBe("ok");
  expect(pageAt(crawlResult, "/child").discoveredFrom).toBe("https://example.com/a");
});
