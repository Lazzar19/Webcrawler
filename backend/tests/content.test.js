jest.mock("../src/crawler/url-policy", () => {
  const actual = jest.requireActual("../src/crawler/url-policy");
  return {
    ...actual,
    readHtml(html, pageUrl, logger) {
      if (html === "THROW") {
        throw new Error("parse failed");
      }
      return actual.readHtml(html, pageUrl, logger);
    },
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
      const route = routes[path] ?? htmlResponse("");
      const page = typeof route === "function" ? await route() : route;
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

function crawlSite(routes, config, dependencies = {}) {
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
    { httpClient: http, ...dependencies }
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

const aliasBody = '<link rel="canonical" href="/target"><a href="/own"></a>';

test("a declared canonical is reserved at the same depth and the page links are not", async () => {
  const discovered = [];
  const { http, result } = crawlSite(
    {
      "/": htmlResponse('<a href="/alias"></a>'),
      "/alias": htmlResponse(aliasBody),
      "/target": htmlResponse("<p>target</p>"),
      "/own": htmlResponse("<p>own</p>"),
    },
    { maxDepth: 1 },
    {
      trace(event, fields) {
        if (event === "links") {
          discovered.push(fields.discovered);
        }
      },
    }
  );
  const crawlResult = await result;
  const alias = pageAt(crawlResult, "/alias");
  const target = pageAt(crawlResult, "/target");

  expect(alias.state).toBe("skipped");
  expect(alias.skipReason).toBe("canonical");
  expect(alias.statusCode).toBe(200);
  expect(alias.contentType).toBe("text/html; charset=utf-8");
  expect(alias.byteLength).toBe(Buffer.byteLength(aliasBody));
  expect(alias.attempts).toBe(1);
  expect(alias.finalUrl).toBe("https://example.com/alias");
  expect(target.state).toBe("ok");
  expect(target.depth).toBe(1);
  expect(target.discoveredFrom).toBe("https://example.com/alias");
  expect(crawlResult.pages.some((page) => page.canonicalUrl.endsWith("/own"))).toBe(false);
  expect(http.requested).toEqual([
    "https://example.com/",
    "https://example.com/alias",
    "https://example.com/target",
  ]);
  expect(discovered).toEqual([1, 1, 0]);
});

test("an unusable canonical href leaves the page and its links alone", async () => {
  const bodies = [
    '<link rel="canonical" href="http://["><a href="/kept"></a>',
    '<link rel="canonical" href="https://user:pw@example.com/secret"><a href="/kept"></a>',
    '<link rel="canonical" href="https://other.example/x"><a href="/kept"></a>',
    '<link rel="canonical" href="/alias#section"><a href="/kept"></a>',
    '<link rel="canonical"><link rel="canonical" href="/second"><a href="/kept"></a>',
    '<link rel="canonical-not" href="/nope"><a href="/kept"></a>',
    '<a rel="canonical" href="/kept"></a>',
  ];

  for (const body of bodies) {
    const { result } = crawlSite({
      "/alias": htmlResponse(body),
      "/kept": htmlResponse("<p>kept</p>"),
      "/": htmlResponse('<a href="/alias"></a>'),
    });
    const crawlResult = await result;
    expect(pageAt(crawlResult, "/alias").state).toBe("ok");
    expect(pageAt(crawlResult, "/kept").discoveredFrom).toBe("https://example.com/alias");
    expect(crawlResult.pages.some((page) => page.skipReason === "canonical")).toBe(false);
    expect(crawlResult.pages.some((page) => page.canonicalUrl.includes("other.example"))).toBe(false);
    expect(crawlResult.pages.some((page) => page.canonicalUrl.includes("/secret"))).toBe(false);
    expect(crawlResult.pages.some((page) => page.canonicalUrl.endsWith("/second"))).toBe(false);
    expect(crawlResult.pages.some((page) => page.canonicalUrl.endsWith("/nope"))).toBe(false);
  }
});

test("the first canonical token wins, and a base href resolves it", async () => {
  const { result } = crawlSite({
    "/": htmlResponse(
      '<base href="/docs/"><link rel="author Canonical" href="a#x"><link rel="canonical" href="/second"><a href="b"></a>'
    ),
    "/docs/a": htmlResponse("<p>a</p>"),
    "/second": htmlResponse("<p>second</p>"),
    "/docs/b": htmlResponse("<p>b</p>"),
  });
  const crawlResult = await result;

  expect(pageAt(crawlResult, "/").skipReason).toBe("canonical");
  expect(pageAt(crawlResult, "/docs/a").discoveredFrom).toBe("https://example.com/");
  expect(pageAt(crawlResult, "/docs/a").depth).toBe(0);
  expect(crawlResult.pages.some((page) => page.canonicalUrl.endsWith("/second"))).toBe(false);
  expect(crawlResult.pages.some((page) => page.canonicalUrl.endsWith("/docs/b"))).toBe(false);
});

test("a canonical target still faces traps and maxPages", async () => {
  const trapped = await crawlSite(
    {
      "/": htmlResponse('<link rel="canonical" href="/a/b"><a href="/own"></a>'),
      "/a/b": htmlResponse("<p>deep</p>"),
    },
    { maxPathDepth: 1 }
  );
  const trapResult = await trapped.result;
  expect(pageAt(trapResult, "/").skipReason).toBe("canonical");
  expect(pageAt(trapResult, "/a/b").skipReason).toBe("path-depth");
  expect(trapped.http.requested).toEqual(["https://example.com/"]);

  const capped = await crawlSite(
    {
      "/": htmlResponse('<a href="/alias"></a>'),
      "/alias": htmlResponse(aliasBody),
    },
    { maxPages: 2 }
  );
  const capResult = await capped.result;
  expect(pageAt(capResult, "/alias").skipReason).toBe("canonical");
  expect(pageAt(capResult, "/target").skipReason).toBe("page-limit");
  expect(capResult.pages.some((page) => page.canonicalUrl.endsWith("/own"))).toBe(false);
});

test("a canonical key that is already seen is not reserved again", async () => {
  const { http, result } = crawlSite({
    "/": htmlResponse('<a href="/alias"></a>'),
    "/alias": htmlResponse('<link rel="canonical" href="/"><a href="/other"></a>'),
  });
  const crawlResult = await result;

  expect(pageAt(crawlResult, "/alias").skipReason).toBe("canonical");
  expect(crawlResult.pages.filter((page) => page.canonicalUrl === "https://example.com/")).toHaveLength(1);
  expect(crawlResult.pages.some((page) => page.canonicalUrl.endsWith("/other"))).toBe(false);
  expect(http.requested).toEqual(["https://example.com/", "https://example.com/alias"]);
});

test("duplicate-content wins over a canonical tag on the later copy", async () => {
  const body = '<link rel="canonical" href="/canon"><a href="/own"></a>';
  const { result } = crawlSite({
    "/": htmlResponse('<a href="/a"></a><a href="/b"></a>'),
    "/a": htmlResponse(body),
    "/b": htmlResponse(body),
    "/canon": htmlResponse("<p>canon</p>"),
    "/own": htmlResponse("<p>own</p>"),
  });
  const crawlResult = await result;

  expect(pageAt(crawlResult, "/a").skipReason).toBe("canonical");
  expect(pageAt(crawlResult, "/b").skipReason).toBe("duplicate-content");
  expect(pageAt(crawlResult, "/canon").discoveredFrom).toBe("https://example.com/a");
  expect(crawlResult.pages.filter((page) => page.canonicalUrl.endsWith("/canon"))).toHaveLength(1);
  expect(crawlResult.pages.some((page) => page.canonicalUrl.endsWith("/own"))).toBe(false);
});

test("--no-canonical reserves the page links and does not discover the target", async () => {
  const { result } = crawlSite(
    {
      "/": htmlResponse('<a href="/alias"></a>'),
      "/alias": htmlResponse(aliasBody),
      "/target": htmlResponse("<p>target</p>"),
      "/own": htmlResponse("<p>own</p>"),
    },
    { respectCanonical: false }
  );
  const crawlResult = await result;

  expect(pageAt(crawlResult, "/alias").state).toBe("ok");
  expect(pageAt(crawlResult, "/own").discoveredFrom).toBe("https://example.com/alias");
  expect(crawlResult.pages.some((page) => page.canonicalUrl.endsWith("/target"))).toBe(false);
});

test("dedupe off still skips every copy that declares a canonical", async () => {
  const body = '<link rel="canonical" href="/canon"><a href="/own"></a>';
  const { result } = crawlSite(
    {
      "/": htmlResponse('<a href="/a"></a><a href="/b"></a>'),
      "/a": htmlResponse(body),
      "/b": htmlResponse(body),
      "/canon": htmlResponse("<p>canon</p>"),
    },
    { dedupeContent: false }
  );
  const crawlResult = await result;

  expect(pageAt(crawlResult, "/a").skipReason).toBe("canonical");
  expect(pageAt(crawlResult, "/b").skipReason).toBe("canonical");
  expect(pageAt(crawlResult, "/canon").discoveredFrom).toBe("https://example.com/a");
  expect(crawlResult.pages.filter((page) => page.canonicalUrl.endsWith("/canon"))).toHaveLength(1);
});

test("the earlier commit owns the hash when a later copy finishes first", async () => {
  let releaseA;
  const holdA = new Promise((resolve) => {
    releaseA = resolve;
  });
  const finished = [];
  const { result } = crawlSite(
    {
      "/": htmlResponse('<a href="/a"></a><a href="/b"></a>'),
      "/a": async () => {
        await holdA;
        finished.push("/a");
        return htmlResponse(shared);
      },
      "/b": async () => {
        finished.push("/b");
        return htmlResponse(shared);
      },
      "/child": htmlResponse("<p>child</p>"),
    },
    { concurrency: 2 }
  );

  await new Promise((resolve) => setImmediate(resolve));
  expect(finished).toEqual(["/b"]);
  releaseA();
  const crawlResult = await result;

  expect(finished).toEqual(["/b", "/a"]);
  expect(pageAt(crawlResult, "/a").state).toBe("ok");
  expect(pageAt(crawlResult, "/b").skipReason).toBe("duplicate-content");
  expect(pageAt(crawlResult, "/child").discoveredFrom).toBe("https://example.com/a");
});

test("a stop reserves no canonical target", async () => {
  const controller = new AbortController();
  const { result } = crawlSite(
    {
      "/": htmlResponse('<a href="/alias"></a>'),
      "/alias": () => {
        controller.abort();
        return htmlResponse(aliasBody);
      },
      "/target": htmlResponse("<p>target</p>"),
    },
    {},
    { signal: controller.signal }
  );
  const crawlResult = await result;

  expect(crawlResult.stopReason).toBe("interrupted");
  expect(pageAt(crawlResult, "/alias").skipReason).toBe("canonical");
  expect(crawlResult.pages.some((page) => page.canonicalUrl.endsWith("/target"))).toBe(false);
  expect(crawlResult.pages.some((page) => page.canonicalUrl.endsWith("/own"))).toBe(false);
});
