const http = require("node:http");

function createFixtureServer({ routes = {}, clock = { now: () => Date.now() } } = {}) {
  const requests = [];
  let currentConcurrency = 0;
  let peakConcurrency = 0;

  const server = http.createServer(async (req, res) => {
    currentConcurrency += 1;
    if (currentConcurrency > peakConcurrency) {
      peakConcurrency = currentConcurrency;
    }

    const requestUrl = new URL(req.url, "http://127.0.0.1");
    requests.push({
      path: req.url,
      userAgent: req.headers["user-agent"] || "",
      startedAt: clock.now(),
    });

    try {
      const route = routes[requestUrl.pathname];
      if (route) {
        await route(req, res);
      } else {
        res.writeHead(404);
        res.end();
      }
    } finally {
      currentConcurrency -= 1;
    }
  });

  return {
    requests,
    get currentConcurrency() {
      return currentConcurrency;
    },
    get peakConcurrency() {
      return peakConcurrency;
    },
    origin: null,
    listen() {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const { port } = server.address();
          this.origin = `http://127.0.0.1:${port}`;
          resolve(this);
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

module.exports = {
  createFixtureServer,
};
