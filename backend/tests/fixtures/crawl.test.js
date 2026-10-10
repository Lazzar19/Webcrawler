const { crawl } = require("../../src/crawler/crawl");
const { DEFAULTS } = require("../../src/crawler/crawl-config");
const { createFixtureServer } = require("./server");

const clock = { now: () => 1_700_000_000_000 };

function html(body) {
  return (_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  };
}

function redirect(statusCode, location) {
  return (_req, res) => {
    res.writeHead(statusCode, { location });
    res.end();
  };
}

function text(body, statusCode = 200, headers = {}) {
  return (_req, res) => {
    res.writeHead(statusCode, { "content-type": "text/plain", ...headers });
    res.end(body);
  };
}

function steppingClock() {
  let time = 0;
  return {
    now: () => time,
    sleep(ms) {
      time += ms;
      return Promise.resolve();
    },
  };
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(predicate) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 2000) {
      throw new Error("timed out waiting for the crawl to reach the expected state");
    }
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
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

function crawlOrigin(server, config) {
  return crawl(
    {
      startUrl: `${server.origin}/`,
      minIntervalMs: 0,
      ...config,
    },
    { clock }
  );
}

function paths(server) {
  return server.requests.map((request) => request.path);
}

function outline(pages) {
  return pages.map((page) => ({
    canonicalUrl: page.canonicalUrl,
    discoveredFrom: page.discoveredFrom,
    depth: page.depth,
    state: page.state,
    skipReason: page.skipReason,
    errorKind: page.errorKind,
  }));
}

function portable(result) {
  const origin = new URL(result.startUrl).origin;
  const rewrite = (value) => (typeof value === "string" ? value.replace(origin, "http://origin") : value);
  return result.pages.map((page) => ({
    ...page,
    canonicalUrl: rewrite(page.canonicalUrl),
    requestedUrl: rewrite(page.requestedUrl),
    finalUrl: rewrite(page.finalUrl),
    discoveredFrom: rewrite(page.discoveredFrom),
  }));
}

describe("fixture crawl", () => {
  test("depth 0 fetches only the start URL", async () => {
    await withServer(
      {
        "/": html('<a href="/a"></a>'),
        "/a": html('<a href="/b"></a>'),
        "/b": html(""),
      },
      async (server) => {
        const result = await crawlOrigin(server, { maxDepth: 0, maxPages: 10, concurrency: 1 });
        expect(paths(server)).toEqual(["/robots.txt", "/"]);
        expect(server.requests.map((request) => request.userAgent)).toEqual([
          DEFAULTS.userAgent,
          DEFAULTS.userAgent,
        ]);
        expect(outline(result.pages)).toEqual([
          {
            canonicalUrl: `${server.origin}/`,
            discoveredFrom: null,
            depth: 0,
            state: "ok",
            skipReason: null,
            errorKind: null,
          },
          {
            canonicalUrl: `${server.origin}/a`,
            discoveredFrom: `${server.origin}/`,
            depth: 1,
            state: "skipped",
            skipReason: "depth-limit",
            errorKind: null,
          },
        ]);
      }
    );
  });

  test("depth 1 fetches the child and records the grandchild as depth-limit", async () => {
    await withServer(
      {
        "/": html('<a href="/a"></a>'),
        "/a": html('<a href="/b"></a>'),
        "/b": html(""),
      },
      async (server) => {
        const result = await crawlOrigin(server, { maxDepth: 1, maxPages: 10, concurrency: 1 });
        expect(paths(server)).toEqual(["/robots.txt", "/", "/a"]);
        expect(outline(result.pages)).toEqual([
          {
            canonicalUrl: `${server.origin}/`,
            discoveredFrom: null,
            depth: 0,
            state: "ok",
            skipReason: null,
            errorKind: null,
          },
          {
            canonicalUrl: `${server.origin}/a`,
            discoveredFrom: `${server.origin}/`,
            depth: 1,
            state: "ok",
            skipReason: null,
            errorKind: null,
          },
          {
            canonicalUrl: `${server.origin}/b`,
            discoveredFrom: `${server.origin}/a`,
            depth: 2,
            state: "skipped",
            skipReason: "depth-limit",
            errorKind: null,
          },
        ]);
      }
    );
  });

  test("depth 2 fetches the grandchild", async () => {
    await withServer(
      {
        "/": html('<a href="/a"></a>'),
        "/a": html('<a href="/b"></a>'),
        "/b": html(""),
      },
      async (server) => {
        const result = await crawlOrigin(server, { maxDepth: 2, maxPages: 10, concurrency: 1 });
        expect(paths(server)).toEqual(["/robots.txt", "/", "/a", "/b"]);
        expect(result.pages.map((page) => page.state)).toEqual(["ok", "ok", "ok"]);
        expect(result.pages.map((page) => page.depth)).toEqual([0, 1, 2]);
      }
    );
  });

  test("the page limit leaves a skipped page-limit record", async () => {
    await withServer(
      {
        "/": html('<a href="/a"></a><a href="/b"></a>'),
        "/a": html(""),
        "/b": html(""),
      },
      async (server) => {
        const result = await crawlOrigin(server, { maxDepth: 2, maxPages: 2, concurrency: 1 });
        expect(paths(server)).toEqual(["/robots.txt", "/", "/a"]);
        expect(result.counts.reserved).toBe(2);
        expect(outline(result.pages)).toEqual([
          {
            canonicalUrl: `${server.origin}/`,
            discoveredFrom: null,
            depth: 0,
            state: "ok",
            skipReason: null,
            errorKind: null,
          },
          {
            canonicalUrl: `${server.origin}/a`,
            discoveredFrom: `${server.origin}/`,
            depth: 1,
            state: "ok",
            skipReason: null,
            errorKind: null,
          },
          {
            canonicalUrl: `${server.origin}/b`,
            discoveredFrom: `${server.origin}/`,
            depth: 1,
            state: "skipped",
            skipReason: "page-limit",
            errorKind: null,
          },
        ]);
      }
    );
  });

  test("a cycle and a repeated link create one record per key", async () => {
    await withServer(
      {
        "/": html('<a href="/a"></a><a href="/a"></a>'),
        "/a": html('<a href="/"></a><a href="/a"></a>'),
      },
      async (server) => {
        const result = await crawlOrigin(server, { maxDepth: 2, maxPages: 10, concurrency: 1 });
        expect(paths(server)).toEqual(["/robots.txt", "/", "/a"]);
        expect(outline(result.pages)).toEqual([
          {
            canonicalUrl: `${server.origin}/`,
            discoveredFrom: null,
            depth: 0,
            state: "ok",
            skipReason: null,
            errorKind: null,
          },
          {
            canonicalUrl: `${server.origin}/a`,
            discoveredFrom: `${server.origin}/`,
            depth: 1,
            state: "ok",
            skipReason: null,
            errorKind: null,
          },
        ]);
      }
    );
  });

  test("concurrency 1 and 5 produce the same pages when responses have different delays", async () => {
    const routes = {
      "/": html('<a href="/c"></a><a href="/b"></a>'),
      "/b": async (_req, res) => {
        await delay(500);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end('<a href="/x"></a><a href="/y"></a>');
      },
      "/c": async (_req, res) => {
        await delay(10);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end('<a href="/x"></a><a href="/z"></a>');
      },
      "/x": html(""),
      "/y": html(""),
      "/z": html(""),
    };

    const slow = await withServer(routes, (server) =>
      crawlOrigin(server, { maxDepth: 2, maxPages: 4, concurrency: 1 })
    );
    const fast = await withServer(routes, (server) =>
      crawlOrigin(server, { maxDepth: 2, maxPages: 4, concurrency: 5 })
    );

    const origin = "http://origin";
    expect(portable(fast)).toEqual(portable(slow));
    expect(outline(portable(slow))).toEqual([
      {
        canonicalUrl: `${origin}/`,
        discoveredFrom: null,
        depth: 0,
        state: "ok",
        skipReason: null,
        errorKind: null,
      },
      {
        canonicalUrl: `${origin}/b`,
        discoveredFrom: `${origin}/`,
        depth: 1,
        state: "ok",
        skipReason: null,
        errorKind: null,
      },
      {
        canonicalUrl: `${origin}/c`,
        discoveredFrom: `${origin}/`,
        depth: 1,
        state: "ok",
        skipReason: null,
        errorKind: null,
      },
      {
        canonicalUrl: `${origin}/x`,
        discoveredFrom: `${origin}/b`,
        depth: 2,
        state: "ok",
        skipReason: null,
        errorKind: null,
      },
      {
        canonicalUrl: `${origin}/y`,
        discoveredFrom: `${origin}/b`,
        depth: 2,
        state: "skipped",
        skipReason: "page-limit",
        errorKind: null,
      },
      {
        canonicalUrl: `${origin}/z`,
        discoveredFrom: `${origin}/c`,
        depth: 2,
        state: "skipped",
        skipReason: "page-limit",
        errorKind: null,
      },
    ]);
  });

  test("a redirect alias does not consume a page slot", async () => {
    await withServer(
      {
        "/": redirect(302, "/target"),
        "/target": html('<a href="/extra"></a>'),
        "/extra": html(""),
      },
      async (server) => {
        const result = await crawlOrigin(server, { maxDepth: 2, maxPages: 1, concurrency: 1 });
        expect(paths(server)).toEqual(["/robots.txt", "/", "/target"]);
        expect(result.counts.reserved).toBe(1);
        expect(result.pages[0].state).toBe("ok");
        expect(result.pages[0].finalUrl).toBe(`${server.origin}/target`);
        expect(result.pages[1].skipReason).toBe("page-limit");
      }
    );
  });

  test("a redirect onto an already reserved key is duplicate and is not requested", async () => {
    await withServer(
      {
        "/": html('<a href="/a"></a>'),
        "/a": redirect(302, "/"),
      },
      async (server) => {
        const result = await crawlOrigin(server, { maxDepth: 2, maxPages: 10, concurrency: 1 });
        expect(paths(server)).toEqual(["/robots.txt", "/", "/a"]);
        expect(result.pages.find((page) => page.canonicalUrl === `${server.origin}/a`).skipReason).toBe(
          "duplicate"
        );
      }
    );
  });

  test("an off-origin redirect is not requested", async () => {
    const other = createFixtureServer({
      routes: {
        "/gone": html("no"),
      },
    });
    await other.listen();
    try {
      await withServer(
        {
          "/": redirect(302, `${other.origin}/gone`),
        },
        async (server) => {
          const result = await crawlOrigin(server, { maxDepth: 2, maxPages: 10, concurrency: 1 });
          expect(paths(server)).toEqual(["/robots.txt", "/"]);
          expect(other.requests).toEqual([]);
          expect(result.pages[0].skipReason).toBe("redirect-off-origin");
        }
      );
    } finally {
      await other.close();
    }
  });

  test("a redirect loop fails without another request", async () => {
    await withServer(
      {
        "/": redirect(302, "/again"),
        "/again": redirect(302, "/"),
      },
      async (server) => {
        const result = await crawlOrigin(server, { maxDepth: 2, maxPages: 10, concurrency: 1 });
        expect(paths(server)).toEqual(["/robots.txt", "/", "/again"]);
        expect(result.pages[0].state).toBe("failed");
        expect(result.pages[0].errorKind).toBe("redirect-loop");
      }
    );
  });

  test("a redirect with no Location is bad-redirect and stops", async () => {
    await withServer(
      {
        "/": (_req, res) => {
          res.writeHead(302);
          res.end();
        },
        "/next": html("no"),
      },
      async (server) => {
        const result = await crawlOrigin(server, { maxDepth: 2, maxPages: 10, concurrency: 1 });
        expect(paths(server)).toEqual(["/robots.txt", "/"]);
        expect(result.pages[0].state).toBe("failed");
        expect(result.pages[0].errorKind).toBe("bad-redirect");
      }
    );
  });

  test("a redirect Location that does not parse is bad-redirect and is not requested", async () => {
    await withServer(
      {
        "/": redirect(302, "http://["),
      },
      async (server) => {
        const result = await crawlOrigin(server, { maxDepth: 2, maxPages: 10, concurrency: 1 });
        expect(paths(server)).toEqual(["/robots.txt", "/"]);
        expect(result.pages[0].state).toBe("failed");
        expect(result.pages[0].errorKind).toBe("bad-redirect");
      }
    );
  });

  test("a redirect Location with userinfo is bad-redirect and is not requested", async () => {
    let location = "";
    await withServer(
      {
        "/": (_req, res) => {
          res.writeHead(302, { location });
          res.end();
        },
        "/secret": html("no"),
      },
      async (server) => {
        location = `http://user:pw@${new URL(server.origin).host}/secret`;
        const result = await crawlOrigin(server, { maxDepth: 2, maxPages: 10, concurrency: 1 });
        expect(paths(server)).toEqual(["/robots.txt", "/"]);
        expect(result.pages[0].state).toBe("failed");
        expect(result.pages[0].errorKind).toBe("bad-redirect");
      }
    );
  });

  test("a redirect Location to ftp is redirect-off-origin and is not requested", async () => {
    await withServer(
      {
        "/": redirect(302, "ftp://files.example/a"),
      },
      async (server) => {
        const result = await crawlOrigin(server, { maxDepth: 2, maxPages: 10, concurrency: 1 });
        expect(paths(server)).toEqual(["/robots.txt", "/"]);
        expect(result.pages[0].state).toBe("skipped");
        expect(result.pages[0].skipReason).toBe("redirect-off-origin");
      }
    );
  });

  test("a sixth redirect hop is redirect-limit and is not requested", async () => {
    const routes = { "/6": html("no") };
    for (let hop = 0; hop <= 5; hop += 1) {
      const path = hop === 0 ? "/" : `/${hop}`;
      routes[path] = redirect(302, `/${hop + 1}`);
    }
    await withServer(routes, async (server) => {
      const result = await crawlOrigin(server, { maxDepth: 2, maxPages: 10, concurrency: 1 });
      expect(paths(server)).toEqual(["/robots.txt", "/", "/1", "/2", "/3", "/4", "/5"]);
      expect(result.pages[0].state).toBe("failed");
      expect(result.pages[0].errorKind).toBe("redirect-limit");
    });
  });

  test("a response that never finishes is a failed timeout page", async () => {
    await withServer(
      {
        "/": (_req, res) => {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.write("<html>");
        },
      },
      async (server) => {
        const result = await crawl(
          {
            startUrl: `${server.origin}/`,
            maxDepth: 0,
            maxPages: 1,
            concurrency: 1,
            minIntervalMs: 0,
            timeoutMs: 80,
          }
        );
        expect(result.pages).toHaveLength(1);
        expect(result.pages[0].state).toBe("failed");
        expect(result.pages[0].errorKind).toBe("timeout");
        expect(result.counts.failed).toBe(1);
      }
    );
  });

  test("a body over the byte limit is a failed too-large page", async () => {
    await withServer(
      {
        "/": (_req, res) => {
          const body = "x".repeat(1000);
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-length": String(body.length),
          });
          res.end(body);
        },
      },
      async (server) => {
        const result = await crawl(
          {
            startUrl: `${server.origin}/`,
            maxDepth: 0,
            maxPages: 1,
            concurrency: 1,
            minIntervalMs: 0,
            maxResponseBytes: 10,
          }
        );
        expect(result.pages[0].state).toBe("failed");
        expect(result.pages[0].errorKind).toBe("too-large");
      }
    );
  });

  test("two workers share one robots.txt fetch", async () => {
    await withServer(
      {
        "/": html('<a href="/a"></a>'),
        "/a": html("<html></html>"),
      },
      async (server) => {
        const result = await crawlOrigin(server, { maxDepth: 1, maxPages: 10, concurrency: 2 });
        expect(paths(server).filter((path) => path === "/robots.txt")).toEqual(["/robots.txt"]);
        expect(result.pages.every((page) => page.state === "ok")).toBe(true);
      }
    );
  });

  test("perOriginLimit 1 still completes when robots.txt is fetched", async () => {
    await withServer(
      {
        "/": html('<a href="/a"></a>'),
        "/a": html("<html></html>"),
      },
      async (server) => {
        const result = await crawlOrigin(server, {
          maxDepth: 1,
          maxPages: 10,
          concurrency: 2,
          perOriginLimit: 1,
        });
        expect(result.pages.map((page) => page.state)).toEqual(["ok", "ok"]);
        expect(paths(server)).toContain("/robots.txt");
      }
    );
  });

  test("a disallowed path is never requested", async () => {
    await withServer(
      {
        "/robots.txt": text("User-agent: *\nDisallow: /secret\n"),
        "/": html('<a href="/secret"></a>'),
        "/secret": html("no"),
      },
      async (server) => {
        const result = await crawlOrigin(server, { maxDepth: 1, maxPages: 10, concurrency: 1 });
        expect(paths(server)).toEqual(["/robots.txt", "/"]);
        expect(result.pages.map((page) => page.skipReason)).toEqual([null, "robots"]);
      }
    );
  });

  test("a redirect into a disallowed path is never requested", async () => {
    await withServer(
      {
        "/robots.txt": text("User-agent: *\nDisallow: /secret\n"),
        "/": redirect(302, "/secret"),
        "/secret": html("no"),
      },
      async (server) => {
        const result = await crawlOrigin(server, { maxDepth: 1, maxPages: 10, concurrency: 1 });
        expect(paths(server)).toEqual(["/robots.txt", "/"]);
        expect(result.pages[0].skipReason).toBe("robots");
      }
    );
  });

  test("a missing robots.txt allows the origin", async () => {
    await withServer(
      {
        "/": html("<html></html>"),
      },
      async (server) => {
        const result = await crawlOrigin(server, { maxDepth: 0, maxPages: 1, concurrency: 1 });
        expect(paths(server)).toEqual(["/robots.txt", "/"]);
        expect(result.pages[0].state).toBe("ok");
        expect(result.robots).toEqual([
          {
            origin: server.origin,
            statusCode: 404,
            outcome: "allow-all",
            errorKind: null,
          },
        ]);
      }
    );
  });

  test("robots.txt 500 after retries skips the origin", async () => {
    await withServer(
      {
        "/robots.txt": text("no", 500),
        "/": html("<html></html>"),
      },
      async (server) => {
        const result = await crawlOrigin(server, {
          maxDepth: 0,
          maxPages: 1,
          concurrency: 1,
          retryCount: 2,
          retryBaseDelayMs: 0,
        });
        expect(paths(server)).toEqual(["/robots.txt", "/robots.txt", "/robots.txt"]);
        expect(result.pages[0].skipReason).toBe("robots-unavailable");
        expect(result.pages[0].attempts).toBe(0);
        expect(result.robots[0]).toMatchObject({
          outcome: "unavailable",
          errorKind: "http-status",
          statusCode: 500,
        });
      }
    );
  });

  test("503 succeeds on retry", async () => {
    let hits = 0;
    await withServer(
      {
        "/": (_req, res) => {
          hits += 1;
          if (hits === 1) {
            res.writeHead(503);
            res.end("busy");
            return;
          }
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end("<html></html>");
        },
      },
      async (server) => {
        const result = await crawlOrigin(server, {
          maxDepth: 0,
          maxPages: 1,
          concurrency: 1,
          retryCount: 1,
          retryBaseDelayMs: 0,
        });
        expect(result.pages[0].state).toBe("ok");
        expect(result.pages[0].attempts).toBe(2);
        expect(paths(server).filter((path) => path === "/")).toEqual(["/", "/"]);
      }
    );
  });

  test("Retry-After raises the wait, and a value above 5000 ms is not retried", async () => {
    const retryClock = steppingClock();
    let hits = 0;
    const server = createFixtureServer({
      clock: retryClock,
      routes: {
        "/": (_req, res) => {
          hits += 1;
          if (hits === 1) {
            res.writeHead(429, { "retry-after": "1" });
            res.end("later");
            return;
          }
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end("<html></html>");
        },
      },
    });
    await server.listen();
    try {
      const result = await crawl(
        {
          startUrl: `${server.origin}/`,
          maxDepth: 0,
          maxPages: 1,
          concurrency: 1,
          minIntervalMs: 0,
          retryCount: 1,
          retryBaseDelayMs: 0,
        },
        { clock: retryClock }
      );
      const pageStarts = server.requests.filter((request) => request.path === "/").map((request) => request.startedAt);
      expect(pageStarts).toEqual([0, 1000]);
      expect(result.pages[0].state).toBe("ok");
    } finally {
      await server.close();
    }

    const blocked = steppingClock();
    const once = createFixtureServer({
      clock: blocked,
      routes: {
        "/": text("no", 429, { "retry-after": "6" }),
      },
    });
    await once.listen();
    try {
      const result = await crawl(
        {
          startUrl: `${once.origin}/`,
          maxDepth: 0,
          maxPages: 1,
          concurrency: 1,
          minIntervalMs: 0,
          retryCount: 2,
          retryBaseDelayMs: 0,
        },
        { clock: blocked }
      );
      expect(once.requests.filter((request) => request.path === "/")).toHaveLength(1);
      expect(result.pages[0].state).toBe("failed");
      expect(result.pages[0].errorKind).toBe("http-status");
      expect(blocked.now()).toBe(0);
    } finally {
      await once.close();
    }
  });

  test("same-origin peak concurrency stays within perOriginLimit", async () => {
    const child = async (_req, res) => {
      await delay(80);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html></html>");
    };
    await withServer(
      {
        "/": html('<a href="/a"></a><a href="/b"></a><a href="/c"></a><a href="/d"></a>'),
        "/a": child,
        "/b": child,
        "/c": child,
        "/d": child,
      },
      async (server) => {
        await crawlOrigin(server, {
          maxDepth: 1,
          maxPages: 10,
          concurrency: 4,
          perOriginLimit: 2,
        });
        expect(server.peakConcurrency).toBe(2);
      }
    );
  });

  test("consecutive request starts on one origin are at least minIntervalMs apart", async () => {
    const pace = steppingClock();
    const server = createFixtureServer({
      clock: pace,
      routes: {
        "/": html('<a href="/a"></a>'),
        "/a": html("<html></html>"),
      },
    });
    await server.listen();
    try {
      await crawl(
        {
          startUrl: `${server.origin}/`,
          maxDepth: 1,
          maxPages: 10,
          concurrency: 1,
          perOriginLimit: 1,
          minIntervalMs: 200,
        },
        { clock: pace }
      );
      const starts = server.requests.map((request) => request.startedAt);
      expect(server.requests.map((request) => request.path)).toEqual(["/robots.txt", "/", "/a"]);
      expect(starts).toEqual([0, 200, 400]);
    } finally {
      await server.close();
    }
  });

  test("respectRobots false fetches a disallowed path and ignores crawl-delay", async () => {
    const pace = steppingClock();
    const server = createFixtureServer({
      clock: pace,
      routes: {
        "/robots.txt": text("User-agent: *\nDisallow: /secret\nCrawl-delay: 30\n"),
        "/": html('<a href="/secret"></a>'),
        "/secret": html("<html></html>"),
      },
    });
    await server.listen();
    try {
      const result = await crawl(
        {
          startUrl: `${server.origin}/`,
          maxDepth: 1,
          maxPages: 10,
          concurrency: 1,
          minIntervalMs: 0,
          respectRobots: false,
        },
        { clock: pace }
      );
      expect(paths(server)).toEqual(["/", "/secret"]);
      expect(result.pages.every((page) => page.state === "ok")).toBe(true);
      expect(pace.now()).toBe(0);
      expect(result.robots).toEqual([
        {
          origin: server.origin,
          statusCode: null,
          outcome: "not-checked",
          errorKind: null,
        },
      ]);
    } finally {
      await server.close();
    }
  });

  test("a ten-link fan-out at depth 2 finishes with five workers", async () => {
    const routes = {};
    const linkList = (prefix) =>
      Array.from({ length: 10 }, (_value, index) => `<a href="${prefix}${index}"></a>`).join("");
    routes["/"] = html(linkList("/d1/"));
    for (let child = 0; child < 10; child += 1) {
      routes[`/d1/${child}`] = html(linkList(`/d2/${child}/`));
      for (let grandchild = 0; grandchild < 10; grandchild += 1) {
        routes[`/d2/${child}/${grandchild}`] = html(linkList(`/d3/${child}/${grandchild}/`));
      }
    }

    await withServer(routes, async (server) => {
      const result = await crawlOrigin(server, { maxDepth: 2, maxPages: 200, concurrency: 5 });
      expect(result.counts.reserved).toBe(111);
      expect(result.counts.ok).toBe(111);
      expect(result.counts.skipped).toBe(1000);
      expect(result.pages.filter((page) => page.skipReason === "depth-limit")).toHaveLength(1000);
      expect(server.requests).toHaveLength(112);
    });
  }, 20000);
});

test("an unclassified error rejects with that object after every worker returns", async () => {
  const boom = new Error("boom");
  let releaseSlow;
  const slowGate = new Promise((resolve) => {
    releaseSlow = resolve;
  });
  let boomSeen = false;
  let slowSeen = false;
  let slowFinished = false;

  function ok(url, body, options) {
    const read = options.wantBody({ statusCode: 200, contentType: "text/html" });
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
  }

  const httpClient = {
    async get(url, options) {
      await options.beforeAttempt();
      const path = new URL(url).pathname;
      if (path === "/robots.txt") {
        return ok(url, "", options);
      }
      if (path === "/") {
        return ok(url, '<a href="/boom"></a><a href="/slow"></a>', options);
      }
      if (path === "/boom") {
        boomSeen = true;
        throw boom;
      }
      if (path === "/slow") {
        slowSeen = true;
        await slowGate;
        slowFinished = true;
        return ok(url, "", options);
      }
      throw new Error(`unexpected ${path}`);
    },
  };

  let settled = false;
  const pending = crawl(
    {
      startUrl: "https://example.com/",
      maxDepth: 1,
      maxPages: 10,
      concurrency: 2,
      minIntervalMs: 0,
    },
    { httpClient, clock }
  ).finally(() => {
    settled = true;
  });

  await waitFor(() => boomSeen && slowSeen);
  expect(settled).toBe(false);
  expect(slowFinished).toBe(false);
  releaseSlow();
  await expect(pending).rejects.toBe(boom);
  expect(slowFinished).toBe(true);
});
