const { crawl } = require("../src/crawler/crawl");
const { createFixtureServer } = require("./fixtures/server");

function html(body) {
  return (_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(body);
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

test("the first reserved spelling is fetched, not the canonical path", async () => {
  await withServer(
    {
      "/": html('<a href="/a/"></a><a href="/a"></a>'),
      "/a/": html("<html></html>"),
      "/a": html("<html></html>"),
    },
    async (server) => {
      await crawl({
        startUrl: `${server.origin}/`,
        maxDepth: 1,
        maxPages: 10,
        concurrency: 1,
        minIntervalMs: 0,
      });
      const spellings = server.requests
        .map((request) => request.path)
        .filter((path) => path === "/a/" || path === "/a");
      expect(spellings).toEqual(["/a/"]);
    }
  );
});

test("the reserved query spelling keeps percent-encoding", async () => {
  await withServer(
    {
      "/": html('<a href="/search?q=b%20a"></a>'),
      "/search": html("<html></html>"),
    },
    async (server) => {
      await crawl({
        startUrl: `${server.origin}/`,
        maxDepth: 1,
        maxPages: 10,
        concurrency: 1,
        minIntervalMs: 0,
      });
      const requested = server.requests.map((request) => request.path);
      expect(requested).toContain("/search?q=b%20a");
      expect(requested).not.toContain("/search?q=b+a");
    }
  );
});

test("a discovered link with userinfo is not requested and has no record", async () => {
  const authorizations = [];
  let secret = "";
  const server = createFixtureServer({
    routes: {
      "/": (req, res) => {
        authorizations.push(req.headers.authorization);
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(`<a href="${secret}"></a>`);
      },
      "/secret": (req, res) => {
        authorizations.push(req.headers.authorization);
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end("<html></html>");
      },
    },
  });
  await server.listen();
  secret = `http://user:pw@${new URL(server.origin).host}/secret`;

  try {
    const result = await crawl({
      startUrl: `${server.origin}/`,
      maxDepth: 1,
      maxPages: 10,
      concurrency: 1,
      minIntervalMs: 0,
    });
    expect(result.pages.map((page) => page.canonicalUrl)).toEqual([`${server.origin}/`]);
    expect(server.requests.map((request) => request.path)).not.toContain("/secret");
    expect(authorizations.some(Boolean)).toBe(false);
    expect(result.pages.some((page) => page.requestedUrl === secret)).toBe(false);
  } finally {
    await server.close();
  }
});

test("the first reserved spelling wins when /a comes first", async () => {
  await withServer(
    {
      "/": html('<a href="/a"></a><a href="/a/"></a>'),
      "/a": html("<html></html>"),
      "/a/": html("<html></html>"),
    },
    async (server) => {
      await crawl({
        startUrl: `${server.origin}/`,
        maxDepth: 1,
        maxPages: 10,
        concurrency: 1,
        minIntervalMs: 0,
      });
      const spellings = server.requests
        .map((request) => request.path)
        .filter((path) => path === "/a/" || path === "/a");
      expect(spellings).toEqual(["/a"]);
    }
  );
});
