const { parseArgs } = require("node:util");
const { ConfigError } = require("../crawler/crawl-config.js");

const OPTIONS = {
  depth: { type: "string" },
  "max-pages": { type: "string" },
  concurrency: { type: "string" },
  "per-origin": { type: "string" },
  "min-interval": { type: "string" },
  timeout: { type: "string" },
  "user-agent": { type: "string" },
  "no-respect-robots": { type: "boolean" },
  format: { type: "string" },
  output: { type: "string" },
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
  if (values["user-agent"] !== undefined) {
    options.userAgent = values["user-agent"];
  }
  if (values["no-respect-robots"] === true) {
    options.respectRobots = false;
  }

  return {
    startUrl: parsed.positionals[0],
    options,
    format: values.format,
    output: values.output,
  };
}

module.exports = {
  parseCliArgs,
};
