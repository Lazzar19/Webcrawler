const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("the image follows the Node pin, runs as a user, and stays unpublished", () => {
  const nodeMajor = read("backend/.nvmrc").trim();
  const dockerfile = read("Dockerfile");
  const ignore = read(".dockerignore");
  const fromLines = dockerfile.match(/^FROM /gm);

  expect(nodeMajor).toBe("24");
  expect(fromLines).toHaveLength(2);
  expect(dockerfile).toContain(`node:${nodeMajor}-bookworm-slim AS deps`);
  expect(dockerfile).toContain(`node:${nodeMajor}-bookworm-slim AS runtime`);
  expect(dockerfile).toMatch(/^USER appuser$/m);
  expect(dockerfile).toContain("npm ci --omit=dev");
  expect(dockerfile).toContain("backend/tests/fixtures/demo.js");
  expect(dockerfile).not.toMatch(/docker (login|push)|ghcr\.io|trivy|snyk|grype/i);
  expect(ignore).toContain("**/.npmrc");
  expect(ignore).toContain("node_modules/");
  expect(ignore).toContain(".env");
});
