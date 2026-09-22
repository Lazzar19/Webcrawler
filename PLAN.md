# Webcrawler Development Plan

This is the living development tracker for the project. Update it together with implementation, tests, documentation, and architectural decisions.

## Status Legend

- `[ ]` not started
- `[-]` in progress
- `[x]` completed
- `[!]` blocked or requires a decision

## Project Goal

Build a reliable, tested, and extensible command-line web crawler that is strong enough for a portfolio or CV project. The crawler engine and CLI are the primary product. An API and UI may be added only after the core contract is stable.

The project is also a structured learning exercise. Each major change should explain the problem, the chosen design, the alternatives, and the evidence that the change works.

### Learning Themes

- system design for bounded concurrency, scheduling, and backpressure;
- URL identity, deduplication, and lifecycle states;
- timeouts, retries, and failure isolation;
- robots policy, rate limiting, and responsible network usage;
- resource limits and observability;
- modular design and dependency injection;
- CI/CD, reproducible builds, and Docker;
- security, especially SSRF protection when a service layer is introduced.

## Current Status

**Active milestone:** Milestone 0 - Repository baseline

**Known state:**

- `[x]` Backend crawler, configuration, robots, and reporting modules exist.
- `[x]` Initial Jest tests exist for crawling, configuration, robots, and reporting.
- `[x]` A Vite/React frontend exists, but it is not connected to the backend.
- `[x]` Root documentation and commands reflect the actual `backend/` layout.
- `[x]` Root developer workflow is defined for tests, lint, and builds.
- `[x]` GitHub Actions CI runs backend tests and frontend lint/build checks.
- `[ ]` Robots rules are not yet enforced by the crawl flow.
- `[ ]` Configured concurrency is not yet guaranteed to be applied per crawl.
- `[ ]` `maxDepth` and `maxPages` semantics are not fully defined and tested.
- `[ ]` Release automation and deployment are not implemented.
- `[ ]` Docker image and distribution workflow are not implemented.

**Current focus:**

1. Make URL handling, scheduling, and crawl limits correct and deterministic.
2. Add tests that make the crawler contract explicit.
3. Record the system-design reasoning behind each engine decision.

## Milestones

### Milestone 0 - Repository Baseline

**Goal:** A new developer can clone, install, and verify the project without knowing its history.

- `[x]` Add and maintain this `PLAN.md`.
- `[x]` Add a root `package.json` with clear workspace commands.
- `[x]` Update `README.md` to match the actual repository structure.
- `[ ]` Decide what to do with the duplicate `src/crawler/crawl.js`.
- `[x]` Define backend/frontend verification commands.
- `[x]` Add GitHub Actions CI for backend tests and frontend lint/build.

**Definition of done:**

- the README works as a start guide;
- root verification has one clear meaning;
- backend tests and frontend lint/build are reproducible;
- CI checks the same baseline quality as local development.

### Milestone 1 - Correct Crawler Engine

**Goal:** The crawler has precise, deterministic, and tested behavior.

- `[ ]` Extract URL normalization and relative-link resolution.
- `[ ]` Define same-origin rules, fragment handling, and query-string behavior.
- `[ ]` Introduce a per-crawl scheduler that uses `config.concurrency`.
- `[ ]` Define URL lifecycle states: discovered, queued, crawling, completed, skipped, and failed.
- `[ ]` Correct the semantics of `maxDepth` and `maxPages`.
- `[ ]` Introduce structured `PageResult` and `CrawlResult` values.
- `[ ]` Add a local HTTP-server integration test.

**System-design questions:**

- Which component reserves a URL when multiple pages discover it at the same time?
- Does `maxPages` count discovered, scheduled, fetched, or successfully processed pages?
- How does the scheduler prevent unbounded queue growth?
- What state and result does a skipped URL receive?

### Milestone 2 - Network Reliability and Policy

**Goal:** The crawler behaves predictably and responsibly on real networks.

- `[ ]` Extract an `HttpClient` with timeout and user-agent support.
- `[ ]` Record status, response time, response size, and redirect information.
- `[ ]` Define handling for non-2xx responses, timeouts, and network errors.
- `[ ]` Add bounded retries for transient failures.
- `[ ]` Enforce robots rules before each fetch.
- `[ ]` Cache robots rules per origin.
- `[ ]` Define crawl-delay and rate-limiting policy.
- `[ ]` Add maximum response-size and other resource limits.

### Milestone 3 - Stable CLI and Reporting

**Goal:** The CLI is useful locally, in shell scripts, and in CI environments.

- `[ ]` Add `--depth`, `--max-pages`, `--concurrency`, and `--timeout`.
- `[ ]` Add `--user-agent`, `--respect-robots`, `--format`, and `--output`.
- `[ ]` Validate URLs and all numeric options.
- `[ ]` Define meaningful exit codes and top-level error handling.
- `[ ]` Support console, JSON, and CSV output.
- `[ ]` Handle empty results and CSV escaping.
- `[ ]` Add CLI-level tests.

**First public/CV-ready milestone:** Milestones 0-3 are complete.

### Milestone 4 - Observability and Portfolio Quality

- `[ ]` Introduce structured logging.
- `[ ]` Add crawl summaries with statistics and duration.
- `[ ]` Document the failure model and resource limits.
- `[ ]` Add coverage reporting and quality gates.
- `[ ]` Add a reproducible local demo scenario.
- `[ ]` Improve the README with architecture, examples, and known limitations.

### Milestone 5 - CI/CD

CI comes first, once the local test and verification commands are stable. CD comes later, after a release target and deployment environment have been chosen.

- `[x]` Add a basic GitHub Actions CI workflow.
- `[ ]` Verify the Node version and dependency installation in CI.
- `[ ]` Add coverage and test artifacts.
- `[ ]` Add dependency and security audits.
- `[ ]` Document branch protection and quality gates.
- `[ ]` Add a release workflow with versioning and GitHub Release artifacts.
- `[ ]` Decide whether releases contain an npm package, CLI artifact, or Docker image.
- `[ ]` Add CD only after deciding where the service or artifact is deployed.

**System-design questions:**

- Which quality gates are mandatory before merge?
- How do we reproduce the same build locally and in CI?
- What is the release unit: source package, CLI artifact, or container image?

### Milestone 6 - Docker and Distribution

Docker comes after the CLI has a stable runtime contract.

- `[ ]` Add a `Dockerfile` with a reproducible Node version.
- `[ ]` Use a minimal or multi-stage production image where appropriate.
- `[ ]` Run the process as a non-root user.
- `[ ]` Document CLI execution through Docker.
- `[ ]` Add image vulnerability scanning to CI.
- `[ ]` Define resource and network restrictions.
- `[ ]` Add a healthcheck only if a long-running service process is introduced.
- `[ ]` Automate image publishing through the release workflow.

### Milestone 7 - Optional API and UI

This milestone is not part of the first CLI goal.

- `[ ]` Define an API job model only after the crawler engine is stable.
- `[ ]` Add `POST /crawls`, status, results, and cancellation endpoints.
- `[ ]` Add SSRF protection and service-level resource limits.
- `[ ]` Connect the existing React frontend to the API contract.
- `[ ]` Add configuration, status, metrics, results, and report-download views.
- `[ ]` Add API contract/integration tests and OpenAPI documentation.

## Prioritized Backlog

### P0 - Next

- `[ ]` Decide what to do with the duplicate `src/crawler/crawl.js`.
- `[ ]` Define the crawler behavior contract for depth, page limits, and URL identity.
- `[ ]` Add URL resolver and normalization tests.
- `[ ]` Add concurrency and duplicate-discovery tests.

### P1 - Engine Correctness

- `[ ]` Implement URL resolver and normalization.
- `[ ]` Implement the per-crawl concurrency scheduler.
- `[ ]` Correct depth and page-limit semantics.
- `[ ]` Add a local HTTP-server integration fixture.

### P2 - Production Behavior

- `[ ]` Add the `HttpClient` abstraction.
- `[ ]` Add timeout, retry, and response metadata.
- `[ ]` Enforce robots policy.
- `[ ]` Add CLI options and structured reports.

### P3 - Portfolio and Distribution

- `[ ]` Add CI quality gates and release artifacts.
- `[ ]` Add the Docker image and image scanning.
- `[ ]` Add API/UI only after the CLI contract is stable.

## Verification Matrix

| Area | Command/check | Goal |
|---|---|---|
| Backend | `npm test` | All crawler tests pass from the repository root |
| Frontend lint | `npm run lint:frontend` | No lint errors |
| Frontend build | `npm run build:frontend` | Production build succeeds |
| Full local check | `npm run verify` | All baseline checks pass |
| Integration | Local HTTP fixture | Depth, limits, duplicates, and concurrency are correct |
| CLI | CLI test suite | Validation, output, and exit codes are correct |
| CI | GitHub Actions | CI reproduces local verification |
| Docker | `docker build` and smoke test | Runtime is reproducible |

## Definition of Done

A task or milestone is complete only when it has:

- an implementation;
- a test for the expected behavior;
- updated documentation and this plan;
- defined error behavior;
- a resource and security impact review;
- a reproducible verification command;
- a short learning-log entry for non-trivial decisions.

## Architecture Decision Records

Create ADR documents in `docs/adr/` for decisions that have meaningful long-term consequences.

Initial candidates:

- `[ ]` ADR: authoritative backend layout and root workflow.
- `[ ]` ADR: URL identity and normalization policy.
- `[ ]` ADR: scheduler and concurrency model.
- `[ ]` ADR: retry, timeout, and failure policy.
- `[ ]` ADR: robots failure behavior.
- `[ ]` ADR: CLI output contract.
- `[ ]` ADR: CI/CD release strategy.
- `[ ]` ADR: Docker runtime and distribution strategy.

## Learning Log

Each major task should record the problem, the decision, the alternatives, and the evidence.

### Template

- Date:
- Topic:
- Problem:
- Chosen solution:
- Alternatives considered:
- How it was verified:
- Lesson learned:

### 2026-09-22 - Root Workspace Commands

- **Problem:** `npm test` from the repository root failed because the runtime package is under `backend/`.
- **Chosen solution:** The root `package.json` delegates commands with `npm --prefix`.
- **How it was verified:** `npm test` passes with 61 tests; the full `npm run verify` also passes.
- **Lesson learned:** A monorepo needs an explicit developer workflow; the directory layout alone is not enough.

## Change Log

### 2026-09-22

- Added the project tracker.
- Marked the CLI as the primary product and the UI as a later milestone.
- Added CI/CD and Docker as separate development stages.
- Added root workspace commands for backend tests and frontend checks.
- Updated the README to match the actual repository structure and current limitations.
- Added GitHub Actions CI for backend tests and frontend lint/build.
- Converted this plan to English for consistent project documentation.
