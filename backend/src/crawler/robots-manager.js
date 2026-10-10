const robotsParser = require("robots-parser");
const { FetchError } = require("./http-client");

const ROBOTS_BYTES = 512000;
const HOP_LIMIT = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CRAWL_DELAY_CAP_MS = 10000;

function productToken(userAgent) {
  const cut = userAgent.search(/[/\s]/);
  return cut === -1 ? userAgent : userAgent.slice(0, cut);
}

function summaryOf(record) {
  return {
    origin: record.origin,
    statusCode: record.statusCode,
    outcome: record.outcome,
    errorKind: record.errorKind,
  };
}

function createRobotsManager({ http, userAgent, respectRobots }) {
  const token = productToken(userAgent);
  const cache = new Map();
  const settled = new Map();
  const order = [];

  function remember(record) {
    settled.set(record.origin, record);
    return record;
  }

  function unavailable(origin, statusCode, errorKind) {
    return remember({
      origin,
      statusCode,
      outcome: "unavailable",
      errorKind,
      parser: null,
      crawlDelaySeconds: null,
    });
  }

  function allowAll(origin, statusCode) {
    return remember({
      origin,
      statusCode,
      outcome: "allow-all",
      errorKind: null,
      parser: null,
      crawlDelaySeconds: null,
    });
  }

  async function load(origin, beforeAttempt) {
    let current = `${origin}/robots.txt`;
    const seen = new Set();
    let hops = 0;

    while (true) {
      if (seen.has(current)) {
        return unavailable(origin, null, "redirect-loop");
      }
      seen.add(current);

      let response;
      try {
        response = await http.get(current, {
          maxBytes: ROBOTS_BYTES,
          beforeAttempt,
          wantBody({ statusCode }) {
            return statusCode >= 200 && statusCode < 300;
          },
        });
      } catch (error) {
        if (error instanceof FetchError) {
          return unavailable(origin, null, error.kind);
        }
        throw error;
      }

      const statusCode = response.statusCode;
      if (REDIRECT_STATUSES.has(statusCode)) {
        hops += 1;
        if (hops > HOP_LIMIT) {
          return unavailable(origin, null, "redirect-limit");
        }
        if (!response.location) {
          return unavailable(origin, null, "bad-redirect");
        }
        let resolved;
        try {
          resolved = new URL(response.location, current);
        } catch {
          return unavailable(origin, null, "bad-redirect");
        }
        if (resolved.username !== "" || resolved.password !== "") {
          return unavailable(origin, null, "bad-redirect");
        }
        if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
          return unavailable(origin, null, "bad-redirect");
        }
        resolved.hash = "";
        current = resolved.href;
        continue;
      }

      if (statusCode >= 200 && statusCode < 300) {
        const parser = robotsParser(`${origin}/robots.txt`, response.body ?? "");
        const crawlDelaySeconds = parser.getCrawlDelay(token);
        return remember({
          origin,
          statusCode,
          outcome: "parsed",
          errorKind: null,
          parser,
          crawlDelaySeconds: crawlDelaySeconds == null ? null : crawlDelaySeconds,
        });
      }

      if (statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
        return allowAll(origin, statusCode);
      }

      return unavailable(origin, statusCode, "http-status");
    }
  }

  function start(origin, beforeAttempt) {
    order.push(origin);
    const pending = load(origin, beforeAttempt);
    cache.set(origin, pending);
    return pending;
  }

  return {
    async check(url, { beforeAttempt } = {}) {
      const origin = new URL(url).origin;
      if (!respectRobots) {
        if (!settled.has(origin)) {
          order.push(origin);
          remember({
            origin,
            statusCode: null,
            outcome: "not-checked",
            errorKind: null,
            parser: null,
            crawlDelaySeconds: null,
          });
        }
        return { allowed: true };
      }

      const pending = cache.has(origin)
        ? cache.get(origin)
        : start(origin, beforeAttempt ?? (async () => {}));
      const record = await pending;
      if (record.outcome === "unavailable") {
        return { allowed: false, reason: "robots-unavailable" };
      }
      if (record.outcome === "parsed" && record.parser.isAllowed(url, token) === false) {
        return { allowed: false, reason: "robots" };
      }
      return { allowed: true };
    },

    gapMs(origin, minIntervalMs) {
      const record = settled.get(origin);
      if (!record || record.outcome !== "parsed" || record.crawlDelaySeconds == null) {
        return minIntervalMs;
      }
      const delayMs = record.crawlDelaySeconds * 1000;
      if (delayMs <= minIntervalMs) {
        return minIntervalMs;
      }
      return Math.min(CRAWL_DELAY_CAP_MS, delayMs);
    },

    summaries() {
      return order
        .map((origin) => settled.get(origin))
        .filter((record) => record)
        .map(summaryOf);
    },
  };
}

module.exports = {
  createRobotsManager,
  productToken,
};
