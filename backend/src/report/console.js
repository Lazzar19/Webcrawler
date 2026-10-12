const CRAWL_LABELS = ["reserved", "fetched", "ok", "skipped", "failed", "queued"];
const URL_LIMIT = 64;
const SHORT_NOTE = "URLs may be shortened for terminal display; use --format json or --format csv for complete values.";

function byCountThenName(left, right) {
  if (left.count !== right.count) {
    return right.count - left.count;
  }
  if (left.name < right.name) {
    return -1;
  }
  if (left.name > right.name) {
    return 1;
  }
  return 0;
}

function tally(pages, state, field) {
  const counts = new Map();
  for (const page of pages) {
    if (page.state !== state) {
      continue;
    }
    const name = page[field];
    if (name == null) {
      continue;
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort(byCountThenName);
}

function countBlock(title, rows) {
  const labelWidth = Math.max(...rows.map((row) => row.name.length));
  const countWidth = Math.max(...rows.map((row) => String(row.count).length));
  const lines = rows.map((row) => {
    const label = row.name.padEnd(labelWidth);
    const count = String(row.count).padStart(countWidth);
    return `  ${label}  ${count}`;
  });
  return [title, ...lines].join("\n");
}

function robotLine(entry) {
  let line = `  ${entry.origin}  ${entry.outcome}`;
  if (entry.statusCode != null) {
    line += ` ${entry.statusCode}`;
  }
  if (entry.errorKind != null) {
    line += ` ${entry.errorKind}`;
  }
  return line;
}

function displayUrl(url) {
  if (url.length <= URL_LIMIT) {
    return { text: url, shortened: false };
  }
  const origin = new URL(url).origin;
  if (origin.length + 3 >= URL_LIMIT) {
    return { text: `${origin}...`, shortened: true };
  }
  const budget = URL_LIMIT - origin.length - 3;
  const head = Math.ceil(budget / 2);
  const tail = budget - head;
  const rest = url.slice(origin.length);
  return {
    text: `${origin}${rest.slice(0, head)}...${rest.slice(-tail)}`,
    shortened: true,
  };
}

function statusCell(page) {
  if ((page.state === "ok" || page.state === "failed") && page.statusCode != null) {
    return String(page.statusCode);
  }
  return "-";
}

function reasonCell(page) {
  if (page.state === "skipped") {
    return page.skipReason ?? "-";
  }
  if (page.state === "failed") {
    return page.errorKind ?? "-";
  }
  return "-";
}

function formatConsole(result) {
  const counts = result.counts;
  const blocks = [
    `${result.stopReason} ${result.startUrl} ${result.durationMs}ms`,
    countBlock("crawl", CRAWL_LABELS.map((name) => ({ name, count: counts[name] }))),
  ];
  const skipped = tally(result.pages, "skipped", "skipReason");
  if (skipped.length > 0) {
    blocks.push(countBlock("skipped", skipped));
  }
  const failed = tally(result.pages, "failed", "errorKind");
  if (failed.length > 0) {
    blocks.push(countBlock("failed", failed));
  }
  if (result.robots.length > 0) {
    blocks.push(["robots", ...result.robots.map(robotLine)].join("\n"));
  }
  return `${blocks.join("\n\n")}\n`;
}

function formatDetails(result) {
  const shown = result.pages.map((page) => ({
    page,
    url: displayUrl(page.canonicalUrl),
  }));
  const urlWidth = Math.max(3, ...shown.map((row) => row.url.text.length));
  const header = [
    "STATE".padEnd(8),
    "STATUS".padEnd(6),
    "DEPTH".padEnd(5),
    "URL".padEnd(urlWidth),
    "REASON",
  ].join("  ");
  const rows = shown.map(({ page, url }) => [
    String(page.state).padEnd(8),
    statusCell(page).padEnd(6),
    String(page.depth).padEnd(5),
    url.text.padEnd(urlWidth),
    reasonCell(page),
  ].join("  "));
  const table = ["pages", `  ${header}`, ...rows.map((row) => `  ${row}`)].join("\n");
  const note = shown.some((row) => row.url.shortened) ? `\n${SHORT_NOTE}` : "";
  return `${formatConsole(result)}\n${table}${note}\n`;
}

module.exports = {
  formatConsole,
  formatDetails,
};
