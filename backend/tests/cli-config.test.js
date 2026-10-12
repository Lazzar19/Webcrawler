const { DEFAULTS, ConfigError } = require("../src/crawler/crawl-config.js");
const { createCliConfig } = require("../src/cli/cli-config.js");

const startUrl = "https://example.com/start";

test("a missing numeric flag keeps the default", () => {
  const { config } = createCliConfig([startUrl]);

  expect(config.maxDepth).toBe(DEFAULTS.maxDepth);
  expect(config.minIntervalMs).toBe(DEFAULTS.minIntervalMs);
  expect(config.maxDurationMs).toBeNull();
  expect(config.maxTotalAttempts).toBeNull();
  expect(config.respectRobots).toBe(true);
  expect(Object.isFrozen(config)).toBe(true);
});

test("an explicit 0 for depth stays 0", () => {
  const { config } = createCliConfig([startUrl, "--depth", "0"]);

  expect(config.maxDepth).toBe(0);
  expect(typeof config.maxDepth).toBe("number");
  expect(config.maxPages).toBe(DEFAULTS.maxPages);
});

test("an explicit 0 for min-interval stays 0", () => {
  const { config } = createCliConfig([startUrl, "--min-interval", "0"]);

  expect(config.minIntervalMs).toBe(0);
});

test("present numbers replace only their own defaults", () => {
  const { config, format, output } = createCliConfig([
    startUrl,
    "--depth",
    "1",
    "--max-pages",
    "10",
    "--concurrency",
    "4",
    "--per-origin",
    "1",
    "--min-interval",
    "50",
    "--timeout",
    "1500",
    "--user-agent",
    "Bot/1.0",
    "--no-respect-robots",
    "--format",
    "json",
    "--output",
    "out.json",
  ]);

  expect(config.maxDepth).toBe(1);
  expect(config.maxPages).toBe(10);
  expect(config.concurrency).toBe(4);
  expect(config.perOriginLimit).toBe(1);
  expect(config.minIntervalMs).toBe(50);
  expect(config.timeoutMs).toBe(1500);
  expect(config.userAgent).toBe("Bot/1.0");
  expect(config.respectRobots).toBe(false);
  expect(config.retryCount).toBe(DEFAULTS.retryCount);
  expect(format).toBe("json");
  expect(output).toBe("out.json");
  expect(config).not.toHaveProperty("format");
  expect(config).not.toHaveProperty("output");
  expect(config).not.toHaveProperty("details");
});

test("--details and --trace are not crawl config fields", () => {
  const { config, details, trace } = createCliConfig([startUrl, "--details", "--trace"]);

  expect(details).toBe(true);
  expect(trace).toBe(true);
  expect(config).not.toHaveProperty("details");
  expect(config).not.toHaveProperty("trace");
});

test("a missing URL is rejected", () => {
  expect(() => createCliConfig([])).toThrow(ConfigError);
  expect(() => createCliConfig([])).toThrow(/startUrl/);
});

test("a non-http URL and a URL with userinfo are rejected", () => {
  expect(() => createCliConfig(["ftp://example.com/"])).toThrow(ConfigError);
  expect(() => createCliConfig(["https://user:secret@example.com/"])).toThrow(ConfigError);
});

test.each([
  ["--depth", "1.5", /maxDepth/],
  ["--depth", "1e2", /maxDepth/],
  ["--max-pages", "0", /maxPages/],
  ["--concurrency", "abc", /concurrency/],
  ["--per-origin", "0", /perOriginLimit/],
  ["--timeout", "0", /timeoutMs/],
  ["--max-duration", "0", /maxDurationMs/],
  ["--max-attempts", "0", /maxTotalAttempts/],
  ["--max-duration", "1.5", /maxDurationMs/],
  ["--max-attempts", "nope", /maxTotalAttempts/],
])("%s %s is rejected", (flag, value, pattern) => {
  expect(() => createCliConfig([startUrl, flag, value])).toThrow(ConfigError);
  expect(() => createCliConfig([startUrl, flag, value])).toThrow(pattern);
});

test("a negative depth is rejected", () => {
  expect(() => createCliConfig([startUrl, "--depth=-1"])).toThrow(ConfigError);
  expect(() => createCliConfig([startUrl, "--depth=-1"])).toThrow(/maxDepth/);
});

test("an unknown flag is rejected", () => {
  expect(() => createCliConfig([startUrl, "--bogus"])).toThrow(ConfigError);
  expect(() => createCliConfig([startUrl, "--bogus"])).toThrow(/--bogus/);
  expect(() => createCliConfig([startUrl, "--max-bytes", "10"])).toThrow(/--max-bytes/);
});

test("--max-duration and --max-attempts become positive integers", () => {
  const { config } = createCliConfig([
    startUrl,
    "--max-duration",
    "1500",
    "--max-attempts",
    "4",
  ]);

  expect(config.maxDurationMs).toBe(1500);
  expect(config.maxTotalAttempts).toBe(4);
});
