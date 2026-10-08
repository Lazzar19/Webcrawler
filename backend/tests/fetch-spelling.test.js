const http = require("http");
const { test, expect } = require("@jest/globals");

// Milestone 1 checkpoint. These tests describe the fetch spelling and the
// discovered-userinfo rule. crawl() is not the production crawler. Each
// test is test.failing until that crawler exists. Do not point them at the
// current recursive crawlPage. That function locks a different contract.

async function crawl() {
  throw new Error(
    "NOT-IMPLEMENTED: fetch spelling waits for the Milestone 1 crawler."
  );
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test.failing("the first reserved spelling is fetched, not the canonical path", async () => {
  const requested = [];
  const server = await listen((req, res) => {
    requested.push(req.url);
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url === "/") {
      res.end('<a href="/a/"></a><a href="/a"></a>');
      return;
    }
    res.end("<html></html>");
  });

  try {
    const { port } = server.address();
    await crawl({
      startUrl: `http://127.0.0.1:${port}/`,
      maxDepth: 1,
      maxPages: 10,
      concurrency: 1,
      minIntervalMs: 0,
    });
    const spellings = requested.filter((url) => url === "/a/" || url === "/a");
    expect(spellings).toEqual(["/a/"]);
  } finally {
    await close(server);
  }
});

test.failing("the reserved query spelling keeps percent-encoding", async () => {
  const requested = [];
  const server = await listen((req, res) => {
    requested.push(req.url);
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url === "/") {
      res.end('<a href="/search?q=b%20a"></a>');
      return;
    }
    res.end("<html></html>");
  });

  try {
    const { port } = server.address();
    await crawl({
      startUrl: `http://127.0.0.1:${port}/`,
      maxDepth: 1,
      maxPages: 10,
      concurrency: 1,
      minIntervalMs: 0,
    });
    expect(requested).toContain("/search?q=b%20a");
    expect(requested).not.toContain("/search?q=b+a");
  } finally {
    await close(server);
  }
});

test.failing("a discovered link with userinfo is not requested and has no record", async () => {
  const requested = [];
  let secret = "";
  const server = await listen((req, res) => {
    requested.push({ url: req.url, authorization: req.headers.authorization });
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url === "/") {
      res.end(`<a href="${secret}"></a>`);
      return;
    }
    res.end("<html></html>");
  });

  const { port } = server.address();
  secret = `http://user:pw@127.0.0.1:${port}/secret`;

  try {
    const result = await crawl({
      startUrl: `http://127.0.0.1:${port}/`,
      maxDepth: 1,
      maxPages: 10,
      concurrency: 1,
      minIntervalMs: 0,
    });
    expect(result.pages.map((page) => page.canonicalUrl)).toEqual([`http://127.0.0.1:${port}/`]);
    expect(requested.map((entry) => entry.url)).not.toContain("/secret");
    expect(requested.some((entry) => entry.authorization)).toBe(false);
    expect(result.pages.some((page) => page.requestedUrl === secret)).toBe(false);
  } finally {
    await close(server);
  }
});

test.failing("the first reserved spelling wins when /a comes first", async () => {
  const requested = [];
  const server = await listen((req, res) => {
    requested.push(req.url);
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url === "/") {
      res.end('<a href="/a"></a><a href="/a/"></a>');
      return;
    }
    res.end("<html></html>");
  });

  try {
    const { port } = server.address();
    await crawl({
      startUrl: `http://127.0.0.1:${port}/`,
      maxDepth: 1,
      maxPages: 10,
      concurrency: 1,
      minIntervalMs: 0,
    });
    const spellings = requested.filter((url) => url === "/a/" || url === "/a");
    expect(spellings).toEqual(["/a"]);
  } finally {
    await close(server);
  }
});
