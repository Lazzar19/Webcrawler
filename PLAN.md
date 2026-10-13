# Webcrawler Plan

**Status: complete.** No further milestones are planned. New work happens in separate systems projects.

The original detailed plan and behavior contract (cemented rules, checkpoints, learning log, change log)
is archived at [docs/archive/PLAN-full.md](docs/archive/PLAN-full.md). It remains the reference for exact
edge cases such as canonical-key rules, the robots status table, and retry timing.

## Goal

Build a single-process command-line crawler that is correct enough to show: bounded concurrency,
an explicit URL policy, robots and timeouts, a tested crawl of a local site, and an honest README.

The engine and the CLI are the product. Node.js is the implementation language here; the design
(queue, URL identity, politeness, failure model) is meant to transfer to later crawlers or worker
pools in C++, Rust, or Go, which get their own repositories.

A reviewer can clone the repo, run `npm install --prefix backend`, `npm run verify`, and
`node backend/tests/fixtures/demo.js`, and see a crawl whose limits, failures, and output match
the documented behavior.

## Milestones (all done)

| # | Milestone | Delivered |
|---|---|---|
| 0 | Repository baseline | One crawler under `backend/`, root `npm` commands, CI, frontend and duplicate crawler removed |
| 1 | Queue, workers, URL policy | FIFO frontier with fixed workers, canonical key, link resolution, commit order, hop-by-hop redirects, `CrawlResult` |
| 2 | HTTP policy and robots | Per-attempt timeout, byte limit, error kinds, retries with backoff, `robots-parser` manager, per-origin politeness gate |
| 3 | CLI and reports | `parseArgs` flags, exit codes `0`/`1`/`2`/`130`, console/JSON/CSV reporters, `--output`, Ctrl+C partial result |
| 4 | CV cutoff | README with design decisions, known limitations, fixture demo, sample JSON |
| 5 | Optional image | Multi-stage Dockerfile on Node 24, non-root user, runs the fixture demo |
| 6 | Terminal output | Count summary by default, `--details` page table, `--trace` events on stderr, `--help` |
| 7 | Crawl budget | `--max-duration` and `--max-attempts`; a budget stop is a normal result (`budget`, exit `0`) |
| 8 | Crawler-trap guards | `--max-url-length`, `--max-path-depth`, `--max-segment-repeats`, checked before `maxPages` |
| 9 | Content identity | SHA-256 body dedupe (`duplicate-content`) and `rel=canonical` following, each with an off switch |

Verification: `npm run verify` (ESLint, then Jest; 369 tests at completion) runs locally and in
`.github/workflows/ci.yml` on the Node version in `backend/.nvmrc`.

## Key design decisions

Details are in the README's [Design highlights](README.md#design-highlights) and in
[docs/Architecture.md](docs/Architecture.md).

- **One queue, fixed workers:** `concurrency` worker loops over one FIFO frontier; no recursion, no module-level state.
- **Reserve before fetch:** the `seen` check and insert are one synchronous step; `maxPages` counts reservations.
- **Commit in dequeue order:** links are reserved in take order, so results are identical for any `concurrency`.
- **Key vs. spelling:** the canonical key decides identity; the request uses the first reserved spelling.
- **Redirects in the worker:** each hop is checked for scope, loops, duplicates, traps, and robots before it is requested.
- **Politeness is separate from concurrency:** per-origin FIFO leases plus a minimum gap; a larger `Crawl-delay` replaces it, capped at 10 s.
- **Robots fail closed:** `429`, 5xx, or a network failure on `robots.txt` skips that origin as `robots-unavailable`.
- **Failures are records:** classified errors become `PageResult`s; only unexpected exceptions stop the crawl (exit `1`).
- **Thin CLI over a library engine:** the engine returns a `CrawlResult` and never writes stdout or files; reporters format it.
- **Injected dependencies:** HTTP client, clock, logger, and signal are injectable, so tests are exact and run against a local fixture server.

## Known gaps and possible future work

None of these are planned. They are recorded so they are not mistaken for oversights.

- **Canonical default:** `rel=canonical` is followed by default, and a page whose canonical points elsewhere
  reserves none of its own links. On sites that canonicalize pagination or tracking URLs this can hide whole
  sections. Safer options: keep following the page's links, or default `--no-canonical`.
- **Byte counting and charset:** the size limit and `byteLength` count UTF-8 bytes of the decoded text, not
  bytes received, and bodies are always decoded as UTF-8. Fix: count raw chunk bytes, decode by the
  `Content-Type` charset or `<meta charset>`, and hash raw bytes for dedupe.
- **Near-duplicate detection:** dedupe is an exact SHA-256 of the body, so a timestamp or token defeats it.
  A normalized-text hash or SimHash would catch near copies.
- **Scaling:** per-origin queues with a ready-time heap, retries rescheduled into the frontier instead of
  holding a worker, a streaming parser in place of `jsdom`, JSONL streaming output, and resumable state.
- **Robots and politeness refinements:** `rel=nofollow`, `<meta name=robots>`, `X-Robots-Tag`, widening an
  origin's gap after `429`, and retry jitter.
- **Observability:** metrics export, latency percentiles, and a progress line.

Broken-link detection is already covered by failed `PageResult` records.

## Out of scope

- A web UI, HTTP API, or job service
- JavaScript rendering or browser automation
- Subdomain or multi-site crawling, sitemap crawling
- Distributed workers, proxy rotation, cookie auth
- SEO extraction, HTML reports, a drawn crawl graph, persistent storage
- Publishing to npm or an image registry
- TypeScript, a type checker, or an ESM migration