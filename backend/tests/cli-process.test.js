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

  test.each([
    [["--format", "json", "--details"], /console output/],
    [["--format", "csv", "--details"], /console output/],
    [["--details=true"], /does not take an argument/],
    [["--trace=1"], /does not take an argument/],
  ])("rejected presentation %j exits 2 before a fetch", async (args, pattern) => {
    const before = server.requests.length;
    const result = await runCli([`${server.origin}/`, ...args]);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(pattern);
    expect(server.requests.length).toBe(before);
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
    expect(result.stdout).toContain("crawl");
    expect(result.stdout).toContain("depth-limit");
    expect(result.stdout).not.toContain("/child");
    expect(result.stdout).not.toContain("http-status");
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
    expect(result.stderr).toContain("crawl");
    expect(result.stderr).toContain("depth-limit");
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
    expect(result.stdout).toContain("crawl");
    expect(result.stdout).toContain("http-status");
    expect(result.stdout).toContain("non-html");
    expect(result.stdout).not.toContain("/child");
    expect(result.stdout).not.toContain("/missing");
  });
});
