# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-29

First public release. The platform is feature-complete for the lifecycle it
documents: design, validate, version, schedule, execute, observe, debug, retry,
backfill and analyse.

### Added

**Workflow engine**
- Portable JSON workflow definition with a typed node-type registry; the same
  field schema drives validation, the editor's forms and the documentation.
- DAG analysis: iterative cycle detection, topological layering, ancestor and
  descendant traversal, connected components, critical path.
- Validation with graph-anchored errors covering cycles, arity, disconnected
  nodes, duplicate IDs, unresolved node references, missing credentials,
  unsupported connectors and invalid configuration.
- Version diffing that distinguishes semantic changes from canvas moves, and a
  content hash computed identically in the browser and on the server.
- Retry planning with exponential, fixed and explicit backoff, error
  classification, and a refusal to retry non-idempotent destructive writes.

**Execution**
- DAG executor with lease-based task claiming, so workers scale horizontally and
  a crashed worker's tasks are reclaimed rather than lost.
- Cancellation that propagates to running tasks and is checked before expensive
  operations begin.
- Quality gates that mark downstream tasks `BLOCKED` instead of failing them.
- Condition nodes that skip the branch they did not select.
- Incident detection from stored evidence: repeated failures, duration spikes,
  quality failures, schema drift, missing data and stale datasets.
- Failure investigation that gathers the failed task, its attempts, its logs,
  the previous successful run and the definition diff since then.

**Data**
- SQL engine: tokenizer, Pratt parser and evaluator supporting joins (hash and
  nested loop), aggregates, `GROUP BY`/`HAVING`, `CASE`, `CAST`, 30 scalar
  functions and PostgreSQL null-ordering semantics.
- Data quality: eight check types with thresholds, severities and gates.
- Schema registry with type inference, profiling, and deterministic
  `COMPATIBLE`/`WARNING`/`BREAKING` classification of schema evolution.
- Lineage derived from published definitions, with unresolved nodes reported
  rather than guessed.
- Connectors for PostgreSQL, MySQL, HTTP, S3-compatible storage, CSV, JSON,
  inline rows and a deterministic generator, behind one interface.

**Platform**
- REST API with API-key and Clerk authentication, a four-role permission matrix
  enforced in the service layer, sliding-window rate limits, request IDs, audit
  logging and a single error envelope.
- Server-sent events for live runs, resumable from the last sequence.
- PostgreSQL persistence with full migrations, partial indexes, `FOR UPDATE SKIP
  LOCKED` claiming and optional row-level security; an in-memory driver runs the
  same conformance suite.
- Cron and interval scheduling with explicit IANA timezones, DST-correct
  firing, catchup and duplicate protection; backfills with concurrency limits
  and guard rails.
- TypeScript SDK, `dataflow` CLI (including `pipeline test` for CI gating), and
  a worker with health and Prometheus endpoints.
- Next.js application: dashboard, visual DAG editor, live run view, dataset
  catalog, lineage explorer, incidents, analytics, connectors and settings.

### Security
- Secrets sealed with AES-256-GCM under per-organization derived keys; no API
  endpoint returns a secret value.
- SSRF protection with DNS resolution, private-range blocking, redirect
  re-validation and hostname allowlists.
- SQL identifier validation and read-only source queries.
- Credential redaction applied at the log sink.
- Python execution behind a provider interface that refuses by default.
- 24 adversarial tests covering cross-tenant access, SSRF, injection, secret
  leakage, privilege escalation and resource exhaustion.

### Known limitations
See the "Known limitations" section of the README.

[Unreleased]: https://github.com/itsshreyasbhardwaj-design/dataflow-studio/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/itsshreyasbhardwaj-design/dataflow-studio/releases/tag/v0.1.0
