const { createHash } = require("node:crypto");
const { createClock } = require("./clock");
const { createLogger } = require("./logger");
const { createCrawlConfig } = require("./crawl-config");
const { createHttpClient, BudgetStop, FetchError } = require("./http-client");
const { createPolitenessGate } = require("./politeness");
const { createRobotsManager } = require("./robots-manager");
const { createFrontier, trapReason } = require("./frontier");
const { canonicalKey, declaredCanonicalKey, readHtml } = require("./url-policy");
const { emitTrace, guardTrace } = require("./trace");

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

function contentHash(body) {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

async function fetchRecord(item, lease, http, robots, frontier, clock, startOrigin, config, logger, trace) {
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
          await lease.beforeAttempt();
          if (!notedWait) {
            page.waitedMs = clock.now() - item.takenAt;
            notedWait = true;
            startedAt = clock.now();
          }
        },
        wantBody({ statusCode, contentType }) {
          return statusCode >= 200 && statusCode < 300 && isHtml(contentType);
        },
      });
    } catch (error) {
      if (error instanceof BudgetStop) {
        item.links = [];
        skipPage(page, "budget");
        if (page.attempts === 0) {
          page.finalUrl = null;
          page.waitedMs = null;
        }
        return;
      }
      if (error instanceof FetchError) {
        page.attempts += error.attempts;
        if (error.statusCode != null) {
          page.statusCode = error.statusCode;
        }
        if (error.contentType != null) {
          page.contentType = error.contentType;
        }
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
      const guard = trapReason(hopKey, config);
      if (guard !== null) {
        skipPage(page, guard);
        item.links = [];
        return;
      }

      const decision = await robots.check(resolved.href, { beforeAttempt: lease.beforeAttempt });
      emitTrace(trace, "robots-check", {
        url: resolved.href,
        allowed: decision.allowed,
        reason: decision.reason,
      });
      if (!decision.allowed) {
        skipPage(page, decision.reason);
        item.links = [];
        return;
      }
      emitTrace(trace, "redirect", {
        from: currentUrl,
        to: resolved.href,
        status: response.statusCode,
      });
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
      const parsed = readHtml(response.body, page.finalUrl, logger);
      item.links = parsed.links;
      if (config.respectCanonical) {
        item.canonicalTarget = declaredCanonicalKey(
          parsed.canonicalHref,
          parsed.baseHref,
          page.canonicalUrl,
          startOrigin
        );
      }
      if (config.dedupeContent && typeof response.body === "string") {
        item.contentHash = contentHash(response.body);
      }
      emitTrace(trace, "links", {
        url: page.finalUrl,
        discovered: item.links.length,
      });
      page.state = "ok";
    } catch (error) {
      failPage(page, "parse", error.message);
      item.links = [];
    }
    return;
  }
}

async function runWorker(frontier, gate, robots, http, clock, logger, startOrigin, config, trace) {
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
      emitTrace(trace, "robots-check", {
        url: item.page.requestedUrl,
        allowed: decision.allowed,
        reason: decision.reason,
      });
      if (!decision.allowed) {
        item.page.state = "skipped";
        item.page.skipReason = decision.reason;
        item.links = [];
      } else {
        await fetchRecord(item, lease, http, robots, frontier, clock, startOrigin, config, logger, trace);
      }
      frontier.commit(item);
    } catch (error) {
      item.links = [];
      if (error instanceof BudgetStop) {
        if (item.page.state === "fetching") {
          skipPage(item.page, "budget");
          if (item.page.attempts === 0) {
            item.page.waitedMs = null;
          }
        }
      } else {
        frontier.fail(error, logger);
        throw error;
      }
    } finally {
      if (lease) {
        lease.release();
      }
      frontier.commit(item);
    }
  }
}

function traceStopReason(frontier) {
  if (frontier.fatalError) {
    return "fatal";
  }
  if (frontier.stopReason) {
    return frontier.stopReason;
  }
  return "completed";
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
  const trace = guardTrace(dependencies.trace, logger);
  const fatalControl = new AbortController();
  const startedAt = clock.now();
  let claimedAttempts = 0;
  const frontier = createFrontier({
    config,
    clock,
    onFatal() {
      fatalControl.abort();
    },
    trace,
  });

  function claimAttempt() {
    if (frontier.stopReason === "budget") {
      return false;
    }
    if (config.maxTotalAttempts != null && claimedAttempts >= config.maxTotalAttempts) {
      frontier.stop("budget");
      return false;
    }
    if (config.maxDurationMs != null && clock.now() - startedAt >= config.maxDurationMs) {
      frontier.stop("budget");
      return false;
    }
    claimedAttempts += 1;
    return true;
  }

  const http = dependencies.httpClient ?? createHttpClient({
    fetchImpl: dependencies.fetchImpl,
    clock,
    userAgent: config.userAgent,
    timeoutMs: config.timeoutMs,
    retryCount: config.retryCount,
    retryBaseDelayMs: config.retryBaseDelayMs,
    fatalSignal: fatalControl.signal,
    trace,
    claimAttempt,
  });
  const robots = createRobotsManager({
    http,
    userAgent: config.userAgent,
    respectRobots: config.respectRobots,
  });
  const gate = createPolitenessGate({
    clock,
    perOriginLimit: config.perOriginLimit,
    minIntervalMs: config.minIntervalMs,
    robots,
    fatalSignal: fatalControl.signal,
  });
  const signal = dependencies.signal;

  const onAbort = () => frontier.stop();
  if (signal) {
    if (signal.aborted) {
      frontier.stop();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  emitTrace(trace, "crawl-start", { url: config.startUrl });
  frontier.reserveStart();
  const startOrigin = new URL(config.startUrl).origin;
  const workers = [];
  for (let index = 0; index < config.concurrency; index += 1) {
    workers.push(runWorker(
      frontier,
      gate,
      robots,
      http,
      clock,
      logger,
      startOrigin,
      config,
      trace,
    ));
  }

  try {
    await Promise.allSettled(workers);
  } finally {
    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }
  }

  emitTrace(trace, "crawl-stop", { reason: traceStopReason(frontier) });

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
    stopReason: frontier.stopReason ?? "completed",
    config,
    pages: frontier.pages,
    robots: robots.summaries(),
    counts: countsFor(frontier.pages, frontier.fetchReservations),
  };
}

module.exports = {
  crawl,
};
