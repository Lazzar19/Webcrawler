# Web Crawler

A command-line web crawler built in **Node.js** that recursively traverses same-host hyperlinks and produces crawl reports. The CLI is the primary product; the React frontend is reserved for a later milestone.

![Node.js](https://img.shields.io/badge/Node.js-18.7.0-green?style=flat&logo=node.js)
![JavaScript](https://img.shields.io/badge/JavaScript-ES2022-yellow?style=flat&logo=javascript)
![Jest](https://img.shields.io/badge/tested%20with-jest-orange?style=flat&logo=jest)
![License](https://img.shields.io/badge/license-ISC-blue?style=flat)

## About

Built as a hands-on project for learning how HTTP, scheduling and system design work under the hood. The crawler currently provides the initial crawling engine and test suite. Features described as planned are tracked in [PLAN.md](PLAN.md).

## Features

- Recursive link traversal with depth and page-limit configuration
- Same-host URL filtering and visited URL tracking
- Controlled asynchronous page fetching
- Initial `robots.txt` parsing module
- Jest test suite with mocked network requests

The crawler is under active development. Robots enforcement, fully configurable concurrency, robust URL resolution, retries, timeout handling, CI/CD and Docker are planned milestones, not yet complete features.

## Project Structure

```
webcrawler/
├── backend/       # CLI and crawler engine
│   ├── src/
│   └── tests/
├── frontend/      # React/Vite frontend reserved for a later milestone
├── docs/           # Architecture documentation
├── PLAN.md        # Development tracker and learning roadmap
└── package.json   # Root workspace commands
```

## Getting Started

### Prerequisites

- Node.js `18.7.0` (use [nvm](https://github.com/nvm-sh/nvm) for version management)

```bash
nvm use   # automatically picks up .nvmrc
```

### Install

```bash
git clone https://github.com/Lazzar19/webcrawler.git
cd webcrawler
npm install --prefix backend
npm install --prefix frontend
```

### Run


```bash
node backend/src/main.js <url>
```

The root workspace also exposes the main verification commands:

```bash
npm test                 # backend tests
npm run lint:frontend    # frontend lint
npm run build:frontend   # frontend production build
npm run verify           # all checks above
```

### Tests

```bash
cd backend && npm test
```

## Dependencies

| Package | Purpose |
|---|---|
| `jsdom` | HTML parsing and link extraction |
| `p-limit` | Concurrency limiter for async requests |
| `robots-parser` | Parses `robots.txt` rules; enforcement is being integrated |
| `jest` | Testing framework (dev dependency) |

## Author

**Lazar Nikolic** — [GitHub](https://github.com/Lazzar19) · [LinkedIn](https://www.linkedin.com/in/lazar-nikolic-41aab6344/)
