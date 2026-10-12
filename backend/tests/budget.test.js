const { crawl } = require("../src/crawler/crawl");
const { createFixtureServer } = require("./fixtures/server");

const frozen = {
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

async function withServer(routes, run) {
  const server = createFixtureServer({ routes });
  await server.listen();
  try {
    return await run(server);
  } finally {
    await server.close();
  }
}

function paths(server) {
  return server.requests.map((request) => request.path);
}

function pageAt(result, pathname) {
  return result.pages.find((page) => new URL(page.requestedUrl).pathname === pathname);
}

test("an omitted budget leaves the crawl completed", async () => {
  await withServer({
    "/": html("<html></html>"),
  }, async (server) => {
    const result = await crawl({
      startUrl: `${server.origin}/`,
      minIntervalMs: 0,
      concurrency: 1,
      maxDepth: 0,
      respectRobots: false,
    }, { clock: frozen });

    expect(result.stopReason).toBe("completed");
    expect(result.config.maxDurationMs).toBeNull();
    expect(result.config.maxTotalAttempts).toBeNull();
    expect(paths(server)).toEqual(["/"]);
  });
});

test("a duration cap refuses the next claim and keeps the response already earned", async () => {
  let time = 0;
  const clock = {
    now: () => time,
    sleep() {
      throw new Error("retry sleep should not run");
    },
  };

  await withServer({
    "/": (_req, res) => {
      time = 5;
      res.writeHead(500, { "content-type": "text/html" });
      res.end("no");
    },
  }, async (server) => {
    const result = await crawl({
      startUrl: `${server.origin}/`,
      minIntervalMs: 0,
      concurrency: 1,
      maxDepth: 0,
      respectRobots: false,
      retryCount: 1,
      maxDurationMs: 5,
    }, { clock });

    expect(result.stopReason).toBe("budget");
    expect(paths(server)).toEqual(["/"]);
    expect(result.pages[0].state).toBe("failed");
    expect(result.pages[0].errorKind).toBe("http-status");
    expect(result.pages[0].attempts).toBe(1);
  });
});

test("a refused page claim is not fatal-stop", async () => {
  await withServer({
    "/": html("<html></html>"),
    "/robots.txt": (_req, res) => {
      res.writeHead(404);
      res.end();
    },
  }, async (server) => {
    const result = await crawl({
      startUrl: `${server.origin}/`,
      minIntervalMs: 0,
      concurrency: 1,
      maxDepth: 0,
      maxTotalAttempts: 1,
    }, { clock: frozen });

    expect(result.stopReason).toBe("budget");
    expect(paths(server)).toEqual(["/robots.txt"]);
    expect(result.pages[0].state).toBe("skipped");
    expect(result.pages[0].skipReason).toBe("budget");
    expect(result.pages[0].attempts).toBe(0);
    expect(result.pages[0].waitedMs).toBeNull();
    expect(result.pages[0].finalUrl).toBeNull();
    expect(result.robots).toEqual([
      expect.objectContaining({ outcome: "allow-all", errorKind: null }),
    ]);
  });
});

test("a later SIGINT does not replace a budget stop", async () => {
  const signal = new AbortController();

  await withServer({
    "/": html("<html></html>"),
    "/robots.txt": (_req, res) => {
      res.writeHead(404);
      res.end();
    },
  }, async (server) => {
    const result = await crawl({
      startUrl: `${server.origin}/`,
      minIntervalMs: 0,
      concurrency: 1,
      maxDepth: 0,
      maxTotalAttempts: 1,
    }, {
      clock: frozen,
      signal: signal.signal,
      trace(event) {
        if (event === "commit") {
          signal.abort();
        }
      },
    });

    expect(result.stopReason).toBe("budget");
    expect(paths(server)).toEqual(["/robots.txt"]);
  });
});

test("a later budget refusal does not replace an interrupt", async () => {
  const signal = new AbortController();

  await withServer({
    "/": html("<html></html>"),
    "/robots.txt": (_req, res) => {
      signal.abort();
      res.writeHead(404);
      res.end();
    },
  }, async (server) => {
    const result = await crawl({
      startUrl: `${server.origin}/`,
      minIntervalMs: 0,
      concurrency: 1,
      maxDepth: 0,
      maxTotalAttempts: 1,
    }, { clock: frozen, signal: signal.signal });

    expect(result.stopReason).toBe("interrupted");
    expect(paths(server)).toEqual(["/robots.txt"]);
  });
});

test("a duration that is already past refuses robots.txt and does not mark it unavailable", async () => {
  let started = false;
  const clock = {
    now() {
      if (!started) {
        started = true;
        return 0;
      }
      return 1;
    },
    sleep() {
      return Promise.resolve();
    },
  };

  await withServer({
    "/": html("<html></html>"),
    "/robots.txt": (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nDisallow:\n");
    },
  }, async (server) => {
    const result = await crawl({
      startUrl: `${server.origin}/`,
      minIntervalMs: 0,
      concurrency: 1,
      maxDepth: 0,
      maxDurationMs: 1,
    }, { clock });

    expect(result.stopReason).toBe("budget");
    expect(paths(server)).toEqual([]);
    expect(result.pages[0].state).toBe("skipped");
    expect(result.pages[0].skipReason).toBe("budget");
    expect(result.pages[0].attempts).toBe(0);
    expect(result.pages[0].waitedMs).toBeNull();
    expect(result.robots).toEqual([]);
  });
});

test("a refused retry keeps the network failure already earned", async () => {
  let time = 0;
  let calls = 0;
  const result = await crawl({
    startUrl: "https://example.com/",
    minIntervalMs: 0,
    concurrency: 1,
    maxDepth: 0,
    respectRobots: false,
    retryCount: 1,
    maxDurationMs: 10,
  }, {
    clock: {
      now: () => time,
      sleep() {
        throw new Error("retry sleep should not run");
      },
    },
    fetchImpl() {
      calls += 1;
      time = 10;
      const error = new TypeError("fetch failed");
      error.cause = { code: "ECONNRESET" };
      throw error;
    },
  });

  expect(result.stopReason).toBe("budget");
  expect(calls).toBe(1);
  expect(result.pages[0].state).toBe("failed");
  expect(result.pages[0].errorKind).toBe("reset");
  expect(result.pages[0].attempts).toBe(1);
});

test("a refused redirect hop stays skipped for budget and keeps the last response", async () => {
  await withServer({
    "/": (_req, res) => {
      res.writeHead(302, { location: "/land" });
      res.end();
    },
    "/land": html("<html>land</html>"),
  }, async (server) => {
    const result = await crawl({
      startUrl: `${server.origin}/`,
      minIntervalMs: 0,
      concurrency: 1,
      maxDepth: 0,
      respectRobots: false,
      maxTotalAttempts: 1,
    }, { clock: frozen });

    expect(result.stopReason).toBe("budget");
    expect(paths(server)).toEqual(["/"]);
    expect(result.pages[0].state).toBe("skipped");
    expect(result.pages[0].skipReason).toBe("budget");
    expect(result.pages[0].statusCode).toBe(302);
    expect(result.pages[0].attempts).toBe(1);
    expect(result.pages[0].finalUrl).toBe(`${server.origin}/`);
  });
});

test("one started attempt finishes after the duration cap, and the next claim stops", async () => {
  let time = 0;
  const clock = {
    now: () => time,
    sleep() {
      return Promise.resolve();
    },
  };

  await withServer({
    "/": (_req, res) => {
      time = 50;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end('<a href="/next"></a>');
    },
    "/next": html("<html>next</html>"),
  }, async (server) => {
    const result = await crawl({
      startUrl: `${server.origin}/`,
      minIntervalMs: 0,
      concurrency: 1,
      maxDepth: 1,
      respectRobots: false,
      maxDurationMs: 50,
    }, { clock });

    expect(result.stopReason).toBe("budget");
    expect(paths(server)).toEqual(["/"]);
    expect(pageAt(result, "/").state).toBe("ok");
    expect(pageAt(result, "/").attempts).toBe(1);
    expect(pageAt(result, "/next").state).toBe("skipped");
    expect(pageAt(result, "/next").skipReason).toBe("budget");
    expect(pageAt(result, "/next").attempts).toBe(0);
  });
});

test("respectRobots false spends the single attempt on the page", async () => {
  await withServer({
    "/": html("<html></html>"),
    "/robots.txt": (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nDisallow: /\n");
    },
  }, async (server) => {
    const result = await crawl({
      startUrl: `${server.origin}/`,
      minIntervalMs: 0,
      concurrency: 1,
      maxDepth: 0,
      respectRobots: false,
      maxTotalAttempts: 1,
    }, { clock: frozen });

    expect(result.stopReason).toBe("completed");
    expect(paths(server)).toEqual(["/"]);
    expect(result.pages[0].state).toBe("ok");
    expect(result.pages[0].attempts).toBe(1);
  });
});

test("a page attempt count does not include robots.txt", async () => {
  await withServer({
    "/": html("<html></html>"),
    "/robots.txt": (_req, res) => {
      res.writeHead(404);
      res.end();
    },
  }, async (server) => {
    const result = await crawl({
      startUrl: `${server.origin}/`,
      minIntervalMs: 0,
      concurrency: 1,
      maxDepth: 0,
    }, { clock: frozen });

    expect(result.stopReason).toBe("completed");
    expect(paths(server)).toEqual(["/robots.txt", "/"]);
    expect(result.pages[0].attempts).toBe(1);
  });
});

test("after the stop, queued pages stay queued and a later commit reserves nothing", async () => {
  await withServer({
    "/": html('<a href="/a"></a><a href="/b"></a><a href="/c"></a>'),
    "/a": html('<a href="/extra"></a>'),
    "/b": html("<html>b</html>"),
    "/c": html("<html>c</html>"),
    "/extra": html("<html>extra</html>"),
  }, async (server) => {
    const result = await crawl({
      startUrl: `${server.origin}/`,
      minIntervalMs: 0,
      concurrency: 2,
      maxDepth: 1,
      respectRobots: false,
      maxTotalAttempts: 2,
    }, { clock: frozen });

    expect(result.stopReason).toBe("budget");
    expect(paths(server)).toEqual(["/", "/a"]);
    expect(pageAt(result, "/").state).toBe("ok");
    expect(pageAt(result, "/a").state).toBe("ok");
    expect(pageAt(result, "/b").state).toBe("skipped");
    expect(pageAt(result, "/b").skipReason).toBe("budget");
    expect(pageAt(result, "/b").attempts).toBe(0);
    expect(pageAt(result, "/c").state).toBe("queued");
    expect(pageAt(result, "/extra")).toBeUndefined();
    expect(result.counts.queued).toBe(1);
  });
});
