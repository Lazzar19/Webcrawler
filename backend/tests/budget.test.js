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
    expect(result.pages[0].attempts).toBe(0);
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
