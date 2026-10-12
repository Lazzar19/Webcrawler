const { EventEmitter } = require("node:events");
const { EXIT_SECOND_INTERRUPT, runCli } = require("../src/cli/run.js");

function streams() {
  const stdout = [];
  const stderr = [];
  return {
    stdout: { write(text) { stdout.push(text); } },
    stderr: { write(text) { stderr.push(text); } },
    out: () => stdout.join(""),
    err: () => stderr.join(""),
  };
}

function resultFor(startUrl) {
  return {
    schemaVersion: 1,
    startUrl,
    startedAt: "2026-10-12T00:00:00.000Z",
    finishedAt: "2026-10-12T00:00:00.010Z",
    durationMs: 10,
    stopReason: "completed",
    config: { startUrl },
    pages: [],
    robots: [],
    counts: { reserved: 1, fetched: 1, ok: 0, skipped: 0, failed: 1, queued: 0 },
  };
}

test("a bad URL exits 2 and does not crawl", async () => {
  const io = streams();
  let called = false;
  const code = await runCli(["ftp://example.com/"], {
    ...io,
    signals: new EventEmitter(),
    crawl() {
      called = true;
    },
  });

  expect(code).toBe(2);
  expect(called).toBe(false);
  expect(io.err()).toMatch(/startUrl/);
  expect(io.out()).toBe("");
});

test("an explicit depth of 0 is passed through and a failed page still exits 0", async () => {
  const io = streams();
  let seen = null;
  const code = await runCli(["https://example.com/", "--depth", "0"], {
    ...io,
    signals: new EventEmitter(),
    crawl(config) {
      seen = config;
      return resultFor(config.startUrl);
    },
  });

  expect(code).toBe(0);
  expect(seen.maxDepth).toBe(0);
  expect(io.out()).toContain("failed 1");
  expect(io.out().startsWith("completed https://example.com/")).toBe(true);
});

test("a crawl exception and a failed --output write exit 1", async () => {
  const crashed = streams();
  const crashCode = await runCli(["https://example.com/"], {
    ...crashed,
    signals: new EventEmitter(),
    crawl() {
      throw new Error("frontier broke");
    },
  });
  expect(crashCode).toBe(1);
  expect(crashed.err()).toBe("frontier broke\n");
  expect(crashed.out()).toBe("");

  const io = streams();
  let wrote = false;
  const code = await runCli(["https://example.com/", "--output", "out.json", "--format", "json"], {
    ...io,
    signals: new EventEmitter(),
    crawl(config) {
      return resultFor(config.startUrl);
    },
    writeFile() {
      wrote = true;
      throw new Error("disk full");
    },
  });
  expect(code).toBe(1);
  expect(wrote).toBe(true);
  expect(io.err()).toBe("disk full\n");
  expect(io.out()).toBe("");
});

test("json without --output puts JSON on stdout and the summary on stderr", async () => {
  const io = streams();
  const code = await runCli(["https://example.com/", "--format", "json"], {
    ...io,
    signals: new EventEmitter(),
    crawl(config) {
      return resultFor(config.startUrl);
    },
  });

  expect(code).toBe(0);
  expect(JSON.parse(io.out()).startUrl).toBe("https://example.com/");
  expect(io.err().startsWith("completed https://example.com/")).toBe(true);
});

test("the first SIGINT reports the partial result and exits 0", async () => {
  const io = streams();
  const signals = new EventEmitter();
  const pending = runCli(["https://example.com/"], {
    ...io,
    signals,
    crawl(_config, { signal }) {
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          resolve({
            ...resultFor("https://example.com/"),
            stopReason: "interrupted",
          });
        });
      });
    },
  });
  signals.emit("SIGINT");
  const code = await pending;

  expect(code).toBe(0);
  expect(io.out().startsWith("interrupted https://example.com/")).toBe(true);
});

test("the second SIGINT exits 130 without writing a report", async () => {
  const io = streams();
  const signals = new EventEmitter();
  let released = false;
  let exitCode = null;
  const files = [];
  const pending = runCli(["https://example.com/", "--output", "out.json"], {
    ...io,
    signals,
    exitNow(code) {
      exitCode = code;
    },
    writeFile(_path, text) {
      files.push(text);
    },
    crawl(_config, { signal }) {
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          released = true;
          resolve(resultFor("https://example.com/"));
        });
      });
    },
  });
  signals.emit("SIGINT");
  signals.emit("SIGINT");
  const code = await pending;

  expect(released).toBe(true);
  expect(exitCode).toBe(EXIT_SECOND_INTERRUPT);
  expect(code).toBe(130);
  expect(files).toEqual([]);
  expect(io.out()).toBe("");
});
