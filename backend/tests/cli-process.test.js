const { spawn } = require("node:child_process");
const path = require("node:path");
const { createFixtureServer } = require("./fixtures/server");

jest.setTimeout(20000);

const mainPath = path.join(__dirname, "../src/main.js");
const PAGE_FIELDS = [
  "canonicalUrl",
  "requestedUrl",
  "finalUrl",
  "discoveredFrom",
  "depth",
  "state",
  "skipReason",
  "waitedMs",
  "statusCode",
  "contentType",
  "durationMs",
  "byteLength",
  "attempts",
  "errorKind",
  "errorMessage",
];
const RESULT_FIELDS = [
  "schemaVersion",
  "startUrl",
  "startedAt",
  "finishedAt",
  "durationMs",
  "stopReason",
  "config",
  "pages",
  "robots",
  "counts",
];

function html(body) {
  return (_req, res) => {
    res.writeHead(200, { "Content-Type": 'text/html; charset="utf-8, x"' });
    res.end(body);
  };
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mainPath, ...args], {
      cwd: path.join(__dirname, ".."),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

describe("CLI child process", () => {
  let server;

  beforeAll(async () => {
    server = createFixtureServer({
      routes: {
        "/": html('<a href="/child">child</a><a href="/missing">missing</a><a href="/notes.txt">notes</a>'),
        "/child": html("<p>child</p>"),
        "/missing": (_req, res) => {
          res.writeHead(404, { "Content-Type": "text/html" });
          res.end("missing");
        },
        "/notes.txt": (_req, res) => {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("notes");
        },
      },
    });
    await server.listen();
  });

  afterAll(async () => {
    await server.close();
  });

  test.each([
    [[], /startUrl/],
    [["--bogus"], /--bogus/],
    [["ftp://example.com/"], /http or https/],
    [["https://example.com/", "https://other.example/"], /one URL/],
  ])("bad arguments %j exit 2", async (args, pattern) => {
    const result = await runCli(args);

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(pattern);
    expect(result.stdout).toBe("");
  });

  test("an explicit depth of 0 prints the summary and does not fetch the child", async () => {
    const start = `${server.origin}/`;
    const result = await runCli([
      start,
      "--depth",
      "0",
      "--min-interval",
      "0",
      "--max-pages",
      "10",
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`completed ${start}`);
    expect(result.stdout).toContain(`ok 200 ${start} depth 0`);
    expect(result.stdout).toContain(`skipped ${server.origin}/child depth 1 depth-limit`);
    expect(result.stdout).toContain(`skipped ${server.origin}/missing depth 1 depth-limit`);
    expect(result.stdout).toContain(`skipped ${server.origin}/notes.txt depth 1 depth-limit`);
    expect(result.stdout).toContain("failed 0");
    expect(result.stdout).not.toContain("failed 404");
    expect(server.requests.some((request) => request.path === "/child")).toBe(false);
  });

  test("JSON on stdout parses and matches the result shape", async () => {
    const start = `${server.origin}/`;
    const result = await runCli([
      start,
      "--format",
      "json",
      "--depth",
      "0",
      "--min-interval",
      "0",
      "--max-pages",
      "10",
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout.trim().startsWith("{")).toBe(true);
    const parsed = JSON.parse(result.stdout);
    expect(Object.keys(parsed)).toEqual(RESULT_FIELDS);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.startUrl).toBe(start);
    expect(parsed.stopReason).toBe("completed");
    expect(parsed.config.maxDepth).toBe(0);
    expect(parsed.counts).toEqual({
      reserved: 1,
      queued: 0,
      fetched: 1,
      ok: 1,
      skipped: 3,
      failed: 0,
    });
    expect(Object.keys(parsed.pages[0])).toEqual(PAGE_FIELDS);
    expect(parsed.pages.map((page) => page.skipReason)).toEqual([
      null,
      "depth-limit",
      "depth-limit",
      "depth-limit",
    ]);
    expect(parsed.robots).toEqual([
      {
        origin: server.origin,
        statusCode: 404,
        outcome: "allow-all",
        errorKind: null,
      },
    ]);
    expect(result.stderr.startsWith(`completed ${start}`)).toBe(true);
    expect(result.stderr).toContain("depth-limit");
  });

  test("CSV on stdout quotes a comma and a quote from the crawl", async () => {
    const result = await runCli([
      `${server.origin}/`,
      "--format",
      "csv",
      "--depth",
      "0",
      "--min-interval",
      "0",
      "--max-pages",
      "10",
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout.startsWith(PAGE_FIELDS.join(","))).toBe(true);
    expect(result.stdout).toContain('"text/html; charset=""utf-8, x"""');
    expect(result.stderr).toContain(`ok 200 ${server.origin}/`);
  });

  test("a crawl with a failed page shows ok, skipped, and failed", async () => {
    const start = `${server.origin}/`;
    const result = await runCli([
      start,
      "--depth",
      "1",
      "--min-interval",
      "0",
      "--max-pages",
      "10",
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`ok 200 ${start} depth 0`);
    expect(result.stdout).toContain(`failed 404 ${server.origin}/missing depth 1 http-status HTTP 404`);
    expect(result.stdout).toContain(`skipped ${server.origin}/notes.txt depth 1 non-html`);
    expect(result.stdout).toContain(`ok 200 ${server.origin}/child depth 1`);
  });
});
