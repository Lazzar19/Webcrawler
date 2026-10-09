const { canonicalKey } = require("./url-policy");

function requestedSpelling(input) {
  const url = new URL(input);
  url.hash = "";
  return url.href;
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

function createFrontier({ config, clock }) {
  const startOrigin = new URL(requestedSpelling(config.startUrl)).origin;
  const pages = [];
  const queue = [];
  const seen = new Map();
  const waiters = [];
  const buffer = new Map();
  let fetchReservations = 0;
  let inFlight = 0;
  let nextSequence = 0;
  let nextCommit = 0;
  let stopping = false;
  let fatalError = null;

  function makeQueued(fields) {
    const page = blankPage({ ...fields, state: "queued" });
    const item = { page, sequence: null, committed: false, links: [] };
    seen.set(page.canonicalUrl, item);
    pages.push(page);
    queue.push(item);
    fetchReservations += 1;
    return item;
  }

  function makeSkipped(fields, skipReason) {
    const page = blankPage({ ...fields, state: "skipped", skipReason });
    const item = { page, sequence: null, committed: true, links: [] };
    seen.set(page.canonicalUrl, item);
    pages.push(page);
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
      let key;
      try {
        key = canonicalKey(href);
      } catch {
        continue;
      }
      if (!spelling.has(key)) {
        spelling.set(key, href);
      }
    }
    return [...spelling.keys()].sort(compareKey).map((key) => ({
      key,
      spelling: spelling.get(key),
    }));
  }

  function reserveLinks(parent, hrefs) {
    for (const link of linksInCommitOrder(hrefs)) {
      if (seen.has(link.key)) {
        continue;
      }
      const depth = parent.page.depth + 1;
      const fields = {
        canonicalUrl: link.key,
        requestedUrl: link.spelling,
        discoveredFrom: parent.page.canonicalUrl,
        depth,
      };
      if (new URL(link.spelling).origin !== startOrigin) {
        makeSkipped(fields, "other-origin");
        continue;
      }
      if (depth > config.maxDepth) {
        makeSkipped(fields, "depth-limit");
        continue;
      }
      if (fetchReservations >= config.maxPages) {
        makeSkipped(fields, "page-limit");
        continue;
      }
      makeQueued(fields);
    }
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
      resolve(item);
    }

    if (queue.length === 0 && inFlight === 0 && buffer.size === 0) {
      const pending = waiters.splice(0);
      for (const resolve of pending) {
        resolve(null);
      }
    }
  }

  function drain() {
    while (buffer.has(nextCommit)) {
      const item = buffer.get(nextCommit);
      buffer.delete(nextCommit);
      inFlight -= 1;
      if (!stopping) {
        reserveLinks(item, item.links);
      }
      nextCommit += 1;
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
      pump();
    },
    stop() {
      stopping = true;
      pump();
    },
  };
}

module.exports = {
  createFrontier,
};
