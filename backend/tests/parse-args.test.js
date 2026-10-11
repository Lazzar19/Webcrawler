const { ConfigError } = require("../src/crawler/crawl-config.js");
const { parseCliArgs } = require("../src/cli/parse-args.js");

test("a positional URL is startUrl and omitted flags stay omitted", () => {
  const parsed = parseCliArgs(["https://example.com/start"]);

  expect(parsed.startUrl).toBe("https://example.com/start");
  expect(parsed.options).toEqual({});
  expect(parsed.format).toBeUndefined();
  expect(parsed.output).toBeUndefined();
});

test("numeric flags stay the typed characters, including an explicit 0", () => {
  const parsed = parseCliArgs([
    "https://example.com/",
    "--depth",
    "0",
    "--max-pages=10",
    "--concurrency",
    "4",
    "--per-origin",
    "1",
    "--min-interval",
    "0",
    "--timeout",
    "1500",
  ]);

  expect(parsed.options).toEqual({
    maxDepth: "0",
    maxPages: "10",
    concurrency: "4",
    perOriginLimit: "1",
    minIntervalMs: "0",
    timeoutMs: "1500",
  });
  expect(parsed.options.maxDepth).not.toBe(0);
});

test("--user-agent and --no-respect-robots map to config fields", () => {
  const parsed = parseCliArgs([
    "--user-agent",
    "Bot/1.0",
    "--no-respect-robots",
    "https://example.com/",
  ]);

  expect(parsed.startUrl).toBe("https://example.com/");
  expect(parsed.options.userAgent).toBe("Bot/1.0");
  expect(parsed.options.respectRobots).toBe(false);
});

test("an absent --no-respect-robots does not set respectRobots", () => {
  const parsed = parseCliArgs(["https://example.com/"]);

  expect(parsed.options).not.toHaveProperty("respectRobots");
});

test("--format and --output stay off the config object", () => {
  const parsed = parseCliArgs([
    "https://example.com/",
    "--format",
    "json",
    "--output",
    "out.json",
  ]);

  expect(parsed.format).toBe("json");
  expect(parsed.output).toBe("out.json");
  expect(parsed.options).toEqual({});
});

test("zero positionals leaves startUrl empty", () => {
  expect(parseCliArgs([]).startUrl).toBeUndefined();
});

test("a second positional is a ConfigError", () => {
  expect(() => {
    parseCliArgs(["https://example.com/", "https://other.example/"]);
  }).toThrow(ConfigError);
  expect(() => {
    parseCliArgs(["https://example.com/", "https://other.example/"]);
  }).toThrow(/one URL/);
});

test("an unknown flag is a ConfigError", () => {
  expect(() => {
    parseCliArgs(["https://example.com/", "--bogus"]);
  }).toThrow(ConfigError);
  expect(() => {
    parseCliArgs(["https://example.com/", "--bogus"]);
  }).toThrow(/--bogus/);
});

test("a flag that requires a value rejects a missing one", () => {
  expect(() => {
    parseCliArgs(["https://example.com/", "--depth"]);
  }).toThrow(ConfigError);
  expect(() => {
    parseCliArgs(["https://example.com/", "--depth"]);
  }).toThrow(/--depth/);
});
