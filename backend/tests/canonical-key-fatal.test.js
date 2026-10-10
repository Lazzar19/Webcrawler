const mockBoom = new Error("bad key");

jest.mock("../src/crawler/url-policy", () => {
  const actual = jest.requireActual("../src/crawler/url-policy");
  return {
    ...actual,
    extractLinks() {
      return ["not a url"];
    },
    canonicalKey(input) {
      if (input === "not a url") {
        throw mockBoom;
      }
      return actual.canonicalKey(input);
    },
  };
});

const { crawl } = require("../src/crawler/crawl");

test("a canonicalKey throw during commit rejects crawl with that object", async () => {
  const httpClient = {
    async get(url, options) {
      await options.beforeAttempt();
      return {
        url,
        statusCode: 200,
        contentType: "text/html",
        location: null,
        body: "<html></html>",
        byteLength: 0,
        attempts: 1,
        durationMs: 0,
      };
    },
  };
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };

  const pending = crawl(
    {
      startUrl: "https://example.com/",
      maxDepth: 1,
      maxPages: 10,
      concurrency: 1,
      minIntervalMs: 0,
    },
    { httpClient, logger }
  );

  await expect(pending).rejects.toBe(mockBoom);
});
