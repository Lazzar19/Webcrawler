const { parseArgs } = require("node:util");
const { ConfigError } = require("../crawler/crawl-config.js");

const OPTIONS = {
  depth: { type: "string" },
  "max-pages": { type: "string" },
  concurrency: { type: "string" },
  "per-origin": { type: "string" },
  "min-interval": { type: "string" },
  timeout: { type: "string" },
  "max-duration": { type: "string" },
  "max-attempts": { type: "string" },
  "max-url-length": { type: "string" },
  "max-path-depth": { type: "string" },
  "max-segment-repeats": { type: "string" },
  "user-agent": { type: "string" },
  "no-respect-robots": { type: "boolean" },
  "no-dedupe-content": { type: "boolean" },
  "no-canonical": { type: "boolean" },
  format: { type: "string" },
  output: { type: "string" },
  details: { type: "boolean" },
  trace: { type: "boolean" },
};

function parseCliArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new ConfigError(error.message);
  }

  if (parsed.positionals.length > 1) {
    throw new ConfigError("Expected one URL");
  }

  const values = parsed.values;
  const options = {};
  if (values.depth !== undefined) {
    options.maxDepth = values.depth;
  }
  if (values["max-pages"] !== undefined) {
    options.maxPages = values["max-pages"];
  }
  if (values.concurrency !== undefined) {
    options.concurrency = values.concurrency;
  }
  if (values["per-origin"] !== undefined) {
    options.perOriginLimit = values["per-origin"];
  }
  if (values["min-interval"] !== undefined) {
    options.minIntervalMs = values["min-interval"];
  }
  if (values.timeout !== undefined) {
    options.timeoutMs = values.timeout;
  }
  if (values["max-duration"] !== undefined) {
    options.maxDurationMs = values["max-duration"];
  }
  if (values["max-attempts"] !== undefined) {
    options.maxTotalAttempts = values["max-attempts"];
  }
  if (values["max-url-length"] !== undefined) {
    options.maxUrlLength = values["max-url-length"];
  }
  if (values["max-path-depth"] !== undefined) {
    options.maxPathDepth = values["max-path-depth"];
  }
  if (values["max-segment-repeats"] !== undefined) {
    options.maxSegmentRepeats = values["max-segment-repeats"];
  }
  if (values["user-agent"] !== undefined) {
    options.userAgent = values["user-agent"];
  }
  if (values["no-respect-robots"] === true) {
    options.respectRobots = false;
  }
  if (values["no-dedupe-content"] === true) {
    options.dedupeContent = false;
  }
  if (values["no-canonical"] === true) {
    options.respectCanonical = false;
  }

  return {
    startUrl: parsed.positionals[0],
    options,
    format: values.format,
    output: values.output,
    details: values.details === true,
    trace: values.trace === true,
  };
}

module.exports = {
  parseCliArgs,
};
