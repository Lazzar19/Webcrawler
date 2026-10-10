const { createClock } = require("./clock");
const { createLogger } = require("./logger");
const { createCrawlConfig } = require("./crawl-config");
const { createHttpClient, FetchError } = require("./http-client");
const { createPolitenessGate } = require("./politeness");
const { createRobotsManager } = require("./robots-manager");
const { createFrontier } = require("./frontier");
const { canonicalKey, extractLinks } = require("./url-policy");

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HOP_LIMIT = 5;

function isHtml(contentType) {
  if (!contentType) {
    return false;
  }
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  return mediaType === "text/html" || mediaType === "application/xhtml+xml";
}

function failPage(page, errorKind, errorMessage) {
  page.state = "failed";
  page.errorKind = errorKind;
  page.errorMessage = errorMessage;
}

function skipPage(page, skipReason) {
  page.state = "skipped";
  page.skipReason = skipReason;
}

async function fetchRecord(item, lease, http, robots, frontier, clock, startOrigin, config) {
  const page = item.page;
  let currentUrl = page.requestedUrl;
  page.finalUrl = currentUrl;
  const chain = [page.canonicalUrl];
  let hops = 0;
  let startedAt = null;
  let notedWait = false;

  while (true) {
    let response;
    try {
      response = await http.get(currentUrl, {
        maxBytes: config.maxResponseBytes,
        async beforeAttempt() {
          if (!notedWait) {
            page.waitedMs = clock.now() - item.takenAt;
            notedWait = true;
            startedAt = clock.now();
          }
          await lease.beforeAttempt();
        },
        wantBody({ statusCode, contentType }) {
          return statusCode >= 200 && statusCode < 300 && isHtml(contentType);
        },
      });
    } catch (error) {
      if (error instanceof FetchError) {
        page.attempts += error.attempts;
        if (startedAt !== null) {
          page.durationMs = clock.now() - startedAt;
        }
        failPage(page, error.kind, error.message);
        item.links = [];
        return;
      }
      throw error;
    }

    page.attempts += response.attempts;
    page.statusCode = response.statusCode;
    page.contentType = response.contentType;
    page.byteLength = response.body === null ? null : response.byteLength;
    page.durationMs = clock.now() - startedAt;
    page.finalUrl = currentUrl;

    if (REDIRECT_STATUSES.has(response.statusCode)) {
      hops += 1;
      if (hops > HOP_LIMIT) {
        failPage(page, "redirect-limit", "redirect hop limit exceeded");
        item.links = [];
        return;
      }
      if (!response.location) {
        failPage(page, "bad-redirect", "redirect is missing Location");
        item.links = [];
        return;
      }

      let resolved;
      try {
        resolved = new URL(response.location, currentUrl);
      } catch (error) {
        failPage(page, "bad-redirect", error.message);
        item.links = [];
        return;
      }
      if (resolved.username !== "" || resolved.password !== "") {
        failPage(page, "bad-redirect", "redirect location contains userinfo");
        item.links = [];
        return;
      }
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
        skipPage(page, "redirect-off-origin");
        item.links = [];
        return;
      }
      resolved.hash = "";
      const hopKey = canonicalKey(resolved.href);
      if (resolved.origin !== startOrigin) {
        skipPage(page, "redirect-off-origin");
        item.links = [];
        return;
      }
      if (chain.includes(hopKey)) {
        failPage(page, "redirect-loop", "redirect loop");
        item.links = [];
        return;
      }
      const owner = frontier.ownerOf(hopKey);
      if (owner && owner !== item) {
        skipPage(page, "duplicate");
        item.links = [];
        return;
      }
      frontier.alias(hopKey, item);
      chain.push(hopKey);

      const decision = await robots.check(resolved.href, { beforeAttempt: lease.beforeAttempt });
      if (!decision.allowed) {
        skipPage(page, decision.reason);
        item.links = [];
        return;
      }
      currentUrl = resolved.href;
      continue;
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      failPage(page, "http-status", `HTTP ${response.statusCode}`);
      item.links = [];
      return;
    }
    if (!isHtml(response.contentType)) {
      skipPage(page, "non-html");
      item.links = [];
      return;
    }

    try {
      item.links = extractLinks(response.body, page.finalUrl);
      page.state = "ok";
    } catch (error) {
      failPage(page, "parse", error.message);
      item.links = [];
    }
    return;
  }
}

async function runWorker(frontier, gate, robots, http, clock, logger, startOrigin, config) {
  for (;;) {
    const item = await frontier.take();
    if (item === null) {
      return;
    }
    let lease;
    try {
      lease = await gate.acquire(new URL(item.page.requestedUrl).origin);
      const decision = await robots.check(item.page.requestedUrl, {
        beforeAttempt: lease.beforeAttempt,
      });
      if (!decision.allowed) {
        item.page.state = "skipped";
        item.page.skipReason = decision.reason;
        item.links = [];
      } else {
        await fetchRecord(item, lease, http, robots, frontier, clock, startOrigin, config);
      }
      frontier.commit(item);
    } catch (error) {
      item.links = [];
      frontier.fail(error, logger);
      throw error;
    } finally {
      if (lease) {
        lease.release();
      }
      frontier.commit(item);
    }
  }
}

function countsFor(pages, reserved) {
  return {
    reserved,
    queued: pages.filter((page) => page.state === "queued").length,
    fetched: pages.filter((page) => page.attempts >= 1).length,
    ok: pages.filter((page) => page.state === "ok").length,
    skipped: pages.filter((page) => page.state === "skipped").length,
    failed: pages.filter((page) => page.state === "failed").length,
  };
}

async function crawl(configInput, dependencies = {}) {
  const config = createCrawlConfig(configInput);
  const clock = dependencies.clock ?? createClock();
  const logger = dependencies.logger ?? createLogger();
  const fatalControl = new AbortController();
  const http = dependencies.httpClient ?? createHttpClient({
    fetchImpl: dependencies.fetchImpl,
    clock,
    userAgent: config.userAgent,
    timeoutMs: config.timeoutMs,
    retryCount: config.retryCount,
    retryBaseDelayMs: config.retryBaseDelayMs,
    fatalSignal: fatalControl.signal,
  });
  const gate = createPolitenessGate();
  const robots = createRobotsManager({
    http,
    userAgent: config.userAgent,
    respectRobots: config.respectRobots,
  });
  const frontier = createFrontier({
    config,
    clock,
    onFatal() {
      fatalControl.abort();
    },
  });
  const startedAt = clock.now();
  const signal = dependencies.signal;

  const onAbort = () => frontier.stop();
  if (signal) {
    if (signal.aborted) {
      frontier.stop();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  frontier.reserveStart();
  const startOrigin = new URL(config.startUrl).origin;
  const workers = [];
  for (let index = 0; index < config.concurrency; index += 1) {
    workers.push(runWorker(frontier, gate, robots, http, clock, logger, startOrigin, config));
  }

  try {
    await Promise.allSettled(workers);
  } finally {
    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }
  }

  if (frontier.fatalError) {
    throw frontier.fatalError;
  }

  const finishedAt = clock.now();
  return {
    schemaVersion: 1,
    startUrl: config.startUrl,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - startedAt,
    stopReason: frontier.stopping ? "interrupted" : "completed",
    config,
    pages: frontier.pages,
    robots: robots.summaries(),
    counts: countsFor(frontier.pages, frontier.fetchReservations),
  };
}

function getURLs(htmlBody, baseURL) {
  return extractLinks(htmlBody, baseURL);
}

module.exports = {
  crawl,
  getURLs,
};
