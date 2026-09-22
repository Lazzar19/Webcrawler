# Webcrawler — Architecture v1

## 1. Purpose

Webcrawler is a configurable command-line web crawling and website analysis tool built with Node.js.

The primary goal is to build a reliable, testable and extensible crawler capable of:

* recursively traversing websites;
* respecting crawling policies such as `robots.txt`;
* controlling concurrency and request rate;
* handling network failures gracefully;
* collecting structured information about crawled pages;
* producing machine-readable and human-readable reports.

The project is intentionally designed as a modular crawling engine rather than a collection of functions tied to the CLI.

---

# 2. Architectural Goals

The architecture should prioritize:

### Separation of concerns

Each component should have one clearly defined responsibility.

### Testability

Core components should be testable independently without requiring real internet access.

### Extensibility

New capabilities such as sitemap crawling, SEO analysis, persistent state or a REST API should be possible without rewriting the crawler core.

### Controlled resource usage

The crawler must avoid uncontrolled concurrency, infinite crawling, excessive memory usage and unnecessary requests.

### Explicit behavior

Important crawler behavior should be configurable rather than hidden in hard-coded values.

### Observability

A crawl should provide enough information to understand what happened:

* pages crawled;
* pages skipped;
* HTTP statuses;
* errors;
* response times;
* crawl duration;
* queue/concurrency information.

---

# 3. High-Level Architecture

```text
                         ┌──────────────────┐
                         │       CLI        │
                         └────────┬─────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │  Crawl Service   │
                         └────────┬─────────┘
                                  │
          ┌───────────────────────┼───────────────────────┐
          │                       │                       │
          ▼                       ▼                       ▼
   ┌─────────────┐        ┌─────────────┐        ┌─────────────┐
   │ URL Manager │        │  Scheduler  │        │    Robots   │
   └─────────────┘        └──────┬──────┘        └─────────────┘
                                 │
                                 ▼
                          ┌─────────────┐
                          │ HTTP Client │
                          └──────┬──────┘
                                 │
                                 ▼
                              Internet
                                 │
                                 ▼
                          ┌─────────────┐
                          │ HTML Parser │
                          └──────┬──────┘
                                 │
                                 ▼
                          ┌─────────────┐
                          │ Crawl Result│
                          └──────┬──────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
       ┌────────────┐     ┌────────────┐     ┌────────────┐
       │  Console   │     │    JSON    │     │    HTML    │
       │  Reporter  │     │  Reporter  │     │  Reporter  │
       └────────────┘     └────────────┘     └────────────┘
```

The crawler core must not depend on a specific output format.

The CLI must not contain crawling logic.

The HTTP layer must be isolated from crawling orchestration.

---

# 4. Target Project Structure

```text
webcrawler/
│
├── src/
│   │
│   ├── cli/
│   │   ├── index.js
│   │   └── options.js
│   │
│   ├── crawler/
│   │   ├── crawler.js
│   │   ├── scheduler.js
│   │   ├── url-manager.js
│   │   └── crawl-result.js
│   │
│   ├── http/
│   │   ├── http-client.js
│   │   └── retry.js
│   │
│   ├── robots/
│   │   └── robots-manager.js
│   │
│   ├── parser/
│   │   └── html-parser.js
│   │
│   ├── reporting/
│   │   ├── reporter.js
│   │   ├── console-reporter.js
│   │   ├── json-reporter.js
│   │   ├── csv-reporter.js
│   │   └── html-reporter.js
│   │
│   └── utils/
│       ├── logger.js
│       └── url.js
│
├── tests/
│   │
│   ├── unit/
│   │   ├── crawler.test.js
│   │   ├── scheduler.test.js
│   │   ├── url-manager.test.js
│   │   ├── http-client.test.js
│   │   ├── robots-manager.test.js
│   │   └── html-parser.test.js
│   │
│   ├── integration/
│   │   └── crawler.integration.test.js
│   │
│   └── fixtures/
│       ├── basic-site/
│       ├── cyclic-site/
│       └── robots/
│
├── docs/
│   └── ARCHITECTURE.md
│
├── main.js
├── package.json
├── package-lock.json
├── .nvmrc
└── README.md
```

This is the target structure.

It should NOT be created all at once.

Components will be introduced incrementally during the refactoring phases.

---

# 5. Core Domain Objects

## 5.1 CrawlConfig

Represents all configuration required for a crawl.

Conceptually:

```js
{
    startUrl,
    maxDepth,
    maxPages,
    concurrency,
    timeout,
    userAgent,
    retryCount,
    retryDelay,
    respectRobots,
    outputFormat,
    outputPath
}
```

The exact implementation can evolve.

The important rule is that crawler behavior should come from configuration rather than hard-coded values.

---

# 6. PageResult

Every successfully processed URL should produce a structured page result.

Initial model:

```js
{
    url,
    depth,
    statusCode,
    contentType,
    responseTime,
    contentLength,
    links,
    error
}
```

Potential future fields:

```js
{
    title,
    description,
    canonical,
    headers,
    redirectedFrom,
    discoveredAt
}
```

`PageResult` should represent what happened to one URL.

It should not contain reporting-specific information.

---

# 7. CrawlResult

`CrawlResult` represents the complete result of a crawl.

Conceptually:

```js
{
    startUrl,
    startedAt,
    finishedAt,
    duration,
    pages,
    statistics,
    errors
}
```

Statistics may include:

```js
{
    discovered,
    crawled,
    skipped,
    failed,
    successful,
    averageResponseTime,
    statusCodes
}
```

The result should be independent from the output format.

---

# 8. Crawler

## Responsibility

The `Crawler` is the main orchestrator.

It coordinates:

* URL discovery;
* scheduling;
* robots checks;
* HTTP requests;
* HTML parsing;
* result collection;
* crawl termination.

It should NOT:

* directly parse CLI arguments;
* directly write CSV/JSON/HTML files;
* implement HTTP retry logic;
* implement HTML parsing;
* contain URL normalization logic.

## Conceptual API

```js
class Crawler {
    async crawl(startUrl, config) {}
}
```

Returns:

```js
CrawlResult
```

The crawler should be the only component responsible for coordinating the complete crawl lifecycle.

---

# 9. URL Manager

## Responsibility

The `URLManager` owns URL identity and crawl policy.

Responsibilities:

* normalize URLs;
* determine whether URLs belong to the allowed scope;
* detect duplicates;
* track visited URLs;
* optionally apply include/exclude rules.

Conceptual API:

```js
class URLManager {
    normalize(url) {}

    isAllowed(url) {}

    hasVisited(url) {}

    markVisited(url) {}

    add(url) {}
}
```

URL normalization must be explicitly defined and tested.

Cases to consider:

```text
https://example.com
https://example.com/
https://example.com/#section
https://example.com/about
https://example.com/about/
https://example.com?id=1
https://example.com?id=2
```

The project must decide which URLs are considered equivalent.

---

# 10. Scheduler

## Responsibility

The scheduler controls when URLs are processed.

Responsibilities:

* maintain pending work;
* enforce concurrency;
* dispatch crawl jobs;
* track active jobs;
* stop accepting new work when limits are reached;
* support graceful shutdown.

Conceptually:

```js
class Scheduler {
    add(task) {}

    start() {}

    stop() {}

    getStats() {}
}
```

The current fixed concurrency value should eventually become configuration-driven.

Example:

```text
concurrency = 5

       ┌── Request 1
Queue ─┼── Request 2
       ├── Request 3
       ├── Request 4
       └── Request 5
```

No component should create uncontrolled numbers of simultaneous requests.

---

# 11. HTTP Client

## Responsibility

The HTTP client is the only layer responsible for network requests.

All calls to `fetch()` should eventually live behind this abstraction.

Responsibilities:

* perform HTTP requests;
* apply timeout;
* configure headers;
* set User-Agent;
* expose response metadata;
* handle redirects;
* classify errors;
* perform retries.

Conceptual API:

```js
class HttpClient {
    async get(url, options) {}
}
```

A successful response should expose enough information to build a `PageResult`.

Example:

```js
{
    statusCode,
    headers,
    body,
    contentType,
    responseTime
}
```

---

# 12. Retry Strategy

Retries should live in the HTTP layer rather than inside the crawler.

Initially retry:

```text
Network errors
429
500
502
503
504
```

Potential strategy:

```text
Attempt 1
    ↓
failure
    ↓
wait 1s
    ↓
Attempt 2
    ↓
failure
    ↓
wait 2s
    ↓
Attempt 3
```

Retry behavior must be configurable.

---

# 13. Robots Manager

## Responsibility

The `RobotsManager` determines whether a URL may be crawled.

Pipeline:

```text
URL
 ↓
RobotsManager
 ↓
allowed?
 ├── NO → skip
 └── YES
       ↓
    Scheduler
```

Responsibilities:

* retrieve `robots.txt`;
* cache robots rules;
* parse rules;
* evaluate URL permissions;
* expose crawl-delay;
* expose sitemap information.

Conceptual API:

```js
class RobotsManager {
    async canCrawl(url) {}

    async getRules(origin) {}

    getCrawlDelay(origin) {}

    getSitemaps(origin) {}
}
```

Important:

`robots.txt` support is not complete merely because a parser exists.

The crawler must actually use `RobotsManager` before making page requests.

---

# 14. HTML Parser

## Responsibility

The parser receives HTML and extracts structured information.

Initial responsibility:

```text
HTML
 ↓
links
```

Future responsibility:

```text
HTML
 ↓
title
meta description
canonical
headings
links
language
```

Conceptual API:

```js
class HtmlParser {
    parse(html, baseUrl) {}
}
```

Example:

```js
{
    links: [],
    title: null,
    description: null,
    canonical: null
}
```

The parser should not perform network requests.

---

# 15. Reporter Architecture

The crawler should produce a `CrawlResult`.

Reporters consume that result.

```text
                 CrawlResult
                      │
       ┌──────────────┼──────────────┐
       ▼              ▼              ▼
   Console          JSON           HTML
   Reporter        Reporter        Reporter
```

Conceptual interface:

```js
class Reporter {
    generate(crawlResult) {}
}
```

Possible output formats:

### Console

Human-readable summary.

### JSON

Machine-readable complete result.

### CSV

Tabular page-level data.

### HTML

Interactive human-readable crawl report.

The HTML reporter is expected to become the primary showcase feature of the project.

---

# 16. CLI

The CLI should be a thin adapter over the crawler engine.

Example:

```bash
webcrawler https://example.com \
    --depth 3 \
    --max-pages 500 \
    --concurrency 10 \
    --timeout 5000 \
    --format html \
    --output ./reports
```

The CLI is responsible for:

1. parsing arguments;
2. validating arguments;
3. creating `CrawlConfig`;
4. starting the crawler;
5. passing `CrawlResult` to a reporter;
6. setting an appropriate process exit code.

The CLI must not contain crawling algorithms.

---

# 17. Error Handling

Errors should be classified rather than handled uniformly.

Potential categories:

```text
Invalid URL
Network Error
Timeout
DNS Error
HTTP Error
Robots Denied
Unsupported Content Type
Parsing Error
Configuration Error
```

A page-level failure should normally not terminate the entire crawl.

Example:

```text
/page-a → 200
/page-b → timeout
/page-c → 404
/page-d → 200
```

The crawler should continue wherever possible and record failures in `CrawlResult`.

Fatal errors should be reserved for problems such as invalid configuration or inability to initialize the crawler.

---

# 18. Crawl Lifecycle

The intended crawl lifecycle is:

```text
1. Validate configuration
        ↓
2. Normalize start URL
        ↓
3. Initialize crawler state
        ↓
4. Initialize robots rules
        ↓
5. Add start URL to scheduler
        ↓
6. Scheduler selects URL
        ↓
7. URLManager validates URL
        ↓
8. RobotsManager checks permission
        ↓
9. HttpClient performs request
        ↓
10. Record response metadata
        ↓
11. Check content type
        ↓
12. HTMLParser extracts links
        ↓
13. Normalize discovered URLs
        ↓
14. Add new URLs to scheduler
        ↓
15. Repeat until queue is empty
        ↓
16. Build CrawlResult
        ↓
17. Reporter generates output
```

This sequence should remain conceptually stable even if individual implementations change.

---

# 19. Crawl Termination

A crawl may terminate because:

* queue is empty;
* `maxPages` has been reached;
* `maxDepth` has been reached;
* user requests shutdown;
* fatal initialization error occurs.

The crawler must distinguish between:

```text
successful completion
partial completion
fatal failure
```

This will become important when implementing graceful shutdown.

---

# 20. Graceful Shutdown

Future implementation should support:

```text
Ctrl+C
   ↓
stop scheduling new URLs
   ↓
wait for active requests
   ↓
build partial CrawlResult
   ↓
write report
   ↓
exit
```

This is especially important for long-running crawls.

---

# 21. Testing Architecture

Tests should be split into two major categories.

## Unit tests

Each component is tested independently.

```text
URLManager
Scheduler
HttpClient
RobotsManager
HtmlParser
Reporter
```

External network calls should be mocked.

## Integration tests

Integration tests should use a local HTTP server.

Example fixture:

```text
localhost
├── /
├── /about
├── /products
├── /broken
├── /slow
└── /loop
```

This allows the complete crawler pipeline to be tested without depending on external websites.

---

# 22. Dependency Direction

The preferred dependency direction is:

```text
CLI
 ↓
Crawler
 ↓
Scheduler / URLManager / RobotsManager / HttpClient / Parser
 ↓
Utilities
```

Reporting depends on domain results:

```text
CrawlResult
 ↓
Reporter
```

The core crawler should NOT depend on:

```text
CSV
HTML
CLI
filesystem-specific output paths
```

This keeps the core reusable.

---

# 23. Configuration Principles

Configuration should eventually support:

```js
{
    maxDepth,
    maxPages,
    concurrency,
    timeout,
    userAgent,
    retryCount,
    retryDelay,
    respectRobots,
    rateLimit
}
```

Defaults must be:

* safe;
* documented;
* predictable.

The crawler should never default to an effectively unlimited crawl without an explicit reason.

---

# 24. Observability

The crawler should eventually expose:

```text
Pages discovered
Pages crawled
Pages skipped
Pages failed
HTTP status distribution
Average response time
Total crawl duration
Current queue size
Active requests
```

Logging should support levels:

```text
DEBUG
INFO
WARN
ERROR
```

Logging should be separated from reporting.

A log message is not a crawl report.

---

# 25. Future Extensions

The architecture should leave room for:

### Sitemap crawling

```text
robots.txt
   ↓
sitemap.xml
   ↓
URL discovery
```

### Broken link analysis

Identify:

```text
404
410
5xx
timeouts
```

### SEO analysis

Extract and analyze:

```text
title
description
canonical
headings
```

### Crawl graph

Store relationships:

```text
/home
 ├── /about
 ├── /products
 └── /contact
```

### Persistent crawl state

Allow:

```bash
webcrawler --resume crawl-state.json
```

### Database storage

Potentially SQLite for large crawls.

### REST API

A REST API should be implemented only after the crawler engine is stable.

The API would act as another adapter over the same core:

```text
CLI ───────┐
           │
           ▼
      Crawler Engine
           ▲
           │
REST API ──┘
```

---

# 26. Explicit Non-Goals for v1

The first architectural version should NOT attempt to solve:

* distributed crawling;
* multi-machine workers;
* browser automation;
* JavaScript-rendered websites;
* persistent distributed queues;
* large-scale database infrastructure;
* authentication/cookies;
* proxy rotation.

These may be considered later.

The goal of v1 is a high-quality single-process crawler.

---

# 27. Implementation Roadmap

## Phase 1 — Core architecture

* [ ] Define `CrawlConfig`
* [ ] Define `PageResult`
* [ ] Define `CrawlResult`
* [ ] Extract URL Manager
* [ ] Extract HTML Parser
* [ ] Extract Scheduler
* [ ] Create Crawler orchestrator
* [ ] Preserve current behavior

## Phase 2 — HTTP layer

* [ ] Create `HttpClient`
* [ ] Add timeout
* [ ] Add User-Agent
* [ ] Handle response metadata
* [ ] Add retry strategy
* [ ] Add exponential backoff

## Phase 3 — Robots

* [ ] Create `RobotsManager`
* [ ] Integrate robots checks into crawler
* [ ] Respect crawl-delay
* [ ] Expose sitemap URLs
* [ ] Test real crawling decisions

## Phase 4 — CLI

* [ ] Replace raw `process.argv`
* [ ] Add `--help`
* [ ] Add `--depth`
* [ ] Add `--max-pages`
* [ ] Add `--concurrency`
* [ ] Add `--timeout`
* [ ] Add `--user-agent`
* [ ] Add `--format`
* [ ] Add `--output`

## Phase 5 — Reporting

* [ ] Console reporter
* [ ] JSON reporter
* [ ] CSV reporter
* [ ] HTML reporter
* [ ] Crawl statistics

## Phase 6 — Quality

* [ ] Unit test coverage
* [ ] Integration test server
* [ ] ESLint
* [ ] Prettier
* [ ] GitHub Actions
* [ ] Coverage reporting

## Phase 7 — Advanced features

* [ ] Broken link detection
* [ ] Sitemap support
* [ ] Response-time analysis
* [ ] Graceful shutdown
* [ ] Crawl graph
* [ ] Persistent crawl state

## Phase 8 — Portfolio polish

* [ ] Architecture documentation
* [ ] Updated README
* [ ] Architecture diagram
* [ ] Example reports
* [ ] Benchmarks
* [ ] Design decisions
* [ ] Known limitations
* [ ] Demo video/GIF

````

---

# 28. Architectural Rule

The most important rule for future development is:

> **Do not add a feature directly to `Crawler` unless that feature is genuinely orchestration logic.**

If a feature can have its own responsibility, it should probably become its own component.

For example:

```text
❌ Crawler handles:
    HTTP
    retries
    robots
    parsing
    CSV
    URL normalization

✅ Crawler coordinates:
    URLManager
    Scheduler
    RobotsManager
    HttpClient
    HtmlParser
    CrawlResult
````

The crawler should become the conductor, not the entire orchestra.

---

# 29. Definition of Done for Architecture v1

Architecture v1 will be considered implemented when:

* the crawler core is modular;
* HTTP requests are isolated behind `HttpClient`;
* URL handling is isolated behind `URLManager`;
* scheduling/concurrency is isolated behind `Scheduler`;
* robots rules are enforced by `RobotsManager`;
* HTML parsing is isolated;
* crawl results use structured objects;
* reporters consume crawl results;
* CLI only handles configuration and presentation;
* unit tests cover individual components;
* integration tests cover the complete crawling pipeline;
* no core component depends on a specific output format.
