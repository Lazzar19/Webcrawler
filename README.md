# Web Crawler

A single-process command-line crawler. It fetches one origin, keeps a record for every URL it accepts or skips, and prints that result. The CLI is the product. There is no web UI in this repository.

![Node.js](https://img.shields.io/badge/Node.js-24-green?style=flat&logo=node.js)
![JavaScript](https://img.shields.io/badge/JavaScript-ES2022-yellow?style=flat&logo=javascript)
![Jest](https://img.shields.io/badge/tested%20with-jest-orange?style=flat&logo=jest)
![License](https://img.shields.io/badge/license-ISC-blue?style=flat)

## About

The engine is a fixed set of workers pulling from one queue. URL identity, robots, timeouts, and politeness are separate decisions, and the tests lock them against a local HTTP server. [PLAN.md](PLAN.md) is the contract. This file is the tour.

## How a crawl works

### Queue

One crawl owns one FIFO queue and a `seen` map from canonical key to the record that owns it. `concurrency` is the number of worker loops, and that number is also the cap on in-flight work.

The start URL is reserved first, at depth 0. For each later link the first matching rule wins. A key already in `seen` is ignored. A different origin is `skipped` / `other-origin`. A link past `maxDepth` is `skipped` / `depth-limit`. When fetch reservations have already reached `maxPages`, the link is `skipped` / `page-limit`. Otherwise it is queued. The check and the insert happen together, with no await between them.

`maxDepth` is inclusive. A page at the limit is fetched, and its new links become `depth-limit` records. `maxPages` counts fetch reservations, including the start URL. An other-origin skip, a depth skip, and a page-limit skip do not take a slot. A robots disallow does: the URL was reserved before the check.

### Commit order

Workers finish in network order. That order cannot decide which links are queued, or two runs would diverge.

`take()` assigns a sequence number, `0`, then `1`, then `2`, before the worker starts the request. A finished item waits in a buffer. The frontier reserves links only for the next sequence number, then advances. A skipped or failed item commits an empty link list, so a hole cannot stall the queue. After Ctrl+C or a fatal error the counter still advances, and nothing new is reserved.

### Stable order

On one page, several `href` values can share a key. The spelling that is fetched is the earliest in document order. The remaining keys are sorted, and that sort does not replace the spelling. The same responses therefore produce the same records, in the same order, for any `concurrency`.

The queue is FIFO and reservation waits for commit order, so the crawl is breadth-first. A key is first discovered at its smallest depth.

The canonical key is the identity, not the request URL. It drops the fragment, omits the default port, and sorts the query. The full procedure is in [PLAN.md](PLAN.md). The request uses the reserved spelling.

### Redirects

The HTTP client does not follow redirects. The worker handles `301`, `302`, `303`, `307`, and `308` one hop at a time, and stops after 5. A hop that stays on the start origin and is not already owned becomes an alias of this record. An alias does not take another `maxPages` slot. The record keeps its original depth and `discoveredFrom`. `finalUrl` is the last URL that was actually requested.

A hop to another origin is `skipped` / `redirect-off-origin` and is not requested. A hop that returns to this chain is `failed` / `redirect-loop`. A sixth hop is `failed` / `redirect-limit`. A missing or unusable `Location` is `failed` / `bad-redirect`. A hop already owned by another record is `skipped` / `duplicate`.

### Politeness

`concurrency` and politeness are different limits. `concurrency` is how many workers exist. `perOriginLimit` is how many of those workers may hold a lease on one origin at once. A worker that cannot get a lease waits in a FIFO list for that origin.

`minIntervalMs` is the minimum gap between request starts to the same origin. The gap covers first attempts, retries, redirect hops, and `robots.txt`. The next start time is stored before the wait, so two workers cannot claim the same instant. A robots `Crawl-delay` larger than `minIntervalMs` replaces the gap, and the gap is then capped at 10 seconds. The `robots.txt` fetch itself still uses `minIntervalMs`, because the file has not been parsed yet.

### Failures

A bad start URL or a bad flag stops the process before any fetch and exits `2`. A failed page is a record. The crawl continues, and a finished crawl exits `0` even when some pages failed. An unexpected exception exits `1`.

The page error kinds are `timeout`, `dns`, `connect`, `reset`, `tls`, `too-large`, `http-status`, `redirect-loop`, `redirect-limit`, `bad-redirect`, and `parse`. Non-HTML is `skipped` / `non-html`, and the body is not read. Retries cover `timeout`, `connect`, `reset`, and statuses `429`, `500`, `502`, `503`, and `504`. `dns`, `tls`, `too-large`, redirects, and every other status are not retried.

If `robots.txt` cannot be read, the origin fails closed: later URLs there are `skipped` / `robots-unavailable`. A disallowed path is `skipped` / `robots` and is not requested.

The first Ctrl+C stops handing out queued work, lets in-flight requests finish, and prints the partial result with `stopReason` `interrupted`. The second Ctrl+C exits `130` without a report.

### Defaults

| Flag | Field | Default |
|---|---|---|
| `--depth` | `maxDepth` | `2` |
| `--max-pages` | `maxPages` | `50` |
| `--concurrency` | `concurrency` | `5` |
| `--per-origin` | `perOriginLimit` | `2` |
| `--min-interval` | `minIntervalMs` | `200` |
| `--timeout` | `timeoutMs` | `10000` |
| `--user-agent` | `userAgent` | `WebcrawlerBot/1.0 (+https://github.com/Lazzar19/webcrawler)` |
| `--no-respect-robots` | `respectRobots` | `true` |
| `--format` | stdout format | `console` |
| `--output` | file path | none |

An omitted flag uses the default. `--depth 0` is a real setting, not "missing". `--format` is `console`, `json`, or `csv`. With `json` or `csv` and no `--output`, that format is the only thing on stdout and the summary goes to stderr. `--output` writes the chosen format to that path, and the summary stays on stdout.

## Demo

From the repository root, with Node 24. The local site lives in [backend/tests/fixtures/demo.js](backend/tests/fixtures/demo.js). It serves a home page, `/docs`, a `robots.txt` that disallows `/secret`, a 404, a text file, and a link to `https://example.com/outside`. The command sets `--depth 1` and `--min-interval 0`, then runs the CLI. The port changes every run. The lines below are from one run with the port written as `9`.

```bash
npm install --prefix backend
node backend/tests/fixtures/demo.js
```

```text
completed http://127.0.0.1:9/ 125ms
reserved 5 fetched 4 ok 2 skipped 3 failed 1 queued 0

ok 200 http://127.0.0.1:9/ depth 0
ok 200 http://127.0.0.1:9/docs depth 1
failed 404 http://127.0.0.1:9/missing depth 1 http-status HTTP 404
skipped http://127.0.0.1:9/notes.txt depth 1 non-html
skipped http://127.0.0.1:9/secret depth 1 robots
skipped https://example.com/outside depth 1 other-origin

robots http://127.0.0.1:9 parsed 200
```

`/secret` was not requested. Neither was `https://example.com/outside`. `/secret` still counts as reserved, because the reservation happens before the robots check. The outside link does not.

To crawl some other origin:

```bash
node backend/src/main.js https://example.com/ --depth 1 --max-pages 20
```

## Sample report

`node backend/tests/fixtures/demo.js --format json` prints the `CrawlResult` on stdout and the summary on stderr. This is one run of that command. `startedAt`, `finishedAt`, `durationMs`, and `waitedMs` change between runs. The port in the sample is `9`.

```json
{
  "schemaVersion": 1,
  "startUrl": "http://127.0.0.1:9/",
  "startedAt": "2026-10-12T08:31:24.111Z",
  "finishedAt": "2026-10-12T08:31:24.236Z",
  "durationMs": 125,
  "stopReason": "completed",
  "config": {
    "maxDepth": 1,
    "maxPages": 50,
    "concurrency": 5,
    "perOriginLimit": 2,
    "minIntervalMs": 0,
    "timeoutMs": 10000,
    "maxResponseBytes": 1000000,
    "retryCount": 2,
    "retryBaseDelayMs": 500,
    "respectRobots": true,
    "userAgent": "WebcrawlerBot/1.0 (+https://github.com/Lazzar19/webcrawler)",
    "startUrl": "http://127.0.0.1:9/"
  },
  "pages": [
    {
      "canonicalUrl": "http://127.0.0.1:9/",
      "requestedUrl": "http://127.0.0.1:9/",
      "finalUrl": "http://127.0.0.1:9/",
      "discoveredFrom": null,
      "depth": 0,
      "state": "ok",
      "skipReason": null,
      "waitedMs": 45,
      "statusCode": 200,
      "contentType": "text/html; charset=utf-8",
      "durationMs": 5,
      "byteLength": 161,
      "attempts": 1,
      "errorKind": null,
      "errorMessage": null
    },
    {
      "canonicalUrl": "http://127.0.0.1:9/docs",
      "requestedUrl": "http://127.0.0.1:9/docs",
      "finalUrl": "http://127.0.0.1:9/docs",
      "discoveredFrom": "http://127.0.0.1:9/",
      "depth": 1,
      "state": "ok",
      "skipReason": null,
      "waitedMs": 0,
      "statusCode": 200,
      "contentType": "text/html; charset=utf-8",
      "durationMs": 3,
      "byteLength": 11,
      "attempts": 1,
      "errorKind": null,
      "errorMessage": null
    },
    {
      "canonicalUrl": "http://127.0.0.1:9/missing",
      "requestedUrl": "http://127.0.0.1:9/missing",
      "finalUrl": "http://127.0.0.1:9/missing",
      "discoveredFrom": "http://127.0.0.1:9/",
      "depth": 1,
      "state": "failed",
      "skipReason": null,
      "waitedMs": 0,
      "statusCode": 404,
      "contentType": "text/html",
      "durationMs": 13,
      "byteLength": null,
      "attempts": 1,
      "errorKind": "http-status",
      "errorMessage": "HTTP 404"
    },
    {
      "canonicalUrl": "http://127.0.0.1:9/notes.txt",
      "requestedUrl": "http://127.0.0.1:9/notes.txt",
      "finalUrl": "http://127.0.0.1:9/notes.txt",
      "discoveredFrom": "http://127.0.0.1:9/",
      "depth": 1,
      "state": "skipped",
      "skipReason": "non-html",
      "waitedMs": 10,
      "statusCode": 200,
      "contentType": "text/plain",
      "durationMs": 3,
      "byteLength": null,
      "attempts": 1,
      "errorKind": null,
      "errorMessage": null
    },
    {
      "canonicalUrl": "http://127.0.0.1:9/secret",
      "requestedUrl": "http://127.0.0.1:9/secret",
      "finalUrl": null,
      "discoveredFrom": "http://127.0.0.1:9/",
      "depth": 1,
      "state": "skipped",
      "skipReason": "robots",
      "waitedMs": null,
      "statusCode": null,
      "contentType": null,
      "durationMs": null,
      "byteLength": null,
      "attempts": 0,
      "errorKind": null,
      "errorMessage": null
    },
    {
      "canonicalUrl": "https://example.com/outside",
      "requestedUrl": "https://example.com/outside",
      "finalUrl": null,
      "discoveredFrom": "http://127.0.0.1:9/",
      "depth": 1,
      "state": "skipped",
      "skipReason": "other-origin",
      "waitedMs": null,
      "statusCode": null,
      "contentType": null,
      "durationMs": null,
      "byteLength": null,
      "attempts": 0,
      "errorKind": null,
      "errorMessage": null
    }
  ],
  "robots": [
    {
      "origin": "http://127.0.0.1:9",
      "statusCode": 200,
      "outcome": "parsed",
      "errorKind": null
    }
  ],
  "counts": {
    "reserved": 5,
    "queued": 0,
    "fetched": 4,
    "ok": 2,
    "skipped": 3,
    "failed": 1
  }
}
```

## Project structure

```
webcrawler/
├── backend/        # CLI and crawler engine
│   ├── src/
│   └── tests/
├── docs/           # Component boundaries. PLAN.md is the roadmap.
├── PLAN.md
└── package.json    # Root commands that delegate to backend/
```

## Getting started

### Prerequisites

- Node.js 24, listed in `backend/.nvmrc`

```bash
cd backend
nvm use
```

### Install and test

```bash
npm install --prefix backend
npm test
```

`npm test` from the repository root runs the backend Jest suite. `npm run lint` runs ESLint. `npm run verify` runs lint, then tests.

## Dependencies

| Package | Purpose |
|---|---|
| `jsdom` | HTML parsing and link extraction |
| `robots-parser` | Allow and crawl-delay decisions for `robots.txt` |
| `jest` | Testing framework (dev dependency) |
| `eslint` | Linter (dev dependency) |

## Author

**Lazar Nikolic** — [GitHub](https://github.com/Lazzar19) · [LinkedIn](https://www.linkedin.com/in/lazar-nikolic-41aab6344/)
