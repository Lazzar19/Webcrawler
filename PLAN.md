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

### Checkpoints

Each checkpoint is a spec-first step: the agent writes the artifact before the implementation it describes, then stops for the author's review. Implementation starts only after the author approves the artifact.

A milestone is not done until the author can explain the checkpoint without reading the code. The agent's artifacts are written to make that possible: plain language, small examples, and no reference to code that does not exist yet.

- Milestone 1: the agent writes the URL equivalence tests, including redirect aliases, and a worker-loop sketch in the learning log before implementation. The sketch must show `take`, the commit-in-order step, and the termination condition. The agent then stops for review. It implements the frontier and worker loop only after the author approves both. The author must then be able to redraw the queue without opening the file.
- Milestone 2: the agent writes the robots decision table (allow, disallow, missing file, 4xx, 5xx, fetch failure) and the politeness cases (global cap, per-origin cap, minimum gap, crawl-delay, retry gap) in the learning log before wiring the library, then stops for review.
- Milestone 4: the agent drafts the "Design decisions" and "Known limitations" sections of the README from Cemented Behavior. The author reviews them and must be able to defend each point.

## Rules for Implementation Agents

These apply to every change made by an agent, including Grok. They exist because each one blocks a shortcut that would pass a weak test and break the contract.

### Process

- Read Cemented Behavior before writing code. If a case is not covered, stop and ask. Do not invent policy in code. A new policy is an edit to Cemented Behavior first.
- At each checkpoint in [Checkpoints](#checkpoints), write the artifact first, then stop and ask the author to review it. Do not write the implementation it describes until the author approves. Record the approval date in the learning-log entry.
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

`canonicalKey(input)` is identity only. The fetched URL is not the key.

Procedure, in this order. No other normalization exists.

1. Parse with `new URL(input)`. If that throws, `canonicalKey` throws the same `TypeError`. It does not return `null` or any other sentinel. `canonicalKey` also throws `TypeError` when the parsed scheme is not `http:` or `https:`, and when the parsed URL has a non-empty username or password. It does not return a key with the userinfo removed. These three cases are the complete definition of invalid input. Callers do not use the throw to skip a link. The link pipeline and the redirect loop reject these cases before calling `canonicalKey`, so a throw at run time is a bug and therefore fatal.
2. Path only: do not call `decodeURIComponent`, do not re-encode, and do not change the case of percent-escapes. The path is `url.pathname` as the parser returned it, then the trailing-slash rule below. In the path, `%7e` and `%7E` stay different, `%2F` and `%2f` stay different, and neither becomes `/`. This rule does not apply to the query. Step 7 decodes and re-encodes the query.
3. Drop the fragment. It is not part of the key.
4. Lowercase scheme and hostname come from the parser. Keep path case.
5. Ports come from the parser. `80` is omitted only for `http`. `443` is omitted only for `https`. `http://host:443` keeps `:443`. `https://host:80` keeps `:80`. Any other port stays.
6. Trailing slashes. `https://host` and `https://host/` are the same key, and the stored path is `/`. If the path is longer than `/` and ends with `/`, remove that one slash, and repeat until it does not end with `/`. This is what idempotence requires. It does not collapse internal empty segments: `/a//b` stays `/a//b`, and `/a//` becomes `/a`. Apply this to the path before the query is serialized, so `/a/?x=1` and `/a/?x=1#section` both have the key path `/a` and the query below.
7. Query. A missing query and an empty query (`?`) are the same key, serialized with no `?`. Otherwise parse `url.search` with `URLSearchParams`, so `?a` and `?a=` are the same empty value, and `+` and `%20` are the same space. Keep repeated pairs. Copy the entries and sort them by name, then by value, using JavaScript code-unit order (`<`), not `localeCompare`. Append the sorted entries into a new `URLSearchParams` and serialize with `toString()`. `?B=1&a=1` and `?a=1&B=1` are the key query `B=1&a=1`, because `B` is before `a` in code-unit order. A locale sort would put `a` first. That result is wrong. Because `URLSearchParams` decodes then re-encodes, percent-escapes in the query are normalized: `?q=%7e`, `?q=%7E`, and `?q=~` are all the key query `q=%7E`, and `?q=%2f` and `?q=/` are both `q=%2F`. Bytes that are not valid UTF-8 decode to U+FFFD, so `?q=%FF` and `?q=%FE` share the key query `q=%EF%BF%BD`. That collision is accepted and listed as a known limitation.
8. The key is `scheme://hostname[:port]/path`, then `?` and the serialized query only when the string produced by `toString()` in step 7 is non-empty. Whether the raw `url.search` was non-empty does not matter. `?&` has a non-empty `url.search`, its serialized query is empty, and its key is `…/a` with no `?`. No fragment.

`canonicalKey(canonicalKey(x)) === canonicalKey(x)` for every input that returns a key. A test checks this on the equivalence cases. An input that throws does not have a key.

The fetched URL is the resolved URL with the fragment removed, not the key. On one page, resolve every link first. When several resolved URLs share a key, the spelling that is fetched is the earliest in document order. Sorting by key orders distinct keys. It does not replace that spelling. A later discovery of the same key does not fetch and does not change the spelling. So if `/a/` is reserved before `/a`, the request path is `/a/`. If the reserved spelling is `?q=b%20a`, the request uses `%20`, not the key's `+` form.

### Scope and link resolution

- Stay on the start URL's origin: scheme, host, and port. Subdomains are outside the crawl.
- Read each `<a>` element's raw `href` attribute with `getAttribute('href')`. Do not use the DOM `href` property. An empty or whitespace-only value is ignored.
- The document base is the first `<base href>` resolved against the final response URL, if it parses. Otherwise it is the final response URL.
- Resolve each link with `new URL(raw, documentBase)`. String concatenation is not link resolution. A value that does not parse is ignored. `canonicalKey` is not called on it.
- Queue only `http` and `https` links. Other schemes (`mailto:`, `javascript:`, `tel:`, `data:`) are ignored and produce no record.
- A resolved link with a non-empty username or password is ignored. It is not fetched, it is not rewritten by stripping the userinfo, and it does not enter `seen`. This is not the start-URL rule. A start URL with userinfo is a fatal configuration error and exit `2` before any fetch. One bad discovered link does not stop the crawl.
- A redirect `Location` that resolves with a username or password is not requested. That record is `failed` / `bad-redirect`.
- A redirect `Location` that resolves to a scheme other than `http` or `https` is not requested. A different scheme is a different origin, so that record is `skipped` / `redirect-off-origin`. `canonicalKey` is not called on it.
- Ignored links produce no `PageResult`. They may produce a debug log line.

### Frontier and reservation

One crawl owns one frontier. The frontier is a FIFO queue plus a `seen` map from canonical key to the record that owns it.

Each link from a page at depth `d` is handled in this order. The first rule that matches decides the outcome.

1. Resolve with `new URL`. If it throws, ignore the link. If the resolved URL has a username or password, ignore it. If the scheme is not `http` or `https`, ignore it. Otherwise canonicalize. Invalid input never becomes a `seen` entry and never becomes a page failure.
2. The key is already in `seen`: ignored. No new record. This is the deduplication rule.
3. The origin differs from the start origin: one record, `skipped` / `other-origin`. Not fetched.
4. `d + 1 > maxDepth`: one record, `skipped` / `depth-limit`. Not fetched.
5. `maxPages` records are already reserved: one record, `skipped` / `page-limit`. Not fetched.
6. Otherwise reserve: create a record with state `queued` and depth `d + 1`, and push it onto the queue.

Every created record, skipped or reserved, enters `seen`, so each canonical key has at most one `PageResult`.

- The start URL is reserved first, at depth 0, with `discoveredFrom: null`.
- Reservation is a synchronous check-and-insert. No `await` may occur between the `seen` check and the insert.
- Before step 1, resolve the page's links in document order. For one key, keep the earliest spelling. Then sort those survivors by key. Step order then gives the same records, and the same fetched spelling, for the same responses.
- Every later record stores `discoveredFrom`, the canonical key of the page whose links created it.
- A robots-disallowed page still consumed its reservation. `maxPages` counts reservations, not successful fetches.

### Depth and page limit

- The start URL is depth 0.
- `maxDepth` is inclusive. `maxDepth: 0` fetches only the start URL. A page at depth `d` is fetched when `d <= maxDepth`. Its links are reserved for fetch only when `d < maxDepth`. A page at depth `maxDepth` is still parsed, and each new link becomes a `skipped` / `depth-limit` record. The link is not dropped and it is not fetched.
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

`startUrl` is a required config field with no default. Config validation rejects it unless it parses, its scheme is `http` or `https`, and it has no username or password. This check runs inside config creation, before `crawl()` reserves anything, so `canonicalKey` never sees an invalid start URL even when `crawl()` is called from code instead of the CLI.

An omitted field other than `startUrl` gets the default above. An unknown config key is a configuration error, so a typo cannot silently fall back to a default. Validation: `maxDepth` and `retryCount` and `minIntervalMs` and `retryBaseDelayMs` are non-negative integers. `maxPages`, `concurrency`, `perOriginLimit`, `timeoutMs`, and `maxResponseBytes` are positive integers. `respectRobots` is a boolean. `userAgent` is a non-empty string.

### Workers and termination

`concurrency` is the number of worker loops. A worker is the global slot. There is no separate global semaphore.

Worker loop:

1. `item = await frontier.take()`. `null` means the crawl is over, and the worker returns.
2. The record is now `fetching` and has its dequeue sequence number. `take()` assigns both synchronously before it returns the item, so every item a worker holds already has a number.
3. Acquire the politeness lease for the item's origin (see Politeness).
4. Check robots. The check stays at this point in the loop for every milestone. In Milestone 1 the check is a stand-in that always allows the URL. It does not fetch `robots.txt`, parse it, cache it, fail closed, or apply `Crawl-delay`. `respectRobots` is stored and does not change the stand-in. Milestone 2 replaces the stand-in with the robots manager. The call site does not move. A real disallow is `skipped` / `robots`. A real unavailable file is `skipped` / `robots-unavailable`. Neither contributes links.
5. If the check allows the URL, run the redirect loop (see Redirects). Each network attempt calls the lease's `beforeAttempt`. In Milestone 1, `beforeAttempt` returns immediately.
6. Classify the response. If it is HTML, extract links.
7. Release the lease.
8. Commit the item with its links (see Commit order). This always happens, in a `finally`, including after a skip or a classified failure.

The frontier tracks three numbers: queued items, items taken but not committed, and results waiting in the commit buffer. A worker never treats a momentarily empty queue as the end, because a taken item that has not committed can still add links.

Normal termination: the queue is empty and every item that `take()` already returned has been committed. The frontier then resolves every pending `take()` with `null`. Each of those workers returns. `crawl()` resolves after all workers have returned. `null` means this crawl is over. It is not an error.

Fatal stop: an exception that is not a classified page failure. The frontier enters fatal-stop immediately.

- It does not hand out any further queued item.
- Every `take()` that is already waiting resolves with `null`, so no worker stays blocked in `take()`. A worker that receives that `null` returns. It has no item and does not commit.
- A politeness wait is released the same way, without throwing a second error. Milestone 1 does not wait, because `acquire` returns immediately. Milestone 2 must release the lease wait on fatal-stop, or a worker can sit there forever.
- The worker that threw holds an item, so it has a sequence number. Its `finally` commits that number with an empty link list if it has not committed yet, then rethrows the same exception object.
- Any other worker that already holds an item finishes that item and commits it.
- While stopping, commits follow the stopping rule in Commit order: `nextCommit` still advances, and nothing is reserved.
- The first exception that triggers fatal-stop is the rejection value. A later exception from another worker is logged and does not replace it.
- `crawl()` waits for every worker with `Promise.allSettled`, not `Promise.all`. `Promise.all` rejects while other workers are still running, which breaks "after the workers return".
- `crawl()` rejects with that first exception after the workers return. Shutdown must not replace it, wrap it, or reject with a new error. A failure inside shutdown is logged and does not become the rejection.

Classified page failures are not fatal-stop. They commit an empty link list and the crawl continues.

### Commit order

Workers finish in network order, which changes from run to run. Links are therefore reserved in dequeue order, not finish order.

- Each taken item gets a sequence number `0, 1, 2, ...` in the order `take()` returned it.
- A finished item is placed in a commit buffer keyed by sequence number.
- The frontier keeps `nextCommit`. While the buffer holds `nextCommit`, it removes that entry, applies the reservation rules to its links, and increments `nextCommit`.
- Skipped and failed items are committed with an empty link list. A sequence number that is never committed stalls the crawl, which is why step 8 runs in `finally`.
- A commit marks its sequence number committed before it applies reservations. An exception during reservation then cannot cause the `finally` to commit the same number twice.
- Stopping rule. Once the crawl is stopping, after a SIGINT or a fatal-stop, every commit still removes its entry and advances `nextCommit`, but it reserves nothing. The rule depends on when the commit happens, not on when the page finished. A page that finished before the stop but was still waiting in the buffer reserves nothing when it commits after the stop.

Because the queue is FIFO and commits happen in dequeue order, the crawl is breadth-first. A key is always first discovered at its smallest depth. The same responses produce the same records in the same order for any `concurrency`. Fetching stays concurrent. Only reservation waits.

### Redirects

The HTTP client does not follow redirects. The worker runs the redirect loop because every hop is a scope and robots decision.

- A response with status `301`, `302`, `303`, `307`, or `308` and a `Location` header is a hop. Resolve `Location` against the current URL. If that throws, or the resolved URL has a username or password, the record is `failed` / `bad-redirect` and `canonicalKey` is not called. If the resolved scheme is not `http` or `https`, the record is `skipped` / `redirect-off-origin` and `canonicalKey` is not called. Otherwise canonicalize it.
- If the hop leaves the start origin, the record is `skipped` / `redirect-off-origin`. The off-origin URL is not requested.
- If the hop key equals the record's own key or an earlier hop in this chain, the record is `failed` / `redirect-loop`.
- If the hop key is already in `seen` and owned by another record, this record is `skipped` / `duplicate`. That URL is not requested here. The other record owns it.
- Otherwise add the hop key to `seen` as an alias owned by this record. An alias does not consume a `maxPages` slot. Check robots for the hop with the same function as step 4 of the worker loop. In Milestone 1 that check is the allow-all stand-in. If allowed, request the hop's resolved spelling, with the fragment removed, not the canonical key.
- More than 5 hops is `failed` / `redirect-limit`. A redirect status without `Location`, or a hop URL with a username or password, is `failed` / `bad-redirect`. The userinfo hop is not requested.
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
- `redirect-loop`, `redirect-limit`, `bad-redirect`: as defined in Redirects. `bad-redirect` is a redirect status with no `Location`, a `Location` that does not resolve, or a hop whose resolved URL has a username or password.
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
- On the first SIGINT, stop handing out queued items, let in-flight items finish including their retries, reserve nothing from any commit after the signal (the stopping rule in Commit order), write the partial `CrawlResult` with `stopReason: "interrupted"`, and exit `0`. A second SIGINT exits `130` immediately without writing.

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

- `crawl(config, { httpClient, clock, logger, signal })`. `config` is a plain object that includes `startUrl` and is validated as in Defaults. Each dependency defaults to the real implementation, so `crawl({ startUrl, ... })` with no second argument is a valid call.
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

**Active milestone:** Milestone 2 - HTTP policy and robots. The checkpoint comes first: the robots decision table and the politeness cases in the learning log, before any implementation.

**Known behavior of the code today:**

- `[x]` A frontier crawl, config validation, a custom robots parser, and a console/CSV report exist under `backend/`.
- `[x]` Jest covers the canonical key, link resolution, the frontier, the fixture crawl, config validation, robots parsing, and sort order, plus the Milestone 1 checkpoint tests and the setup tests. The suite has 147 tests.
- `[x]` Root `npm test` runs the backend suite. `npm run verify` runs lint, then that suite.
- `[x]` GitHub Actions installs `backend/` and runs `npm run verify` on the Node version in `backend/.nvmrc`.
- `[x]` `npm start` from `backend/` runs `src/main.js`.
- `[x]` The duplicate root crawler and the Vite starter are gone.
- `[x]` `concurrency` is the worker count. `p-limit` is gone. A parent no longer holds a slot while waiting for children.
- `[x]` `maxPages` counts fetch reservations. The default is `50`. `Infinity` is rejected.
- `[x]` Depth `0` is passed through. It fetches the start URL and records further links as `depth-limit`.
- `[x]` The canonical key keeps scheme, port, and query. Link extraction reads the raw `href` and resolves it with `new URL` against the document base.
- `[x]` Scope is the start origin. Redirects are hop-by-hop. An off-origin hop is not requested.
- `[x]` The engine returns `CrawlResult` and `PageResult`. Non-HTML is `skipped` / `non-html`. A missing `Content-Type` is non-HTML. Unread bodies are cancelled.
- `[!]` Page fetches send a User-Agent and do not follow redirects. They still have no timeout and no size cap. An invalid start URL is a `ConfigError` before any fetch.
- `[!]` The worker calls an allow-all robots stand-in. `robots-parser` is installed and unused. The custom parser does not decide whether a path is allowed.
- `[!]` `printReport` still writes a CSV onto a guessed Desktop path, including a Windows path when run from WSL. The macOS branch is unreachable. `npm start` no longer calls it. `sortPages` still sorts by hit count.
- `[x]` Node is pinned to 24, and ESLint checks `backend/`.

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

Checkpoint first: the agent writes the equivalence tests and the worker-loop sketch in the learning log, then stops for author review. Frontier work starts after approval.

Setup:

- `[x]` Move to Node 24 LTS as described in Toolchain. Add ESLint and `npm run lint` (root and `backend/`). Make root `npm run verify` run lint then tests, and run lint in CI. Fix the existing lint findings.
- `[x]` Add the fixture server with request logging and peak-concurrency tracking.
- `[x]` Add the injected `clock` and `logger` with real defaults.

URL policy:

- `[x]` Implement the canonical key from Cemented Behavior. In the same change, replace the local stand-in in [backend/tests/url-identity.test.js](backend/tests/url-identity.test.js) with the real module and turn every `test.failing` in that file into `test`. Convert all of them at once. Do not convert only the ones that went red: a `test.failing` that stays green means that case is still wrong.
- `[x]` Replace string concatenation with `getAttribute('href')` and `new URL(raw, documentBase)`. Cover `./`, `../`, bare relative paths, query-only links, protocol-relative links, `<base href>`, non-`http(s)` schemes, and a base URL that already has a path.
- `[x]` Leave `sortPages` with the old reporter. Rewriting those tests moved to Milestone 3, next to removing the Desktop path. Keys without a scheme, `about:blank` resolution, `maxPages: Infinity`, and the hit-count map are rewritten.

Frontier and workers:

- `[x]` Replace recursive `p-limit` with one frontier and `concurrency` worker loops. Remove `p-limit`.
- `[x]` Implement the reservation rules in their cemented order. Reservation is synchronous.
- `[x]` Implement commit order with a sequence number and a commit buffer.
- `[x]` Implement the termination condition. `take()` resolves `null` for every waiting worker when the crawl is over.
- `[x]` Call the politeness gate's `acquire` and `beforeAttempt` before each fetch. In this milestone both return immediately.
- `[x]` Call the robots check at its place in the worker loop. In this milestone the check is the allow-all stand-in. Do not fetch or parse `robots.txt`.
- `[x]` Apply inclusive `maxDepth` and reservation-based `maxPages`. Change the default page limit to `50` and reject `Infinity`. Add the new config fields and the unknown-key check.

Fetch path:

- `[x]` Move `fetch` into an HTTP client module with `redirect: 'manual'`, User-Agent, `wantBody`, and body cancellation. Timeout, byte limit, and retries arrive in Milestone 2.
- `[x]` Implement the redirect loop in the worker with the alias, duplicate, loop, limit, and off-origin rules.
- `[x]` Classify HTML by media type. A missing `Content-Type` is non-HTML.
- `[x]` Return `PageResult` and `CrawlResult` values in contract shape. Retire the hit-count map.

Fixture tests:

- `[x]` Depth `0`, `1`, and `2`.
- `[x]` Page limit, with skipped `page-limit` records.
- `[x]` Cycles and duplicate links.
- `[x]` Identical `pages` arrays for `concurrency` 1 and 5 when routes have different response delays.
- `[x]` A redirect alias that does not consume a page slot, a redirect to an already reserved key, an off-origin redirect that is never requested, and a redirect loop.
- `[x]` A fan-out site (ten links per page, depth 2, concurrency 5) that would stall the old limiter.
- `[x]` The first reserved spelling is the request URL: `/a/` is requested when it is reserved before `/a`, `/a` is requested when it comes first, and `?q=b%20a` is requested with `%20`. A discovered link with userinfo is not requested and has no record. These are the tests in [backend/tests/fetch-spelling.test.js](backend/tests/fetch-spelling.test.js). Point them at the real `crawl()` and turn every `test.failing` into `test`, all at once, when the crawler exists. Move them onto the shared fixture server.
- `[x]` Fatal-stop: an injected HTTP client that throws an unclassified error makes `crawl()` reject with that same error object, after every worker has returned, and nothing stays pending.

**Done when:** those tests pass against the local server, lint passes, no `test.failing` remains in `url-identity.test.js` or `fetch-spelling.test.js`, and the author can redraw the queue, the commit buffer, and the termination condition without opening the file.

### Milestone 2 - HTTP policy and robots

**Goal:** A rude or stuck network cannot define the crawl.

Checkpoint first: the agent writes the robots decision table and the politeness cases in the learning log, then stops for author review.

- `[ ]` Add the per-attempt timeout and the streaming byte limit to the HTTP client.
- `[ ]` Map network errors to the error taxonomy through `cause.code`. Unit-test each kind with an injected `fetchImpl`.
- `[ ]` Retry only the cemented cases, with the cemented backoff and `Retry-After` rule, through the injected clock.
- `[ ]` Build the robots manager on `robots-parser` with the single-flight cache, the status rules, fail-closed behavior, the product-token match, and capped crawl-delay. Check every redirect hop.
- `[ ]` Implement the politeness gate: per-origin FIFO leases, `nextAllowedAt` set before waiting, the gap on every attempt, crawl-delay override, and `waitedMs`.
- `[ ]` Unit-test the gate and the retry delays with a fake clock.
- `[ ]` Delete the custom robots parser after the new tests cover the decision table. In the same change, retire [backend/tests/robots.test.js](backend/tests/robots.test.js). It locks behavior this plan forbids: `403` and network errors return an empty file, which allows crawling where the plan fails closed. It also locks a one-hour cache TTL, the `MyCrawlerBot` user agent, and a direct global `fetch`.
- `[ ]` Extend the fixture with a disallowed path, a redirect into a disallowed path, a missing `robots.txt`, a `robots.txt` that returns `500`, a slow response that hits the timeout, an oversized body, a `503` that succeeds on retry, a `429` with `Retry-After`, and a same-origin run that records peak concurrency.

**Done when:** a disallowed path is never requested, including through a redirect. A timeout becomes a failed `PageResult` rather than a hung process. A same-origin run never has more than `perOriginLimit` requests in flight. Consecutive request starts to one origin are at least `minIntervalMs` apart in the fixture log.

### Milestone 3 - CLI and reports

**Goal:** The CLI is a thin adapter. Scripts can depend on the exit code and the JSON shape.

- `[ ]` Parse with `node:util` `parseArgs`. Accept a positional URL plus `--depth`, `--max-pages`, `--concurrency`, `--per-origin`, `--min-interval`, `--timeout`, `--user-agent`, `--no-respect-robots`, `--format`, and `--output`.
- `[ ]` Validate the URL and every number. Preserve an explicit `0` for depth. Unknown flags are errors.
- `[ ]` Use exit codes `0`, `1`, `2`, and `130` as specified above.
- `[ ]` Emit console, JSON, and CSV from `CrawlResult`, following the one-artifact-on-stdout rule. CSV escapes commas, quotes, and newlines.
- `[ ]` Write files only to `--output`. Remove the Desktop path.
- `[ ]` Rewrite `sortPages` and [backend/tests/report.test.js](backend/tests/report.test.js). Reporters keep `pages` in creation order. Remove the hit-count sort together with the Desktop path.
- `[ ]` On SIGINT, stop handing out items, finish in-flight work, and emit the partial result.
- `[ ]` Test the CLI as a child process against the fixture: bad arguments, explicit `0`, JSON shape, JSON on stdout being parseable, CSV escaping, and a crawl that includes a failed page.

**Done when:** `node backend/src/main.js` against the fixture prints a summary a stranger can read, and JSON matches the result shape.

### Milestone 4 - CV cutoff

**Goal:** The README can stand next to the code in a portfolio review.

- `[ ]` Document the queue, commit order, stable order, redirect identity, the politeness split, the failure model, and the defaults.
- `[ ]` Include one copy-paste demo against the local fixture and one sample JSON report.
- `[ ]` List known limitations: no JavaScript rendering, no subdomain crawl, no sitemap crawl, no resume, single process, UTF-8 decoding only, non-UTF-8 query bytes such as `%FF` and `%FE` sharing one key, `nofollow` not honored, a slow page delays reservation of later pages' links, and one origin's backoff holds a worker.
- `[ ]` Agent drafts the design-decisions and limitations sections. Author reviews and approves them.
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
- the checkpoint artifact written by the agent in the learning log and approved by the author
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

### 2026-10-08 - Milestone 1 checkpoint

Approved: 2026-10-08. Frontier work and the URL policy start after Setup. Neither is implemented yet.

- **Problem:** The crawl still identifies a page by host plus path, joins links by string concatenation, and reserves work by finishing a recursive call. Concurrent finishes would not be stable even after the links on one page are sorted.
- **Chosen solution:** Lock the canonical key with tests, and describe the worker loop in plain language before any of that code exists. `canonicalKey` returns the sentinel `NOT-IMPLEMENTED`, so each assertion runs and fails. The tests are `test.failing` so the current suite stays green. They become normal tests in the same change that implements the key.
- **How it was verified:** `node --check` on the new test file, and `npm test`. The new assertions fail on the sentinel and Jest counts each `test.failing` as an expected failure. The previous 61 tests still pass.
- **Lesson learned:** The key and the commit order are one contract. Two spellings can share a key. The fetched URL is the first reserved spelling, not the key.

### 2026-10-08 - Checkpoint correction

Included in the Milestone 1 checkpoint approved on 2026-10-08. Still no production crawler, frontier, or URL policy.

- **Problem:** The checkpoint left robots, fatal-stop, trailing slashes, scheme-specific ports, query ordering, userinfo, and the fetched spelling for an agent to guess.
- **Chosen solution:** Milestone 1 keeps the robots call and implements it as an allow-all stand-in. Normal termination resolves pending `take()` with `null` only when the queue is empty and every taken item is committed. Fatal-stop resolves those same waits with `null` and rejects with the original exception. The key removes repeated trailing slashes but not internal empty segments, omits `80` only for `http` and `443` only for `https`, sorts query pairs by code-unit order, and uses `URLSearchParams` without a further decode step. A discovered link with userinfo is ignored. The request uses the first reserved spelling.
- **How it was verified:** The decisions are in Cemented Behavior. The new assertions are `test.failing` and are not a production implementation. The retired tests listed below were checked again and were not edited.
- **Lesson learned:** Idempotence decides repeated trailing slashes. One removal of a final slash, repeated until the path is stable, turns `/a//` into `/a` and leaves `/a//b` alone. A locale sort would not.

### 2026-10-08 - Second checkpoint correction

Included in the Milestone 1 checkpoint approved on 2026-10-08.

- **Problem:** A second review found two keys that broke idempotence (`?&`, and a non-`http(s)` redirect hop reaching `canonicalKey`), wording that said percent-escapes stay distinct in the query, an unspecified `crawl()` signature, fatal-stop gaps (`Promise.all`, reservation while stopping, which exception wins), a vacuous userinfo assertion, and three errors in the retired-test list.
- **Chosen solution:** Cemented Behavior now settles each point. See the change log entry of the same date.
- **How it was verified:** Each canonicalization rule was checked against Node's `URL` and `URLSearchParams` with a reference implementation that was not committed. Node's `fetch` refuses URLs that contain credentials, so "`/secret` was never requested" cannot fail for an implementation that tries to fetch it.
- **Resolved before approval:** `url-identity.test.js` has the query percent-escape case and the `?&` case. `fetch-spelling.test.js` asserts that the userinfo crawl has only the start record, and it has the reversed-order spelling test.
- **Lesson learned:** A rule that is correct for one URL component, such as "do not decode", is wrong when written as a rule for the whole URL.

#### Retired behavior

The old crawl locks below were rewritten with the frontier and the result contract. One reporter lock remains, and it belongs to Milestone 3.

- Keys without a scheme. Rewritten. Lookups are full keys such as `https://example.com/pageA`, and `http` and `https` stay different.
- `about:blank` resolution. Rewritten. `href="invalid"` on base `https://blog.boot.dev` resolves to `https://blog.boot.dev/invalid`. Resolved spellings still keep a trailing slash. Only the key drops it.
- `maxPages: Infinity`. Rewritten. [backend/tests/crawl-config.test.js](backend/tests/crawl-config.test.js) rejects `Infinity`. The default is `50`.
- The hit-count map. Rewritten. The engine stores one `PageResult` per key. A non-HTML response is `skipped` / `non-html`. Repeat discoveries do not increment a count.
- Exclusive depth. Rewritten. `maxDepth` is inclusive. A link past the limit is a `depth-limit` record, and the page at the limit is fetched.
- Dropped external links. Rewritten. An external link is a `skipped` / `other-origin` record.
- `sortPages`. Still locked by [backend/tests/report.test.js](backend/tests/report.test.js), which expects rows ordered by descending hit count. The engine already returns `pages` in creation order. The reporter rewrite is Milestone 3, next to removing the Desktop path.

#### Worker loop

One crawl has one frontier and `concurrency` worker loops. A worker is one global slot. There is no second global semaphore. The frontier has a FIFO queue, a `seen` map from canonical key to the one record that owns it, a commit buffer, and `nextCommit` starting at 0.

`take()` waits until either a queued item exists or the crawl is over. It returns the item, or `null` when the crawl is over. A worker that receives `null` returns. It does not treat an empty queue as the end of the crawl.

Loop:

1. `item = await frontier.take()`. `null` means this worker returns.
2. The record is `fetching` and has its dequeue sequence number, `0`, then `1`, then `2`, in the order `take()` returned items. `take()` assigns both before it returns, not when the response arrives.
3. Acquire the politeness lease for the item's origin. Milestone 1's `acquire` returns immediately. Milestone 2 makes it wait in a FIFO list when that origin already holds `perOriginLimit` leases.
4. Check robots at this point in the loop. The position is permanent. In Milestone 1 the function is a stand-in that always allows the URL. It does not fetch, parse, or cache `robots.txt`, and it does not fail closed or apply crawl-delay. Milestone 2 replaces the function. A real disallow is `skipped` / `robots`. A real unavailable file is `skipped` / `robots-unavailable`. Neither contributes links.
5. If the check allows the URL, run the redirect loop. The HTTP client does not follow redirects. Each hop is a `301`, `302`, `303`, `307`, or `308` with a `Location` header. Resolve `Location` against the current URL. If that throws, or the resolved URL has a username or password, the record is `failed` / `bad-redirect`, `canonicalKey` is not called, and the hop is not requested. A hop whose scheme is not `http` or `https` is `skipped` / `redirect-off-origin`, without `canonicalKey`. Otherwise canonicalize it. A hop that leaves the start origin is `skipped` / `redirect-off-origin` and is not requested. A hop key equal to this record's key, or equal to an earlier hop in this chain, is `failed` / `redirect-loop`. A hop key owned by another record is `skipped` / `duplicate`, and this record does not request it. Otherwise the hop key is an alias in `seen`, owned by this record, and it does not consume a `maxPages` slot. More than 5 hops is `failed` / `redirect-limit`. A redirect status without `Location` is `failed` / `bad-redirect`. The robots check on a hop is the same function as step 4, so in Milestone 1 it allows the hop. Each network attempt calls the lease's `beforeAttempt` before the request. Milestone 1's `beforeAttempt` returns immediately. The request uses the reserved spelling with the fragment removed, not the canonical key.
6. The request goes through the HTTP client. A classified failure becomes `failed` with that `errorKind` and no links. HTML is parsed for links. Anything else that was fetched and is not HTML is `skipped` / `non-html` and has no links. A skip from robots or from the redirect rules also has no links.
7. Release the lease.
8. Commit this sequence number with its link list. This is in a `finally`, so a skip or a classified failure still commits. The link list is empty in those cases. A sequence number that never commits freezes every later commit.

Commit: the finished item goes into a buffer under its sequence number. While the buffer holds `nextCommit`, remove it, apply the reservation rules to its links, and increment `nextCommit`. Links are resolved in document order first. One key keeps its earliest spelling. The survivors are then sorted by key. Reservation then ignores a link that does not parse, has userinfo, or is not `http(s)`. It ignores a key already in `seen` without a new record. Otherwise it records `other-origin`, `depth-limit`, or `page-limit`, or reserves a `queued` record and pushes it. The push is what makes the queue non-empty again. Workers blocked in `take()` receive those items.

Normal termination: the queue is empty and every item already returned by `take()` has been committed. Pending `take()` calls then resolve with `null`. Those workers return. `crawl()` resolves. An empty queue alone is not termination, because a taken item that has not committed can still add links.

Fatal stop: an exception that is not a classified page failure. The frontier stops handing out items and resolves every pending `take()` with `null`, so nobody stays blocked there. `null` only shuts those workers down. It is not a new error. The worker that threw commits an empty link list in `finally` if its sequence number is not committed yet, then rethrows the same exception. Other workers that already hold an item finish and commit that item. While stopping, every commit advances `nextCommit` and reserves nothing, including buffered items released by the empty commit. `crawl()` waits with `Promise.allSettled` and rejects with the first exception after every worker returns. Shutdown must not wrap it or replace it. A classified page failure is not fatal-stop. It commits an empty link list and the crawl continues.

#### Why finish order must not reserve links

`concurrency` is 2. `maxPages` is 4. Politeness and robots allow every request. Response time is the only difference.

The start page `S` is reserved first and taken as sequence 0. Its HTML contains `/c` and then `/b`. Sorted by key, the links are `/b` then `/c`. Commit of sequence 0 reserves `B`, then `C`. The queue is `B`, `C`. Three pages are reserved: `S`, `B`, `C`. One reservation remains.

`B` is taken next, so it is sequence 1. `C` is sequence 2. `C` responds in 10ms and links to `/x` and `/z`. That result waits in the buffer because `nextCommit` is still 1. `B` responds in 500ms and links to `/x` and `/y`.

Commit sequence 1 first. Sorted links are `/x`, `/y`. `/x` takes the last reservation. `/y` is `skipped` / `page-limit`. `discoveredFrom` of `/x` is `B`. Then commit sequence 2. `/x` is already in `seen`, so it is ignored and no second record is created. `/z` is `skipped` / `page-limit`.

Creation order is `S`, `B`, `C`, `/x`, `/y`, `/z`.

If reservation followed network completion, `C` would reserve `/x` at 10ms. `discoveredFrom` of `/x` would be `C`, and the later records would be `/z` then `/y`. The same site would produce a different `pages` array whenever `C` happened to be faster. Fetching stays concurrent. Only reservation waits for dequeue order.

The same example shows termination. After `S` is taken, the queue is empty and `S` has not committed. The crawl is not over. Ending there would drop `B` and `C`. After `C` is in the buffer and `B` has not committed, the queue is empty again. The crawl is still not over. `B` must commit before `C` can reserve, and `B`'s commit is what creates `/x`.

### 2026-10-08 - Milestone 1 setup

- **Problem:** The crawl rewrite needed a current Node pin, a linter that sees today's undeclared variables, a real local server for later engine tests, and a clock and logger the engine can receive instead of calling `Date` and `console` itself.
- **Chosen solution:** Node 24 in `.nvmrc`, the root `engines` field, CI, and the README badge. ESLint flat config with the recommended rules and the Node and Jest globals. The fixture listens on `127.0.0.1` port `0`, logs path, User-Agent, and start time, and tracks current and peak concurrency. `createClock()` and `createLogger()` are the real defaults. The existing recursive crawl is unchanged and does not call them yet.
- **How it was verified:** `npm run verify`. Lint is clean. The suite has 114 tests. The new clock, logger, and fixture tests pass. The checkpoint tests are still `test.failing`.
- **Lesson learned:** The linter's first job was the code that already existed. `sortPages` assigned `aHits` and `bHits` without declaring them, and two test imports were unused. Those are fixed. The crawl bugs stay until their own steps.

### 2026-10-09 - URL policy

- **Problem:** Pages were identified by host plus path, and links were joined by string concatenation against a document whose base was `about:blank`.
- **Chosen solution:** `canonicalKey` follows the cemented procedure. `extractLinks` reads `getAttribute('href')` and resolves with `new URL` against the first `<base href>`, or the page URL. The recursive crawl now stores those keys and extracts links that way. It is still the old loop.
- **How it was verified:** `npm run verify`. The URL identity tests are normal `test` calls and pass. Link tests cover relative paths, query-only links, protocol-relative links, `<base href>`, and ignored schemes. Scheme-less lookups in the crawl tests now use the full key. `maxPages: Infinity`, the hit-count map, and `sortPages` still lock the old result shape. Those change with the frontier and the result contract.
- **Lesson learned:** The key and the fetched spelling are different strings. `/a/` stays `/a/` in the link list. Only the key drops the slash.

### 2026-10-09 - Frontier and workers

- **Problem:** The crawl was a recursive `p-limit` loop. A parent held a slot while its children waited, `maxPages` could record a URL without fetching it, and the result was a hit-count map.
- **Chosen solution:** One FIFO frontier and `concurrency` workers. Reservation is synchronous, in the cemented order. `take()` assigns a sequence number, and finished items commit in that order from a buffer. Politeness and robots are immediate allow-all stand-ins at the real call sites. The HTTP client uses `redirect: 'manual'`. The worker follows hops, skips an off-origin hop before requesting it, and returns `PageResult` inside `CrawlResult`. `p-limit` is removed.
- **How it was verified:** `npm run verify`. Lint is clean. The suite has 129 tests. Injected-client tests cover cycles, inclusive depth, the page limit, the first reserved spelling, commit order, fatal-stop, and the redirect alias, duplicate, off-origin, and loop cases. The fixture checklist is still open. `fetch-spelling.test.js` is still `test.failing`. `sortPages` still sorts by hit count.
- **Lesson learned:** Canonicalizing a hop is not the same as staying on the start origin. A `https` hop on another host is a valid key and must still be `redirect-off-origin` before anyone requests it.

### 2026-10-10 - Fixture tests

- **Problem:** The frontier behavior was locked by an injected HTTP client. The plan requires the same cases against the local server, including the spelling tests that were still `test.failing`.
- **Chosen solution:** [backend/tests/fixtures/crawl.test.js](backend/tests/fixtures/crawl.test.js) drives `crawl()` through `createFixtureServer`. It covers depth 0, 1, and 2, the page limit, cycles, commit order under concurrency 1 and 5, redirects, and a 10-by-10 fan-out. [backend/tests/fetch-spelling.test.js](backend/tests/fetch-spelling.test.js) now calls the real `crawl()` on that server. Fatal-stop still uses an injected client, and it waits until the other worker finishes before `crawl()` rejects.
- **How it was verified:** `npm run verify`. Lint is clean. The suite has 141 tests. No `test.failing` remains. `sortPages` still sorts by hit count.
- **Lesson learned:** Two fixture servers get two ports, so the page arrays match only after the origin is removed. The record order does not.

### 2026-10-10 - Milestone 1 cleanup

- **Problem:** `linksInCommitOrder` caught `canonicalKey` and skipped the link. A throw after the link pipeline has already filtered the URL is a bug and must stop the crawl. Four redirect failures had no test. The open `sortPages` checkbox made Milestone 1 look unfinished.
- **Chosen solution:** `canonicalKey` is called without a catch. The worker commits inside `try`, so that throw reaches the worker catch, starts fatal-stop, and `crawl()` rejects with the same object. Fixture tests cover a missing `Location`, an unparseable `Location`, userinfo, an `ftp:` hop, and a sixth hop. The depth-0 fixture crawl asserts the default User-Agent. `sortPages` moved to Milestone 3. `report.js` is unchanged.
- **How it was verified:** `npm run verify`. Lint is clean. The suite has 147 tests.
- **Lesson learned:** The link filter and the key are two steps. Swallowing the second step hides a bug in the first.

## Change Log

### 2026-10-10 (Milestone 1 cleanup)

- A `canonicalKey` throw during commit is fatal and rejects with the same error object.
- Fixture tests cover a missing, unparseable, userinfo, and non-http redirect, plus a sixth hop.
- Moved the `sortPages` rewrite to Milestone 3. Milestone 2 is the active milestone, and its checkpoint is not written yet.

### 2026-10-10 (Fixture tests)

- Locked depth, page limit, cycles, commit order, redirects, fan-out, and fetch spelling against the local fixture server.
- Turned every `test.failing` in the spelling tests into `test`. Fatal-stop rejects with the original error after the other worker returns.

### 2026-10-09 (Frontier and workers)

- Replaced the recursive crawl with a frontier, commit-ordered workers, and `CrawlResult`.
- `maxPages` defaults to 50 and counts reservations. `maxDepth` is inclusive. `Infinity` is rejected.
- The HTTP client does not follow redirects. The worker applies the alias, duplicate, loop, limit, and off-origin rules.
- Politeness and robots are allow-all stand-ins. `p-limit` is removed. Timeout, byte limit, and retries are still Milestone 2.

### 2026-10-09 (URL policy)

- Implemented `canonicalKey` and `extractLinks`. The URL identity tests now call the real module.
- The recursive crawl stores canonical keys and resolves links against the page URL. The frontier is still the old loop.

### 2026-10-08 (Milestone 1 setup)

- Approved the Milestone 1 checkpoint.
- Pinned Node 24. Added ESLint. `npm run verify` and CI run lint, then tests.
- Added the local fixture server, the real clock, and the stderr logger. The crawl loop does not use them yet.

### 2026-10-08 (second checkpoint correction)

- `canonicalKey` throws `TypeError` for non-`http(s)` schemes. A non-`http(s)` redirect hop is `redirect-off-origin`.
- The no-decoding rule is limited to the path. The query is normalized by `URLSearchParams`, and the non-UTF-8 collision is a known limitation.
- `?` is added only when the serialized query is non-empty, which keeps `?&` idempotent.
- Fatal-stop: `take()` assigns sequence numbers, a stopping commit advances `nextCommit` and reserves nothing, the first exception wins, and `Promise.allSettled` is used. SIGINT uses the same stopping rule.
- `startUrl` is a required, validated config field of `crawl(config, deps)`.
- Milestone 1 requires converting every `test.failing` at once and having none left when it is done. Added a reversed-order spelling case and a fatal-stop fixture test.
- Corrected the learning-log list of retired tests. Robots tests are retired in Milestone 2.

### 2026-10-08

- Added the Milestone 1 URL equivalence tests and the worker-loop sketch. Neither is approved. The URL policy, frontier, and worker loop are not implemented.
- Corrected the checkpoint: Milestone 1 robots stand-in, normal termination, fatal-stop, trailing slashes, scheme-specific ports, code-unit query order, `URLSearchParams` pairs, no extra percent-decoding, invalid `canonicalKey`, discovered userinfo, and first-reserved fetch spelling.
- Renamed "Author checkpoints" to "Checkpoints". The agent now writes every checkpoint artifact (equivalence tests, worker-loop sketch, robots decision table, politeness cases, README design and limitation sections). The author reviews and approves each one before the implementation it describes.

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
