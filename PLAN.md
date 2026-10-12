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

Milestones 0 through 4 are the portfolio. Milestone 5 (a single Docker image) is optional polish. Milestones 6 and 7 are the current work. Milestones 8 and 9 follow them. Anything that is not a milestone yet is in Future work.

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
- Do not implement Future work until an item is promoted into a milestone. Do not add dependencies other than the ones listed in [Dependencies](#dependencies).

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
- The engine does not write to stdout and does not write files. Logs go to the injected logger, which writes to stderr by default. Trace is an injected sink. The engine does not call `console.error` for it.
- Do not wrap worker code in a catch-all that turns unknown exceptions into page failures. Only errors classified in [Error taxonomy](#error-taxonomy) become page records. Anything else is a fatal error.
- The robots manager never acquires a lease and never calls `fetch`. It uses the worker's current lease and the injected HTTP client. Only the worker that actually performs the `robots.txt` fetch calls `beforeAttempt` for that fetch. Waiters on the cached promise do not.
- Do not implement a second robots matcher. `robots-parser` is the only allow and crawl-delay implementation.
- Fatal-stop may cut a politeness or retry sleep short. It does not abort an in-flight `fetch`. SIGINT does not cut those sleeps.
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
- Ignored links produce no `PageResult`. An empty or whitespace-only `href` is silent. Every other ignored link writes one `logger.debug` line: `ignored {reason} {href} base {pageUrl}`. The reason is `unparsable` when `new URL` throws, `scheme` when the resolved scheme is not `http` or `https`, and `userinfo` when the resolved URL has a username or password. Carriage returns and line feeds in the href or the base are replaced with a space, so one link is one stderr line. The crawl passes the injected logger. A call with no logger writes nothing.

### Frontier and reservation

One crawl owns one frontier. The frontier is a FIFO queue plus a `seen` map from canonical key to the record that owns it.

Each link from a page at depth `d` is handled in this order. The first rule that matches decides the outcome.

1. Resolve with `new URL`. If it throws, ignore the link. If the resolved URL has a username or password, ignore it. If the scheme is not `http` or `https`, ignore it. Otherwise canonicalize. Invalid input never becomes a `seen` entry and never becomes a page failure.
2. The key is already in `seen`: ignored. No new record. This is the URL-key rule. A repeated body is a different rule, in Content identity.
3. The origin differs from the start origin: one record, `skipped` / `other-origin`. Not fetched.
4. `d + 1 > maxDepth`: one record, `skipped` / `depth-limit`. Not fetched.
5. The key trips a crawler-trap guard: one record, `skipped` with that guard's reason. Not fetched, and not a reservation. The start URL is reserved before this step and is never trap-skipped.
6. `maxPages` records are already reserved: one record, `skipped` / `page-limit`. Not fetched.
7. Otherwise reserve: create a record with state `queued` and depth `d + 1`, and push it onto the queue.

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

### Crawler-trap guards

`maxPages` limits how many URLs are reserved. These three limits drop a discovered URL before it takes a slot. Each is a positive integer. `0` is a `ConfigError`. The check uses the canonical key, after the URL-key, origin, and crawl-depth steps, and before the `maxPages` step. The first matching guard wins.

- `maxUrlLength` is the maximum JavaScript string length of the canonical key. A longer key is `skipped` / `url-length`.
- `maxPathDepth` counts path segments. Split the key's path on `/` and drop the leading empty string. Count what remains, including empty segments between slashes. `/` is 0, `/a/b` is 2, and `/a//b` is 3. The query is not part of the count. A count above the limit is `skipped` / `path-depth`.
- `maxSegmentRepeats` is how many times one non-empty segment may occur in that same list. Comparison is exact and case-sensitive. A segment that occurs more times is `skipped` / `repeated-segment`. `/a/b/a` is allowed when the limit is 2. `/a/a/a` is not.

The start URL is reserved first and fetched even when its key would trip a guard. A discovered URL that trips a guard enters `seen`, is not fetched, and does not count toward `maxPages`.

A redirect hop uses the same three checks after the off-origin, loop, and duplicate checks, and before robots. A hop that trips a guard is not requested. The record is `skipped` with that reason, keeps the attempts and the last response status, and keeps `finalUrl` as the last URL requested. The hop key is stored in `seen` as an alias of this record and does not take another `maxPages` slot.

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
| `maxDurationMs` | `null` |
| `maxTotalAttempts` | `null` |
| `maxUrlLength` | `2048` |
| `maxPathDepth` | `16` |
| `maxSegmentRepeats` | `2` |
| `dedupeContent` | `true` |
| `respectCanonical` | `true` |

Fixed constants, not configuration: retry delay cap 5000 ms, crawl-delay cap 10 seconds, redirect hop limit 5, `robots.txt` size limit 500 KiB.

`startUrl` is a required config field with no default. Config validation rejects it unless it parses, its scheme is `http` or `https`, and it has no username or password. This check runs inside config creation, before `crawl()` reserves anything, so `canonicalKey` never sees an invalid start URL even when `crawl()` is called from code instead of the CLI.

### CLI arguments

`parseArgs` from `node:util` reads the arguments after the script name. It does not crawl and it does not coerce numbers. A missing flag is omitted, so the default in Defaults still applies. A present numeric flag stays the characters the user typed, including `0`.

| Argument | Result |
|---|---|
| one positional | `startUrl` |
| `--depth` | `maxDepth` |
| `--max-pages` | `maxPages` |
| `--concurrency` | `concurrency` |
| `--per-origin` | `perOriginLimit` |
| `--min-interval` | `minIntervalMs` |
| `--timeout` | `timeoutMs` |
| `--max-duration` | `maxDurationMs` |
| `--max-attempts` | `maxTotalAttempts` |
| `--max-url-length` | `maxUrlLength` |
| `--max-path-depth` | `maxPathDepth` |
| `--max-segment-repeats` | `maxSegmentRepeats` |
| `--user-agent` | `userAgent` |
| `--no-respect-robots` | `respectRobots: false` |
| `--no-dedupe-content` | `dedupeContent: false` |
| `--no-canonical` | `respectCanonical: false` |
| `--format` | reporter format, not a config field |
| `--output` | file path, not a config field |
| `--details` | presentation flag, not a config field |
| `--trace` | presentation flag, not a config field |

- `--no-respect-robots`, `--no-dedupe-content`, and `--no-canonical` take no value. When the flag is absent, that field is omitted and the default stays `true`.
- `--details` and `--trace` take no value. They are `type: "boolean"` in `parseArgs`. A form with a value, such as `--details=true` or `--trace=1`, is a `ConfigError`. When the flag is absent, the field is false. Neither flag is passed to `createCrawlConfig`, and neither appears in `CrawlResult.config`.
- Zero positionals leaves `startUrl` empty for the validation step. A second positional is a `ConfigError`.
- An unknown flag, or a flag that requires a value and has none, is a `ConfigError`. The parser does not accept a second name for the same option.
- Validation reads that result and calls `createCrawlConfig`. A numeric flag must be one or more digits. `0` becomes the number 0 and is passed in, so the default does not replace it. Any other spelling is a `ConfigError`. `createCrawlConfig` then applies the URL rule and the positive or non-negative rule. `--format` and `--output` stay beside the config and are not checked here.
- The runner accepts `--format` `console` (the default when the flag is absent), `json`, or `csv`. Any other value is a `ConfigError` and exit `2`, before a crawl.
- `--details` is valid only with console output. `--format json --details` and `--format csv --details` are a `ConfigError` and exit `2`, before a crawl. `--trace` is valid with every format. `--details` with `--output` and the default format is allowed: the file is the same human text as stdout.

An omitted field other than `startUrl` gets the default above. An unknown config key is a configuration error, so a typo cannot silently fall back to a default. Validation: `maxDepth` and `retryCount` and `minIntervalMs` and `retryBaseDelayMs` are non-negative integers. `maxPages`, `concurrency`, `perOriginLimit`, `timeoutMs`, and `maxResponseBytes` are positive integers. `maxDurationMs` and `maxTotalAttempts` are `null` or a positive integer. `0` is rejected for both. `maxUrlLength`, `maxPathDepth`, and `maxSegmentRepeats` are positive integers. `0` is rejected for each. `dedupeContent` and `respectCanonical` are booleans. There is no `--max-bytes` flag. `maxResponseBytes` stays the per-response cap, and a total-byte budget is not a config field. `respectRobots` is a boolean. `userAgent` is a non-empty string and must not contain a character in U+0000–U+001F or U+007F. Those bytes are illegal in an HTTP header value, so a `User-Agent` of `Bot\r\nX-Extra: 1` is a `ConfigError` before any fetch. The message is `userAgent must not contain control characters`.

### Workers and termination

`concurrency` is the number of worker loops. A worker is the global slot. There is no separate global semaphore.

Worker loop:

1. `item = await frontier.take()`. `null` means the crawl is over, and the worker returns.
2. The record is now `fetching` and has its dequeue sequence number. `take()` assigns both synchronously before it returns the item, so every item a worker holds already has a number.
3. Acquire the politeness lease for the item's origin (see Politeness).
4. Check robots at this point, with the lease already held: `robots.check(url, { beforeAttempt: lease.beforeAttempt })`. A disallow is `skipped` / `robots`. An unavailable file is `skipped` / `robots-unavailable`. Neither contributes links. The call site does not move.
5. If the check allows the URL, run the redirect loop (see Redirects). Each page network attempt calls the same lease's `beforeAttempt`.
6. Classify the response. If it is HTML, read the body, parse links and the raw canonical href, and remember the body hash. Content identity decides, at commit time, whether those links are reserved.
7. Release the lease.
8. Commit the item with its links (see Commit order). This always happens, in a `finally`, including after a skip or a classified failure.

The frontier tracks three numbers: queued items, items taken but not committed, and results waiting in the commit buffer. A worker never treats a momentarily empty queue as the end, because a taken item that has not committed can still add links.

Normal termination: the queue is empty and every item that `take()` already returned has been committed. The frontier then resolves every pending `take()` with `null`. Each of those workers returns. `crawl()` resolves after all workers have returned. `null` means this crawl is over. It is not an error.

Fatal stop: an exception that is not a classified page failure. The frontier enters fatal-stop immediately.

- It does not hand out any further queued item.
- Every `take()` that is already waiting resolves with `null`, so no worker stays blocked in `take()`. A worker that receives that `null` returns. It has no item and does not commit.
- A politeness `beforeAttempt` wait and an HTTP retry sleep end early. They resolve without throwing. The in-flight `fetch` is not aborted. The worker continues the item it already holds: it finishes the current attempt or retry loop, then commits. A cancelled sleep is not itself a page failure.
- A worker blocked in `acquire` is not woken by fatal-stop directly. It is released when a holder hits `finally` and calls `release()`, then it acquires and finishes its item. It must not sit in the FIFO forever, and it must not poll.
- The worker that threw holds an item, so it has a sequence number. Its `finally` commits that number with an empty link list if it has not committed yet, then rethrows the same exception object.
- Any other worker that already holds an item finishes that item and commits it.
- While stopping, commits follow the stopping rule in Commit order: `nextCommit` still advances, and nothing is reserved.
- The first exception that triggers fatal-stop is the rejection value. A later exception from another worker is logged and does not replace it.
- `crawl()` waits for every worker with `Promise.allSettled`, not `Promise.all`. `Promise.all` rejects while other workers are still running, which breaks "after the workers return".
- `crawl()` rejects with that first exception after the workers return. Shutdown must not replace it, wrap it, or reject with a new error. A failure inside shutdown is logged and does not become the rejection.

Classified page failures are not fatal-stop. They commit an empty link list and the crawl continues.

### Crawl budget

`maxPages` limits how many URLs are reserved. `timeoutMs` limits one attempt. `maxDurationMs` and `maxTotalAttempts` limit the crawl. `null` means that limit is off. Omitting the flag leaves the default `null`, so an existing crawl does not stop early.

`maxDurationMs` is measured with the injected clock, from the start of `crawl()` to the moment the next attempt would be claimed. Politeness waits and retry backoff that already started count as time. `maxTotalAttempts` counts every claim that starts an HTTP attempt: page fetches, retries, redirect hops, and `robots.txt`. `PageResult.attempts` still counts only that page's own attempts. It does not include `robots.txt`.

The crawl owns a `claimAttempt()` used by every `http.get` before `beforeAttempt` and before a retry sleep. The HTTP client does not decide the budget. The claim is synchronous, before any wait:

- If this stop reason is already `budget`, the claim fails and the count does not change.
- If `maxTotalAttempts` is set and the count is already at that cap, the claim fails and the frontier stops for `budget`.
- If `maxDurationMs` is set and `clock.now() - startedAt` is already at or past it, the claim fails and the frontier stops for `budget`.
- Otherwise the count increments by one and the claim succeeds.

A failed claim does not sleep and does not call `fetch`. A claim that succeeded may finish its politeness wait, its retry sleep, and its `fetch`, including the body, even if the clock passes `maxDurationMs` during that work. The next claim then fails. Two workers cannot both take the last remaining attempt, because the increment happens before the first wait. Several workers may already hold a claimed attempt when the duration cap is crossed. Those attempts finish. That is the overshoot.

`BudgetStop` is the refusal. It is not a `FetchError`, not an `errorKind`, and not fatal-stop. `beforeAttempt` throwing it, or `get` returning because a retry was refused, must not be wrapped as a network error.

What the worker commits:

- No page request has started, including when `robots.txt` was refused or had not been fetched yet. The record is `skipped` / `budget`, with `attempts` 0 and `waitedMs` null. The origin is not `robots-unavailable`. A `robots.txt` response that already completed stays in the cache.
- A page attempt already failed with a `FetchError`, and the retry claim is refused. The page stays that failure (`timeout`, `connect`, `reset`, or the other retryable kind).
- A retryable status was returned, and the retry claim is refused. The page is `failed` / `http-status` for that status.
- The next redirect hop is refused. The record is `skipped` / `budget`. It keeps the attempts and the last response status. `finalUrl` is the last URL that was requested. No further hop is requested.

The frontier stores the first stop reason. `SIGINT` uses `interrupted`. The budget uses `budget`. A later signal does not replace the first reason. Fatal-stop still rejects with the original exception and does not return a `budget` result. After a budget stop, `take()` hands out nothing, queued records stay `queued`, and a commit reserves nothing. The process exits `0`.

There is no `maxTotalBytes`. `maxResponseBytes` remains the only byte cap.

### Commit order

Workers finish in network order, which changes from run to run. Links are therefore reserved in dequeue order, not finish order.

- Each taken item gets a sequence number `0, 1, 2, ...` in the order `take()` returned it.
- A finished item is placed in a commit buffer keyed by sequence number.
- The frontier keeps `nextCommit`. While the buffer holds `nextCommit`, it removes that entry, applies the reservation rules to its links, and increments `nextCommit`.
- Skipped and failed items are committed with an empty link list. A sequence number that is never committed stalls the crawl, which is why step 8 runs in `finally`.
- A commit marks its sequence number committed before it applies reservations. An exception during reservation then cannot cause the `finally` to commit the same number twice.
- Stopping rule. Once the crawl is stopping, after a SIGINT, a budget stop, or a fatal-stop, every commit still removes its entry and advances `nextCommit`, but it reserves nothing. The rule depends on when the commit happens, not on when the page finished. A page that finished before the stop but was still waiting in the buffer reserves nothing when it commits after the stop. A budget stop does not start a new attempt. A SIGINT still lets the current item finish its retry loop. See Crawl budget.

Because the queue is FIFO and commits happen in dequeue order, the crawl is breadth-first. A key is always first discovered at its smallest depth. The same responses produce the same records in the same order for any `concurrency`. Fetching stays concurrent. Only reservation waits.

### Redirects

The HTTP client does not follow redirects. The worker runs the redirect loop because every hop is a scope and robots decision.

- A response with status `301`, `302`, `303`, `307`, or `308` and a `Location` header is a hop. Resolve `Location` against the current URL. If that throws, or the resolved URL has a username or password, the record is `failed` / `bad-redirect` and `canonicalKey` is not called. If the resolved scheme is not `http` or `https`, the record is `skipped` / `redirect-off-origin` and `canonicalKey` is not called. Otherwise canonicalize it.
- If the hop leaves the start origin, the record is `skipped` / `redirect-off-origin`. The off-origin URL is not requested.
- If the hop key equals the record's own key or an earlier hop in this chain, the record is `failed` / `redirect-loop`.
- If the hop key is already in `seen` and owned by another record, this record is `skipped` / `duplicate`. That URL is not requested here. The other record owns it.
- If the hop key trips a crawler-trap guard, the record is `skipped` with that guard's reason. The hop is not requested. The hop key is added to `seen` as an alias owned by this record and does not consume a `maxPages` slot. The record keeps the attempts and the last response status. `finalUrl` stays the last URL requested.
- Otherwise add the hop key to `seen` as an alias owned by this record. An alias does not consume a `maxPages` slot. Check robots for the hop with the same function as step 4 of the worker loop, passing the same lease `beforeAttempt`. If allowed, request the hop's resolved spelling, with the fragment removed, not the canonical key.
- More than 5 hops is `failed` / `redirect-limit`. A redirect status without `Location`, or a hop URL with a username or password, is `failed` / `bad-redirect`. The userinfo hop is not requested.
- `finalUrl` is the last requested URL. Links are resolved against it. The record keeps its original depth and `discoveredFrom`.

### Content identity

URL-key deduplication still happens at reservation. This section is the body. It runs when an HTML record commits, in dequeue order, so two workers cannot disagree about which copy came first. The hash set belongs to that crawl. `node:crypto` SHA-256 is the hash. No new package. The input is the decoded body string encoded as UTF-8. An empty body has a hash. A non-HTML response, a failed page, and a page whose parser throws do not enter the set.

The parser still does not fetch. It returns the link list as it does today, and the raw `href` of the first `<link>` whose `rel` tokens include `canonical`, compared without case. Later canonical links are ignored. A missing tag yields no href. The `links` trace count stays the number of links.

`respectCanonical` resolves that href with the same document base as links. A value that does not parse, has a username or password, is not `http` or `https`, or has another origin is ignored. A key equal to this record's key is ignored. Any other key is a declared canonical.

On commit, the first matching rule decides:

1. `dedupeContent` is true and this hash is already stored. The record is `skipped` / `duplicate-content`. It keeps the status, content type, byte length, and attempts of the fetch. No links are reserved, and a canonical target is not reserved.
2. `respectCanonical` is true and the page declares a canonical key. Store this hash when `dedupeContent` is true. The record is `skipped` / `canonical` and keeps the fetch fields above. Its own links are not reserved. If the canonical key is not in `seen`, discover it through the reservation steps at the same depth as this record, with `discoveredFrom` set to this record's key. The depth check for that discovery is `depth > maxDepth`, not `depth + 1 > maxDepth`. Origin, trap, and `maxPages` then apply as usual. A key already in `seen` is not reserved again.
3. Otherwise store this hash when `dedupeContent` is true, and reserve the page's links as usual.

`--no-dedupe-content` leaves the hash unused, so step 1 does not fire. `--no-canonical` leaves the tag unused, so step 2 does not fire. With both flags, a crawl reserves links the way it did before this section. The stopping rule still reserves nothing after a stop, including a canonical target.

### Politeness

`concurrency` and politeness are different limits. Effective pace is whichever limit is tighter.

- `concurrency` caps in-flight work for the whole crawl, because it is the number of workers.
- `perOriginLimit` caps leases held on one origin at once. A worker that cannot get a lease waits in a FIFO list for that origin until a lease is released.
- `minIntervalMs` is the minimum gap between the starts of two network attempts to the same origin. Tests and the CLI may set it to `0`.
- A robots `Crawl-delay` larger than `minIntervalMs` replaces the gap for that origin, capped at 10 seconds.
- The gap applies to every attempt: first attempts, retries, redirect hops, and `robots.txt`.
- Each origin stores `nextAllowedAt`. `beforeAttempt` computes `startAt = max(now, nextAllowedAt)`, sets `nextAllowedAt = startAt + gap` synchronously, then waits until `startAt` through the clock. Setting `nextAllowedAt` before awaiting prevents two workers from claiming the same start time.
- `waitedMs` is the time from `take()` to that page's own first `beforeAttempt`. Fetching `robots.txt` does not set it. A record skipped before its own page request keeps `waitedMs` null. When the page is fetched, the value includes time spent on the lease, the robots fetch, and the gap.
- On a single-origin crawl, `perOriginLimit` is the limit you can see. `concurrency` still matters as the ceiling, and as the number of workers waiting on that origin.
- Crawl-delay from a parsed `robots.txt` is seconds × 1000. It replaces `minIntervalMs` only when it is larger, then it is capped at 10000. A missing delay, a smaller delay, `allow-all`, `unavailable`, and `not-checked` leave the gap at `minIntervalMs`. The `robots.txt` fetch itself always uses `minIntervalMs`. The parsed delay applies to later attempts on that origin, including the page request that triggered the fetch.
- The gate asks the robots manager for the current gap. It does not parse `robots.txt`.
- Fatal-stop races each `clock.sleep` against an internal abort that `frontier.fail` trips. The race resolves; it does not throw. SIGINT uses the existing `signal` and does not trip that abort, so in-flight work keeps the gap and the backoff.

### Page states

`queued`, `fetching`, `ok`, `skipped`, `failed`.

`fetching` is transient. A finished result does not contain it: in-flight work reaches `ok`, `skipped`, or `failed` before the result is returned. `queued` appears in a result only after an interrupt or a budget stop. If a `fetching` record is still present, `--details` prints a row for it and the summary does not throw. A throw there would replace the partial crawl with a fatal report error. The summary does not add a seventh count for it.

Skip reasons: `other-origin`, `redirect-off-origin`, `depth-limit`, `page-limit`, `duplicate`, `robots`, `robots-unavailable`, `non-html`, `budget`.

A skipped or failed URL is a record in the result. It is not a successful page. The old `pages` map that stored a hit count is retired. Inbound link counts are out of scope.

### HTTP client

One module owns `fetch`. It is created with injected dependencies: `createHttpClient({ fetchImpl, clock, userAgent, timeoutMs, retryCount, retryBaseDelayMs, fatalSignal })`. `fetchImpl` defaults to the global `fetch`. `fatalSignal` is the internal abort from `crawl()`. It cancels retry sleeps only.

`get(url, { maxBytes, beforeAttempt, wantBody })`:

- Sends `redirect: 'manual'`, the configured `User-Agent`, and `Accept: text/html,application/xhtml+xml;q=0.9,*/*;q=0.1`. No cookies. The same headers are used for `robots.txt`.
- Before each attempt, awaits `beforeAttempt()`. The client does not compute politeness. It only calls the hook.
- Each attempt has its own timeout of `timeoutMs` that covers headers and body. Use `AbortSignal.timeout`. Do not attach the fatal-stop abort to the `fetch` itself.
- After headers arrive, it calls `wantBody({ statusCode, contentType })`. If that returns false, or the status is not 2xx, the body is cancelled without reading. A body is always either fully read or cancelled, so no connection is left open.
- If `Content-Length` exceeds `maxBytes`, the attempt fails `too-large` without reading. Otherwise the body stream is read and its decoded bytes are counted. Passing `maxBytes` aborts the read and fails `too-large`.
- The body is decoded as UTF-8 with `TextDecoder`.
- It returns `{ url, statusCode, contentType, location, body, byteLength, attempts, durationMs }`, or throws a `FetchError` with `kind` and `attempts`.
- An HTTP status is never thrown. A 4xx or 5xx response is returned after retries are exhausted, and the crawler classifies it.
- `get` does not return `undefined`. `retryCount` must be a non-negative integer. Any other value throws `Error` `retryCount must be a non-negative integer` before an attempt. If the attempt loop ends without a response or a `FetchError`, `get` throws `Error` `HTTP client ended without a response`. That error is not a page failure. The worker's existing catch treats it as fatal-stop.
- `trace` on the client is optional and defaults to a no-op. It is used only for `attempt-start` and `retry` in Trace. Omitting it changes no fetch behavior.
- `get` calls the crawl's `claimAttempt()` once per attempt it intends to start, before a retry sleep and before `beforeAttempt`. A refusal throws `BudgetStop` when this `get` has not started an attempt, or returns the last response, or rethrows the last `FetchError`, as Crawl budget specifies. `BudgetStop` is not retried and is not wrapped as a `FetchError`.

### Retries

Retries live in the HTTP client and consume the same reservation.

- Retry: `timeout`, `connect`, `reset`, and status `429`, `500`, `502`, `503`, `504`.
- Do not retry: `dns`, `tls`, `too-large`, any other status, and redirects.
- Delay before retry `n` (starting at 1) is `min(5000, retryBaseDelayMs * 2^(n-1))`. There is no jitter, so tests are exact.
- On `429` or `503`, a `Retry-After` header can raise that wait, never lower it. A non-negative integer is seconds. Anything else is parsed as an HTTP date minus `now`; a date in the past is 0. A value that is neither an integer nor a date is ignored, and the backoff stands. The wait is `max(backoff, retryAfterMs)`. If that value is above 5000, do not retry. Return that response.
- The client awaits the backoff through the injected clock first, then calls `beforeAttempt`, then starts the attempt. The worker keeps its lease during both waits. Backoff that already passed the gap is not followed by another full gap: `beforeAttempt` uses `max(now, nextAllowedAt)` as usual.

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

Use the `robots-parser` dependency for allow/disallow and crawl-delay decisions. Do not keep a second production parser. Delete `backend/src/crawler/robots.js` and `backend/tests/robots.test.js` in the same change as the manager.

The file is `${origin}/robots.txt`. The product token is the configured `userAgent` up to, but not including, the first `/` or space. The default token is `WebcrawlerBot`. Pass that token to the library. The library matches it without case sensitivity. A group for that token does not inherit `User-agent: *`. A `*` group applies only when the token has no group of its own. `Sitemap` and `Host` are ignored. Longest match wins, including `Allow` beating a shorter `Disallow`.

- The manager uses the injected HTTP client. It never calls `fetch` and never acquires a lease.
- `check(url, { beforeAttempt })` is the only entry point from the worker. Redirect hops call the same function before they are requested.
- One outcome per origin per crawl. The cache stores the in-flight promise, then that same settled result. There is no TTL. Two workers share one fetch. Only the worker that starts that fetch calls `beforeAttempt` for each robots attempt and robots redirect hop. A waiter only awaits the promise.
- The worker already holds the page origin's lease. The manager uses that `beforeAttempt`. A second lease would deadlock when `perOriginLimit` is 1.
- `robots.txt` is not a `PageResult`. It is not inserted into `seen` and does not consume `maxPages`.
- Fetch with `maxBytes: 512000` (500 KiB) and the normal retry policy. This is a manager-owned redirect loop of at most 5 hops. It may leave the host. The HTTP client still does not follow redirects.
- A 6th hop, a repeated hop, a missing or unparseable `Location`, a `Location` with userinfo, or a non-`http(s)` location is a robots redirect failure. The cache key and the summary stay on the origin that was asked. The final host is not crawled as a page.
- 2xx: parse the body. Empty body allows every path and has no crawl-delay.
- Any 4xx except `429`: the origin is allowed. No crawl-delay. Summary `outcome: "allow-all"`.
- `429` or 5xx after retries: fail-closed. This record and every later record on this origin are `skipped` / `robots-unavailable`. Already fetched records stay as they are. Summary `outcome: "unavailable"`, `errorKind: "http-status"`.
- Network failure, timeout, or `too-large` after retries: same skip. Summary `errorKind` is the `FetchError` kind. `statusCode` is null.
- Robots redirect-loop failure: same skip. Summary `errorKind` is `bad-redirect`, `redirect-loop`, or `redirect-limit`.
- A status that is not 2xx, not 4xx, and not a hop this loop follows (for example `304` or `100`) is `unavailable`.
- A disallowed path is `skipped` / `robots`. The URL is not requested. A reserved skip still counts toward `maxPages`. `attempts`, `waitedMs`, and `errorKind` on that page stay empty. The cause lives on the robots summary.
- With `respectRobots: false`, do not fetch, do not apply crawl-delay, allow every path. Summary `outcome: "not-checked"`.
- Honor `Crawl-delay` for the product token as specified in Politeness.

### Output and shutdown

- The engine returns a `CrawlResult`. Reporters format that result. The engine does not write to stdout and does not choose a filesystem path.
- `--details` and `--trace` change presentation only. They do not change URL policy, reservation order, concurrency, robots, retries, or the contents of `CrawlResult`.
- There is no Desktop report. `printReport`, `getDesktopPath`, `saveToCSV`, and `sortPages` are gone. Nothing writes a CSV because the platform looks like Windows, WSL, or macOS. A file is written only when the CLI is given `--output`.
- Formats: console summary, JSON, and CSV. CSV is the machine table, not the human report. Its quoting covers commas, quotes, and newlines. Its columns are the `PageResult` fields in contract order. `null` is an empty cell. JSON is `CrawlResult` with no extra fields. Trace fields are not added to either format.
- The one-line-per-page console listing is retired. The default human report is the summary below. Complete page rows stay in `--details`, JSON, and CSV.
- JSON is `JSON.stringify` of the `CrawlResult` with a two-space indent and a trailing newline. It adds no fields.
- The CSV's first row is the `PageResult` field names in contract order. Each later row is one page. `null` is an empty cell. A cell that contains a comma, a quote, or a newline is wrapped in quotes, and each quote inside it is doubled.
- A failed `--output` write prints the error on stderr, does not print the report, and exits `1`.
- The first SIGINT aborts the crawl signal. In-flight work finishes, the partial result is reported, and the process exits `0`. The second SIGINT exits `130` immediately and does not write the report.
- The old writer in `backend/src/crawler/report.js` is gone. Reporters live under `backend/src/report/` and do not choose a path.
- On the first SIGINT, stop handing out queued items, let in-flight items finish including their retries, reserve nothing from any commit after the signal (the stopping rule in Commit order), write the partial `CrawlResult` with `stopReason: "interrupted"`, and exit `0`. A second SIGINT exits `130` immediately without writing.

#### Streams

Trace is never written to stdout. `node backend/src/main.js https://example.com --format json --trace > result.json` must leave only the JSON artifact in `result.json`.

| Situation | stdout | stderr | file |
|---|---|---|---|
| Default console | summary | empty unless a fatal error occurs | none |
| `--details` | summary, then the page table | empty unless a fatal error occurs | none |
| `--format json` | JSON only | summary | none |
| `--format csv` | CSV only | summary | none |
| `--format json --trace` | JSON only | summary, then trace | none |
| `--format csv --trace` | CSV only | summary, then trace | none |
| `--output report.json` | summary | empty | the chosen format |
| `--output report.json --trace` | summary | trace only | the chosen format |
| `--output report.txt --details` | summary, then the page table | trace when `--trace` is set | the same human text as stdout |
| configuration error | empty | error message | none |
| crawl or output failure | empty | error message | none |

With `--output`, the summary stays on stdout. It is not copied to stderr. `--details` does not create a fourth format. When the format is `json` or `csv`, the file is that artifact and the summary is still the human text on stdout.

#### Console summary

The default console format does not print one line per page.

Sections, in this order, with a blank line between blocks:

1. Completion line: `{stopReason} {startUrl} {durationMs}ms`. `stopReason` is `completed`, `interrupted`, or `budget`. A fatal error does not print a summary.
2. The `crawl` count block. These six numbers are `CrawlResult.counts` as stored. The reporter does not recompute them. Zero is printed.
3. A `skipped` block, only when at least one page has `state === "skipped"` and `skipReason !== null`.
4. A `failed` block, only when at least one page has `state === "failed"` and `errorKind !== null`.
5. A `robots` block, only when `result.robots` is not empty.

`skipped` and `failed` are presentation maps. They are not fields on `CrawlResult`. Count a skipped page by `skipReason`, and a failed page by `errorKind`. Drop a null reason or kind from the map. An unknown string is shown, not dropped. Sort entries by descending count, then by ascending name.

Within one count block, labels are left-aligned to the longest label in that block and counts are right-aligned to the widest count in that block. The indent is two spaces. Two spaces separate the label and the count. The labels in the crawl block are `reserved`, `fetched`, `ok`, `skipped`, `failed`, `queued`, in that order.

A robots line is not a count row. Indent two spaces, then `{origin}`, two spaces, `{outcome}`, then ` {statusCode}` when status is not null, then ` {errorKind}` when the kind is not null. One origin per line, in result order.

```text
completed https://example.com/ 840ms

crawl
  reserved  12
  fetched    8
  ok         5
  skipped    6
  failed     1
  queued     0

skipped
  depth-limit   3
  other-origin  2
  robots        1

failed
  http-status  1

robots
  https://example.com  allow-all 404
```

In that example the crawl labels pad to `reserved` and the counts pad to `12`. The skipped labels pad to `other-origin`.

#### Details

`--details` prints the summary, a blank line, then a `pages` table. It does not replace the summary. Rows follow `result.pages`. The reporter does not sort or deduplicate them.

Columns, left-aligned, separated by two spaces, with a two-space indent:

| Column | Width | Cell |
|---|---|---|
| `STATE` | 8 | `ok`, `skipped`, `failed`, `queued`, or `fetching` |
| `STATUS` | 6 | the status number for `ok` or `failed` when `statusCode` is not null, otherwise `-` |
| `DEPTH` | 5 | `page.depth` |
| `URL` | the longer of `3` and the longest display URL in this table | display form of `page.canonicalUrl` |
| `REASON` | unpadded | `-` for `ok`, `queued`, and `fetching`; `skipReason` or `-` for `skipped`; `errorKind` or `-` for `failed` |

`errorMessage` is not a column. A redirect target is not a second line. Both stay in JSON, CSV, and trace.

`canonicalUrl`, `requestedUrl`, JSON, and CSV stay complete. Only this table may shorten a URL, and the function is not allowed to read the terminal width.

- If `url.length <= 64`, print it unchanged.
- Otherwise take `new URL(url).origin`. The marker is `...`.
- If `origin.length + 3 >= 64`, print `origin` plus `...`.
- Otherwise `budget = 64 - origin.length - 3`, `head = ceil(budget / 2)`, `tail = budget - head`. The rest is `url` after the origin. Print `origin`, the first `head` characters of the rest, `...`, and the last `tail` characters of the rest.

When any row was shortened, print this line after the table:

```text
URLs may be shortened for terminal display; use --format json or --format csv for complete values.
```

Omit that line when every URL fit.

```text
pages
  STATE     STATUS  DEPTH  URL                            REASON
  ok        200     0      https://example.com/           -
  skipped   -       1      https://example.com/private    robots
  failed    404     1      https://example.com/missing    http-status
  skipped   -       1      https://example.com/notes.txt  non-html
```

#### Trace

`--trace` writes diagnostic lines to stderr through one injected sink. It is not produced by replaying `CrawlResult` after the fact. The default sink is a no-op, so a crawl that does not pass `trace` does not print these lines.

`crawl(config, { httpClient, clock, logger, signal, trace })`. `createHttpClient` takes the same `trace` and may emit only `attempt-start` and `retry`. The client still does not know depth, robots, or the frontier. Every other event is emitted by the frontier or the worker. The sink is called as `trace(event, fields)` and is not awaited. A throw from the sink is caught, logged once, and ignored. It does not change a page record, and it does not replace the crawl's rejection.

A line is `[trace] {event}` plus ` {key}={value}` pairs in a fixed order per event. A value that matches `^[A-Za-z0-9._:/-]+$` is printed raw. Any other value is JSON-quoted after CR and LF are replaced with a space. A URL with a username or password is rewritten to that origin's URL with the username `***` and an empty password before it is printed. Trace fields are an allow-list. Response bodies, `Cookie`, and `Authorization` are not fields.

| Event | When | Fields |
|---|---|---|
| `crawl-start` | once, after config validation, before workers | `url` |
| `reserved` | a queued record is created, including the start URL | `url`, `depth`, `reason` (`start` or `discovered`) |
| `skipped` | a record is created already skipped (`other-origin`, `depth-limit`, `page-limit`, `url-length`, `path-depth`, `repeated-segment`) | `url`, `reason` |
| `take` | `take()` hands an item to a worker | `url`, `depth`, `sequence` |
| `robots-check` | the worker's `robots.check` returns, including a hop | `url`, `allowed` (`true` or `false`), and `reason` when not allowed |
| `attempt-start` | the HTTP client is about to call `fetch`, after `beforeAttempt` | `url`, `attempt` (1-based) |
| `retry` | a retry wait is about to start | `url`, `next` (the upcoming attempt), `wait` (milliseconds), and `status` or `kind` |
| `redirect` | a hop will be requested | `from`, `to`, `status` |
| `links` | `extractLinks` returned | `url` (the final URL), `discovered` (that return value's length) |
| `commit` | the first `commit` of an item, after its reservations | `sequence`, `state` |
| `fatal` | the first `frontier.fail` | `message` (one line) |
| `crawl-stop` | once, after the workers return, including before a fatal rejection | `reason` (`completed`, `interrupted`, `budget`, or `fatal`) |

A duplicate discovery emits nothing. A reserved page that later becomes `skipped` / `robots` does not emit `skipped`; its `commit` line carries `state=skipped`. The idempotent second `commit` emits nothing. `retry` is not emitted when the response is returned because the wait would exceed 5000 ms. `redirect` is not emitted for a hop that is not requested. `links` is not emitted when extraction throws.

Child `reserved` and `skipped` lines are produced while the parent commit reserves links, and the parent's `commit` line follows them.

Events from one worker stay in this order. Other workers may interleave.

```text
take -> robots-check -> attempt-start / retry / redirect / robots-check -> links, or the page ends without links -> commit
```

A page refused by robots before its own request:

```text
take -> robots-check -> commit
```

A fatal error:

```text
take -> fatal -> commit -> crawl-stop reason=fatal -> the original rejection
```

`crawl-stop` is one line. Trace is not a stable API. Scripts use JSON or CSV.

```text
[trace] crawl-start url=https://example.com/
[trace] reserved url=https://example.com/ depth=0 reason=start
[trace] take url=https://example.com/ depth=0 sequence=0
[trace] robots-check url=https://example.com/ allowed=true
[trace] attempt-start url=https://example.com/ attempt=1
[trace] links url=https://example.com/ discovered=3
[trace] reserved url=https://example.com/about depth=1 reason=discovered
[trace] skipped url=https://external.example/ reason=other-origin
[trace] commit sequence=0 state=ok
[trace] crawl-stop reason=completed
```

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
- `stopReason`: `completed`, `interrupted`, or `budget`.
- `config`: the effective configuration.
- `pages`: records in creation order, which commit order makes stable.
- `robots`: one entry per origin with `origin`, `statusCode`, `outcome` (`parsed`, `allow-all`, `unavailable`, `not-checked`), and `errorKind`.
- `counts`: `reserved`, `queued` (non-zero only after an interrupt or a budget stop), `fetched` (records with `attempts >= 1`), `ok`, `skipped`, `failed`.

### Dependency injection

Inject only what tests need to replace.

- `crawl(config, { httpClient, clock, logger, signal, trace })`. `config` is a plain object that includes `startUrl` and is validated as in Defaults. Each dependency defaults to the real implementation, so `crawl({ startUrl, ... })` with no second argument is a valid call. `trace` defaults to a no-op. The CLI passes a stderr writer only when `--trace` is set.
- `clock` is `{ now(), sleep(ms) }`. Do not add a signal argument to `sleep`. Fatal-stop cancellation is `Promise.race` against an internal abort created inside `crawl()`, tripped only by `frontier.fail`. The HTTP client and the gate receive that abort. SIGINT does not trip it.
- Every time measurement and every delay in the engine, HTTP client, and politeness gate goes through the clock. Unit tests use a fake clock. Integration tests may use the real clock with `minIntervalMs` and `retryBaseDelayMs` set to small values.
- `logger` is `{ debug, info, warn, error }` and writes to stderr by default.
- `signal` is the stop request used by the CLI for SIGINT.

Do not add a container, a plugin system, or interfaces for components that have one implementation.

### Dependencies

- Runtime: `jsdom` (link extraction, already installed) and `robots-parser`. Remove `p-limit`.
- Development: `jest`, `eslint`, `@eslint/js`, `globals`.
- Node built-ins cover the rest: `fetch`, `node:http` for the fixture, `node:util` `parseArgs` for the CLI.

Adding any other package is an edit to this section first.

### Toolchain

- Node 24 LTS. `backend/.nvmrc`, the root `engines` field, CI, and the README badge agree.
- ESLint flat config with `@eslint/js` recommended rules and the Node and Jest globals. `npm run lint` runs it. CI runs lint and tests.
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

**Active milestone:** Milestone 7 - Crawl budget. Milestones 0–6 are complete. Config, `claimAttempt()`, and the first stop reason are in place. A page refused before its request is not classified yet.

**Known behavior of the code today:**

- `[x]` A frontier crawl, config validation, a robots manager on `robots-parser`, and a console/CSV report exist under `backend/`.
- `[x]` Jest covers the canonical key, link resolution, the frontier, the fixture crawl, config validation, robots parsing, and sort order, plus the Milestone 1 checkpoint tests and the setup tests. The suite has 313 tests.
- `[x]` Root `npm test` runs the backend suite. `npm run verify` runs lint, then that suite.
- `[x]` GitHub Actions installs `backend/` and runs `npm run verify` on the Node version in `backend/.nvmrc`.
- `[x]` `npm start` from `backend/` runs `src/main.js` through `runCli`. A bad URL or flag exits `2`. A finished crawl exits `0`, including when pages failed. A fatal error or a failed `--output` write exits `1`. The second SIGINT exits `130`. The default stdout artifact is the console summary. `--format json` or `csv` without `--output` puts that artifact on stdout and the summary on stderr. `--output` writes the chosen format and still prints the summary.
- `[x]` The duplicate root crawler and the Vite starter are gone.
- `[x]` `concurrency` is the worker count. `p-limit` is gone. A parent no longer holds a slot while waiting for children.
- `[x]` `maxPages` counts fetch reservations. The default is `50`. `Infinity` is rejected.
- `[x]` Depth `0` is passed through. It fetches the start URL and records further links as `depth-limit`.
- `[x]` The canonical key keeps scheme, port, and query. Link extraction reads the raw `href` and resolves it with `new URL` against the document base.
- `[x]` Scope is the start origin. Redirects are hop-by-hop. An off-origin hop is not requested.
- `[x]` The engine returns `CrawlResult` and `PageResult`. Non-HTML is `skipped` / `non-html`. A missing `Content-Type` is non-HTML. Unread bodies are cancelled.
- `[x]` Each page attempt has a timeout and a streaming byte limit. A hung response is `failed` / `timeout`. An oversized body is `failed` / `too-large`. Redirects are still manual. An invalid start URL is a `ConfigError` before any fetch.
- `[x]` Retries stay inside the HTTP client. `timeout`, `connect`, `reset`, and `429`/`500`/`502`/`503`/`504` retry. `dns`, `tls`, `too-large`, redirects, and every other status do not. Backoff runs through the clock before `beforeAttempt`. `Retry-After` on `429` or `503` can only raise that wait, and a wait above 5000 ms returns the response. Fatal-stop ends the sleep and does not abort `fetch`.
- `[x]` `robots-parser` decides allow and crawl-delay. One `robots.txt` fetch is shared per origin, on the worker's existing lease. A disallowed path is `skipped` / `robots` and is not requested. An unavailable file is `skipped` / `robots-unavailable`. The custom parser is gone.
- `[x]` The politeness gate is a per-origin FIFO of leases. `beforeAttempt` claims `nextAllowedAt` before it waits. The gap is `minIntervalMs` until a parsed crawl-delay is larger, then that delay, capped at 10 seconds. `waitedMs` runs from `take()` through that page's own gap. Fatal-stop ends the wait and does not release a held lease.
- `[x]` A file is written only for `--output`. There is no guessed Desktop path. Console, JSON, and CSV keep `pages` in creation order.
- `[x]` Node is pinned to 24, and ESLint checks `backend/`.
- `[x]` `docker build -t webcrawler .` then `docker run --rm webcrawler` runs the fixture demo. The image uses Node 24, a non-root user, and a deps stage that is not the runtime. The repository does not publish the image.
- `[x]` The default console is the count summary. `--details` prints that summary, then the page table. `--format json --details` and `--format csv --details` exit `2` before a crawl. `--details=true` and `--trace=1` exit `2`. `--trace` emits the event table to stderr and never to stdout. Values outside the character rule are quoted. A URL with userinfo is rewritten to that origin with username `***`. A throwing sink is logged once and does not change the result or the rejection. `--format json --trace` leaves parseable JSON on stdout. JSON and CSV stay as they are.
- `[ ]` `maxDurationMs` and `maxTotalAttempts` default to `null`. `0` is a `ConfigError`. `--max-duration` and `--max-attempts` set them, and `--max-bytes` is rejected. `claimAttempt()` runs before a retry sleep and before `beforeAttempt`. A refused claim does not fetch. `BudgetStop` does not become fatal-stop. The first stop reason stays: a budget stop exits `0`, and a later SIGINT does not replace it. A page that never starts a request is still not `skipped` / `budget`. Queued records after the stop, and the rest of the fake-clock suite, have not started.
- `[ ]` There are no crawler-trap guards. Milestone 8 adds URL length, path depth, and repeated segments.
- `[ ]` A repeated HTML body is fetched and its links are reserved. A `rel=canonical` href is not read. Milestone 9 adds both.

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

Checkpoint approved 2026-10-10. The decision table and politeness cases in the learning log stand, as corrected in Cemented Behavior. Implementation may start.

- `[x]` Add the per-attempt timeout and the streaming byte limit to the HTTP client. Count decoded bytes as they arrive. Do not load the whole body and measure it afterwards.
- `[x]` Map network errors to the error taxonomy through `cause.code`. Unit-test each kind with an injected `fetchImpl`.
- `[x]` Retry only the cemented cases, with backoff before `beforeAttempt`, the `Retry-After` rule, and the injected clock. Race retry sleeps against the fatal-stop abort. Do not abort the `fetch`.
- `[x]` Replace the robots stand-in with a manager on `robots-parser`. Single-flight cache, status table, fail-closed, product-token match, manager-owned robots redirect loop, lease reuse. `check(url, { beforeAttempt })` stays at worker step 4 and on every page redirect hop.
- `[x]` Implement the politeness gate: per-origin FIFO leases, `nextAllowedAt` set before waiting, gap on every attempt, crawl-delay from the robots manager after a successful parse, `waitedMs` as specified.
- `[x]` Unit-test the gate and the retry delays with a fake clock, including the case where backoff already passed the gap.
- `[x]` Delete `backend/src/crawler/robots.js` and `backend/tests/robots.test.js` in the same change.
- `[x]` Fixture and injected-client tests:
  - disallowed path is never requested
  - redirect into a disallowed path is never requested
  - missing `robots.txt` (404) allows the origin
  - `robots.txt` 500, after retries, skips the origin as `robots-unavailable`
  - two workers share one `robots.txt` fetch
  - `perOriginLimit: 1` plus a robots fetch does not deadlock
  - slow body hits `timeoutMs` and becomes `failed` / `timeout`
  - oversized body becomes `failed` / `too-large`
  - `503` succeeds on retry; `429` with `Retry-After` waits that long unless it exceeds 5000 ms
  - same-origin peak concurrency never exceeds `perOriginLimit`
  - consecutive request starts to one origin, including `robots.txt`, are at least `minIntervalMs` apart
  - `respectRobots: false` fetches a disallowed path and leaves crawl-delay unused

**Done when:** a disallowed path is never requested, including through a redirect. A timeout becomes a failed `PageResult` rather than a hung process. `perOriginLimit: 1` still completes a crawl that must fetch `robots.txt`. A same-origin run never has more than `perOriginLimit` requests in flight. Consecutive request starts to one origin are at least `minIntervalMs` apart in the fixture log. `npm run verify` is green and the custom parser is gone.

The console summary in Output is not part of this milestone.

### Milestone 3 - CLI and reports

**Goal:** The CLI is a thin adapter. Scripts can depend on the exit code and the JSON shape.

- `[x]` Parse with `node:util` `parseArgs`. Accept a positional URL plus `--depth`, `--max-pages`, `--concurrency`, `--per-origin`, `--min-interval`, `--timeout`, `--user-agent`, `--no-respect-robots`, `--format`, and `--output`.
- `[x]` Validate the URL and every number. Preserve an explicit `0` for depth. Unknown flags are errors.
- `[x]` Use exit codes `0`, `1`, `2`, and `130` as specified above.
- `[x]` Emit the console summary from Output, plus JSON and CSV, from `CrawlResult`, following the one-artifact-on-stdout rule. CSV escapes commas, quotes, and newlines. The console text matches the sample, including a skipped page, a failed page, a redirect `final` suffix, and a robots line.
- `[x]` Write files only to `--output`. Delete `getDesktopPath`, `saveToCSV`, and `printReport` in that change. No guessed Desktop path remains.
- `[x]` Delete `sortPages` and rewrite [backend/tests/report.test.js](backend/tests/report.test.js). The console summary and every other reporter keep `pages` in creation order. The hit-count sort goes away with the Desktop writer.
- `[x]` On SIGINT, stop handing out items, finish in-flight work, and emit the partial result.
- `[x]` Test the CLI as a child process against the fixture: bad arguments, explicit `0`, JSON shape, JSON on stdout being parseable, CSV escaping, and a crawl that includes a failed page.

**Done when:** `node backend/src/main.js` against the fixture prints a human report, a stranger can see which pages were fetched, skipped, and failed, no CSV is written to a Desktop path, and JSON matches the result shape.

The page listing this milestone shipped (`ok 200 {url} depth {depth}`) is retired by Milestone 6. Do not restore it.

### Milestone 4 - CV cutoff

**Goal:** The README can stand next to the code in a portfolio review.

- `[x]` Document the queue, commit order, stable order, redirect identity, the politeness split, the failure model, and the defaults.
- `[x]` Include one copy-paste demo against the local fixture and one sample JSON report.
- `[x]` List known limitations: no JavaScript rendering, no subdomain crawl, no sitemap crawl, no resume, single process, UTF-8 decoding only, non-UTF-8 query bytes such as `%FF` and `%FE` sharing one key, `nofollow` not honored, a slow page delays reservation of later pages' links, and one origin's backoff holds a worker.
- `[x]` Agent drafts the design-decisions and limitations sections. Author reviews and approves them. Approved 2026-10-12.
- `[x]` Add a learning-log entry for the queue, commit order, and robots fail-closed behavior.

**Done when:** Milestones 0–3 are checked, and a reader can run the demo from the README alone.

**First CV-ready cutoff:** end of this milestone.

### Milestone 5 - Optional image

Not required for the CV cutoff. Do this only after Milestone 4.

- `[x]` Add a Dockerfile pinned to the Node version in `backend/.nvmrc`.
- `[x]` Run as a non-root user. Multi-stage build if it keeps the image small.
- `[x]` Document `docker run` for the same fixture demo.
- `[x]` Keep publishing, registry credentials, and image scanners out of this repository.

### Milestone 6 - Terminal output

**Goal:** `npm start` and `node backend/src/main.js <url>` are readable before anyone asks for a page list.

The contract is Output. Part A is reporters and CLI flags. Part B is the trace sink. Do not start Part B until Part A is green. Trace must not be built by printing `CrawlResult` at the end.

Part A, summary and details:

- `[x]` Replace the one-line page listing with the console summary. Counts come from `CrawlResult.counts`. Skip and failure blocks are reporter-derived, omit empty blocks, and sort by count then name.
- `[x]` Add `--details`. Print the summary, then the page table in `pages` order, with the column widths and the 64-character URL rule. Print the shortened-URL note only when a row was shortened.
- `[x]` Reject `--format json --details` and `--format csv --details` as a `ConfigError` before a crawl. Reject `--details=true` and `--trace=1`.
- `[x]` Follow the stream table, including `--output` with and without `--trace` and `--details`.
- `[x]` Rewrite the console assertions in the reporter, CLI, and demo tests. Default stdout has the crawl counts and does not list page URLs. `--details` lists them in order. JSON and CSV keep the full URL.
- `[x]` Update the README console sample and add the three commands in Output's verification list.

Part B, trace:

- `[x]` Add the `trace` sink to `crawl()` and the HTTP client. Default no-op. The CLI writes stderr only when `--trace` is set.
- `[x]` Emit the event table, including `fatal` and `crawl-stop`. A record created already skipped emits `skipped` and does not emit `take` or `commit`. A reserved page that robots skips emits `commit` with `state=skipped` and does not emit a second `skipped`.
- `[x]` Quote values with the character rule. Redact userinfo. Do not emit bodies, cookies, or authorization.
- `[x]` Catch a sink throw, log it, and leave the crawl result or the original rejection in place.
- `[x]` Lock local event order with `concurrency: 1`. Lock that `--format json --trace` leaves parseable JSON on stdout and trace on stderr only.

**Done when:** a default crawl prints the summary and no page URL list. `--details` adds the table. `--format json --details` exits `2`. `--format json --trace > result.json` is valid JSON, and the trace is only on stderr. `npm run verify` is green. The README shows the plain command, `--details`, and `--format json --trace`.

### Milestone 7 - Crawl budget

**Goal:** A crawl can stop because it ran long enough, or because it made enough HTTP attempts, without looking like Ctrl+C or a crashed page.

The contract is Crawl budget. Do this after Milestone 6. Do not add `maxTotalBytes`.

- `[x]` Add `maxDurationMs` and `maxTotalAttempts` to config, default `null`. `null` or a positive integer. `0` is a `ConfigError`. Wire `--max-duration` and `--max-attempts`. Do not add `--max-bytes`.
- `[x]` Add synchronous `claimAttempt()`. The HTTP client calls it before a retry sleep and before `beforeAttempt`. A refused claim does not fetch. `BudgetStop` is not a `FetchError` and not fatal-stop.
- `[x]` Store the first stop reason. Budget sets `stopReason` to `budget` and exits `0`. SIGINT still sets `interrupted`. A later signal does not replace the first reason.
- `[ ]` A page that never starts a request is `skipped` / `budget`, with `attempts` 0. A refused `robots.txt` fetch does not mark the origin `robots-unavailable`. A refused retry keeps the failure or `http-status` already earned. A refused hop is `skipped` / `budget` and keeps the last response.
- `[ ]` After the stop, leave queued records queued and reserve nothing from later commits. A claimed attempt may finish past the duration cap. Two workers cannot both claim the last remaining attempt.
- `[ ]` Tests with a fake clock: duration stops the next claim; one started attempt finishes; `maxTotalAttempts: 1` with robots on fetches `robots.txt` and does not fetch the page; `respectRobots: false` uses that one attempt for the page; omitted budgets do not stop the crawl; `PageResult.attempts` still excludes `robots.txt`.

**Done when:** a crawl with no budget flags matches today's limits. A duration or attempt cap returns a result with `stopReason` `budget` and exit `0`. Ctrl+C is still `interrupted`. `npm run verify` is green.

### Milestone 8 - Crawler-trap guards

**Goal:** A calendar path, a repeated segment, or a very long URL is skipped before it takes a `maxPages` slot.

The contract is Crawler-trap guards. Do this after Milestone 7.

- `[ ]` Add `maxUrlLength`, `maxPathDepth`, and `maxSegmentRepeats` to config, with the defaults in Defaults. `0` is a `ConfigError`. Wire `--max-url-length`, `--max-path-depth`, and `--max-segment-repeats`.
- `[ ]` Apply the three checks in that order to a discovered key, after crawl depth and before `maxPages`. A hit is `skipped` with `url-length`, `path-depth`, or `repeated-segment`. It enters `seen`, is not fetched, and does not count as a reservation.
- `[ ]` Fetch the start URL even when its key would trip a guard. Apply the same guards to a redirect hop after the duplicate check and before robots. A refused hop keeps the attempts and the last status.
- `[ ]` Tests: a key of length `maxUrlLength + 1` is `url-length`; `/a//b` counts the empty segment; the third copy of a segment is `repeated-segment`; a URL inside the defaults is reserved as today; two guards on one key report the earlier reason.

**Done when:** the fixture demo page set is unchanged under the defaults. A tight cap skips the trap URL and still fetches a later URL that fits in `maxPages`. `npm run verify` is green.

### Milestone 9 - Content identity

**Goal:** The same HTML body does not keep feeding the queue, and a declared canonical URL is what the crawl follows.

The contract is Content identity. Do this after Milestone 8. Do not add a body-hash column to `PageResult`. `schemaVersion` stays `1`.

- `[ ]` Add `dedupeContent` and `respectCanonical`, both default `true`. Wire `--no-dedupe-content` and `--no-canonical` as valueless flags.
- `[ ]` Hash a successful HTML body with `node:crypto` SHA-256 at commit time. The second committed copy is `skipped` / `duplicate-content`, keeps the fetch fields, and reserves no links. A parse failure does not enter the hash set. An empty body does.
- `[ ]` Read the first `rel=canonical` href. A declared other key makes the fetched page `skipped` / `canonical` and reserves that target at the same depth, subject to origin, traps, and `maxPages`. Ignore a tag that does not parse, has userinfo, is off-origin, or names this record's own key.
- `[ ]` With `concurrency` greater than 1, the copy that commits first owns the hash. The other becomes `duplicate-content`.
- `[ ]` Give fixture pages that share a body distinct bodies, or expect `duplicate-content`. With both disable flags, link reservation matches the crawl from before this milestone.

**Done when:** two URLs with the same body produce one fetched page with links and one `duplicate-content` page without them. A canonical tag reserves the target and does not reserve the alias page's other links. Both disable flags leave link reservation unchanged. `npm run verify` is green.

## Future work

Not a current milestone. Implement an item only after it is promoted into Milestones.

- Per-origin queues with a ready-time heap, and retries rescheduled into the frontier instead of holding a worker. Needed only when more than one origin is in scope.
- Widening an origin's gap after `429`, and retry jitter.
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
| CLI summary | `node backend/tests/fixtures/demo.js` | Prints the Output summary, lists no page URL, and exits 0 |
| CLI details | `node backend/tests/fixtures/demo.js --details` | Prints that summary, then the page table, and exits 0 |
| CLI JSON trace | `node backend/tests/fixtures/demo.js --format json --trace` | JSON on stdout. The summary, then trace text, on stderr. Exits 0 |
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
- The HTML parser returns links and the raw canonical href. It does not fetch.
- Reporters format a `CrawlResult` and do not crawl.

Add a file when a boundary above is being violated. Do not add a file only to match a diagram.

## Learning Log

### 2026-10-12 - Trap guards and content identity

- **Problem:** `maxPages` still spends its slots on calendar paths and repeated URLs. Two URLs with the same HTML both enqueue links. A canonical tag was not part of identity.
- **Chosen solution:** Milestone 8, after Milestone 7. URL length, path depth, and repeated segments skip a discovered key before it is reserved. The start URL is still fetched. Milestone 9, after Milestone 8. SHA-256 of the decoded body is decided at commit time. The second copy reserves nothing. A `rel=canonical` key is discovered at the same depth, and the alias page's own links are not.
- **How it was verified:** Read against the reservation order, the redirect hop order, and the fixture pages that reuse one body. No code in this change.
- **Lesson learned:** A duplicate body has to be decided in commit order. Deciding it when the response arrives would make the winner depend on which worker finished first.

### 2026-10-12 - Future work replaces Frozen

- **Problem:** The Frozen section listed products this repository would not build. That list sat beside the real backlog and made postponed crawler work look out of scope.
- **Chosen solution:** Remove Frozen. Keep the postponed crawler items as Future work. Current work stays Milestones 6 and 7. An item in Future work is implemented only after it becomes a milestone.
- **How it was verified:** Read against the milestone list and the agent process rule. No code in this change.
- **Lesson learned:** The backlog is the next crawler behavior. A ban list is not a milestone.

### 2026-10-12 - Crawl budget

- **Problem:** `maxPages` caps reserved URLs and `timeoutMs` caps one attempt. Retries, redirect hops, `robots.txt`, and politeness waits can keep a crawl running with no whole-crawl cap. A total-byte cap was considered and left out.
- **Chosen solution:** Milestone 7, after Milestone 6. `maxDurationMs` and `maxTotalAttempts` default to `null`. The clock measures duration. Every HTTP attempt, including `robots.txt`, consumes the attempt budget through a synchronous `claimAttempt()`. The attempt already claimed may finish. The next one does not start. `stopReason` is `budget`, distinct from `interrupted`, and the process exits `0`. A page that never gets a request is `skipped` / `budget`. There is no `maxTotalBytes`.
- **How it was verified:** Read against the stop reasons and the worker commit rules. No code in this change.
- **Lesson learned:** A budget stop is a finished crawl. Folding it into Ctrl+C or into a page error hides which limit fired.

### 2026-10-12 - Terminal output contract

- **Problem:** The default console prints one line per page, so the first thing a new user sees is a wall of URLs.
- **Chosen solution:** Milestone 6. The default report is a summary of counts, skip reasons, failure kinds, and robots. `--details` adds a page table and may shorten URLs for display only. `--trace` is a live stderr sink, not a replay of `CrawlResult`. JSON and CSV are unchanged. `--details` is illegal with `json` and `csv`. A record created already skipped is a `skipped` trace line and is not a `take`. A reserved page that robots refuses is a `commit` with `state=skipped`. Part A lands before Part B.
- **How it was verified:** Read against the stream table and the event allow-list. No code in this change.
- **Lesson learned:** A page list is a details view. Putting it on the default stdout made a correct crawl look unfinished.

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

The old crawl locks below were rewritten with the frontier and the result contract. The hit-count reporter was removed with the Desktop writer.

- Keys without a scheme. Rewritten. Lookups are full keys such as `https://example.com/pageA`, and `http` and `https` stay different.
- `about:blank` resolution. Rewritten. `href="invalid"` on base `https://blog.boot.dev` resolves to `https://blog.boot.dev/invalid`. Resolved spellings still keep a trailing slash. Only the key drops it.
- `maxPages: Infinity`. Rewritten. [backend/tests/crawl-config.test.js](backend/tests/crawl-config.test.js) rejects `Infinity`. The default is `50`.
- The hit-count map. Rewritten. The engine stores one `PageResult` per key. A non-HTML response is `skipped` / `non-html`. Repeat discoveries do not increment a count.
- Exclusive depth. Rewritten. `maxDepth` is inclusive. A link past the limit is a `depth-limit` record, and the page at the limit is fetched.
- Dropped external links. Rewritten. An external link is a `skipped` / `other-origin` record.
- `sortPages`. Rewritten. Console, JSON, and CSV keep `pages` in creation order. The hit-count sort and the Desktop writer are gone.

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

### 2026-10-10 - Milestone 2 checkpoint

Approved: 2026-10-10, with the corrections written into Cemented Behavior in the same day's review. Implementation may start. This entry does not add a robots manager, a real politeness gate, a timeout, or a retry.

The call site does not move. A worker still acquires one lease, then checks robots, then fetches. Milestone 2 replaces the allow-all stand-in and the immediate gate. `robots-parser` makes the allow and crawl-delay decision. This crawler does not implement a second matcher.

#### Robots decision table

The file is `${origin}/robots.txt`. The product token is the configured `userAgent` up to, but not including, the first `/` or space. The default token is `WebcrawlerBot`. That token is what the library receives. The library matches it without case sensitivity. A group for that token does not inherit `User-agent: *`. A `*` group applies only when the token has no group of its own. `Sitemap` and `Host` are ignored.

One example file:

```text
User-agent: *
Disallow: /private

User-agent: WebcrawlerBot
Allow: /secret/public
Disallow: /secret
Crawl-delay: 2
```

For `WebcrawlerBot`, the library's answers are the ones this crawl will use:

| Path | Allowed | Why |
|---|---|---|
| `/secret` | no | The token's group disallows that prefix. |
| `/secret/public` | yes | The allow rule is the longer match. |
| `/private` | yes | `/private` is only in the `*` group, and this token has its own group. |
| `/` | yes | Nothing in the token's group disallows it. |

`Crawl-delay` for that token is 2 seconds. An empty 2xx body allows every path and has no crawl-delay. `User-agent: *` plus `Disallow: /` disallows `/` for this token, because the token has no group of its own.

What the fetch of `robots.txt` does to the origin:

| Result of the robots fetch | Pages on that origin | Robots summary | Is the page requested? |
|---|---|---|---|
| 2xx, and the path is allowed | The page is fetched. | `outcome: "parsed"`, `errorKind: null`, status of that 2xx. | Yes. |
| 2xx, and the path is disallowed | This record is `skipped` / `robots`. No links. | `outcome: "parsed"`, `errorKind: null`. | No. |
| 404, or any other 4xx except 429 | The origin is allowed. There is no crawl-delay. | `outcome: "allow-all"`, `errorKind: null`, that status. | Yes. |
| 429 or 5xx, after the HTTP client's retries are finished | This record and every later record on this origin are `skipped` / `robots-unavailable`. No links. Records already fetched stay as they are. | `outcome: "unavailable"`, `errorKind: "http-status"`, that status. | No. |
| Network failure, timeout, or `too-large`, after retries | Same skip as a 429. | `outcome: "unavailable"`, `errorKind` is the `FetchError` kind (`dns`, `connect`, `reset`, `tls`, `timeout`, `too-large`). `statusCode: null`. | No. |
| The robots redirect loop fails | Same skip as a 429. | `outcome: "unavailable"`, `errorKind` is `bad-redirect`, `redirect-loop`, or `redirect-limit`. | No. |
| `respectRobots: false` | Pages are fetched. Crawl-delay is not applied. | One entry, `outcome: "not-checked"`. Nothing is fetched. | Yes. |

A skipped robots record was already reserved, so it still counts toward `maxPages`. Its `attempts`, `waitedMs`, and `errorKind` stay at the empty values. The cause lives on the robots summary, not on the page.

`robots.txt` redirects are not page redirects. The manager follows at most 5 hops and may leave the host. A 6th hop, a repeated hop, a missing or unparseable `Location`, a `Location` with userinfo, or a non-`http(s)` location is a redirect failure. The cache key stays the origin that was asked. The final host is not crawled.

The cache stores the in-flight promise. Two workers that need the same origin share one fetch. There is no TTL. The fetch uses the 512000-byte limit, which is the plan's 500 KiB, and the same retry rules as a page. It is not a `PageResult`, it is not inserted into `seen`, and it does not consume `maxPages`.

The worker fetches that file with the one lease it already holds. It does not acquire a second lease. A second lease would deadlock when `perOriginLimit` is 1. Each robots attempt, including a redirect hop, calls that lease's `beforeAttempt`. That call enforces the gap and does not set the page's `waitedMs`. `waitedMs`, `durationMs`, and `attempts` on the page count only the page's own attempts. A record skipped before its own request keeps `waitedMs` null.

A redirect hop of a page is checked with the same function before it is requested. A disallowed hop is `skipped` / `robots` on the original record. An unavailable file is `skipped` / `robots-unavailable`. The hop URL is not requested.

#### Politeness cases

`concurrency` is the only global cap, because it is the number of workers. `perOriginLimit` is a FIFO of leases for one origin. The gap is separate from the lease. `beforeAttempt` computes `startAt = max(now, nextAllowedAt)`, sets `nextAllowedAt = startAt + gap` before it waits, then waits through the clock.

Crawl-delay from a parsed file is in seconds. Converted to milliseconds, it replaces `minIntervalMs` only when it is larger. It is then capped at 10000. A missing crawl-delay, a smaller crawl-delay, `allow-all`, `unavailable`, and `not-checked` all leave the gap at `minIntervalMs`.

Case 1, global cap. `concurrency` is 2 and `perOriginLimit` is 5, with two origins that both have work. The fixture's peak is 2. The origin cap never creates a third in-flight request.

Case 2, per-origin cap. One origin, `concurrency` 3, `perOriginLimit` 2, `minIntervalMs` 0, robots already known. Workers take A, B, then C. A and B hold the two leases. C waits in that origin's FIFO. When A releases, C is the next to acquire. Nobody polls.

Case 3, minimum gap. Same origin, `perOriginLimit` 2, `minIntervalMs` 200, no crawl-delay. A and B both hold leases. A's `beforeAttempt` at t=0 sets `nextAllowedAt` to 200 and starts. B's `beforeAttempt` at t=0 sees 200, sets `nextAllowedAt` to 400, and starts at t=200. A finishes at t=250 and C acquires the free lease, but C's attempt starts at t=400, not at t=250. Holding a lease is not permission to start early.

Case 4, crawl-delay. The example file's delay is 2 seconds. `minIntervalMs` is 200, so the gap becomes 2000. A delay of 30 seconds becomes 10000. A delay of 0.1 seconds is 100 ms, which is not larger than 200, so the gap stays 200.

Case 5, retry gap. `retryCount` is 2 extra attempts, so three attempts at most. The delay before retry `n`, with `n` starting at 1, is `min(5000, retryBaseDelayMs * 2^(n-1))`. With the default base of 500, the waits are 500 then 1000. The client sleeps that backoff first, then calls `beforeAttempt`, then starts the attempt. The worker keeps its lease during the sleep.

One origin, one worker, `minIntervalMs` 200. Attempt 1 starts at t=0 and sets `nextAllowedAt` to 200. It times out at t=10. The backoff ends at t=510. `beforeAttempt` sees `max(510, 200)`, starts at t=510, and sets `nextAllowedAt` to 710. The gap does not add another 200 on top of a backoff that already passed it.

On `429` or `503`, a `Retry-After` can raise that wait. A non-negative integer is seconds. Anything else is read as an HTTP date minus `now`, and a date in the past means 0. The wait is the greater of the backoff and that value. If the greater value is above 5000, the client does not retry and returns that response. A value that is neither an integer nor a date is ignored, and the backoff stands. Redirects, `dns`, `tls`, `too-large`, and every status outside the retry list are not retried. A status is never thrown. After the last attempt, a 4xx or 5xx is returned and the page becomes `failed` / `http-status`.

Fatal-stop ends a politeness sleep and a retry sleep early. It does not throw a second error. The worker then finishes the item it already holds and commits it. A worker blocked in `acquire` is released when the holder hits `finally` and releases the lease, so it does not sit in the FIFO forever. SIGINT does not cancel those sleeps. In-flight work on interrupt keeps the gap and the backoff, then commits under the stopping rule.

#### Corrections accepted at approval

These replace the looser readings from the first draft of this checkpoint.

1. `robots.txt` uses the worker's current lease and never takes a second one. `perOriginLimit: 1` must still make progress.
2. 500 KiB is 512000 bytes.
3. A robots redirect may change host. A non-`http(s)` hop is a robots redirect failure (`unavailable`), not a page `redirect-off-origin`. The summary stays under the origin that was asked.
4. A final status that is not 2xx, not 4xx, and not a hop this loop follows is `unavailable`. `429` is the only 4xx that fail-closes.
5. The page's `waitedMs` starts at `take()` and ends at that page's own first `beforeAttempt`. The `robots.txt` attempt does not set it. A skip before the page request keeps it null.
6. Backoff is awaited before `beforeAttempt`. `Retry-After` raises the wait and never lowers it. Above 5000 ms, do not retry.
7. Fatal-stop races `clock.sleep` against an internal abort and does not abort `fetch`. SIGINT does not trip that abort.
8. Only the worker that starts the shared `robots.txt` fetch calls `beforeAttempt` for it. Waiters do not. Otherwise two leases would consume two gaps for one file.
9. Crawl-delay is applied only after a successful parse. The `robots.txt` fetch itself uses `minIntervalMs`.

### 2026-10-10 - HTTP timeout and byte limit

- **Problem:** A page fetch could wait forever, and a body was loaded completely before its size was known.
- **Chosen solution:** Each attempt uses `AbortSignal.timeout`. The client reads the body with `TextDecoder` and counts decoded bytes as chunks arrive. A `Content-Length` above `maxBytes` fails `too-large` without reading. A timeout is `failed` / `timeout` on the page. Retries, robots, and the politeness gate are unchanged.
- **How it was verified:** `npm run verify`. Lint is clean. The suite has 154 tests. A hung fixture response becomes one failed page. A declared body over the limit is `too-large`.
- **Lesson learned:** The timeout has to cover the body read, not only the headers. Cancelling a stream after the limit is what keeps the connection from staying open.

### 2026-10-10 - Network error kinds

- **Problem:** A down host has to be a page failure. The client already read `cause.code`, but nothing locked the table, so a wrong kind could become a fatal stop.
- **Chosen solution:** Injected `fetchImpl` throws `TypeError('fetch failed')` with `cause.code`. `ENOTFOUND` and `EAI_AGAIN` are `dns`. `ECONNREFUSED` and `UND_ERR_CONNECT_TIMEOUT` are `connect`. `ECONNRESET`, `UND_ERR_SOCKET`, and `EPIPE` are `reset`. `CERT_*`, `ERR_TLS_*`, and `DEPTH_ZERO_SELF_SIGNED_CERT` are `tls`. An unknown code is `connect`, and the raw code stays in `errorMessage`. `TimeoutError` stays `timeout`.
- **How it was verified:** `npm run verify`. Lint is clean. The suite has 166 tests. Each code above is one case.
- **Lesson learned:** The kind is decided before the crawler sees the error. If the client wraps it as a generic failure, the crawl stops instead of recording the page.

### 2026-10-10 - Retries

- **Problem:** One failed attempt was final, so a timeout or a `503` ended the page even when `retryCount` said to try again.
- **Chosen solution:** The HTTP client retries `timeout`, `connect`, `reset`, and status `429`, `500`, `502`, `503`, `504`. It does not retry `dns`, `tls`, `too-large`, redirects, or any other status. The delay before retry `n` is `min(5000, retryBaseDelayMs * 2^(n-1))`. The client sleeps that delay on the injected clock, then calls `beforeAttempt`, then starts the attempt. On `429` or `503`, `Retry-After` can raise the wait. Above 5000 ms the response is returned. `frontier.fail` aborts `fatalSignal`, which ends the sleep and leaves `fetch` running. SIGINT still only stops the frontier.
- **How it was verified:** `npm run verify`. Lint is clean. The suite has 182 tests. A fake clock locks the delays, the `Retry-After` cases, and the order backoff then `beforeAttempt` then fetch. Aborting `fatalSignal` during the sleep still completes the next attempt, and that attempt's signal stays open.
- **Lesson learned:** The sleep and the fetch are different signals. Cancelling the sleep has to resolve, not throw, or a retry becomes a fatal stop.

### 2026-10-10 - Robots manager

- **Problem:** The worker always allowed every path. A second parser in `robots.js` fetched `robots.txt` with its own timeout and a one-hour cache, and it was not what the crawl used.
- **Chosen solution:** `createRobotsManager` uses the injected HTTP client and `robots-parser`. The cache stores one in-flight promise per origin. Only the worker that starts that fetch calls `beforeAttempt`, and it reuses the page lease. 2xx is parsed for the product token. Other 4xx except `429` allow the origin. `429`, 5xx, network failure, `too-large`, and a failed robots redirect fail closed. `respectRobots: false` does not fetch. Crawl-delay is available through `gapMs` and is not applied until the politeness gate asks for it. The custom parser and its tests are deleted in this change.
- **How it was verified:** `npm run verify`. Lint is clean. The suite has 185 tests. The example file, the status table, a shared fetch, a redirect off-host, and a disallowed path that is never requested are covered. The Jest open-handle warning from the old parser's timer is gone.
- **Lesson learned:** `robots.txt` is not a page. Giving it a second lease deadlocks when `perOriginLimit` is 1, so the fetch has to ride the lease the worker already holds.

### 2026-10-10 - Politeness gate

- **Problem:** Every worker could start a request as soon as it held an item. `perOriginLimit`, `minIntervalMs`, and crawl-delay were configuration that the crawl ignored.
- **Chosen solution:** One FIFO of leases per origin. `beforeAttempt` asks the robots manager for the current gap, sets `nextAllowedAt` before waiting, and sleeps on the injected clock. The `robots.txt` fetch still uses `minIntervalMs`. After a parsed crawl-delay, the page that triggered the fetch waits that delay when it is larger, capped at 10 seconds. `waitedMs` is from `take()` to the end of that page's own first gap. Fatal-stop resolves the sleep and does not wake a worker blocked in `acquire`. A backoff that has already passed `nextAllowedAt` does not add another full gap.
- **How it was verified:** `npm run verify`. Lint is clean. The suite has 196 tests. A fake clock covers the FIFO, the claimed start time, crawl-delay, and both backoff cases. `perOriginLimit: 1` completes a crawl that fetches `robots.txt`.
- **Lesson learned:** The gap and the lease are different waits. Holding a lease is not permission to start early, and crawl-delay cannot be known until the file has been parsed.

### 2026-10-10 - Fixture policy

- **Problem:** The robots table, retries, and the politeness limits were locked in unit tests. The fixture log did not yet show that a disallowed path stays unrequested, that same-origin starts keep the gap, or that peak concurrency stays inside `perOriginLimit`.
- **Chosen solution:** The local server records every request, including `robots.txt`. A disallowed path and a redirect into one are absent from that log. `robots.txt` 500 is retried, then the origin is `robots-unavailable`. `503` becomes `ok` on the next attempt. `Retry-After: 1` waits 1000 ms, and `Retry-After: 6` is not retried. Two workers share one `robots.txt` fetch. `perOriginLimit: 1` finishes. Peak concurrency is 2 when the limit is 2. Consecutive starts are 200 ms apart, including `robots.txt`. `respectRobots: false` fetches the disallowed path and does not apply crawl-delay.
- **How it was verified:** `npm run verify`. Lint is clean. The suite has 207 tests. The spacing and `Retry-After` cases use a clock whose `sleep` advances `now`, and the fixture log reads that same clock.
- **Lesson learned:** The server log is the proof of what was requested. A skipped page record is not enough, because the request can still have left the process.

### 2026-10-11 - CLI arguments

- **Problem:** `npm start` still reads a positional depth and max pages. The Milestone 3 flags were named, but nothing turned those names into fields, and `Number` would have turned an explicit `0` into a value that is easy to drop.
- **Chosen solution:** `parseCliArgs` uses `node:util` `parseArgs`. One positional is `startUrl`. Each flag maps to the field in CLI arguments. Numeric flags stay strings. `--format` and `--output` stay off the config object. `--no-respect-robots` sets `respectRobots` to false only when present. A second positional, an unknown flag, or a missing flag value is a `ConfigError`. The function does not crawl, and `main.js` does not call it yet.
- **How it was verified:** `npm run verify`. Lint is clean. The suite has 220 tests. The new file locks `0` as the string `"0"`, the flag map, and the three argument errors.
- **Lesson learned:** Parsing and validation are separate. The parser's job is to keep the characters the user typed. Turning `"0"` into a number, and rejecting a bad URL, is the next step.

### 2026-10-11 - CLI validation

- **Problem:** The parser kept `"0"` as text. A missing `--depth` and a typed `0` would look the same if that text were dropped, and a bad URL or a non-digit would not yet be a `ConfigError` from the CLI path.
- **Chosen solution:** `createCliConfig` turns a digit string into a number and passes it to `createCrawlConfig`. `0` is passed in, so depth stays `0` and does not become the default `2`. A non-digit, a missing URL, a non-http URL, userinfo, and an unknown flag are `ConfigError`. `--format` and `--output` stay beside the frozen config. `main.js` still does not call this.
- **How it was verified:** `npm run verify`. Lint is clean. The suite has 234 tests. Explicit `0` stays `0` for depth and for `minIntervalMs`. `0` is rejected for the positive limits.
- **Lesson learned:** The default applies only when the flag is absent. Once the characters are a number, `0` is a real setting.

### 2026-10-12 - Exit codes

- **Problem:** `main.js` still read a positional depth and max pages, printed one counts line, and used exit `1` for a missing URL. A second interrupt had no path to exit `130`.
- **Chosen solution:** `runCli` builds config with `createCliConfig`. A `ConfigError`, including an unknown `--format`, exits `2` before a crawl. A finished crawl exits `0` even when pages failed. A thrown crawl error, or a failed `--output` write, exits `1` and does not print the report. The first SIGINT aborts the crawl signal, the partial result is reported, and the process exits `0`. The second SIGINT exits `130` and skips the report.
- **How it was verified:** `npm run verify`. Lint is clean. The suite has 247 tests. Injected crawls lock exits `0`, `1`, `2`, and `130`, including an explicit depth `0` and a write failure.
- **Lesson learned:** Exit `0` means the crawl finished. A failed page is a record, not a failed process. Exit `130` is only the second interrupt, and it has to happen before the report is written.

### 2026-10-12 - Report formats

- **Problem:** The human report was specified, and the process still printed `Crawled N pages`. JSON and CSV had no path that followed the one-artifact rule.
- **Chosen solution:** The console summary is the sample: header, counts, one line per page in result order, then robots. Nulls are omitted. A redirect appends `final`. JSON is the `CrawlResult` with a two-space indent. CSV columns are the `PageResult` fields, `null` is empty, and commas, quotes, and newlines are quoted. `--format json` or `csv` without `--output` puts that text on stdout and the summary on stderr. `--output` writes the chosen format and prints the summary on stdout. `printReport` is still in the tree and `npm start` does not call it.
- **How it was verified:** `npm run verify`. Lint is clean. The suite has 247 tests. The console fixture matches the sample, including a skipped page, a failed page, a redirect `final` suffix, and a robots line.
- **Lesson learned:** The summary is a view of `CrawlResult`. It does not sort, drop pages, or recompute the counts.

### 2026-10-12 - Desktop writer

- **Problem:** `printReport` still guessed a Desktop path, including a Windows path from WSL, and wrote a hit-count CSV there. `npm start` did not call it, but the function was still in the tree.
- **Chosen solution:** Delete `getDesktopPath`, `saveToCSV`, and `printReport` with `backend/src/crawler/report.js`. A file is written only when `--output` is set, and that path is the one the user gave. The source tree has no `Desktop` guess.
- **How it was verified:** `npm run verify`. Lint is clean. A test reads `backend/src` and rejects `getDesktopPath`, `saveToCSV`, `printReport`, and `Desktop`.
- **Lesson learned:** An unused writer is still a writer. The safe path is the one the CLI was given, not a path chosen from the operating system.

### 2026-10-12 - Creation order

- **Problem:** `sortPages` still ordered a hit-count map, and `report.test.js` locked that order. The crawl result is already in creation order.
- **Chosen solution:** Delete `sortPages`. `report.test.js` now locks console, JSON, and CSV to the `pages` array order. A later URL is not moved ahead of an earlier one.
- **How it was verified:** `npm run verify`. Lint is clean. The order test uses `https://example.com/z` before `https://example.com/a`.
- **Lesson learned:** Creation order is the report order. A sort by hits or by URL would tell a different story from the crawl.

### 2026-10-12 - CLI process

- **Problem:** The exit codes and the report text were locked by calling `runCli` in-process. A script depends on the real process: its exit code, stdout being one artifact, and stderr carrying the summary when JSON or CSV is selected.
- **Chosen solution:** Spawn `node src/main.js` against the local fixture. Bad arguments exit `2` with an empty stdout. `--depth 0` prints the summary, records the child as `depth-limit`, and does not request it. `--format json` stdout parses as the `CrawlResult` shape, with `maxDepth` still `0`, and the summary is on stderr. `--format csv` quotes a content type that contains a comma and a quote. A depth-1 crawl prints an `ok` line, a `skipped` / `non-html` line, and a `failed` / `http-status` line, and exits `0`.
- **How it was verified:** `npm run verify`. Lint is clean. The suite has 255 tests.
- **Lesson learned:** `reserved` counts fetch reservations. A `depth-limit` record is in the summary and is not a reservation, so depth `0` reports `reserved 1` and three skipped children.

### 2026-10-12 - README tour

- **Problem:** The README still said the politeness gate was open, that `robots-parser` was unused, and that a Desktop CSV and a hit-count sort remained. A reader could not see how the queue, commit order, or failures actually work.
- **Chosen solution:** The README now describes the queue, commit order, stable order, redirect identity, the split between `concurrency` and politeness, the failure model, and the defaults. The full canonical-key procedure stays in this file.
- **How it was verified:** Read against Cemented Behavior. `npm run verify` is still the suite gate.
- **Lesson learned:** The tour is the mechanism in plain language. A second copy of the key algorithm would drift.

### 2026-10-12 - Fixture demo

- **Problem:** The fixture existed only inside Jest. A reader had no command that starts it, crawls it, and exits.
- **Chosen solution:** `node backend/tests/fixtures/demo.js` starts the local site, runs the CLI at depth 1 with no gap, and prints the summary. `--format json` prints a `CrawlResult`. The README includes that command and one sample from a real run, with the port written as `9`.
- **How it was verified:** `npm run verify`. Lint is clean. The suite has 257 tests. The demo test expects exit 0 and the `ok`, `skipped`, and `failed` lines.
- **Lesson learned:** The sample counts are part of the contract. `/secret` is reserved and not fetched. The other-origin link is not reserved.

### 2026-10-12 - Queue, commit order, and robots fail-closed

Approved: 2026-10-12. The README sections Design decisions and Known limitations are the checkpoint.

- **Problem:** A reviewer will ask why concurrent fetches still produce one `pages` array, and why a failed `robots.txt` skips the rest of the origin.
- **Chosen solution:** One crawl owns one FIFO queue and `concurrency` worker loops. `take()` numbers an item before the request. Finished items wait in a buffer, and links are reserved only for the next number. A skip or a failure commits an empty list. The same responses produce the same records for any `concurrency`.

  Example, already used at the Milestone 1 checkpoint. `concurrency` is 2 and `maxPages` is 4. The start page links to `/c` then `/b`. Sorted, the queue is B, then C, and one reservation remains. B is sequence 1 and answers in 500 ms with `/x` and `/y`. C is sequence 2 and answers in 10 ms with `/x` and `/z`. C waits. B commits first, so `/x` is discovered from B and `/y` is `page-limit`. C then finds `/x` already seen, and `/z` is `page-limit`. Creation order is the start page, B, C, `/x`, `/y`, `/z`. If C's finish had reserved the links, `/x` would belong to C and the later records would be `/z` then `/y`.

  `robots.txt` fails closed when it cannot be used. A 2xx body is parsed. A 4xx other than `429` allows the origin and sets no crawl-delay. `429`, a 5xx after retries, a network failure, a timeout, `too-large`, or a failed robots redirect makes this record and every later record on that origin `skipped` / `robots-unavailable`. Records already fetched stay. A disallowed path is `skipped` / `robots` and is not requested. The README states the same rules under Design decisions, and lists the accepted limits under Known limitations.
- **How it was verified:** Read against Cemented Behavior for the frontier, commit order, robots, and the query step that maps `%FF` and `%FE` to `q=%EF%BF%BD`. Node's `URLSearchParams` produces that shared key. `npm run verify` is unchanged: lint is clean and the suite has 257 tests. No crawl behavior changed.
- **Lesson learned:** Stable order has a cost. Sequence 2 can be finished and still unable to reserve links until sequence 1 commits. Fail-closed is the other side of the same idea: an unknown robots policy is not treated as permission.

### 2026-10-12 - Optional image

- **Problem:** The fixture demo ran only on the host. A reviewer had no image pinned to the same Node version, and a root process was the easy default.
- **Chosen solution:** `Dockerfile` uses `node:24-bookworm-slim`, the major version in `backend/.nvmrc`. A deps stage runs `npm ci --omit=dev` and is discarded. The runtime stage copies production `node_modules`, `backend/src`, and the two fixture files the demo needs, then switches to `appuser` (uid 1001). The default command is `node backend/tests/fixtures/demo.js`, so `docker run --rm webcrawler` is the README demo. `.dockerignore` keeps `.npmrc`, `.env`, and `node_modules` out of the build context. There is no publish step, registry login, or image scanner.
- **How it was verified:** `npm run verify`. Lint is clean. The suite has 258 tests. `docker build -t webcrawler .` then `docker run --rm webcrawler` prints the summary and exits 0. `docker inspect` reports user `appuser`.
- **Lesson learned:** The deps stage is the size cut. Jest and ESLint never enter the runtime image. The Node base is still most of the image, and a second stage does not remove it.

### 2026-10-12 - Engine and CLI edges

- **Problem:** `get` could finish the retry loop with `undefined` when `retryCount` was not a non-negative integer, and the worker would then fail the crawl without a named error. A `User-Agent` containing CR or LF was accepted and could split the header. `getURLs` was a second name for `extractLinks`. Ignored links were dropped with no debug line. A `fetching` record made `formatConsole` throw, which would discard a partial result.
- **Chosen solution:** `get` throws `retryCount must be a non-negative integer` before an attempt, and throws `HTTP client ended without a response` if the loop ends with nothing. That second error is fatal-stop, not a page failure. `userAgent` rejects U+0000–U+001F and U+007F as a `ConfigError`, so the CLI exits `2` before a fetch. `getURLs` is gone; the old cases call `extractLinks`. An ignored link that is not blank writes `ignored {reason} {href} base {pageUrl}` through the injected logger. The console line for a leaked `fetching` record is `fetching {canonicalUrl} depth {depth}`, with the same `final` suffix as the other lines.
- **How it was verified:** `npm run verify`. Lint is clean. The suite has 263 tests.
- **Lesson learned:** A reporter that throws is a second failure mode. The partial crawl has to survive a state the engine is not supposed to emit.

### 2026-10-12 - Console summary and details

- **Problem:** `npm start` printed one line per page, including the full URL. A first run against a real site was a wall of text.
- **Chosen solution:** `formatConsole` prints the completion line, the six `CrawlResult.counts`, then skip and failure tallies sorted by count and then name, then robots rows in result order. Empty skip, failure, and robots blocks are omitted. `--details` is a boolean presentation flag, not a config field. It prints that summary and then a `pages` table in result order. A display URL longer than 64 characters is shortened, and the note is printed only then. `canonicalUrl` in JSON and CSV stays complete. A leaked `fetching` row is a table row; the summary does not list it and does not throw.
- **How it was verified:** `npm run verify`. Lint is clean. The suite has 267 tests. The reporter test compares the Output sample, including the padded counts and the details table.
- **Lesson learned:** The old fetching line was a way to keep a partial report from throwing. The summary does not need that line. The table is the place a leaked `fetching` record is visible.

### 2026-10-12 - Flag rejection and stream placement

- **Problem:** `--details` could be combined with JSON or CSV, and a boolean flag could be given a value. The stream table also said where a trace line belongs, but nothing placed it.
- **Chosen solution:** `--format json --details` and `--format csv --details` throw `ConfigError` `--details is only valid with console output` after format validation and before `crawl()`. `--details=true` and `--trace=1` are rejected by `parseArgs` because those flags are booleans, and the CLI wraps that as a `ConfigError`. `--trace` is not a config field. `renderReport` takes a trace string. With no `--output`, JSON and CSV keep the artifact on stdout and put the summary, then the trace, on stderr. With `--output`, stdout is the human text, stderr is the trace only, and the file is the chosen format. `--details` with `--output` writes the same page table to stdout and the file. The string is empty until the sink in Part B emits events, so a crawl with `--trace` does not invent lines.
- **How it was verified:** `npm run verify`. Lint is clean. The suite has 276 tests. A child process against the fixture exits `2` for the rejected forms and does not record a request.
- **Lesson learned:** The place a line is printed can be locked before the line exists. The sink still has to emit the events; placement does not replay `CrawlResult`.

### 2026-10-12 - README console sample

- **Problem:** The README still showed one line per page, so the first sample a reader saw was the report Milestone 6 retired.
- **Chosen solution:** The demo sample is the count summary from one fixture run, with the port written as `9`. The README lists the plain demo, `--details` with the page table from that run, and `--format json --trace`. It says trace lines are not emitted yet. The Verification table names those three commands.
- **How it was verified:** `node backend/tests/fixtures/demo.js --format json`, then the summary and the details table rendered from that result after the origin was rewritten to port `9`. `npm run verify` stays green. The suite has 276 tests.
- **Lesson learned:** A sample that still lists every URL teaches the old report. The command list has to match the text the formatter prints.

### 2026-10-12 - Trace sink and events

- **Problem:** `--trace` accepted the flag and reserved a place on stderr, but the crawl never called a sink, so a run could not show what it was doing.
- **Chosen solution:** `crawl(config, { trace })` and `createHttpClient({ trace })` take the same function. The default is a no-op. The CLI installs a stderr writer only when `--trace` is set and passes `trace(event, fields)` during the crawl, not a replay of `CrawlResult`. The frontier emits `reserved`, `skipped`, `take`, `commit`, and the first `fatal`. The worker emits `robots-check`, `redirect`, and `links`. The HTTP client emits `attempt-start` and `retry`, including the `robots.txt` fetch that happens inside a check. `crawl-start` is before the workers. `crawl-stop` is after they return, including `reason=fatal` before the original rejection. A record created already skipped emits `skipped` only. A robots refusal emits `commit` with `state=skipped` and does not emit `skipped`. A duplicate discovery emits nothing. `retry` is omitted when the wait would exceed 5000 ms. A hop that is not requested does not emit `redirect`.
- **How it was verified:** `npm run verify`. Lint is clean. The suite has 285 tests. A depth-0 fixture crawl lists `skipped` for `depth-limit` and `other-origin` and does not `take` them. A disallowed `/secret` is `commit state=skipped` with no page fetch.
- **Lesson learned:** `robots.txt` is a fetch, so its `attempt-start` is inside the check and prints before `robots-check`. The page's own `attempt-start` still follows that check.

### 2026-10-12 - Trace quoting, sink errors, and order

- **Problem:** A trace value with a space, a newline, or a password could break the line or leak the password. A sink that threw became the crawl's failure. Nothing yet checked that `--format json --trace` in a real process keeps JSON alone on stdout.
- **Chosen solution:** A value matching `^[A-Za-z0-9._:/-]+$` is printed raw. Anything else is JSON-quoted after CR and LF become a space. A URL with a username or password is replaced by that origin's URL with username `***` and an empty password, so the path and query are not printed. Fields other than the event's allow-list, including a body, `Cookie`, and `Authorization`, are dropped. `guardTrace` catches a sink throw, logs it once through the injected logger, and ignores later throws. The page records and a fatal rejection stay as they were. With `concurrency` 1, one page's `take` through `commit` finishes before the next `take`. A child process running `--format json --trace` parses as `CrawlResult` on stdout, and `[trace]` appears only on stderr after the summary.
- **How it was verified:** `npm run verify`. Lint is clean. The suite has 291 tests.
- **Lesson learned:** The sink is a spectator. If it fails, the crawl that was going to succeed still succeeds, and the crawl that was going to throw still throws the same error.

### 2026-10-12 - Crawl budget config, claim, and first stop reason

- **Problem:** A crawl could run until `maxPages` or one timeout, with no whole-crawl cap, and every non-fatal stop looked like Ctrl+C.
- **Chosen solution:** `maxDurationMs` and `maxTotalAttempts` default to `null`. `0` is a `ConfigError`. `--max-duration` and `--max-attempts` set them. `--max-bytes` is not a flag. `claimAttempt()` is synchronous. The HTTP client calls it before a retry sleep and before `beforeAttempt`. A failed claim does not sleep and does not fetch. The first claim of a `get` throws `BudgetStop`. A refused retry returns the last response or rethrows the last `FetchError`. `BudgetStop` is not a `FetchError` and does not call `frontier.fail`. The frontier keeps the first of `budget` and `interrupted`. A budget result exits `0`.
- **How it was verified:** `npm run verify`. Lint is clean. The suite has 313 tests. A duration cap refuses the retry and keeps the `500`. One attempt spent on `robots.txt` refuses the page and the crawl still returns. Aborting on `commit` leaves `budget`. Aborting during `robots.txt` leaves `interrupted`.
- **Lesson learned:** The claim decides the budget. The HTTP client only asks, and a stop reason written first is the one the result reports.

## Change Log

### 2026-10-12 (Crawl budget config, claim, and first stop reason)

- `maxDurationMs` and `maxTotalAttempts` default to `null`, and the CLI flags set them. `claimAttempt()` can refuse the next HTTP attempt. The first stop reason is `budget` or `interrupted`, and a budget result exits `0`. Page classification for a request that never started has not started.

### 2026-10-12 (Trace quoting, sink errors, and order)

- Trace values are quoted or redacted, and a body, cookie, or authorization is not a field. A throwing sink is logged once. `--format json --trace` keeps JSON on stdout and the trace on stderr. Milestone 6 is complete.

### 2026-10-12 (Trace sink and events)

- `--trace` calls a live sink. The default crawl does not. Events follow the trace table, including `fatal` and `crawl-stop`. Quoting edge cases and a thrown sink have not started.

### 2026-10-12 (README console sample)

- The README demo shows the count summary, the `--details` table, and `--format json --trace`. The Verification table lists those three commands. Trace events are still not emitted.

### 2026-10-12 (Flag rejection and stream placement)

- `--details` is rejected with JSON and CSV before a crawl. A value on `--details` or `--trace` is a `ConfigError`. Trace text is placed on stderr only. The event sink has not started.

### 2026-10-12 (Console summary and details)

- The default console is the count summary. `--details` adds the page table and shortens only the displayed URL. JSON and CSV are unchanged. `--trace` and the flag-combination rejections have not started.

### 2026-10-12 (Trap guards and content identity)

- Promoted crawler-trap guards to Milestone 8 and body-hash deduplication plus `rel=canonical` to Milestone 9. Both follow Milestone 7. The defaults are on. `PageResult` gains no hash column.

### 2026-10-12 (Future work)

- Removed the Frozen section. Postponed crawler items now live only under Future work. They are not current milestones.

### 2026-10-12 (Crawl budget)

- Specified `maxDurationMs` and `maxTotalAttempts`, default unlimited. A hit stops the crawl with `stopReason` `budget` and exit `0`. Total downloaded bytes stay uncapped.

### 2026-10-12 (Terminal output contract)

- Retired the one-line page listing as the default console report. Milestone 6 is the summary, `--details`, and `--trace`. JSON and CSV stay page-level artifacts.

### 2026-10-12 (Engine and CLI edges)

- `get` no longer falls out of the retry loop with `undefined`. A `User-Agent` with a control character is a `ConfigError`. `getURLs` is gone. Ignored links write one debug line. A `fetching` record is printed instead of throwing away the report.

### 2026-10-12 (Optional image)

- A multi-stage image pinned to Node 24 runs the fixture demo as `appuser`. The README documents `docker build` and `docker run`. The image is not published.

### 2026-10-12 (Milestone 4 checkpoint)

- Design decisions and Known limitations were approved on 2026-10-12.

### 2026-10-12 (Milestone 4 draft)

- The README lists the known limitations and drafts Design decisions, including dequeue order and robots fail-closed. The learning log records the same queue example. Author approval is still open.

### 2026-10-12 (Fixture demo)

- `node backend/tests/fixtures/demo.js` crawls the local site and prints the summary. The README includes that command and one sample JSON report.

### 2026-10-12 (README tour)

- The README documents the queue, commit order, stable order, redirect identity, politeness, failures, and the defaults.

### 2026-10-12 (CLI process)

- The CLI is tested as a child process against the fixture: bad arguments, explicit depth `0`, parseable JSON in the result shape, quoted CSV, and a crawl that shows fetched, skipped, and failed pages.

### 2026-10-12 (Creation order)

- `sortPages` is gone. Console, JSON, and CSV keep `pages` in creation order.

### 2026-10-12 (Desktop writer)

- `getDesktopPath`, `saveToCSV`, and `printReport` are gone with `backend/src/crawler/report.js`. A file is written only for `--output`.

### 2026-10-12 (Report formats)

- The console summary, JSON, and CSV are rendered from `CrawlResult`. Stdout carries one artifact. `--output` writes the chosen format and the summary stays on stdout.

### 2026-10-12 (Exit codes)

- `runCli` exits `2` for a bad URL or flag, `0` when the crawl finishes, `1` for a fatal error or a failed `--output` write, and `130` on the second SIGINT. The first SIGINT reports the partial result and exits `0`.

### 2026-10-11 (CLI validation)

- `createCliConfig` checks the URL and each numeric flag. An explicit `0` stays `0`. Unknown flags stay errors. `main.js` still uses the old positional depth and max pages.

### 2026-10-11 (CLI arguments)

- `parseCliArgs` reads one positional URL and the Milestone 3 flags through `node:util` `parseArgs`. Numeric flags stay strings. `main.js` still uses the old positional depth and max pages.

### 2026-10-10 (Fixture policy)

- Locked robots, retries, and politeness against the fixture log: disallowed paths stay unrequested, retries and `Retry-After` follow the table, and same-origin pace stays inside the limit and the gap.

### 2026-10-10 (Console summary)

### 2026-10-10 (Console summary)

- The human report is the console summary in Output: one header, one line per page, then robots. Desktop CSV is not a report. Deleting it waits for Milestone 3.

### 2026-10-10 (Politeness gate)

- Added per-origin FIFO leases and a gap on every attempt. Crawl-delay applies after `robots.txt` is parsed. A backoff that already passed the gap does not add another one.

### 2026-10-10 (Robots manager)

- Replaced the allow-all robots stand-in with `robots-parser`. One shared `robots.txt` fetch per origin uses the worker's lease. The custom parser is gone.

### 2026-10-10 (Retries)

- Retries live in the HTTP client. Backoff goes through the clock before `beforeAttempt`. `Retry-After` can only raise the wait. Fatal-stop ends that sleep and does not abort `fetch`.

### 2026-10-10 (Network error kinds)

- Locked `cause.code` to `dns`, `connect`, `reset`, `tls`, and `timeout`. An unknown code is `connect` and stays in the message.

### 2026-10-10 (HTTP timeout and byte limit)

- Added a per-attempt timeout and a streaming byte limit to the HTTP client.
- A slow page is `failed` / `timeout`. An oversized body is `failed` / `too-large` and is not fully read.

### 2026-10-10 (Milestone 2 checkpoint)

- Wrote the robots decision table and the politeness cases. Approved the same day after review.
- Cemented: lease reuse, 512000-byte robots cap, manager-owned robots redirects, odd status → `unavailable`, `waitedMs` on the page attempt only, backoff before `beforeAttempt`, fatal-stop cancels sleeps but not `fetch`, single-flight `beforeAttempt` ownership, crawl-delay only after parse.
- At this checkpoint, implementation of timeout, retries, robots, and politeness had not started.

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
