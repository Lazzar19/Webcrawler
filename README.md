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

An omitted flag uses the default. `--depth 0` is a real setting, not "missing". `--format` is `console`, `json`, or `csv`. With `json` or `csv` and no `--output`, that format is the only thing on stdout and the summary goes to stderr. `--output` writes the chosen format to that path, and the summary stays on stdout. `--details` adds a page table after the summary. It takes no value, and `--format json --details` or `--format csv --details` exits `2` before a crawl. `--trace` takes no value. Its lines go to stderr and never to stdout. When the summary is already on stderr, the lines follow it. Otherwise stderr is only those lines.

## Design decisions

These are the choices behind the procedures above. [PLAN.md](PLAN.md) has the full rules.

### One queue, a fixed set of workers

One `crawl()` call creates its own frontier and `concurrency` worker loops. The queue, the `seen` map, and the commit buffer belong to that call. A worker takes one URL, finishes it, and takes another. The number of workers is the cap on in-flight work.

### The key is identity. The spelling is the request.

`canonicalKey` decides whether two URLs are the same page. The request uses the spelling that was reserved: the earliest `href` on the page for that key, with the fragment removed. A later spelling of the same key leaves that request alone. Sorting the keys on a page orders the records and leaves the spelling alone.

### A URL is reserved before it is fetched

The `seen` check and the insert are one synchronous step, so two workers cannot both accept the same key. `maxPages` counts those reservations. The count includes the start URL and a URL that robots later refuses. An other-origin link, a link past `maxDepth`, and a link past `maxPages` are records, and they do not take a reservation.

### Links are reserved in dequeue order

A worker finishes when the network answers. That order changes between runs, so it does not choose the next links.

`take()` numbers pages `0`, `1`, `2` before the request starts. A finished page waits until its number is next. Its links are reserved, and the counter advances. A skip or a failure commits an empty list, so a missing number cannot freeze the queue. The same responses therefore produce the same `pages` array for any `concurrency`. Fetching stays concurrent. Reservation waits.

The price is in [Known limitations](#known-limitations): a slow page holds up the links from pages that already finished behind it.

Example. `concurrency` is 2 and `maxPages` is 4. The start page links to `/c` and then `/b`. Sorted by key, those are `/b` then `/c`. The commit of the start page reserves B, then C. One reservation remains. B is taken as sequence 1 and answers in 500 ms, with links `/x` and `/y`. C is sequence 2 and answers in 10 ms, with links `/x` and `/z`. C waits in the buffer. B commits first. `/x` takes the last reservation, `/y` is `page-limit`, and `discoveredFrom` of `/x` is B. C then commits. `/x` is already seen, and `/z` is `page-limit`. The creation order is the start page, B, C, `/x`, `/y`, `/z`.

### Every redirect hop is checked

The HTTP client returns a redirect and leaves it there. The worker handles `301`, `302`, `303`, `307`, and `308` one hop at a time, and stops after 5. Each hop is a scope check and a robots check before anyone requests it. A hop that stays on the start origin and is free becomes an alias of the same record. An alias does not take another `maxPages` slot. The record keeps its original depth and `discoveredFrom`. A hop to another origin is `skipped` / `redirect-off-origin` and is not requested. A hop that returns to this chain is `failed` / `redirect-loop`.

### Politeness is a second limit

`concurrency` is how many workers exist. `perOriginLimit` is how many of them may hold a lease on one origin. `minIntervalMs` is the gap between request starts on that origin. The next start time is stored before the wait. A parsed `Crawl-delay` replaces that gap only when it is larger, and the result is capped at 10 seconds.

`robots.txt` uses the lease the worker already holds. The manager does not take a second lease. With `perOriginLimit` set to 1, a second lease would wait for a release that cannot happen until that fetch finished.

### An unreadable robots.txt closes the origin

`robots-parser` is the only allow and crawl-delay implementation. The product token is the user agent up to the first `/` or space. The default token is `WebcrawlerBot`. A group written for that token is its whole policy. The `*` group applies only when the token has no group of its own.

A 2xx body is parsed. An empty 2xx body allows every path and sets no crawl-delay. A 4xx other than `429`, including a missing file, allows every path and sets no crawl-delay. `429`, a 5xx, a network failure, a timeout, a body over 500 KiB (512000 bytes), or a failed robots redirect closes the origin. This URL and later URLs there are `skipped` / `robots-unavailable` and are not requested. Pages already fetched stay as they are. A status that is neither a parsed body, nor a 4xx other than `429`, nor a redirect this loop follows, also closes the origin. `304` and `100` are in that group. A disallowed path is `skipped` / `robots` and is not requested. `--no-respect-robots` skips the file and allows every path.

### A failed page stays in the result

Bad configuration exits `2` before any fetch. A classified page failure is a record. The crawl continues, and a finished crawl exits `0`. An unexpected exception exits `1` after the workers return. The first Ctrl+C finishes in-flight work and prints `interrupted`. The second exits `130` and prints no report.

Retries for `timeout`, `connect`, `reset`, and statuses `429`, `500`, `502`, `503`, and `504` stay on the same reservation. The worker holds its lease through the backoff.

### The report follows creation order

JSON, CSV, and `--details` list `pages` in the order the records were created. The default console is a count summary and does not list those URLs. A file is written only for `--output`.

## Demo

From the repository root, with Node 24. The local site lives in [backend/tests/fixtures/demo.js](backend/tests/fixtures/demo.js). It serves a home page, `/docs`, a `robots.txt` that disallows `/secret`, a 404, a text file, and a link to `https://example.com/outside`. The command sets `--depth 1` and `--min-interval 0`, then runs the CLI. The port changes every run. The lines below are from one run with the port written as `9`.

```bash
npm install --prefix backend
node backend/tests/fixtures/demo.js
```

```text
completed http://127.0.0.1:9/ 104ms

crawl
  reserved  5
  fetched   4
  ok        2
  skipped   3
  failed    1
  queued    0

skipped
  non-html      1
  other-origin  1
  robots        1

failed
  http-status  1

robots
  http://127.0.0.1:9  parsed 200
```

`/secret` was not requested. Neither was `https://example.com/outside`. `/secret` still counts as reserved, because the reservation happens before the robots check. The outside link does not. The summary does not print those URLs.

The same demo takes the report flags. These three commands are the check for the terminal report:

```bash
node backend/tests/fixtures/demo.js
node backend/tests/fixtures/demo.js --details
node backend/tests/fixtures/demo.js --format json --trace
```

The first command is the summary above. `--details` prints that summary, then the page table. Rows stay in creation order. A URL longer than 64 characters is shortened only in this table. These rows are from the same run:

```text
pages
  STATE     STATUS  DEPTH  URL                           REASON
  ok        200     0      http://127.0.0.1:9/           -
  ok        200     1      http://127.0.0.1:9/docs       -
  failed    404     1      http://127.0.0.1:9/missing    http-status
  skipped   -       1      http://127.0.0.1:9/notes.txt  non-html
  skipped   -       1      http://127.0.0.1:9/secret     robots
  skipped   -       1      https://example.com/outside   other-origin
```

`--format json --trace` prints the JSON report on stdout and the summary on stderr. Trace lines follow that summary and are not part of the JSON. The crawl does not emit those lines yet, so stderr is the summary alone. The JSON from one run is under [Sample report](#sample-report).

To crawl some other origin:

```bash
node backend/src/main.js https://example.com/ --depth 1 --max-pages 20
```

### Docker

The image is built from the repository root. It uses the Node version in `backend/.nvmrc` and runs as a user other than root. The default command is the same fixture demo. Nothing in this repository publishes the image.

```bash
docker build -t webcrawler .
docker run --rm webcrawler
```

```bash
docker run --rm webcrawler --format json
```

To crawl another origin, replace the entrypoint:

```bash
docker run --rm --entrypoint node webcrawler backend/src/main.js https://example.com/ --depth 1 --max-pages 20
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

## Known limitations

- **No JavaScript rendering.** Links come from `<a href>` in the HTML body. The parser does not run scripts, so a URL that appears only after a script runs is never queued.
- **No subdomain crawl.** Scope is the start origin: scheme, host, and port. `https://blog.example.com/` discovered from `https://example.com/` is `skipped` / `other-origin`.
- **No sitemap crawl.** A `Sitemap` line in `robots.txt` is ignored. The crawl follows links from HTML.
- **No resume.** The queue lives in the process. The first Ctrl+C prints the partial result. The next run starts again from the start URL.
- **Single process.** One Node.js process runs `concurrency` async worker loops. There is no second machine and no separate job queue.
- **UTF-8 decoding only.** Response bodies are decoded as UTF-8. A `charset` parameter does not select another decoder.
- **`%FF` and `%FE` share one query key.** The query goes through `URLSearchParams`. Bytes that are not valid UTF-8 become U+FFFD, so `?q=%FF` and `?q=%FE` are both the key query `q=%EF%BF%BD`. In the path, `%7E` and `%7e` stay different.
- **`nofollow` is not honored.** `rel="nofollow"`, `<meta name="robots">`, and `X-Robots-Tag` leave the queue unchanged. An `href` is reserved when the other rules allow it.
- **A slow page delays later reservations.** Sequence 2 can finish while sequence 1 is still in flight. Its links stay in the buffer until sequence 1 commits. That wait is what keeps the `pages` array stable. The example is under [Links are reserved in dequeue order](#links-are-reserved-in-dequeue-order).
- **One origin's backoff holds a worker.** A retry sleeps inside the HTTP client while that worker still holds the origin's lease. During the sleep the worker does not take another URL.

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
