const { spawn } = require("node:child_process");
const path = require("node:path");
const { createFixtureServer } = require("./server");

function html(body) {
  return (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(body);
  };
}

function createDemoServer() {
  return createFixtureServer({
    routes: {
      "/robots.txt": (_req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("User-agent: *\nDisallow: /secret\n");
      },
      "/": html(
        '<a href="/docs">Docs</a>'
        + '<a href="/secret">Secret</a>'
        + '<a href="/missing">Missing</a>'
        + '<a href="/notes.txt">Notes</a>'
        + '<a href="https://example.com/outside">Outside</a>'
      ),
      "/docs": html("<p>Docs</p>"),
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
}

function runDemo(args = process.argv.slice(2)) {
  const server = createDemoServer();
  return server.listen().then(() => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(__dirname, "../../src/main.js"),
      `${server.origin}/`,
      "--min-interval",
      "0",
      "--depth",
      "1",
      ...args,
    ], { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      server.close().then(() => resolve(code ?? 1), reject);
    });
  }));
}

if (require.main === module) {
  runDemo().then((code) => {
    process.exit(code);
  }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  createDemoServer,
  runDemo,
};
