# Web Crawler

A command-line web crawler built in **Node.js**. It traverses same-host links and prints a crawl report. The CLI is the whole product. There is no web UI in this repository.

![Node.js](https://img.shields.io/badge/Node.js-24-green?style=flat&logo=node.js)
![JavaScript](https://img.shields.io/badge/JavaScript-ES2022-yellow?style=flat&logo=javascript)
![Jest](https://img.shields.io/badge/tested%20with-jest-orange?style=flat&logo=jest)
![License](https://img.shields.io/badge/license-ISC-blue?style=flat)

## About

This is a hands-on project for learning HTTP, scheduling, and the limits of a single-process crawler. The engine and the test suite are real. Several behaviors are still wrong. The contract they should meet is in [PLAN.md](PLAN.md).

## What works today

- A frontier of workers, with inclusive depth and a reservation page limit
- Same-origin filtering and one record per canonical key
- Hop-by-hop redirects that stay on the start origin
- Jest tests against the local fixture server and an injected HTTP client

## Still open

These are known gaps, not future ideas. Milestone 1 is complete. The HTTP client now times out and stops an oversized body. Milestone 2 still owns retries, robots, and politeness. Milestone 3 owns the reporter, including `sortPages` and the Desktop path.

- Retries are not implemented yet. A failed attempt is final.
- Robots is an allow-all stand-in. `robots-parser` is unused.
- `printReport` still writes a CSV onto a guessed Desktop path. `npm start` does not call it.
- `sortPages` still sorts by hit count.

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
| `robots-parser` | Installed for later robots enforcement. The crawl does not call it yet. |
| `jest` | Testing framework (dev dependency) |
| `eslint` | Linter (dev dependency) |

## Author

**Lazar Nikolic** — [GitHub](https://github.com/Lazzar19) · [LinkedIn](https://www.linkedin.com/in/lazar-nikolic-41aab6344/)
