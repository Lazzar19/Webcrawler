const { formatConsole } = require("../src/report/console.js");
const { COLUMNS, formatCsv } = require("../src/report/csv.js");
const { formatJson } = require("../src/report/json.js");
const { renderReport } = require("../src/report/render.js");
const { ConfigError } = require("../src/crawler/crawl-config.js");

const SAMPLE = `completed https://example.com/ 840ms
reserved 4 fetched 2 ok 1 skipped 2 failed 1 queued 0

ok 200 https://example.com/ depth 0
skipped https://example.com/secret depth 1 robots
failed 404 https://example.com/missing depth 1 http-status HTTP 404
skipped https://example.com/notes.txt depth 1 non-html
queued https://example.com/later depth 1

robots https://example.com allow-all 404
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
});

test("a redirect appends final, and a null status is omitted", () => {
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
reserved 2 fetched 1 ok 1 skipped 0 failed 1 queued 0

ok 200 https://example.com/old depth 0 final https://example.com/new
failed https://example.com/big depth 0 too-large response exceeds 10 bytes

robots https://example.com unavailable timeout
`);
});

test("pages stay in result order", () => {
  const result = sampleResult();
  result.pages = [
    page({ canonicalUrl: "https://example.com/b", requestedUrl: "https://example.com/b", finalUrl: "https://example.com/b", state: "skipped", skipReason: "depth-limit", statusCode: null }),
    page({ canonicalUrl: "https://example.com/a", requestedUrl: "https://example.com/a", finalUrl: "https://example.com/a", state: "skipped", skipReason: "page-limit", statusCode: null }),
  ];
  result.robots = [];
  result.counts = { reserved: 1, fetched: 0, ok: 0, skipped: 2, failed: 0, queued: 0 };

  const text = formatConsole(result);
  expect(text.indexOf("https://example.com/b")).toBeLessThan(text.indexOf("https://example.com/a"));
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
});

test("an unknown format is a ConfigError", () => {
  expect(() => renderReport(sampleResult(), { format: "yaml" })).toThrow(ConfigError);
  expect(() => renderReport(sampleResult(), { format: "yaml" })).toThrow(/yaml/);
});
