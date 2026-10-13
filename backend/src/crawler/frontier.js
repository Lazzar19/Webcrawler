const { canonicalKey } = require("./url-policy");
const { emitTrace } = require("./trace");

function requestedSpelling(input) {
  const url = new URL(input);
  url.hash = "";
  return url.href;
}

function pathSegments(pathname) {
  const segments = pathname.split("/").slice(1);
  if (segments.length === 1 && segments[0] === "") {
    return [];
  }
  return segments;
}

function trapReason(key, config) {
  if (key.length > config.maxUrlLength) {
    return "url-length";
  }
  const segments = pathSegments(new URL(key).pathname);
  if (segments.length > config.maxPathDepth) {
    return "path-depth";
  }
  const seen = new Map();
  for (const segment of segments) {
    if (segment === "") {
      continue;
    }
    const count = (seen.get(segment) ?? 0) + 1;
    seen.set(segment, count);
    if (count > config.maxSegmentRepeats) {
      return "repeated-segment";
    }
  }
  return null;
}

function compareKey(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function blankPage(fields) {
  return {
    canonicalUrl: fields.canonicalUrl,
    requestedUrl: fields.requestedUrl,
    finalUrl: null,
    discoveredFrom: fields.discoveredFrom,
    depth: fields.depth,
    state: fields.state,
    skipReason: fields.skipReason ?? null,
    waitedMs: null,
    statusCode: null,
    contentType: null,
    durationMs: null,
    byteLength: null,
    attempts: 0,
    errorKind: null,
    errorMessage: null,
  };
}

function createFrontier({ config, clock, onFatal, trace }) {
  const startOrigin = new URL(requestedSpelling(config.startUrl)).origin;
  const pages = [];
  const queue = [];
  const seen = new Map();
  const waiters = [];
  const buffer = new Map();
  const contentHashes = new Set();
  let fetchReservations = 0;
  let inFlight = 0;
  let nextSequence = 0;
  let nextCommit = 0;
  let stopping = false;
  let stopReason = null;
  let fatalError = null;

  function makeQueued(fields) {
    const page = blankPage({ ...fields, state: "queued" });
    const item = { page, sequence: null, committed: false, links: [] };
    seen.set(page.canonicalUrl, item);
    pages.push(page);
    queue.push(item);
    fetchReservations += 1;
    emitTrace(trace, "reserved", {
      url: page.requestedUrl,
      depth: page.depth,
      reason: page.discoveredFrom === null ? "start" : "discovered",
    });
    return item;
  }

  function makeSkipped(fields, skipReason) {
    const page = blankPage({ ...fields, state: "skipped", skipReason });
    const item = { page, sequence: null, committed: true, links: [] };
    seen.set(page.canonicalUrl, item);
    pages.push(page);
    emitTrace(trace, "skipped", {
      url: page.requestedUrl,
      reason: skipReason,
    });
    return item;
  }

  function reserveStart() {
    const requestedUrl = requestedSpelling(config.startUrl);
    makeQueued({
      canonicalUrl: canonicalKey(requestedUrl),
      requestedUrl,
      discoveredFrom: null,
      depth: 0,
    });
  }

  function linksInCommitOrder(hrefs) {
    const spelling = new Map();
    for (const href of hrefs) {
      const key = canonicalKey(href);
      if (!spelling.has(key)) {
        spelling.set(key, href);
      }
    }
    return [...spelling.keys()].sort(compareKey).map((key) => ({
      key,
      spelling: spelling.get(key),
    }));
  }

  function consider(link, depth, discoveredFrom) {
    if (seen.has(link.key)) {
      return;
    }
    const fields = {
      canonicalUrl: link.key,
      requestedUrl: link.spelling,
      discoveredFrom,
      depth,
    };
    if (new URL(link.spelling).origin !== startOrigin) {
      makeSkipped(fields, "other-origin");
      return;
    }
    if (depth > config.maxDepth) {
      makeSkipped(fields, "depth-limit");
      return;
    }
    const guard = trapReason(link.key, config);
    if (guard !== null) {
      makeSkipped(fields, guard);
      return;
    }
    if (fetchReservations >= config.maxPages) {
      makeSkipped(fields, "page-limit");
      return;
    }
    makeQueued(fields);
  }

  function reserveLinks(parent, hrefs) {
    for (const link of linksInCommitOrder(hrefs)) {
      consider(link, parent.page.depth + 1, parent.page.canonicalUrl);
    }
  }

  function reserveCanonical(item) {
    if (item.canonicalTarget == null) {
      return;
    }
    consider(item.canonicalTarget, item.page.depth, item.page.canonicalUrl);
  }

  function pump() {
    if (stopping) {
      const pending = waiters.splice(0);
      for (const resolve of pending) {
        resolve(null);
      }
      return;
    }

    while (queue.length > 0 && waiters.length > 0) {
      const resolve = waiters.shift();
      const item = queue.shift();
      item.page.state = "fetching";
      item.sequence = nextSequence;
      nextSequence += 1;
      item.takenAt = clock.now();
      inFlight += 1;
      emitTrace(trace, "take", {
        url: item.page.requestedUrl,
        depth: item.page.depth,
        sequence: item.sequence,
      });
      resolve(item);
    }

    if (queue.length === 0 && inFlight === 0 && buffer.size === 0) {
      const pending = waiters.splice(0);
      for (const resolve of pending) {
        resolve(null);
      }
    }
  }

  function applyIdentity(item) {
    const hash = config.dedupeContent ? item.contentHash : null;
    if (hash != null && contentHashes.has(hash)) {
      item.page.state = "skipped";
      item.page.skipReason = "duplicate-content";
      item.links = [];
      item.canonicalTarget = null;
      return;
    }
    if (item.canonicalTarget != null) {
      if (hash != null) {
        contentHashes.add(hash);
      }
      item.page.state = "skipped";
      item.page.skipReason = "canonical";
      return;
    }
    if (hash != null) {
      contentHashes.add(hash);
    }
  }

  function drain() {
    while (buffer.has(nextCommit)) {
      const item = buffer.get(nextCommit);
      buffer.delete(nextCommit);
      inFlight -= 1;
      try {
        applyIdentity(item);
        if (!stopping) {
          if (item.page.skipReason === "canonical") {
            reserveCanonical(item);
          }
          reserveLinks(item, item.links);
        }
      } finally {
        emitTrace(trace, "commit", {
          sequence: item.sequence,
          state: item.page.state,
        });
        nextCommit += 1;
      }
    }
    pump();
  }

  return {
    pages,
    get fetchReservations() {
      return fetchReservations;
    },
    get fatalError() {
      return fatalError;
    },
    get stopping() {
      return stopping;
    },
    get stopReason() {
      return stopReason;
    },
    reserveStart,
    take() {
      return new Promise((resolve) => {
        waiters.push(resolve);
        pump();
      });
    },
    commit(item) {
      if (item.committed) {
        return;
      }
      item.committed = true;
      buffer.set(item.sequence, item);
      drain();
    },
    ownerOf(key) {
      return seen.get(key) ?? null;
    },
    alias(key, item) {
      seen.set(key, item);
    },
    fail(error, logger) {
      if (stopping) {
        logger.error(error);
        return;
      }
      fatalError = error;
      stopping = true;
      emitTrace(trace, "fatal", {
        message: error instanceof Error ? error.message : String(error),
      });
      if (onFatal) {
        onFatal();
      }
      pump();
    },
    stop(reason = "interrupted") {
      if (stopReason === null) {
        stopReason = reason;
      }
      if (!stopping) {
        stopping = true;
        pump();
      }
    },
  };
}

module.exports = {
  createFrontier,
  trapReason,
};
