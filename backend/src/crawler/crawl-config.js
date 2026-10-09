const DEFAULTS = {
  maxDepth: 2,
  maxPages: 50,
  concurrency: 5,
  perOriginLimit: 2,
  minIntervalMs: 200,
  timeoutMs: 10000,
  maxResponseBytes: 1000000,
  retryCount: 2,
  retryBaseDelayMs: 500,
  respectRobots: true,
  userAgent: "WebcrawlerBot/1.0 (+https://github.com/Lazzar19/webcrawler)",
};

const ALLOWED_KEYS = new Set(["startUrl", ...Object.keys(DEFAULTS)]);

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function validateStartUrl(startUrl) {
  if (typeof startUrl !== "string" || startUrl === "") {
    throw new ConfigError("startUrl is required");
  }
  let url;
  try {
    url = new URL(startUrl);
  } catch {
    throw new ConfigError("startUrl must be an http or https URL without userinfo");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError("startUrl must be an http or https URL without userinfo");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError("startUrl must be an http or https URL without userinfo");
  }
}

function createCrawlConfig(options = {}) {
  for (const key of Object.keys(options)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new ConfigError(`Unknown config key: ${key}`);
    }
  }

  const config = { ...DEFAULTS, ...options };
  validateStartUrl(config.startUrl);

  if (!isNonNegativeInteger(config.maxDepth)) {
    throw new ConfigError("maxDepth must be a non-negative integer");
  }
  if (!isPositiveInteger(config.maxPages)) {
    throw new ConfigError("maxPages must be a positive integer");
  }
  if (!isPositiveInteger(config.concurrency)) {
    throw new ConfigError("concurrency must be a positive integer");
  }
  if (!isPositiveInteger(config.perOriginLimit)) {
    throw new ConfigError("perOriginLimit must be a positive integer");
  }
  if (!isNonNegativeInteger(config.minIntervalMs)) {
    throw new ConfigError("minIntervalMs must be a non-negative integer");
  }
  if (!isPositiveInteger(config.timeoutMs)) {
    throw new ConfigError("timeoutMs must be a positive integer");
  }
  if (!isPositiveInteger(config.maxResponseBytes)) {
    throw new ConfigError("maxResponseBytes must be a positive integer");
  }
  if (!isNonNegativeInteger(config.retryCount)) {
    throw new ConfigError("retryCount must be a non-negative integer");
  }
  if (!isNonNegativeInteger(config.retryBaseDelayMs)) {
    throw new ConfigError("retryBaseDelayMs must be a non-negative integer");
  }
  if (typeof config.respectRobots !== "boolean") {
    throw new ConfigError("respectRobots must be a boolean");
  }
  if (typeof config.userAgent !== "string" || config.userAgent === "") {
    throw new ConfigError("userAgent must be a non-empty string");
  }

  return Object.freeze(config);
}

module.exports = {
  DEFAULTS,
  ConfigError,
  createCrawlConfig,
};
