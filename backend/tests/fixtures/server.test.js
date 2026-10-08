const { createFixtureServer } = require("./server");

describe("fixture server", () => {
  let server;

  beforeAll(async () => {
    server = createFixtureServer({
      clock: { now: () => 1_700_000_000_000 },
      routes: {
        "/": (_req, res) => {
          res.end("home");
        },
      },
    });
    await server.listen();
  });

  afterAll(async () => {
    await server.close();
  });

  test("logs path, user-agent, and start time", async () => {
    const response = await fetch(`${server.origin}/hello?x=1`, {
      headers: { "user-agent": "FixtureTest" },
    });
    expect(response.status).toBe(404);
    expect(server.requests.at(-1)).toEqual({
      path: "/hello?x=1",
      userAgent: "FixtureTest",
      startedAt: 1_700_000_000_000,
    });
  });
});

test("two servers are different origins", async () => {
  const first = createFixtureServer();
  const second = createFixtureServer();
  await first.listen();
  await second.listen();
  try {
    expect(first.origin).not.toBe(second.origin);
  } finally {
    await first.close();
    await second.close();
  }
});

test("peak concurrency counts overlapping requests", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const server = createFixtureServer({
    routes: {
      "/slow": async (_req, res) => {
        await gate;
        res.end("ok");
      },
    },
  });
  await server.listen();

  try {
    const pending = Promise.all([
      fetch(`${server.origin}/slow`),
      fetch(`${server.origin}/slow`),
    ]);
    await new Promise((resolve) => {
      const check = () => {
        if (server.requests.length === 2) {
          resolve();
          return;
        }
        setImmediate(check);
      };
      check();
    });
    expect(server.currentConcurrency).toBe(2);
    expect(server.peakConcurrency).toBe(2);
    release();
    const responses = await pending;
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(server.currentConcurrency).toBe(0);
    expect(server.peakConcurrency).toBe(2);
  } finally {
    await server.close();
  }
});
