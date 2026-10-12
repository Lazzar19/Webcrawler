const { parseCliArgs } = require("./parse-args.js");
const { ConfigError, createCrawlConfig } = require("../crawler/crawl-config.js");

const INTEGER_RULE = {
  maxDepth: "non-negative integer",
  minIntervalMs: "non-negative integer",
  maxPages: "positive integer",
  concurrency: "positive integer",
  perOriginLimit: "positive integer",
  timeoutMs: "positive integer",
  maxDurationMs: "positive integer",
  maxTotalAttempts: "positive integer",
  maxUrlLength: "positive integer",
  maxPathDepth: "positive integer",
  maxSegmentRepeats: "positive integer",
};

function integerFlag(field, raw) {
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`${field} must be a ${INTEGER_RULE[field]}`);
  }
  return Number(raw);
}

function createCliConfig(argv) {
  const parsed = parseCliArgs(argv);
  const options = {};
  if (parsed.startUrl !== undefined) {
    options.startUrl = parsed.startUrl;
  }
  for (const [field, raw] of Object.entries(parsed.options)) {
    options[field] = Object.hasOwn(INTEGER_RULE, field) ? integerFlag(field, raw) : raw;
  }

  return {
    config: createCrawlConfig(options),
    format: parsed.format,
    output: parsed.output,
    details: parsed.details,
    trace: parsed.trace,
  };
}

module.exports = {
  createCliConfig,
};
