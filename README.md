# Web Crawler

A command-line web crawler built in **Node.js**. It traverses same-host links and prints a crawl report. The CLI is the whole product. There is no web UI in this repository.

![Node.js](https://img.shields.io/badge/Node.js-24-green?style=flat&logo=node.js)
![JavaScript](https://img.shields.io/badge/JavaScript-ES2022-yellow?style=flat&logo=javascript)
![Jest](https://img.shields.io/badge/tested%20with-jest-orange?style=flat&logo=jest)
![License](https://img.shields.io/badge/license-ISC-blue?style=flat)

## About

This is a hands-on project for learning HTTP, scheduling, and the limits of a single-process crawler. The engine and the test suite are real. Several behaviors are still wrong. The contract they should meet is in [PLAN.md](PLAN.md).

## What works today

- Recursive link traversal with a depth setting and a page-limit setting
- Same-host filtering and a visited-URL map
- A fixed pool of five in-flight fetches
- A `robots.txt` parser that the crawl does not call yet
- Jest tests that mock the network

## Still open

These are known gaps, not future ideas. Milestone 1 replaces the crawl loop instead of patching it in place.

- Concurrency is hard-coded. `config.concurrency` is ignored, and the recursive limiter can stall.
- `maxPages` defaults to unlimited, and the current check can record a URL without fetching it.
- URL identity drops the scheme, port, and query. Relative links are joined by string concatenation.
- The result map mixes visited pages, failures, and repeat counts.
- Page fetches have no timeout, no User-Agent, and no size cap.
- `robots.txt` is not enforced. The installed `robots-parser` package is unused.
- The CSV report is written to a guessed Desktop path.

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

### Run

```bash
node backend/src/main.js <url>
```

From `backend/`:

```bash
npm start -- <url>
```

## Dependencies

| Package | Purpose |
|---|---|
| `jsdom` | HTML parsing and link extraction |
| `p-limit` | Concurrency limiter for async requests. The current crawl can stall under it. |
| `robots-parser` | Installed for later robots enforcement. The crawl does not call it yet. |
| `jest` | Testing framework (dev dependency) |
| `eslint` | Linter (dev dependency) |

## Author

**Lazar Nikolic** — [GitHub](https://github.com/Lazzar19) · [LinkedIn](https://www.linkedin.com/in/lazar-nikolic-41aab6344/)
