const { formatConsole, formatDetails } = require("../src/report/console.js");
const { COLUMNS, formatCsv } = require("../src/report/csv.js");
const { formatJson } = require("../src/report/json.js");
const { renderReport } = require("../src/report/render.js");
const { ConfigError } = require("../src/crawler/crawl-config.js");

const SAMPLE = `completed https://example.com/ 840ms

crawl
  reserved  4
  fetched   2
  ok        1
  skipped   2
  failed    1
  queued    0

skipped
  non-html  1
  robots    1

failed
  http-status  1

robots
  https://example.com  allow-all 404
`;

function page(fields) {
  return {
    canonicalUrl: "https://example.com/",
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    discoveredFrom: null,
    depth: 0,
    state: "ok",
    skipReason: null,
    waitedMs: null,
    statusCode: 200,
    contentType: "text/html",
    durationMs: 10,
    byteLength: 5,
    attempts: 1,
    errorKind: null,
    errorMessage: null,
    ...fields,
  };
}

function sampleResult() {
  return {
    schemaVersion: 1,
    startUrl: "https://example.com/",
    startedAt: "2026-10-12T00:00:00.000Z",
    finishedAt: "2026-10-12T00:00:00.840Z",
    durationMs: 840,
    stopReason: "completed",
    config: { startUrl: "https://example.com/" },
    pages: [
      page({
        canonicalUrl: "https://example.com/",
        requestedUrl: "https://example.com/",
        finalUrl: "https://example.com/",
        depth: 0,
        state: "ok",
        statusCode: 200,
      }),
      page({
        canonicalUrl: "https://example.com/secret",
        requestedUrl: "https://example.com/secret",
        finalUrl: null,
        depth: 1,
        state: "skipped",
        skipReason: "robots",
        statusCode: null,
        attempts: 0,
      }),
      page({
        canonicalUrl: "https://example.com/missing",
        requestedUrl: "https://example.com/missing",
        finalUrl: "https://example.com/missing",
        depth: 1,
        state: "failed",
        statusCode: 404,
        errorKind: "http-status",
        errorMessage: "HTTP 404",
      }),
      page({
        canonicalUrl: "https://example.com/notes.txt",
        requestedUrl: "https://example.com/notes.txt",
        finalUrl: "https://example.com/notes.txt",
        depth: 1,
        state: "skipped",
        skipReason: "non-html",
        statusCode: null,
      }),
      page({
        canonicalUrl: "https://example.com/later",
        requestedUrl: "https://example.com/later",
        finalUrl: null,
        depth: 1,
        state: "queued",
        statusCode: null,
        attempts: 0,
      }),
    ],
    robots: [
      {
        origin: "https://example.com",
        statusCode: 404,
        outcome: "allow-all",
        errorKind: null,
      },
    ],
    counts: {
      reserved: 4,
      fetched: 2,
      ok: 1,
      skipped: 2,
      failed: 1,
      queued: 0,
    },
  };
}

test("the console summary matches the sample, including each line kind", () => {
  expect(formatConsole(sampleResult())).toBe(SAMPLE);
  expect(SAMPLE).not.toContain("https://example.com/secret");
  expect(SAMPLE).not.toContain("https://example.com/missing");
});

test("the summary pads labels and counts, and sorts reasons by count then name", () => {
  const result = sampleResult();
  result.counts = {
    reserved: 12,
    fetched: 8,
    ok: 5,
    skipped: 6,
    failed: 1,
    queued: 0,
  };
  result.pages = [
    page({ state: "skipped", skipReason: "robots", statusCode: null, canonicalUrl: "https://example.com/r" }),
    page({ state: "skipped", skipReason: "other-origin", statusCode: null, canonicalUrl: "https://example.com/o" }),
    page({ state: "skipped", skipReason: "depth-limit", statusCode: null, canonicalUrl: "https://example.com/d1" }),
    page({ state: "skipped", skipReason: "other-origin", statusCode: null, canonicalUrl: "https://example.com/o2" }),
    page({ state: "skipped", skipReason: "depth-limit", statusCode: null, canonicalUrl: "https://example.com/d2" }),
    page({ state: "skipped", skipReason: "depth-limit", statusCode: null, canonicalUrl: "https://example.com/d3" }),
    page({ state: "failed", errorKind: "http-status", statusCode: 404, canonicalUrl: "https://example.com/missing" }),
  ];

  expect(formatConsole(result)).toBe(`completed https://example.com/ 840ms

crawl
  reserved  12
  fetched    8
  ok         5
  skipped    6
  failed     1
  queued     0

skipped
  depth-limit   3
  other-origin  2
  robots        1

failed
  http-status  1

robots
  https://example.com  allow-all 404
`);
});

test("a null status is omitted from the robots line, and a redirect is not a summary line", () => {
  const result = sampleResult();
  result.pages = [
    page({
      canonicalUrl: "https://example.com/old",
      requestedUrl: "https://example.com/old",
      finalUrl: "https://example.com/new",
      state: "ok",
      statusCode: 200,
      depth: 0,
    }),
    page({
      canonicalUrl: "https://example.com/big",
      requestedUrl: "https://example.com/big",
      finalUrl: null,
      state: "failed",
      statusCode: null,
      depth: 0,
      errorKind: "too-large",
      errorMessage: "response exceeds 10 bytes",
    }),
  ];
  result.robots = [
    {
      origin: "https://example.com",
      statusCode: null,
      outcome: "unavailable",
      errorKind: "timeout",
    },
  ];
  result.counts = {
    reserved: 2,
    fetched: 1,
    ok: 1,
    skipped: 0,
    failed: 1,
    queued: 0,
  };

  expect(formatConsole(result)).toBe(`completed https://example.com/ 840ms

crawl
  reserved  2
  fetched   1
  ok        1
  skipped   0
  failed    1
  queued    0

failed
  too-large  1

robots
  https://example.com  unavailable timeout
`);
  expect(formatConsole(result)).not.toContain("https://example.com/new");
  expect(formatConsole(result)).not.toContain("response exceeds");
});

test("a fetching record does not throw and stays out of the summary", () => {
  const result = sampleResult();
  result.pages = [
    page({
      canonicalUrl: "https://example.com/open",
      requestedUrl: "https://example.com/open",
      finalUrl: "https://example.com/landed",
      state: "fetching",
      statusCode: null,
      contentType: null,
      byteLength: null,
      attempts: 0,
    }),
  ];
  result.robots = [];
  result.counts = { reserved: 1, fetched: 0, ok: 0, skipped: 0, failed: 0, queued: 0 };

  expect(formatConsole(result)).toBe(`completed https://example.com/ 840ms

crawl
  reserved  1
  fetched   0
  ok        0
  skipped   0
  failed    0
  queued    0
`);
  expect(formatConsole(result)).not.toContain("https://example.com/open");
});

test("--details lists pages in result order after the summary", () => {
  const result = sampleResult();
  result.pages = [
    page({ canonicalUrl: "https://example.com/b", requestedUrl: "https://example.com/b", finalUrl: "https://example.com/b", state: "skipped", skipReason: "depth-limit", statusCode: null }),
    page({ canonicalUrl: "https://example.com/a", requestedUrl: "https://example.com/a", finalUrl: "https://example.com/a", state: "skipped", skipReason: "page-limit", statusCode: null }),
  ];
  result.robots = [];
  result.counts = { reserved: 1, fetched: 0, ok: 0, skipped: 2, failed: 0, queued: 0 };

  const summary = formatConsole(result);
  expect(summary).not.toContain("https://example.com/b");
  expect(summary).not.toContain("https://example.com/a");

  const text = formatDetails(result);
  expect(text.indexOf(summary.trimEnd())).toBe(0);
  expect(text.indexOf("https://example.com/b")).toBeLessThan(text.indexOf("https://example.com/a"));
  expect(text).not.toContain("URLs may be shortened");
});

test("--details prints the page table and shortens only a long display URL", () => {
  const longPath = `/${"a".repeat(50)}`;
  const longUrl = `https://example.com${longPath}`;
  const wideOrigin = `http://${"x".repeat(55)}`;
  const wideUrl = `${wideOrigin}/secret`;
  const result = sampleResult();
  result.pages = [
    page({
      canonicalUrl: "https://example.com/",
      requestedUrl: "https://example.com/",
      finalUrl: "https://example.com/",
      depth: 0,
      state: "ok",
      statusCode: 200,
    }),
    page({
      canonicalUrl: "https://example.com/private",
      requestedUrl: "https://example.com/private",
      finalUrl: null,
      depth: 1,
      state: "skipped",
      skipReason: "robots",
      statusCode: null,
      attempts: 0,
    }),
    page({
      canonicalUrl: "https://example.com/missing",
      requestedUrl: "https://example.com/missing",
      finalUrl: "https://example.com/missing",
      depth: 1,
      state: "failed",
      statusCode: 404,
      errorKind: "http-status",
      errorMessage: "HTTP 404",
    }),
    page({
      canonicalUrl: "https://example.com/notes.txt",
      requestedUrl: "https://example.com/notes.txt",
      finalUrl: "https://example.com/notes.txt",
      depth: 1,
      state: "skipped",
      skipReason: "non-html",
      statusCode: null,
    }),
  ];
  result.robots = [];
  result.counts = { reserved: 3, fetched: 3, ok: 1, skipped: 2, failed: 1, queued: 0 };

  const fitted = formatDetails(result);
  expect(fitted).toContain(`pages
  STATE     STATUS  DEPTH  URL                            REASON
  ok        200     0      https://example.com/           -
  skipped   -       1      https://example.com/private    robots
  failed    404     1      https://example.com/missing    http-status
  skipped   -       1      https://example.com/notes.txt  non-html
`);
  expect(fitted).not.toContain("URLs may be shortened");
  expect(fitted).not.toContain("HTTP 404");

  result.pages.push(
    page({ canonicalUrl: longUrl, requestedUrl: longUrl, finalUrl: longUrl, depth: 1, state: "ok", statusCode: 200 }),
    page({ canonicalUrl: wideUrl, requestedUrl: wideUrl, finalUrl: wideUrl, depth: 1, state: "queued", statusCode: null, attempts: 0 }),
  );
  const shortened = formatDetails(result);
  const origin = "https://example.com";
  const rest = longPath;
  const budget = 64 - origin.length - 3;
  const head = Math.ceil(budget / 2);
  const tail = budget - head;
  const middle = `${origin}${rest.slice(0, head)}...${rest.slice(-tail)}`;
  expect(shortened).toContain(middle);
  expect(shortened).toContain(`${wideOrigin}...`);
  expect(shortened).not.toContain(longUrl);
  expect(shortened).not.toContain(`${wideOrigin}/secret`);
  expect(shortened.endsWith("URLs may be shortened for terminal display; use --format json or --format csv for complete values.\n")).toBe(true);
  expect(JSON.parse(formatJson(result)).pages.some((item) => item.canonicalUrl === longUrl)).toBe(true);
});

test("JSON is the result with no extra fields", () => {
  const result = sampleResult();
  const text = formatJson(result);
  expect(text.endsWith("\n")).toBe(true);
  expect(JSON.parse(text)).toEqual(result);
});

test("CSV uses the page columns, empty cells for null, and quotes special characters", () => {
  const result = sampleResult();
  result.pages = [
    page({
      canonicalUrl: "https://example.com/a",
      requestedUrl: "https://example.com/a",
      finalUrl: null,
      discoveredFrom: null,
      depth: 1,
      state: "failed",
      skipReason: null,
      waitedMs: null,
      statusCode: null,
      contentType: null,
      durationMs: null,
      byteLength: null,
      attempts: 1,
      errorKind: "http-status",
      errorMessage: 'say "hi",\nnext',
    }),
  ];

  expect(formatCsv(result)).toBe(
    `${COLUMNS.join(",")}\nhttps://example.com/a,https://example.com/a,,,1,failed,,,,,,,1,http-status,"say ""hi"",\nnext"\n`
  );
});

test("stdout carries one artifact, and --output keeps the summary on stdout", () => {
  const result = sampleResult();

  expect(renderReport(result, {}).stdout).toBe(formatConsole(result));
  expect(renderReport(result, {}).stderr).toBe("");
  expect(renderReport(result, {}).file).toBeNull();

  const jsonOut = renderReport(result, { format: "json" });
  expect(jsonOut.stdout).toBe(formatJson(result));
  expect(jsonOut.stderr).toBe(formatConsole(result));
  expect(jsonOut.file).toBeNull();

  const csvFile = renderReport(result, { format: "csv", output: "out.csv" });
  expect(csvFile.stdout).toBe(formatConsole(result));
  expect(csvFile.stderr).toBe("");
  expect(csvFile.file).toEqual({ path: "out.csv", text: formatCsv(result) });

  const detailed = renderReport(result, { details: true });
  expect(detailed.stdout).toBe(formatDetails(result));
  expect(detailed.stdout).toContain("pages");
  expect(detailed.stderr).toBe("");

  const detailedFile = renderReport(result, { details: true, output: "out.txt" });
  expect(detailedFile.stdout).toBe(formatDetails(result));
  expect(detailedFile.stderr).toBe("");
  expect(detailedFile.file).toEqual({ path: "out.txt", text: formatDetails(result) });
});

test("an unknown format is a ConfigError", () => {
  expect(() => renderReport(sampleResult(), { format: "yaml" })).toThrow(ConfigError);
  expect(() => renderReport(sampleResult(), { format: "yaml" })).toThrow(/yaml/);
});
