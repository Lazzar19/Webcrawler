const PAGE_STATES = new Set(["ok", "skipped", "failed", "queued", "fetching"]);

function pageLine(page) {
  if (!PAGE_STATES.has(page.state)) {
    throw new Error(`Unknown page state: ${page.state}`);
  }

  const parts = [page.state];
  if ((page.state === "ok" || page.state === "failed") && page.statusCode != null) {
    parts.push(String(page.statusCode));
  }
  parts.push(page.canonicalUrl, "depth", String(page.depth));
  if (page.state === "skipped" && page.skipReason != null) {
    parts.push(page.skipReason);
  }
  if (page.state === "failed") {
    if (page.errorKind != null) {
      parts.push(page.errorKind);
    }
    if (page.errorMessage != null) {
      parts.push(page.errorMessage);
    }
  }
  if (page.finalUrl != null && page.finalUrl !== page.requestedUrl) {
    parts.push("final", page.finalUrl);
  }
  return parts.join(" ");
}

function robotLine(entry) {
  const parts = ["robots", entry.origin, entry.outcome];
  if (entry.statusCode != null) {
    parts.push(String(entry.statusCode));
  }
  if (entry.errorKind != null) {
    parts.push(entry.errorKind);
  }
  return parts.join(" ");
}

function formatConsole(result) {
  const counts = result.counts;
  const header = [
    `${result.stopReason} ${result.startUrl} ${result.durationMs}ms`,
    `reserved ${counts.reserved} fetched ${counts.fetched} ok ${counts.ok} skipped ${counts.skipped} failed ${counts.failed} queued ${counts.queued}`,
  ].join("\n");
  const pages = result.pages.map(pageLine).join("\n");
  const robots = result.robots.map(robotLine).join("\n");
  const blocks = [header, pages, robots].filter((block) => block !== "");
  return `${blocks.join("\n\n")}\n`;
}

module.exports = {
  formatConsole,
};
