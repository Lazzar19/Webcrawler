function row(flag, text) {
  return `  ${flag.padEnd(32)}${text}`;
}

function formatHelp() {
  const lines = [
    "Usage",
    "  node backend/src/main.js <url> [flags]",
    "  npm start -- <url> [flags]",
    "",
    "One http or https URL, with no username or password. Flags may come before or after the URL.",
    "npm start needs its own -- before the URL so npm does not keep the flags.",
    "An omitted flag uses its default. A bad flag or a bad URL exits 2 before any fetch.",
    "",
    "Crawl",
    row("--depth <n>", "Inclusive page depth. Default 2. 0 fetches only the start URL."),
    row("--max-pages <n>", "How many URLs may be reserved for fetch, including the start URL. Default 50."),
    row("--concurrency <n>", "Worker loops, and the cap on in-flight work. Default 5."),
    row("--per-origin <n>", "How many workers may hold one origin at once. Default 2."),
    row("--min-interval <ms>", "Gap between request starts on one origin. Default 200. 0 is allowed."),
    row("--timeout <ms>", "Limit for one attempt, headers and body. Default 10000."),
    row("--max-duration <ms>", "Stop the crawl this long after it starts. Default off. 0 is rejected."),
    row("--max-attempts <n>", "Stop before the next HTTP attempt at this count. Default off. 0 is rejected."),
    row("--max-url-length <n>", "Skip a discovered key longer than this. Default 2048. The start URL is still fetched."),
    row("--max-path-depth <n>", "Skip a discovered path with more segments. Default 16. / is 0, /a//b is 3."),
    row("--max-segment-repeats <n>", "Skip a path that repeats one segment more than this. Default 2."),
    row("--user-agent <text>", "User-Agent header. It must not contain a control character."),
    row("--no-respect-robots", "Do not fetch robots.txt. The default reads it and fails closed when it cannot."),
    row("--no-dedupe-content", "Keep reserving links from a repeated HTML body. The default skips the later copy."),
    row("--no-canonical", "Do not follow rel=canonical. The default reserves that target at the same depth."),
    "",
    "Output",
    row("--format <name>", "console, json, or csv. Default console. json and csv go to stdout, the summary to stderr."),
    row("--output <path>", "Write the chosen format to this file. The summary stays on stdout."),
    row("--details", "Print the page table after the summary. Console only. json or csv with this flag exits 2."),
    row("--trace", "Event lines on stderr, after the summary when the summary is already there. Valid with every format."),
    row("--help, -h", "Show this text and do not crawl."),
    "",
    "These flags take no value: --details, --trace, --help, -h, --no-respect-robots, --no-dedupe-content, --no-canonical.",
    "The local demo already sets --depth 1 and --min-interval 0, so do not pass those two again:",
    "  node backend/tests/fixtures/demo.js",
    "  node backend/tests/fixtures/demo.js --details",
    "  node backend/tests/fixtures/demo.js --format json --trace",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

module.exports = {
  formatHelp,
};
