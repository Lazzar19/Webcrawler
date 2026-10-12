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

test("a user agent with a newline exits 2 and does not crawl", async () => {
  const io = streams();
  let called = false;
  const code = await runCli(["https://example.com/", "--user-agent", "Bot\r\nX-Extra: 1"], {
    ...io,
    signals: new EventEmitter(),
    crawl() {
      called = true;
    },
  });

  expect(code).toBe(2);
  expect(called).toBe(false);
  expect(io.err()).toMatch(/control characters/);
  expect(io.out()).toBe("");
});

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
  expect(io.out()).toMatch(/failed\s+1/);
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

test("--format json or csv with --details exits 2 and does not crawl", async () => {
  for (const format of ["json", "csv"]) {
    const io = streams();
    let called = false;
    const code = await runCli(["https://example.com/", "--format", format, "--details"], {
      ...io,
      signals: new EventEmitter(),
      crawl() {
        called = true;
      },
    });

    expect(code).toBe(2);
    expect(called).toBe(false);
    expect(io.out()).toBe("");
    expect(io.err()).toBe("--details is only valid with console output\n");
  }
});

test("a value on --details or --trace exits 2 and does not crawl", async () => {
  for (const arg of ["--details=true", "--trace=1"]) {
    const io = streams();
    let called = false;
    const code = await runCli(["https://example.com/", arg], {
      ...io,
      signals: new EventEmitter(),
      crawl() {
        called = true;
      },
    });

    expect(code).toBe(2);
    expect(called).toBe(false);
    expect(io.out()).toBe("");
    expect(io.err()).toMatch(/does not take an argument/);
  }
});

test("--trace places its text on stderr and never on stdout", async () => {
  const trace = "[trace] crawl-stop reason=completed\n";
  const jsonIo = streams();
  const jsonCode = await runCli(["https://example.com/", "--format", "json", "--trace"], {
    ...jsonIo,
    signals: new EventEmitter(),
    traceText: trace,
    crawl(config) {
      expect(config).not.toHaveProperty("trace");
      return resultFor(config.startUrl);
    },
  });
  expect(jsonCode).toBe(0);
  expect(JSON.parse(jsonIo.out()).startUrl).toBe("https://example.com/");
  expect(jsonIo.out()).not.toContain("[trace]");
  expect(jsonIo.err().startsWith("completed https://example.com/")).toBe(true);
  expect(jsonIo.err().endsWith(trace)).toBe(true);

  const quiet = streams();
  await runCli(["https://example.com/", "--format", "json"], {
    ...quiet,
    signals: new EventEmitter(),
    traceText: trace,
    crawl(config) {
      return resultFor(config.startUrl);
    },
  });
  expect(quiet.err()).not.toContain("[trace]");
  expect(quiet.out()).not.toContain("[trace]");

  const fileIo = streams();
  let written = null;
  const fileCode = await runCli(
    ["https://example.com/", "--output", "out.json", "--format", "json", "--trace"],
    {
      ...fileIo,
      signals: new EventEmitter(),
      traceText: trace,
      writeFile(path, text) {
        written = { path, text };
      },
      crawl(config) {
        return resultFor(config.startUrl);
      },
    },
  );
  expect(fileCode).toBe(0);
  expect(fileIo.out().startsWith("completed https://example.com/")).toBe(true);
  expect(fileIo.out()).not.toContain("[trace]");
  expect(fileIo.err()).toBe(trace);
  expect(written.path).toBe("out.json");
  expect(JSON.parse(written.text).startUrl).toBe("https://example.com/");
  expect(written.text).not.toContain("[trace]");

  const detailsIo = streams();
  let detailsFile = null;
  const detailsCode = await runCli(
    ["https://example.com/", "--output", "out.txt", "--details", "--trace"],
    {
      ...detailsIo,
      signals: new EventEmitter(),
      traceText: trace,
      writeFile(_path, text) {
        detailsFile = text;
      },
      crawl(config) {
        return resultFor(config.startUrl);
      },
    },
  );
  expect(detailsCode).toBe(0);
  expect(detailsIo.out()).toContain("pages");
  expect(detailsIo.out()).not.toContain("[trace]");
  expect(detailsIo.err()).toBe(trace);
  expect(detailsFile).toBe(detailsIo.out());
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
