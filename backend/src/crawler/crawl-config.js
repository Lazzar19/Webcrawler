

const DEFAULT_CONFIG = {
    maxDepth: 3,
    maxPages: Infinity,
    concurrency: 5
};


function createCrawlConfig(options = {}) {

    const config = {
        ...DEFAULT_CONFIG,
        ...options
    }

    if(!Number.isInteger(config.maxDepth) || config.maxDepth < 0) {
        throw new Error("Invalid maxDepth. Please provide a non-negative integer.");
    }

    if(config.maxPages != Infinity && (!Number.isInteger(config.maxPages) || config.maxPages <= 0)) {
        throw new Error("Invalid maxPages. Please provide a positive integer or Infinity.");
    }

    if(!Number.isInteger(config.concurrency) || config.concurrency <= 0) {
        throw new Error("Invalid concurrency. Please provide a positive integer.");
    }

    return Object.freeze(config);
}

module.exports = {
    DEFAULT_CONFIG,
    createCrawlConfig
}
