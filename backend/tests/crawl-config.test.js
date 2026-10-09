const { DEFAULTS, ConfigError, createCrawlConfig } = require("../src/crawler/crawl-config.js");

const startUrl = "https://example.com/start";

describe("createCrawlConfig", () => {
  test("returns the cemented defaults", () => {
    const config = createCrawlConfig({ startUrl });

    expect(config).toEqual({ ...DEFAULTS, startUrl });
    expect(config.maxDepth).toBe(2);
    expect(config.maxPages).toBe(50);
  });

  test("allows custom configuration values", () => {
    const config = createCrawlConfig({
      startUrl,
      maxDepth: 5,
      maxPages: 100,
      concurrency: 10,
    });

    expect(config.maxDepth).toBe(5);
    expect(config.maxPages).toBe(100);
    expect(config.concurrency).toBe(10);
  });

  test("fills omitted fields from the defaults", () => {
    const config = createCrawlConfig({
      startUrl,
      maxDepth: 10,
    });

    expect(config.maxDepth).toBe(10);
    expect(config.maxPages).toBe(50);
    expect(config.concurrency).toBe(5);
  });

  test("returns a frozen configuration", () => {
    const config = createCrawlConfig({ startUrl });

    expect(Object.isFrozen(config)).toBe(true);
  });

  test("rejects an unknown key", () => {
    expect(() => {
      createCrawlConfig({ startUrl, typo: 1 });
    }).toThrow(ConfigError);
  });
});

describe("startUrl", () => {
  test("is required", () => {
    expect(() => createCrawlConfig()).toThrow(/startUrl/);
  });

  test("rejects a non-http scheme and userinfo", () => {
    expect(() => createCrawlConfig({ startUrl: "ftp://example.com/" })).toThrow(ConfigError);
    expect(() => createCrawlConfig({ startUrl: "https://user:pw@example.com/" })).toThrow(
      ConfigError
    );
  });
});

describe("configuration validation", () => {
  describe("maxDepth", () => {
    test("accepts zero", () => {
      expect(() => {
        createCrawlConfig({ startUrl, maxDepth: 0 });
      }).not.toThrow();
    });

    test("rejects negative values", () => {
      expect(() => {
        createCrawlConfig({ startUrl, maxDepth: -1 });
      }).toThrow(/maxDepth/);
    });

    test("rejects non-integer values", () => {
      expect(() => {
        createCrawlConfig({ startUrl, maxDepth: 1.5 });
      }).toThrow(/maxDepth/);
    });
  });

  describe("maxPages", () => {
    test("rejects Infinity", () => {
      expect(() => {
        createCrawlConfig({ startUrl, maxPages: Infinity });
      }).toThrow(/maxPages/);
    });

    test("accepts positive integers", () => {
      expect(() => {
        createCrawlConfig({ startUrl, maxPages: 100 });
      }).not.toThrow();
    });

    test("rejects zero", () => {
      expect(() => {
        createCrawlConfig({ startUrl, maxPages: 0 });
      }).toThrow(/maxPages/);
    });

    test("rejects negative values", () => {
      expect(() => {
        createCrawlConfig({ startUrl, maxPages: -1 });
      }).toThrow(/maxPages/);
    });
  });

  describe("concurrency", () => {
    test("accepts positive integers", () => {
      expect(() => {
        createCrawlConfig({ startUrl, concurrency: 10 });
      }).not.toThrow();
    });

    test("rejects zero", () => {
      expect(() => {
        createCrawlConfig({ startUrl, concurrency: 0 });
      }).toThrow(/concurrency/);
    });

    test("rejects negative values", () => {
      expect(() => {
        createCrawlConfig({ startUrl, concurrency: -1 });
      }).toThrow(/concurrency/);
    });

    test("rejects non-integer values", () => {
      expect(() => {
        createCrawlConfig({ startUrl, concurrency: 2.5 });
      }).toThrow(/concurrency/);
    });
  });
});
