## What this changes

<!-- One paragraph: the behaviour that is different after this PR. -->

## Why

<!-- The problem. Link the issue if there is one. -->

## How it was verified

<!-- Not "tests pass" - which tests, and what would have caught the bug. -->

- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass locally
- [ ] New behaviour has a test that fails without the change
- [ ] If the store contract changed, the conformance suite covers both drivers
- [ ] If a node type changed, the registry entry and its validation are updated together

## Risk

<!-- What could break, and how someone would notice. Delete what does not apply. -->

- [ ] Changes execution semantics (retries, cancellation, state transitions)
- [ ] Changes the database schema (migration included and idempotent)
- [ ] Changes an API contract (documented in `docs/api.md`)
- [ ] Touches authentication, RBAC, secrets or the connector egress policy
