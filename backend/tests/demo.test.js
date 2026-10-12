const { spawn } = require("node:child_process");
const path = require("node:path");

jest.setTimeout(20000);

const demoPath = path.join(__dirname, "fixtures/demo.js");

function runDemo(args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [demoPath, ...args], {
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

test("the fixture demo prints a summary and exits 0", async () => {
  const result = await runDemo();

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("ok 200");
  expect(result.stdout).toContain("skipped");
  expect(result.stdout).toContain("robots");
  expect(result.stdout).toContain("failed 404");
  expect(result.stdout).toContain("non-html");
  expect(result.stdout).toContain("other-origin");
  expect(result.stdout).toContain("depth 1 robots");
});

test("the fixture demo can print JSON", async () => {
  const result = await runDemo(["--format", "json"]);
  const parsed = JSON.parse(result.stdout);

  expect(result.code).toBe(0);
  expect(parsed.schemaVersion).toBe(1);
  expect(parsed.stopReason).toBe("completed");
  expect(parsed.config.maxDepth).toBe(1);
  expect(parsed.config.minIntervalMs).toBe(0);
  expect(parsed.pages.some((page) => page.state === "failed")).toBe(true);
  expect(result.stderr).toContain("failed 404");
});
