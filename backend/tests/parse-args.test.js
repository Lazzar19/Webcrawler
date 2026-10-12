const { ConfigError } = require("../src/crawler/crawl-config.js");
const { parseCliArgs } = require("../src/cli/parse-args.js");

test("a positional URL is startUrl and omitted flags stay omitted", () => {
  const parsed = parseCliArgs(["https://example.com/start"]);

  expect(parsed.startUrl).toBe("https://example.com/start");
  expect(parsed.options).toEqual({});
  expect(parsed.format).toBeUndefined();
  expect(parsed.output).toBeUndefined();
  expect(parsed.details).toBe(false);
  expect(parsed.trace).toBe(false);
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
  expect(parsed.details).toBe(false);
  expect(parsed.options).toEqual({});
});

test("--details and --trace stay off the config object", () => {
  const parsed = parseCliArgs(["https://example.com/", "--details", "--trace"]);

  expect(parsed.details).toBe(true);
  expect(parsed.trace).toBe(true);
  expect(parsed.options).toEqual({});
});

test("a value on --details or --trace is a ConfigError", () => {
  expect(() => parseCliArgs(["https://example.com/", "--details=true"])).toThrow(ConfigError);
  expect(() => parseCliArgs(["https://example.com/", "--details=true"])).toThrow(/does not take an argument/);
  expect(() => parseCliArgs(["https://example.com/", "--trace=1"])).toThrow(ConfigError);
  expect(() => parseCliArgs(["https://example.com/", "--trace=1"])).toThrow(/does not take an argument/);
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

test("--max-duration and --max-attempts stay the typed characters", () => {
  const parsed = parseCliArgs([
    "https://example.com/",
    "--max-duration",
    "0",
    "--max-attempts=4",
  ]);

  expect(parsed.options).toEqual({
    maxDurationMs: "0",
    maxTotalAttempts: "4",
  });
  expect(parsed.options.maxDurationMs).not.toBe(0);
});

test("--max-url-length, --max-path-depth, and --max-segment-repeats stay the typed characters", () => {
  const parsed = parseCliArgs([
    "https://example.com/",
    "--max-url-length",
    "0",
    "--max-path-depth=8",
    "--max-segment-repeats",
    "3",
  ]);

  expect(parsed.options).toEqual({
    maxUrlLength: "0",
    maxPathDepth: "8",
    maxSegmentRepeats: "3",
  });
  expect(parsed.options.maxUrlLength).not.toBe(0);
});

test("an unknown flag is a ConfigError", () => {
  expect(() => {
    parseCliArgs(["https://example.com/", "--bogus"]);
  }).toThrow(ConfigError);
  expect(() => {
    parseCliArgs(["https://example.com/", "--bogus"]);
  }).toThrow(/--bogus/);
  expect(() => {
    parseCliArgs(["https://example.com/", "--max-bytes", "10"]);
  }).toThrow(/--max-bytes/);
});

test("a flag that requires a value rejects a missing one", () => {
  expect(() => {
    parseCliArgs(["https://example.com/", "--depth"]);
  }).toThrow(ConfigError);
  expect(() => {
    parseCliArgs(["https://example.com/", "--depth"]);
  }).toThrow(/--depth/);
});
