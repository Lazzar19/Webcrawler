const fs = require("node:fs");
const path = require("node:path");
const { formatConsole } = require("../src/report/console.js");
const { formatCsv } = require("../src/report/csv.js");
const { formatJson } = require("../src/report/json.js");

function sourceText(dir) {
  let text = "";
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      text += sourceText(full);
    } else if (entry.name.endsWith(".js")) {
      text += fs.readFileSync(full, "utf8");
    }
  }
  return text;
}

function page(url, depth, state) {
  return {
    canonicalUrl: url,
    requestedUrl: url,
    finalUrl: url,
    discoveredFrom: null,
    depth,
    state,
    skipReason: state === "skipped" ? "depth-limit" : null,
    waitedMs: null,
    statusCode: state === "ok" ? 200 : null,
    contentType: state === "ok" ? "text/html" : null,
    durationMs: null,
    byteLength: null,
    attempts: state === "ok" ? 1 : 0,
    errorKind: null,
    errorMessage: null,
  };
}

function resultWithPages(pages) {
  return {
    schemaVersion: 1,
    startUrl: "https://example.com/",
    startedAt: "2026-10-12T00:00:00.000Z",
    finishedAt: "2026-10-12T00:00:00.010Z",
    durationMs: 10,
    stopReason: "completed",
    config: { startUrl: "https://example.com/" },
    pages,
    robots: [],
    counts: { reserved: pages.length, fetched: 1, ok: 1, skipped: 1, failed: 0, queued: 0 },
  };
}

const later = "https://example.com/z";
const earlier = "https://example.com/a";

test("the source tree has no Desktop writer", () => {
  const src = sourceText(path.join(__dirname, "../src"));
  expect(src).not.toMatch(/getDesktopPath|saveToCSV|printReport|sortPages|\/mnt\/c\/Users|Desktop/);
});

test("console, JSON, and CSV keep pages in creation order", () => {
  const result = resultWithPages([
    page(later, 1, "skipped"),
    page(earlier, 0, "ok"),
  ]);

  const consoleText = formatConsole(result);
  expect(consoleText.indexOf(later)).toBeLessThan(consoleText.indexOf(earlier));

  const parsed = JSON.parse(formatJson(result));
  expect(parsed.pages.map((item) => item.canonicalUrl)).toEqual([later, earlier]);

  const rows = formatCsv(result).trimEnd().split("\n").slice(1);
  expect(rows[0].startsWith(later)).toBe(true);
  expect(rows[1].startsWith(earlier)).toBe(true);
});
