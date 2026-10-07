# Webcrawler Development Plan

This is the only execution plan for the project. Update it together with implementation, tests, and decisions.

[docs/Architecture.md](docs/Architecture.md) describes component boundaries. It is not a second roadmap. If this file and Architecture.md disagree on scope, order, layout, or behavior, this file wins.

## Status Legend

- `[ ]` not started
- `[-]` in progress
- `[x]` completed
- `[!]` blocked or requires a decision

## Project Goal

Build a single-process command-line crawler that is correct enough to show: bounded concurrency, an explicit URL policy, robots and timeouts, a tested crawl of a local site, and an honest README.

The crawler engine and the CLI are the product. Node.js is the implementation language for this repository. The design should transfer to a later crawler or worker pool in C++, Rust, or Go. Those languages get their own projects. This repository does not grow into a JavaScript platform.

A reviewer should be able to clone the repo, run one command, and see a crawl whose limits, failures, and output match the written contract.

### CV cutoff

Milestones 0 through 4 are the portfolio. Milestone 5 (a single Docker image) is optional polish. The frozen list below is out of the CV scope.

### Learning themes

Each theme below is the same problem in C++, Rust, and Go. The JavaScript syntax is incidental.

- URL identity, redirect aliases, and deduplication
- A work queue, a fixed set of workers, reservation at enqueue time, and stable link order
- Committing results in dequeue order so concurrency does not change the outcome
- Backpressure, crawl limits, and an explicit termination condition
- Politeness as its own limit, separate from how many requests may be in flight
- Timeouts, bounded retries, and failure isolation
- Robots policy and per-origin delay
- A thin CLI over a library-shaped engine
- Tests that lock the contract, including a local HTTP server

### Author checkpoints

LLM-written code is allowed. A milestone is not done until the author can explain the checkpoint without reading the code.

- Milestone 1: the author writes the URL equivalence tests, including redirect aliases, and the worker-loop sketch before implementation. The sketch must show `take`, the commit-in-order step, and the termination condition. An agent may implement the frontier and worker loop only after both exist in the repository and the learning log. The author must then be able to redraw the queue without opening the file.
- Milestone 2: the author writes the robots decision table (allow, disallow, missing file, 4xx, 5xx, fetch failure) and the politeness cases (global cap, per-origin cap, minimum gap, crawl-delay, retry gap) before wiring the library.
- Milestone 4: the author writes the "Design decisions" and "Known limitations" sections of the README.

## Rules for Implementation Agents

These apply to every change made by an agent, including Grok. They exist because each one blocks a shortcut that would pass a weak test and break the contract.

### Process

- Read Cemented Behavior before writing code. If a case is not covered, stop and ask. Do not invent policy in code. A new policy is an edit to Cemented Behavior first.
- Do not start Milestone 1 frontier or worker code until the author checkpoint for Milestone 1 exists. If it is missing, stop and say so.
- Work one milestone at a time. Do not implement later-milestone behavior early unless a checklist item says so.
- Every change keeps `npm run verify` green. Do not delete or weaken a test to make it pass. Tests that lock retired behavior are rewritten only where a checklist item says so.
- Do not edit Frozen scope into existence. Do not add dependencies other than the ones listed in [Dependencies](#dependencies).

### Architecture constraints

- Do not implement the crawler recursively. One crawl has one frontier and `concurrency` worker loops.
- Do not use a module-global limiter or any module-level mutable state. All crawl state is created inside one `crawl()` call. Two crawls in one process must not share anything.
- Do not use `p-limit` or any other generic promise pool for the crawl. Remove the dependency.
- Do not poll. Waiting for queue items, origin slots, and the end of the crawl uses promises that are resolved by an event, not `setInterval` or a loop with a short sleep.
- Do not use fixed or arbitrary sleeps. The only delays are the computed politeness gap and the computed retry backoff, and both go through the injected clock.
- Do not call `fetch` anywhere except inside the HTTP client module. Crawler, robots, and tests of the engine use the injected HTTP client.
- The HTTP client does not schedule, does not know about depth, scope, robots, or the frontier, and does not follow redirects.
- The HTML link extractor does not fetch and does not decide scope.
- Reporters receive a finished `CrawlResult`. They do not crawl, filter, deduplicate, or re-sort pages.
- The engine does not write to stdout and does not write files. Logs go to the injected logger, which writes to stderr by default.
- Do not wrap worker code in a catch-all that turns unknown exceptions into page failures. Only errors classified in [Error taxonomy](#error-taxonomy) become page records. Anything else is a fatal error.
- Keep CommonJS and plain JavaScript. Do not migrate to ESM or TypeScript.

## Cemented Behavior

These are decisions. Change them by editing this section, not by inventing a second policy in code.

### URL identity

The canonical key is produced by the WHATWG URL parser (`new URL`).

- Drop the fragment.
- Lowercase the scheme and hostname. The parser already does this.
- Omit default ports (`http` 80, `https` 443). Keep any other port. The parser already does this.
- Keep the path and its case. `https://host` and `https://host/` are the same key. A trailing slash on any longer path is removed.
- Keep the query. Parse it with `URLSearchParams`, sort entries by name, then by value, and serialize with `URLSearchParams.toString()`. Parameter order does not create two keys. A missing query and an empty query (`?`) are the same key.
- Scheme, hostname, and port stay in the key. `http` and `https` are different. `www` is not stripped. Different query values are different keys.
- The key is identity only. The URL that is fetched is the resolved URL with the fragment removed, not the key. When two spellings share a key, the first one reserved is the one fetched.
- `canonicalKey(canonicalKey(x)) === canonicalKey(x)` for every valid input. A test checks this on the equivalence cases.

### Scope and link resolution

- Stay on the start URL's origin: scheme, host, and port. Subdomains are outside the crawl.
- Read each `<a>` element's raw `href` attribute with `getAttribute('href')`. Do not use the DOM `href` property. An empty or whitespace-only value is ignored.
- The document base is the first `<base href>` resolved against the final response URL, if it parses. Otherwise it is the final response URL.
- Resolve each link with `new URL(raw, documentBase)`. String concatenation is not link resolution. A value that does not parse is ignored.
- Queue only `http` and `https` links. Other schemes (`mailto:`, `javascript:`, `tel:`, `data:`) are ignored and produce no record.
- Ignored links produce no `PageResult`. They may produce a debug log line.

### Frontier and reservation

One crawl owns one frontier. The frontier is a FIFO queue plus a `seen` map from canonical key to the record that owns it.

Each link from a page at depth `d` is handled in this order. The first rule that matches decides the outcome.

1. Resolve and canonicalize. Invalid or non-`http(s)` links are ignored.
2. The key is already in `seen`: ignored. No new record. This is the deduplication rule.
3. The origin differs from the start origin: one record, `skipped` / `other-origin`. Not fetched.
4. `d + 1 > maxDepth`: one record, `skipped` / `depth-limit`. Not fetched.
5. `maxPages` records are already reserved: one record, `skipped` / `page-limit`. Not fetched.
6. Otherwise reserve: create a record with state `queued` and depth `d + 1`, and push it onto the queue.

Every created record, skipped or reserved, enters `seen`, so each canonical key has at most one `PageResult`.

- The start URL is reserved first, at depth 0, with `discoveredFrom: null`.
- Reservation is a synchronous check-and-insert. No `await` may occur between the `seen` check and the insert.
- Before step 1, a page's links are deduplicated by key and sorted by key. Step order then gives the same records for the same responses.
- Every later record stores `discoveredFrom`, the canonical key of the page whose links created it.
- A robots-disallowed page still consumed its reservation. `maxPages` counts reservations, not successful fetches.

### Depth and page limit

- The start URL is depth 0.
- `maxDepth` is inclusive. A page at depth `d` reserves links only when `d < maxDepth`. `maxDepth: 0` fetches only the start URL.
- A page at depth `maxDepth` is still parsed. Its new links become `skipped` / `depth-limit` records, so the depth boundary is visible in the result.
- `maxPages` counts URLs reserved for fetch, including the start URL. Discoveries after the limit are `skipped` / `page-limit`.
- `maxPages` must be a positive integer. There is no unlimited value. `Infinity` is rejected.
- The CLI must pass `0` through. A missing flag uses the default. A present `0` stays `0`.

### Defaults

| Field | Default |
|---|---|
| `maxDepth` | `2` |
| `maxPages` | `50` |
| `concurrency` | `5` |
| `perOriginLimit` | `2` |
| `minIntervalMs` | `200` |
| `timeoutMs` | `10000` |
| `maxResponseBytes` | `1000000` |
| `retryCount` | `2` extra attempts after the first failure |
| `retryBaseDelayMs` | `500` |
| `respectRobots` | `true` |
| `userAgent` | `WebcrawlerBot/1.0 (+https://github.com/Lazzar19/webcrawler)` |

Fixed constants, not configuration: retry delay cap 5000 ms, crawl-delay cap 10 seconds, redirect hop limit 5, `robots.txt` size limit 500 KiB.

An omitted field is the default above. An unknown config key is a configuration error, so a typo cannot silently fall back to a default. Validation: `maxDepth` and `retryCount` and `minIntervalMs` and `retryBaseDelayMs` are non-negative integers. `maxPages`, `concurrency`, `perOriginLimit`, `timeoutMs`, and `maxResponseBytes` are positive integers. `respectRobots` is a boolean. `userAgent` is a non-empty string.

### Workers and termination

`concurrency` is the number of worker loops. A worker is the global slot. There is no separate global semaphore.

Worker loop:

1. `item = await frontier.take()`. `null` means the crawl is over, and the worker returns.
2. Mark the record `fetching` and assign it the next dequeue sequence number.
3. Acquire the politeness lease for the item's origin (see Politeness).
4. Check robots. If disallowed or unavailable, record the skip.
5. Run the redirect loop (see Redirects). Each network attempt calls the lease's `beforeAttempt`.
6. Classify the response. If it is HTML, extract links.
7. Release the lease.
8. Commit the item with its links (see Commit order). This always happens, in a `finally`, including after a skip or a classified failure.

The frontier tracks three numbers: queued items, items taken but not committed, and results waiting in the commit buffer. The crawl is over when the queue is empty and every taken item has been committed. When that becomes true, the frontier resolves every pending `take()` with `null`. A worker never exits because the queue is momentarily empty while other items are in flight, since those items may still add links.

`crawl()` resolves after all workers return. If an unclassified exception escapes a worker, the crawl stops taking items, waits for the other workers, and rejects with that exception.

### Commit order

Workers finish in network order, which changes from run to run. Links are therefore reserved in dequeue order, not finish order.

- Each taken item gets a sequence number `0, 1, 2, ...` in the order `take()` returned it.
- A finished item is placed in a commit buffer keyed by sequence number.
- The frontier keeps `nextCommit`. While the buffer holds `nextCommit`, it removes that entry, applies the reservation rules to its links, and increments `nextCommit`.
- Skipped and failed items are committed with an empty link list. A sequence number that is never committed stalls the crawl, which is why step 8 runs in `finally`.

Because the queue is FIFO and commits happen in dequeue order, the crawl is breadth-first. A key is always first discovered at its smallest depth. The same responses produce the same records in the same order for any `concurrency`. Fetching stays concurrent. Only reservation waits.

### Redirects

The HTTP client does not follow redirects. The worker runs the redirect loop because every hop is a scope and robots decision.

- A response with status `301`, `302`, `303`, `307`, or `308` and a `Location` header is a hop. Resolve `Location` against the current URL, then canonicalize it.
- If the hop leaves the start origin, the record is `skipped` / `redirect-off-origin`. The off-origin URL is not requested.
- If the hop key equals the record's own key or an earlier hop in this chain, the record is `failed` / `redirect-loop`.
- If the hop key is already in `seen` and owned by another record, this record is `skipped` / `duplicate`. That URL is not requested here. The other record owns it.
- Otherwise add the hop key to `seen` as an alias owned by this record. An alias does not consume a `maxPages` slot. Check robots for the hop. If allowed, request it.
- More than 5 hops is `failed` / `redirect-limit`. A redirect status without `Location` is `failed` / `bad-redirect`.
- `finalUrl` is the last requested URL. Links are resolved against it. The record keeps its original depth and `discoveredFrom`.

### Politeness

`concurrency` and politeness are different limits. Effective pace is whichever limit is tighter.

- `concurrency` caps in-flight work for the whole crawl, because it is the number of workers.
- `perOriginLimit` caps leases held on one origin at once. A worker that cannot get a lease waits in a FIFO list for that origin until a lease is released.
- `minIntervalMs` is the minimum gap between the starts of two network attempts to the same origin. Tests and the CLI may set it to `0`.
- A robots `Crawl-delay` larger than `minIntervalMs` replaces the gap for that origin, capped at 10 seconds.
- The gap applies to every attempt: first attempts, retries, redirect hops, and `robots.txt`.
- Each origin stores `nextAllowedAt`. `beforeAttempt` computes `startAt = max(now, nextAllowedAt)`, sets `nextAllowedAt = startAt + gap` synchronously, then waits until `startAt` through the clock. Setting `nextAllowedAt` before awaiting prevents two workers from claiming the same start time.
- `waitedMs` is the time from `take()` to the start of the first network attempt for that record. It covers waiting for the lease and for the gap.
- On a single-origin crawl, `perOriginLimit` is the limit you can see. `concurrency` still matters as the ceiling, and as the number of workers waiting on that origin.

Milestone 1 leaves a gate whose `acquire` and `beforeAttempt` return immediately. Milestone 2 gives that gate the limits above. The engine calls it identically in both milestones.

### Page states

`queued`, `fetching`, `ok`, `skipped`, `failed`.

`fetching` is transient and never appears in a finished result. `queued` appears in a result only after an interrupt.

Skip reasons: `other-origin`, `redirect-off-origin`, `depth-limit`, `page-limit`, `duplicate`, `robots`, `robots-unavailable`, `non-html`.

A skipped or failed URL is a record in the result. It is not a successful page. The old `pages` map that stored a hit count is retired. Inbound link counts are out of scope.

### HTTP client

One module owns `fetch`. It is created with injected dependencies: `createHttpClient({ fetchImpl, clock, userAgent, timeoutMs, retryCount, retryBaseDelayMs })`. `fetchImpl` defaults to the global `fetch`.

`get(url, { maxBytes, beforeAttempt, wantBody })`:

- Sends `redirect: 'manual'`, the configured `User-Agent`, and `Accept: text/html,application/xhtml+xml;q=0.9,*/*;q=0.1`. No cookies.
- Before each attempt, awaits `beforeAttempt()`. The client does not compute politeness. It only calls the hook.
- Each attempt has its own timeout of `timeoutMs` that covers headers and body. Use `AbortSignal.timeout`.
- After headers arrive, it calls `wantBody({ statusCode, contentType })`. If that returns false, or the status is not 2xx, the body is cancelled without reading. A body is always either fully read or cancelled, so no connection is left open.
- If `Content-Length` exceeds `maxBytes`, the attempt fails `too-large` without reading. Otherwise the body stream is read and its decoded bytes are counted. Passing `maxBytes` aborts the read and fails `too-large`.
- The body is decoded as UTF-8 with `TextDecoder`.
- It returns `{ url, statusCode, contentType, location, body, byteLength, attempts, durationMs }`, or throws a `FetchError` with `kind` and `attempts`.
- An HTTP status is never thrown. A 4xx or 5xx response is returned after retries are exhausted, and the crawler classifies it.

### Retries

Retries live in the HTTP client and consume the same reservation.

- Retry: `timeout`, `connect`, `reset`, and status `429`, `500`, `502`, `503`, `504`.
- Do not retry: `dns`, `tls`, `too-large`, any other status, and redirects.
- Delay before retry `n` (starting at 1) is `min(5000, retryBaseDelayMs * 2^(n-1))`. There is no jitter, so tests are exact.
- On `429` or `503`, a `Retry-After` header in seconds or as an HTTP date raises the delay to that value. If it is above 5000 ms, do not retry. Return that response.
- The delay goes through the injected clock. The worker keeps its lease during the delay, and the retry still calls `beforeAttempt`.

### Error taxonomy

`errorKind` is one of these strings. Nothing else is recorded on a page.

- `timeout`: attempt timeout fired (`TimeoutError`).
- `dns`: `ENOTFOUND`, `EAI_AGAIN`.
- `connect`: `ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`.
- `reset`: `ECONNRESET`, `UND_ERR_SOCKET`, `EPIPE`.
- `tls`: certificate and TLS errors (`CERT_*`, `ERR_TLS_*`, `DEPTH_ZERO_SELF_SIGNED_CERT`).
- `too-large`: body over the byte limit.
- `http-status`: final status 4xx or 5xx.
- `redirect-loop`, `redirect-limit`, `bad-redirect`: as defined in Redirects.
- `parse`: the HTML parser threw on the body.

Node's `fetch` reports network failures as `TypeError('fetch failed')` with the system code on `error.cause.code`. The mapping reads `cause.code` and is unit-tested per kind. A network error with an unknown code is `connect`, and its raw code goes into `errorMessage`.

Process-level errors:

- Invalid configuration or an invalid start URL (does not parse, not `http(s)`, or contains credentials) stops the process before any fetch. Exit code `2`.
- Page-level errors are records. The crawl continues.
- Non-HTML responses are `skipped` / `non-html`. The body is not read.
- HTML is media type `text/html` or `application/xhtml+xml`, case-insensitive, parameters ignored. A missing `Content-Type` is non-HTML.
- The process exits `0` when the crawl finishes, including when some pages failed.
- A fatal error after startup, including an unclassified exception and a failure to write `--output`, exits `1`.

### Robots

Use the `robots-parser` dependency for allow/disallow and crawl-delay decisions. Do not keep a second production parser. The custom parser in `backend/src/crawler/robots.js` is removed once the library path is covered by tests.

- The robots manager uses the injected HTTP client. It never calls `fetch`.
- One `robots.txt` per origin per crawl. The cache stores the in-flight promise, so concurrent workers share one fetch. There is no TTL.
- `robots.txt` is fetched with the 500 KiB limit and the normal retry policy. It follows up to 5 redirects itself, to any origin.
- A 2xx response is parsed.
- Any 4xx except `429` means the origin is allowed.
- `429`, `5xx`, a network failure, `too-large`, or a redirect failure skips that origin's remaining URLs with reason `robots-unavailable`. This is fail-closed. The cause is recorded in the crawl's robots summary.
- A path the file disallows is `skipped` / `robots`. Redirect hops are checked the same way, so a disallowed path is never requested.
- Rules are matched for the product token of `userAgent`, the text before the first `/` or space (`WebcrawlerBot`).
- Honor `Crawl-delay` for that token, capped at 10 seconds. When it is larger than `minIntervalMs`, it becomes the gap for that origin.
- With `respectRobots: false`, robots is not fetched, and crawl-delay is not applied.
- Sitemap URLs may be read and ignored. Sitemap crawling is out of scope.

### Output and shutdown

- The engine returns a `CrawlResult`. Reporters format it. The engine does not write files and does not choose a Desktop path.
- Formats: console summary, JSON, and CSV. CSV quoting covers commas, quotes, and newlines. CSV columns are the `PageResult` fields in contract order. `null` is an empty cell.
- stdout carries one artifact. With `--format console` (the default), the summary goes to stdout. With `--format json` or `csv` and no `--output`, that format goes to stdout and the summary goes to stderr. With `--output`, the chosen format is written to that path, and the summary goes to stdout.
- On the first SIGINT, stop handing out queued items, let in-flight items finish including their retries, do not reserve links from pages that finish after the signal, write the partial `CrawlResult` with `stopReason: "interrupted"`, and exit `0`. A second SIGINT exits `130` immediately without writing.

### Result shapes

`PageResult` is one canonical key. Fields, in this order. Every field is present. A field that does not apply is `null`.

- `canonicalUrl`: the key.
- `requestedUrl`: the resolved URL first requested, without the fragment.
- `finalUrl`: the last URL requested after redirects.
- `discoveredFrom`: the parent's key, `null` for the start URL.
- `depth`
- `state`
- `skipReason`
- `waitedMs`
- `statusCode`: of the last response.
- `contentType`
- `durationMs`: from the start of the first attempt to the end of the last, including retries, backoff, and redirect hops.
- `byteLength`: decoded body bytes read.
- `attempts`: network attempts for this record across hops and retries.
- `errorKind`
- `errorMessage`

No report-only fields.

`CrawlResult`:

- `schemaVersion`: `1`.
- `startUrl`, `startedAt` and `finishedAt` as ISO strings from the injected clock, `durationMs`.
- `stopReason`: `completed` or `interrupted`.
- `config`: the effective configuration.
- `pages`: records in creation order, which commit order makes stable.
- `robots`: one entry per origin with `origin`, `statusCode`, `outcome` (`parsed`, `allow-all`, `unavailable`, `not-checked`), and `errorKind`.
- `counts`: `reserved`, `queued` (non-zero only after an interrupt), `fetched` (records with `attempts >= 1`), `ok`, `skipped`, `failed`.

### Dependency injection

Inject only what tests need to replace.

- `crawl(config, { httpClient, clock, logger, signal })`. Each defaults to the real implementation.
- `clock` is `{ now(), sleep(ms) }`. Every time measurement and every delay in the engine, HTTP client, and politeness gate goes through it. Unit tests use a fake clock. Integration tests may use the real clock with `minIntervalMs` and `retryBaseDelayMs` set to small values.
- `logger` is `{ debug, info, warn, error }` and writes to stderr by default.
- `signal` is the stop request used by the CLI for SIGINT.

Do not add a container, a plugin system, or interfaces for components that have one implementation.

### Dependencies

- Runtime: `jsdom` (link extraction, already installed) and `robots-parser`. Remove `p-limit`.
- Development: `jest`, `eslint`, `@eslint/js`, `globals`.
- Node built-ins cover the rest: `fetch`, `node:http` for the fixture, `node:util` `parseArgs` for the CLI.

Adding any other package is an edit to this section first.

### Toolchain

- Node 24 LTS. `backend/.nvmrc`, the root `engines` field, CI, and the README badge agree. The current `18.7.0` pin is end-of-life and predates stable `fetch` and `AbortSignal.any`.
- ESLint flat config with `@eslint/js` recommended rules and the Node and Jest globals. It catches undeclared variables and unused imports, both of which exist in the code today. `npm run lint` runs it. CI runs lint and tests.
- No TypeScript and no type checker. Result shapes are documented here and locked by tests. A JSDoc `@typedef` for `PageResult` and `CrawlResult` is allowed as documentation.

### Layout

Code stays under `backend/`. The root `package.json` is the developer entry. The tree in Architecture.md section 4 is not the target layout.

```text
backend/src/crawler/   engine, frontier, URL policy, politeness, robots, HTTP client, links, errors
backend/src/cli/       argument parsing and exit codes
backend/src/report/    console, JSON, CSV
backend/tests/         unit tests
backend/tests/fixtures local HTTP fixture server and its sites
```

Names can differ. Responsibilities cannot: the CLI does not crawl, the HTTP client does not schedule, the parser does not fetch, reporters do not decide what was crawled.

### Local HTTP fixture

Integration tests use a real server, not a `fetch` mock.

- `node:http` on `127.0.0.1`, port `0`, started in `beforeAll` and closed in `afterAll`. Tests never touch the internet.
- A second fixture server on another port is the "other origin".
- The server logs every request: path, `User-Agent`, and start time. It tracks current and peak concurrent requests.
- Routes are plain functions in the fixture module. Each milestone adds the routes its tests need.
- Unit tests may inject a fake `fetchImpl` into the HTTP client. The engine tests use the fixture.

## Current Status

**Active milestone:** Milestone 1 - Queue, workers, and URL policy

**Known behavior of the code today:**

- `[x]` A recursive crawler, config validation, a custom robots parser, and a console/CSV report exist under `backend/`.
- `[x]` Jest covers normalization happy paths, some HTML extraction, cycles, config validation, robots parsing, and sort order. The suite has 61 tests.
- `[x]` Root `npm test` and `npm run verify` run the backend suite only.
- `[x]` GitHub Actions installs `backend/` and runs `npm test` on the Node version in `backend/.nvmrc`.
- `[x]` `npm start` from `backend/` runs `src/main.js`.
- `[x]` The duplicate root crawler and the Vite starter are gone.
- `[!]` `config.concurrency` is ignored. A module-level `p-limit(5)` wraps recursive calls. A parent holds its slot while awaiting children queued behind it. With five or more same-host links on the start page and the CLI default depth, all slots wait on queued work, nothing keeps the event loop alive, and the process exits silently without a report.
- `[!]` `maxPages` records a URL and then skips the fetch when the count is already at the limit. The default is `Infinity`.
- `[!]` Depth `0` is rejected by `parseInt(...) || 2` in the CLI. With `maxDepth: 0` the start URL is never recorded, and the report crashes on an empty map.
- `[!]` Normalization drops the scheme, port, and query. Link extraction concatenates strings and reads the DOM `href` of a document whose base is `about:blank`, so only root-relative links on a root base URL work. `./a`, `a`, and `//host/a` resolve wrongly or are dropped.
- `[!]` Scope compares hostnames only. Redirects are followed automatically and never inspected.
- `[!]` The result map mixes "visited", "fetch failed", and "times seen". Non-HTML pages are stored as successes. A missing `content-type` throws inside the success check. Unread bodies of non-HTML and error responses are never cancelled.
- `[!]` Page fetches have no timeout, no User-Agent, and no size cap. An invalid start URL throws outside any handler.
- `[!]` Robots rules are never consulted. `robots-parser` is installed and unused. The custom parser does not decide whether a path is allowed.
- `[!]` The report writes a CSV onto a guessed Desktop path, including a Windows path when run from WSL. The macOS branch is unreachable. `sortPages` assigns undeclared variables.
- `[!]` Node is pinned to `18.7.0`, and there is no linter.

## Milestones

### Milestone 0 - Repository baseline

**Goal:** The repo matches the CLI product. A new reader is not offered two crawlers or a frontend.

- `[x]` Root workspace commands and a GitHub Actions workflow exist.
- `[x]` README describes the `backend/` layout and points at this plan.
- `[x]` Delete the duplicate root `src/crawler/crawl.js`.
- `[x]` Point `backend` `start` at `backend/src/main.js`.
- `[x]` Remove the frontend from `npm run verify` and from CI. Delete `frontend/` in the same change.
- `[x]` State in the README that the frontend is gone and that the behavior bugs above are still open.

**Done when:** clone, install `backend`, and `npm test` are the whole setup, and only one crawler file exists.

### Milestone 1 - Queue, workers, and URL policy

**Goal:** The crawl is deterministic. Limits mean what this plan says they mean.

Author checkpoint first: write the equivalence tests and the worker-loop sketch in the learning log. Agent work on the frontier starts after that.

Setup:

- `[ ]` Move to Node 24 LTS as described in Toolchain. Add ESLint and `npm run lint` (root and `backend/`). Make root `npm run verify` run lint then tests, and run lint in CI. Fix the existing lint findings.
- `[ ]` Add the fixture server with request logging and peak-concurrency tracking.
- `[ ]` Add the injected `clock` and `logger` with real defaults.

URL policy:

- `[ ]` Implement the canonical key from Cemented Behavior. Test scheme, port, `www`, fragment, trailing slash, query order, empty query, and idempotence.
- `[ ]` Replace string concatenation with `getAttribute('href')` and `new URL(raw, documentBase)`. Cover `./`, `../`, bare relative paths, query-only links, protocol-relative links, `<base href>`, non-`http(s)` schemes, and a base URL that already has a path.
- `[ ]` Rewrite the existing tests that lock retired behavior: keys without a scheme, `about:blank` resolution, `maxPages: Infinity`, the hit-count map, and `sortPages`.

Frontier and workers:

- `[ ]` Replace recursive `p-limit` with one frontier and `concurrency` worker loops. Remove `p-limit`.
- `[ ]` Implement the reservation rules in their cemented order. Reservation is synchronous.
- `[ ]` Implement commit order with a sequence number and a commit buffer.
- `[ ]` Implement the termination condition. `take()` resolves `null` for every waiting worker when the crawl is over.
- `[ ]` Call the politeness gate's `acquire` and `beforeAttempt` before each fetch. In this milestone both return immediately.
- `[ ]` Apply inclusive `maxDepth` and reservation-based `maxPages`. Change the default page limit to `50` and reject `Infinity`. Add the new config fields and the unknown-key check.

Fetch path:

- `[ ]` Move `fetch` into an HTTP client module with `redirect: 'manual'`, User-Agent, `wantBody`, and body cancellation. Timeout, byte limit, and retries arrive in Milestone 2.
- `[ ]` Implement the redirect loop in the worker with the alias, duplicate, loop, limit, and off-origin rules.
- `[ ]` Classify HTML by media type. A missing `Content-Type` is non-HTML.
- `[ ]` Return `PageResult` and `CrawlResult` values in contract shape. Retire the hit-count map.

Fixture tests:

- `[ ]` Depth `0`, `1`, and `2`.
- `[ ]` Page limit, with skipped `page-limit` records.
- `[ ]` Cycles and duplicate links.
- `[ ]` Identical `pages` arrays for `concurrency` 1 and 5 when routes have different response delays.
- `[ ]` A redirect alias that does not consume a page slot, a redirect to an already reserved key, an off-origin redirect that is never requested, and a redirect loop.
- `[ ]` A fan-out site (ten links per page, depth 2, concurrency 5) that would stall the old limiter.

**Done when:** those tests pass against the local server, lint passes, and the author can redraw the queue, the commit buffer, and the termination condition without opening the file.

### Milestone 2 - HTTP policy and robots

**Goal:** A rude or stuck network cannot define the crawl.

Author checkpoint first: write the robots decision table and the politeness cases in the learning log.

- `[ ]` Add the per-attempt timeout and the streaming byte limit to the HTTP client.
- `[ ]` Map network errors to the error taxonomy through `cause.code`. Unit-test each kind with an injected `fetchImpl`.
- `[ ]` Retry only the cemented cases, with the cemented backoff and `Retry-After` rule, through the injected clock.
- `[ ]` Build the robots manager on `robots-parser` with the single-flight cache, the status rules, fail-closed behavior, the product-token match, and capped crawl-delay. Check every redirect hop.
- `[ ]` Implement the politeness gate: per-origin FIFO leases, `nextAllowedAt` set before waiting, the gap on every attempt, crawl-delay override, and `waitedMs`.
- `[ ]` Unit-test the gate and the retry delays with a fake clock.
- `[ ]` Delete the custom robots parser after the new tests cover the decision table.
- `[ ]` Extend the fixture with a disallowed path, a redirect into a disallowed path, a missing `robots.txt`, a `robots.txt` that returns `500`, a slow response that hits the timeout, an oversized body, a `503` that succeeds on retry, a `429` with `Retry-After`, and a same-origin run that records peak concurrency.

**Done when:** a disallowed path is never requested, including through a redirect. A timeout becomes a failed `PageResult` rather than a hung process. A same-origin run never has more than `perOriginLimit` requests in flight. Consecutive request starts to one origin are at least `minIntervalMs` apart in the fixture log.

### Milestone 3 - CLI and reports

**Goal:** The CLI is a thin adapter. Scripts can depend on the exit code and the JSON shape.

- `[ ]` Parse with `node:util` `parseArgs`. Accept a positional URL plus `--depth`, `--max-pages`, `--concurrency`, `--per-origin`, `--min-interval`, `--timeout`, `--user-agent`, `--no-respect-robots`, `--format`, and `--output`.
- `[ ]` Validate the URL and every number. Preserve an explicit `0` for depth. Unknown flags are errors.
- `[ ]` Use exit codes `0`, `1`, `2`, and `130` as specified above.
- `[ ]` Emit console, JSON, and CSV from `CrawlResult`, following the one-artifact-on-stdout rule. CSV escapes commas, quotes, and newlines.
- `[ ]` Write files only to `--output`. Remove the Desktop path.
- `[ ]` On SIGINT, stop handing out items, finish in-flight work, and emit the partial result.
- `[ ]` Test the CLI as a child process against the fixture: bad arguments, explicit `0`, JSON shape, JSON on stdout being parseable, CSV escaping, and a crawl that includes a failed page.

**Done when:** `node backend/src/main.js` against the fixture prints a summary a stranger can read, and JSON matches the result shape.

### Milestone 4 - CV cutoff

**Goal:** The README can stand next to the code in a portfolio review.

- `[ ]` Document the queue, commit order, stable order, redirect identity, the politeness split, the failure model, and the defaults.
- `[ ]` Include one copy-paste demo against the local fixture and one sample JSON report.
- `[ ]` List known limitations: no JavaScript rendering, no subdomain crawl, no sitemap crawl, no resume, single process, UTF-8 decoding only, `nofollow` not honored, a slow page delays reservation of later pages' links, and one origin's backoff holds a worker.
- `[ ]` Author writes the design-decisions and limitations sections.
- `[ ]` Add a learning-log entry for the queue, commit order, and robots fail-closed behavior.

**Done when:** Milestones 0–3 are checked, and a reader can run the demo from the README alone.

**First CV-ready cutoff:** end of this milestone.

### Milestone 5 - Optional image

Not required for the CV cutoff. Do this only after Milestone 4.

- `[ ]` Add a Dockerfile pinned to the Node version in `backend/.nvmrc`.
- `[ ]` Run as a non-root user. Multi-stage build if it keeps the image small.
- `[ ]` Document `docker run` for the same fixture demo.
- `[ ]` Keep publishing, registry credentials, and image scanners out of this repository.

## Frozen

Not in this plan, and not a follow-up milestone until the CV cutoff is done and a later project actually needs them:

- React or any other UI
- HTTP API, job service, OpenAPI, SSRF surface
- HTML report as the showcase
- Release automation, npm publish, image registries
- Sitemap crawling, SEO extraction, a drawn crawl graph, persistent resume, SQLite
- Distributed workers, browser automation, cookie auth, proxy rotation
- TypeScript, a type checker, or an ESM migration

Future work after the cutoff, recorded so it is not mistaken for missing scope:

- Per-origin queues with a ready-time heap, and retries rescheduled into the frontier instead of holding a worker. Needed only when more than one origin is in scope.
- Widening an origin's gap after `429`, and retry jitter.
- Content deduplication by body hash, and `rel=canonical`.
- Crawler-trap guards beyond `maxPages`: URL length, path depth, repeated segments.
- `rel=nofollow`, `<meta name=robots>`, and `X-Robots-Tag`.
- Charset detection beyond UTF-8.
- A streaming parser in place of `jsdom`.
- Streaming output (JSONL) and an event API for very large crawls.
- Metrics export, latency percentiles, and a progress line.

Broken-link detection is already implied by failed `PageResult` records. It does not need a separate feature.

## Verification

| Check | Command | Expectation |
|---|---|---|
| Lint | `npm run lint` | No errors in `backend/src` and `backend/tests` |
| Tests | `npm test` | Backend unit tests and the local HTTP fixture |
| CLI demo | README command | Fixture crawl prints a summary and exits 0 |
| CI | GitHub Actions on `main` and pull requests | Lint and tests, Node from `backend/.nvmrc` |
| Image | `docker build` then the README demo | Only after Milestone 5 |

`npm run verify` runs `npm run lint` and `npm test`. CI installs `backend` only.

## Definition of Done

A milestone is complete when it has:

- the behavior in Cemented Behavior, or an edited change to that section
- tests for the new contract, against the fixture where the behavior involves the network
- no violation of Rules for Implementation Agents
- `npm run verify` passing
- this file updated
- the author checkpoint written in the learning log
- a command in Verification that shows it

## Architecture Boundary

Keep these boundaries when splitting files. They come from Architecture.md and stay here so that document cannot assign new product scope.

- The CLI parses arguments, builds config, starts one crawl, and maps the result to an exit code.
- The crawler owns the frontier, reservations, commit order, depth, page limit, the redirect loop, and when to call robots, politeness, HTTP, and the parser.
- The URL policy owns the canonical key, origin checks, and link resolution.
- The politeness gate owns per-origin leases and gaps. It does not fetch.
- The HTTP client owns fetch, timeout, retries, byte limits, and error classification. It does not follow redirects or schedule.
- The robots manager owns fetching, caching, and evaluating `robots.txt` through the HTTP client.
- The HTML parser returns links and does not fetch.
- Reporters format a `CrawlResult` and do not crawl.

Add a file when a boundary above is being violated. Do not add a file only to match a diagram.

## Learning Log

### Template

- Date:
- Topic:
- Problem:
- Chosen solution:
- How it was verified:
- Lesson learned:

### 2026-09-22 - Root workspace commands

- **Problem:** `npm test` from the repository root failed because the package is under `backend/`.
- **Chosen solution:** The root `package.json` delegates with `npm --prefix`.
- **How it was verified:** `npm test` passed with 61 tests.
- **Lesson learned:** A split directory needs an explicit entry command.

### 2026-10-06 - One plan

- **Problem:** [PLAN.md](PLAN.md) and [docs/Architecture.md](docs/Architecture.md) described different products, layouts, and roadmaps.
- **Chosen solution:** This file is the only roadmap. Product scope is a tested CLI crawler. The transferable core is the queue, the URL key, and the robots/timeout policy. The UI, API, and release pipeline are frozen.
- **How it was verified:** Architecture.md now points here for order and scope.
- **Lesson learned:** A portfolio crawler is the engine contract and the README. A second interface does not make the engine more correct.

### 2026-10-07 - Repository baseline

- **Problem:** The repo offered two crawlers and a Vite starter that no command in the product used. `npm start` pointed at a missing `main.js`.
- **Chosen solution:** Keep `backend/` as the only package. Root `npm test` and CI run that suite. The README lists the engine bugs that Milestone 1 still has to replace.
- **How it was verified:** `npm test` from the repository root.
- **Lesson learned:** A baseline change removes files the product does not run. It does not change crawl behavior.

### 2026-10-07 - Trace, redirect identity, and politeness

- **Problem:** The plan could fetch one page twice after a redirect, could emit different orders on the same site, and used one number for both speed and politeness.
- **Chosen solution:** A redirect's final URL re-enters the seen set. Links are sorted before enqueue. `concurrency` caps in-flight work, and `perOriginLimit` plus `minIntervalMs` pace one origin. Each page records `discoveredFrom` and `waitedMs`.
- **How it was verified:** The decisions are written into Cemented Behavior and into Milestones 1 and 2. Implementation is still ahead.
- **Lesson learned:** The trace of a crawl is the portfolio feature. A second product, such as a sitemap crawler or a drawn graph, can wait.

### 2026-10-07 - Architecture review reconciliation

- **Problem:** Sorting links was not enough for a stable order, because concurrent pages finish in network order. Following redirects automatically would request disallowed and off-origin URLs before any check. The plan did not say when the crawl ends, what a worker does while others are in flight, or which errors are retried.
- **Chosen solution:** Reserve links in dequeue order through a commit buffer. Run redirects hop by hop in the worker. Define the termination condition, the error taxonomy, the retry table, the robots status table, and the result field list. Inject the HTTP client, clock, and logger. Write agent rules that block recursion, global limiters, sleeps, and catch-alls.
- **How it was verified:** Plan review only. Implementation is still ahead.
- **Lesson learned:** "Deterministic" is a claim about concurrency, not about sorting. It needs a mechanism.

## Change Log

### 2026-10-07 (architecture review)

- Added Rules for Implementation Agents.
- Added frontier reservation order, commit order, worker loop, and termination condition.
- Replaced automatic redirect following with a hop-by-hop loop in the worker, with alias, duplicate, loop, limit, and off-origin rules.
- Fixed link resolution to raw `href` plus `<base href>` and `new URL`.
- Specified the HTTP client contract, byte limit, retry table, backoff, `Retry-After`, and the error taxonomy.
- Robots: all 4xx except `429` allow, `robots-unavailable` skip reason, single-flight cache without TTL, hop checks, product-token match.
- Politeness: worker count is the global cap, per-origin FIFO leases, gap on every attempt, `nextAllowedAt` set before waiting.
- Defined `PageResult` field order and nulls, `CrawlResult` with `schemaVersion`, `stopReason`, `robots`, and `counts`.
- Fixed the stdout rule so JSON and CSV output is parseable.
- Rejected `maxPages: Infinity` and unknown config keys. Added `retryBaseDelayMs`.
- Moved to Node 24 LTS, added ESLint, removed `p-limit`, listed allowed dependencies.
- Added the fixture server requirements and expanded Milestone 1–3 checklists to match.
- Recorded post-cutoff ideas as future work under Frozen.

### 2026-10-07

- Recorded redirect identity, stable link order, per-origin politeness, and `discoveredFrom` as part of the existing milestones.
- Removed the duplicate root crawler and the unused Vite app.
- Pointed `npm start` at `backend/src/main.js`.
- Made root verification and GitHub Actions run the backend tests only.

### 2026-10-06

- Replaced the previous milestone list with one CV cutoff at Milestone 4.
- Wrote the URL, queue, limit, retry, robots, and exit-code policies as decisions.
- Recorded the current engine bugs as the reason Milestones 1 and 2 exist.
- Froze the React app, the API, HTML reports, and release automation.
- Left a single optional Docker milestone after the CV cutoff.

### 2026-09-22

- Added the first project tracker, root workspace commands, README alignment, and GitHub Actions.
- Marked the CLI as the primary product.
