# Webcrawler Development Plan

This is the only execution plan for the project. Update it together with implementation, tests, and decisions.

[docs/Architecture.md](docs/Architecture.md) describes component boundaries. It is not a second roadmap. If this file and Architecture.md disagree on scope, order, layout, or behavior, this file wins.

## Status Legend

- `[ ]` not started
- `[-]` in progress
- `[x]` completed
- `[!]` blocked or requires a decision

## Project Goal

Build a single-process command-line crawler that is correct enough to show on a CV: bounded concurrency, an explicit URL policy, robots and timeouts, a tested crawl of a local site, and an honest README.

The crawler engine and the CLI are the product. Node.js is the implementation language for this repository. The design should transfer to a later crawler or worker pool in C++, Rust, or Go. Those languages get their own projects. This repository does not grow into a JavaScript platform.

A reviewer should be able to clone the repo, run one command, and see a crawl whose limits, failures, and output match the written contract.

### CV cutoff

Milestones 0 through 4 are the portfolio. Milestone 5 (a single Docker image) is optional polish. The frozen list below is out of the CV scope.

### Learning themes

Each theme below is the same problem in C++, Rust, and Go. The JavaScript syntax is incidental.

- URL identity and deduplication
- A work queue, a fixed set of workers, and reservation at enqueue time
- Backpressure and crawl limits
- Timeouts, bounded retries, and failure isolation
- Robots policy and per-origin delay
- A thin CLI over a library-shaped engine
- Tests that lock the contract, including a local HTTP server

### Author checkpoints

LLM-written code is allowed. A milestone is not done until the author can explain the checkpoint without reading the code.

- Milestone 1: the author writes the URL equivalence tests and the worker-loop sketch before implementation. The author implements the queue and worker loop by hand.
- Milestone 2: the author writes the robots decision table (allow, disallow, missing file, fetch failure) before wiring the library.
- Milestone 4: the author writes the "Design decisions" and "Known limitations" sections of the README.

## Cemented Behavior

These are decisions. Change them by editing this section, not by inventing a second policy in code.

### URL identity

The canonical key is produced by the WHATWG URL parser.

- Drop the fragment.
- Lowercase the scheme and hostname.
- Omit default ports (`http` 80, `https` 443). Keep any other port.
- Keep the path. `https://host` and `https://host/` are the same key. A trailing slash on any longer path is removed.
- Keep the query. Sort parameters by name, then by value, so parameter order does not create two keys. A missing query and an empty query are the same key.
- Scheme, hostname, and port stay in the key. `http` and `https` are different. `www` is not stripped. Different query values are different keys.

### Scope and link resolution

- Stay on the start URL's origin: scheme, host, and port. Subdomains are outside the crawl.
- Resolve links with the URL parser against the final response URL after redirects. String concatenation is not link resolution.
- Queue only `http` and `https` links.

### Depth and page limit

- The start URL is depth 0.
- `maxDepth` is inclusive. A page at depth `d` enqueues links only when `d < maxDepth`. `maxDepth: 0` fetches only the start URL.
- `maxPages` counts URLs reserved for fetch. Reservation happens when a URL is accepted into the queue. The start URL counts. Discoveries after the limit are skipped with reason `page-limit`.
- The CLI must pass `0` through. A missing flag uses the default. A present `0` stays `0`.

### Defaults

| Field | Default |
|---|---|
| `maxDepth` | `2` |
| `maxPages` | `50` |
| `concurrency` | `5` |
| `timeoutMs` | `10000` |
| `maxResponseBytes` | `1000000` |
| `retryCount` | `2` extra attempts after the first failure |
| `respectRobots` | `true` |
| `userAgent` | `WebcrawlerBot/1.0 (+https://github.com/Lazzar19/webcrawler)` |

An omitted limit is the default above. There is no unlimited default.

### Queue and workers

One crawl owns one queue and `concurrency` workers.

- A worker takes one URL, fetches it, enqueues children, then takes the next URL.
- A worker does not hold its slot while children run.
- The first reservation wins. A later discovery of the same key is ignored.
- The limiter is per crawl. There is no process-global pool.
- The queue stops growing once `maxPages` URLs are reserved or no in-scope links remain inside `maxDepth`.

This replaces the current recursive `p-limit` call. That call holds a slot across the subtree and can stall when every in-flight page is waiting on a child.

### Page states

`queued`, `fetching`, `ok`, `skipped`, `failed`.

Skip reasons: `other-origin`, `depth-limit`, `page-limit`, `duplicate`, `robots`, `non-html`.

A skipped or failed URL is a record in the result. It is not a successful page. The old `pages` map that stored a hit count is retired. Inbound link counts are out of scope.

### Errors

- Invalid configuration or an invalid start URL stops the process before any fetch. Exit code `2`.
- A page-level timeout, DNS error, connection error, HTTP 4xx, or HTTP 5xx is recorded on that URL. The crawl continues.
- Non-HTML responses are `skipped` / `non-html`. They are fetched, then not parsed for links.
- The process exits `0` when the crawl finishes, including when some pages failed.
- A fatal error after startup exits `1`.

### HTTP and retries

Retries live in the HTTP client. Retry network errors, timeouts, `429`, `500`, `502`, `503`, and `504`. Do not retry other 4xx responses. Backoff is exponential and capped. Retries consume the same reservation, not a new page.

Every request sends the configured User-Agent, including `robots.txt`. Each attempt has a timeout. Bodies larger than `maxResponseBytes` are aborted and recorded as failed.

### Robots

Use the `robots-parser` dependency for allow/disallow decisions. Do not keep a second production parser. The custom parser in `backend/src/crawler/robots.js` is removed once the library path is covered by tests.

- Check robots before each fetch. Cache one parsed `robots.txt` per origin.
- `404` on `robots.txt` means the origin is allowed.
- A network failure or a `5xx` while fetching `robots.txt` skips that origin's remaining URLs with reason `robots`. Record the cause. This is fail-closed.
- Honor `Crawl-delay` for the configured user agent, capped at 10 seconds, so a hostile file cannot stall the process forever.
- Sitemap URLs may be read and ignored. Sitemap crawling is out of scope.

### Output and shutdown

- The engine returns a `CrawlResult`. Reporters format it. The engine does not write files and does not choose a Desktop path.
- Formats: console summary, JSON, and CSV. CSV quoting covers commas, quotes, and newlines.
- `--output` writes the chosen format to that path. Console summary stays on stdout when `--output` is set for JSON or CSV. Absent `--output`, JSON and CSV also go to stdout.
- On SIGINT, stop reserving new URLs, let in-flight fetches finish, write the partial `CrawlResult`, and exit `0`.

### Result shapes

`PageResult` is one URL: canonical URL, requested URL, final URL after redirects, depth, state, skip reason, status code, content type, duration, byte length, and error class. No report-only fields.

`CrawlResult` is the crawl: start URL, start time, finish time, duration, the page records, and counts for queued, fetched, ok, skipped, and failed.

### Layout

Code stays under `backend/`. The root `package.json` is the developer entry. The tree in Architecture.md section 4 is not the target layout.

```text
backend/src/crawler/   engine, queue, URL policy, robots, HTTP
backend/src/cli/       argument parsing and exit codes
backend/src/report/    console, JSON, CSV
backend/tests/         unit tests and the local HTTP fixture
```

Names can differ. Responsibilities cannot: the CLI does not crawl, the HTTP client does not schedule, the parser does not fetch, reporters do not decide what was crawled.

## Current Status

**Active milestone:** Milestone 0 - Repository baseline

**Known behavior of the code today:**

- `[x]` A recursive crawler, config validation, a custom robots parser, and a console/CSV report exist under `backend/`.
- `[x]` Jest covers normalization happy paths, some HTML extraction, cycles, config validation, robots parsing, and sort order. The suite has 61 tests.
- `[x]` Root `npm test` and `npm run verify` delegate into `backend/` and `frontend/`.
- `[x]` GitHub Actions runs backend tests plus frontend lint and build.
- `[!]` `config.concurrency` is ignored. A module-level `p-limit(5)` wraps recursive calls and can stall the crawl once in-flight pages wait on their own children.
- `[!]` `maxPages` records a URL and then skips the fetch when the count is already at the limit. The default is `Infinity`.
- `[!]` Depth `0` is rejected by `parseInt(...) || 2` in the CLI. URLs past the depth limit are not reserved.
- `[!]` Normalization drops the scheme, port, and query. Link extraction concatenates strings, so only root-relative links on a root base URL work.
- `[!]` The result map mixes "visited", "fetch failed", and "times seen". Non-HTML pages are stored as successes. A missing `content-type` throws inside the success check.
- `[!]` Page fetches have no timeout, no User-Agent, and no size cap.
- `[!]` Robots rules are never consulted. `robots-parser` is installed and unused. The custom parser does not decide whether a path is allowed.
- `[!]` The report writes a CSV onto a guessed Desktop path, including a Windows path when run from WSL. `sortPages` assigns undeclared variables.
- `[!]` `backend/package.json` `start` points at `main.js`, while the entry file is `backend/src/main.js`.
- `[!]` [src/crawler/crawl.js](src/crawler/crawl.js) is an older copy of the engine and is not the file the CLI loads.
- `[!]` [frontend/](frontend/) is an unmodified Vite starter. It is not part of the product, and CI still builds it.

## Milestones

### Milestone 0 - Repository baseline

**Goal:** The repo matches the CLI product. A new reader is not offered two crawlers or a frontend.

- `[x]` Root workspace commands and a GitHub Actions workflow exist.
- `[x]` README describes the `backend/` layout and points at this plan.
- `[ ]` Delete [src/crawler/crawl.js](src/crawler/crawl.js).
- `[ ]` Point `backend` `start` at `backend/src/main.js`.
- `[ ]` Remove the frontend from `npm run verify` and from CI. Delete [frontend/](frontend/) in the same change.
- `[ ]` State in the README that the frontend is gone and that the behavior bugs above are still open.

**Done when:** clone, install `backend`, and `npm test` are the whole setup, and only one crawler file exists.

### Milestone 1 - Queue, workers, and URL policy

**Goal:** The crawl is deterministic. Limits mean what this plan says they mean.

Author checkpoint first: write the equivalence tests and a short worker-loop sketch in the learning log. Then implement the queue by hand.

- `[ ]` Replace string concatenation with URL resolution. Cover `./`, `../`, query-only links, and a base URL that already has a path.
- `[ ]` Implement the canonical key in the Cemented Behavior section. Test scheme, port, `www`, fragment, trailing slash, and query order.
- `[ ]` Replace recursive `p-limit` with one queue and N workers for this crawl.
- `[ ]` Reserve a URL when it enters the queue. Ignore later duplicates.
- `[ ]` Apply inclusive `maxDepth` and reservation-based `maxPages`. Change the default page limit from `Infinity` to `50`.
- `[ ]` Return `PageResult` and `CrawlResult` values. Retire the hit-count map.
- `[ ]` Add a local HTTP server test for depth, page limit, cycles, duplicates, and a crawl that would have stalled the old limiter.

**Done when:** those tests pass against the local server, and the author can redraw the queue without opening the file.

### Milestone 2 - HTTP policy and robots

**Goal:** A rude or stuck network cannot define the crawl.

Author checkpoint first: write the robots decision table in the learning log.

- `[ ]` Put `fetch` behind an HTTP client with timeout, User-Agent, byte limit, status, duration, and final URL.
- `[ ]` Classify page failures and keep going.
- `[ ]` Retry only the transient cases listed above, on the same reservation.
- `[ ]` Enforce `robots-parser` before fetch, with a per-origin cache, 404-allows, fail-closed on fetch failure, and a capped crawl-delay.
- `[ ]` Delete the custom robots parser after the new tests cover the decision table.
- `[ ]` Extend the local server fixture with a disallowed path, a missing `robots.txt`, and a slow response that hits the timeout.

**Done when:** a disallowed path is never fetched, and a timeout becomes a failed `PageResult` rather than a hung process.

### Milestone 3 - CLI and reports

**Goal:** The CLI is a thin adapter. Scripts can depend on the exit code and the JSON shape.

- `[ ]` Accept a positional URL plus `--depth`, `--max-pages`, `--concurrency`, `--timeout`, `--user-agent`, `--respect-robots`, `--format`, and `--output`.
- `[ ]` Validate the URL and every number. Preserve an explicit `0` for depth.
- `[ ]` Use exit codes `0`, `1`, and `2` as specified above.
- `[ ]` Emit console, JSON, and CSV from `CrawlResult`. CSV escapes commas, quotes, and newlines.
- `[ ]` Write files only to `--output`. Remove the Desktop path.
- `[ ]` On SIGINT, stop reserving, finish in-flight work, and emit the partial result.
- `[ ]` Test the CLI with the local server: bad arguments, JSON shape, CSV escaping, and a crawl that includes a failed page.

**Done when:** `node backend/src/main.js` against the fixture prints a summary a stranger can read, and JSON matches the result shape.

### Milestone 4 - CV cutoff

**Goal:** The README can stand next to the code in a portfolio review.

- `[ ]` Document the queue, the URL policy, the failure model, and the defaults.
- `[ ]` Include one copy-paste demo against the local fixture and one sample JSON report.
- `[ ]` List known limitations: no JavaScript rendering, no subdomain crawl, no sitemap crawl, no resume, single process.
- `[ ]` Author writes the design-decisions and limitations sections.
- `[ ]` Add a learning-log entry for the queue and for robots fail-closed behavior.

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
- Sitemap crawling, SEO extraction, crawl graphs, persistent resume, SQLite
- Distributed workers, browser automation, cookie auth, proxy rotation

Broken-link detection is already implied by failed `PageResult` records. It does not need a separate feature.

## Verification

| Check | Command | Expectation |
|---|---|---|
| Tests | `npm test` | Backend unit tests and the local HTTP fixture |
| CLI demo | README command | Fixture crawl prints a summary and exits 0 |
| CI | GitHub Actions on `main` and pull requests | Same test command, Node from `backend/.nvmrc` |
| Image | `docker build` then the README demo | Only after Milestone 5 |

`npm run verify` becomes `npm test` once the frontend is gone. CI installs `backend` only.

## Definition of Done

A milestone is complete when it has:

- the behavior in Cemented Behavior, or an edited change to that section
- tests for the new contract
- this file updated
- the author checkpoint written in the learning log
- a command in Verification that shows it

## Architecture Boundary

Keep these boundaries when splitting files. They come from Architecture.md and stay here so that document cannot assign new product scope.

- The CLI parses arguments, builds config, starts one crawl, and maps the result to an exit code.
- The crawler owns the queue, reservations, depth, page limit, and when to call robots, HTTP, and the parser.
- The URL policy owns the canonical key, origin checks, and link resolution.
- The HTTP client owns fetch, timeout, retries, redirects, and body limits.
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

## Change Log

### 2026-10-06

- Replaced the previous milestone list with one CV cutoff at Milestone 4.
- Wrote the URL, queue, limit, retry, robots, and exit-code policies as decisions.
- Recorded the current engine bugs as the reason Milestones 1 and 2 exist.
- Froze the React app, the API, HTML reports, and release automation.
- Left a single optional Docker milestone after the CV cutoff.

### 2026-09-22

- Added the first project tracker, root workspace commands, README alignment, and GitHub Actions.
- Marked the CLI as the primary product.
