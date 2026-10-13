# Webcrawler

A polite, deterministic command-line web crawler for one origin, written in Node.js.
It keeps a record for every URL it finds, including why it was skipped or why it failed,
and returns the same results in the same order at any concurrency.

![CI](https://github.com/Lazzar19/Webcrawler/actions/workflows/ci.yml/badge.svg)
![Node.js](https://img.shields.io/badge/Node.js-24-green?style=flat&logo=node.js)
![Jest](https://img.shields.io/badge/tested%20with-jest-orange?style=flat&logo=jest)
![License](https://img.shields.io/badge/license-ISC-blue?style=flat)

**Highlights:** fixed worker pool over one queue · stable results in queue order ·
per-origin rate limiting with robots.txt `Crawl-delay` · hop-by-hop redirect checks ·
timeouts, retries with backoff, size limits · URL-trap guards · duplicate-page detection ·
console / JSON / CSV output · tests against a local HTTP server.

## Quick start

Requires Node 24 (`backend/.nvmrc`).

```bash
npm install --prefix backend
npm run verify                      # lint, then tests
node backend/tests/fixtures/demo.js # crawl a local demo site
```

## What a crawl looks like

The demo site has a home page, `/docs`, a `robots.txt` that disallows `/secret`,
a 404, a text file, and a link to `https://example.com/outside`. The demo sets
`--depth 1` and `--min-interval 0`. The port changes every run.

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

`node backend/tests/fixtures/demo.js --details` adds one row per URL, in creation order:

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

`/secret` and the outside link were never requested. A failed page is a record,
not a crash: the crawl finishes and exits `0`.

## Crawl a real site

```bash
node backend/src/main.js https://example.com/ --depth 1 --max-pages 20
npm start -- https://example.com/ --format json --output result.json
```

| Flag | Default | Meaning |
|---|---|---|
| `--depth` | `2` | Inclusive; `0` fetches only the start URL |
| `--max-pages` | `50` | URLs reserved for fetch, including the start URL |
| `--concurrency` | `5` | Worker loops, and the cap on in-flight work |
| `--per-origin` / `--min-interval` | `2` / `200` ms | Politeness per origin |
| `--format` | `console` | `console`, `json`, or `csv` |

`--help` lists every flag and its default. `--details` adds the page table, `--trace`
prints events to stderr. With `json` or `csv`, stdout carries only that format.
Exit codes: `0` finished · `2` bad flag or URL · `1` fatal error · `130` second Ctrl+C.

## Sample JSON (excerpt)

`node backend/tests/fixtures/demo.js --format json` prints the full `CrawlResult`.
One page record, trimmed:

```json
{
  "schemaVersion": 1,
  "stopReason": "completed",
  "pages": [
    {
      "canonicalUrl": "http://127.0.0.1:9/secret",
      "discoveredFrom": "http://127.0.0.1:9/",
      "depth": 1,
      "state": "skipped",
      "skipReason": "robots",
      "attempts": 0
    }
  ],
  "counts": { "reserved": 5, "queued": 0, "fetched": 4, "ok": 2, "skipped": 3, "failed": 1 }
}
```

## Design highlights

- **One queue, fixed workers.** No recursion, no module-level state; `concurrency` caps in-flight work.
- **Reserve before fetch.** The `seen` check and the insert are one synchronous step; `maxPages` counts reservations.
- **Commit in dequeue order.** Links are reserved in the order pages were taken, not the order they finished, so the same responses give the same `pages` for any `concurrency`.
- **Every redirect hop is checked** for scope, loops, duplicates, trap guards, and robots before it is requested.
- **Politeness is a second limit.** Per-origin FIFO leases and a gap between request starts; a larger `Crawl-delay` replaces it, capped at 10 seconds.
- **An unreadable robots.txt closes the origin.** `429`, 5xx, or a network failure skips its pages as `robots-unavailable`.
- **Failures are data.** Classified errors become records; retries back off; only unexpected exceptions stop the crawl.
- **Traps and copies don't eat the budget.** Long URLs, deep paths, repeated segments, and identical HTML are skipped.

The full contract is in [PLAN.md](PLAN.md); component boundaries are in [docs/Architecture.md](docs/Architecture.md).

## Known limitations

- No JavaScript rendering; links come from `<a href>` in the HTML.
- No subdomain crawl; scope is the start origin (scheme, host, port).
- No sitemap crawl and no resume; one process, the queue lives in memory.
- UTF-8 decoding only; a `charset` parameter does not select another decoder.
- `rel="nofollow"`, `<meta name="robots">`, and `X-Robots-Tag` are not honored.
- A slow page delays reservation of links from pages that finished after it.
- A retry backoff holds its worker and the origin's lease.

## Docker

```bash
docker build -t webcrawler .
docker run --rm webcrawler                # the fixture demo, as a non-root user
docker run --rm --entrypoint node webcrawler backend/src/main.js https://example.com/ --depth 1 --max-pages 20
```

## Project layout

```
webcrawler/
├── backend/
│   ├── src/
│   │   ├── cli/       # argument parsing, help, exit codes
│   │   ├── crawler/   # frontier, URL policy, HTTP client, politeness, robots
│   │   └── report/    # console, JSON, CSV
│   └── tests/         # Jest suites; fixtures/ holds the local server and demo
├── docs/Architecture.md
├── Dockerfile
├── PLAN.md            # roadmap and behavior contract
└── package.json       # root commands that delegate to backend/
```

Built with `jsdom` (link extraction) and `robots-parser`; tested with Jest, linted with ESLint, CI in `.github/workflows/ci.yml`.

## Author

**Lazar Nikolic** — [GitHub](https://github.com/Lazzar19) · [LinkedIn](https://www.linkedin.com/in/lazar-nikolic-41aab6344/)