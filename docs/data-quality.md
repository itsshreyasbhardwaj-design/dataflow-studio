# Data quality

Quality is a first-class node type, not a reporting afterthought. Checks run
inside the pipeline, their results are stored per run, and a gate can stop a bad
load before it reaches a warehouse.

## Checks

```json
{
  "id": "quality",
  "type": "quality.check",
  "config": {
    "dataset": "customer_revenue",
    "checks": [
      { "id": "customer_id_not_null", "type": "not_null", "column": "customer_id" },
      { "id": "customer_id_unique", "type": "unique", "column": "customer_id" },
      { "id": "revenue_non_negative", "type": "range", "column": "revenue", "min": 0 },
      { "id": "email_format", "type": "regex", "column": "email", "pattern": "^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$" },
      { "id": "status_allowed", "type": "accepted_values", "column": "status", "values": ["paid", "refunded"] },
      { "id": "has_rows", "type": "row_count", "minRows": 1 },
      { "id": "fresh", "type": "freshness", "column": "updated_at", "maxAgeSeconds": 86400 },
      { "id": "no_orphans", "type": "custom_sql", "sql": "SELECT id FROM input WHERE customer_id IS NULL" }
    ],
    "onFailure": "warn"
  }
}
```

| Type | Passes when | Options |
| --- | --- | --- |
| `not_null` | Value is present and not empty string | `threshold` |
| `unique` | No value appears twice (NULLs ignored, as a UNIQUE constraint does) | `threshold` |
| `range` | Numeric value within bounds; NULLs are not this check's business | `min`, `max` |
| `regex` | Value matches; NULLs ignored | `pattern`, `caseInsensitive` |
| `accepted_values` | Value is in the list | `values` |
| `row_count` | Batch size within bounds | `minRows`, `maxRows` |
| `freshness` | Newest timestamp is within the window | `column`, `maxAgeSeconds` |
| `custom_sql` | The query returns **no** rows | `sql` |

`custom_sql` follows dbt's convention: the query selects the rows that *violate*
the expectation, so writing one is a matter of describing what is wrong.

Two knobs on every check:

- **`threshold`** — the fraction of rows that must pass, default `1`. Setting
  `0.99` is how a team tolerates known dirty data without muting the check and
  losing the signal.
- **`severity`** — `error` (default) or `warn`. A warning is recorded and shown
  but does not trip an `error_only` gate.

## Results

Every check produces a stored record with real numbers:

```text
customer_id

NOT NULL
Expected: 100%
Actual: 99.4%
Status: FAILED
```

The record carries `passedRows`, `failedRows`, `totalRows`, `passRate`, and up to
five offending values as samples. Samples are values, never whole rows, so a
quality result cannot become a side channel for the data itself.

A check that cannot be evaluated — a missing column, an invalid `custom_sql` —
is `ERRORED`, not `PASSED`. An unevaluated expectation is not a satisfied one,
and a gate treats it as a failure.

## Gates

```json
{ "id": "gate", "type": "quality.gate", "config": { "severity": "any_failure", "scope": "upstream" } }
```

| `severity` | Blocks when |
| --- | --- |
| `any_failure` | Any check in scope did not pass |
| `error_only` | An `error`-severity check did not pass |
| `score_below` | Mean pass rate is below `minScore` |

`scope: "upstream"` (the default) considers only checks produced by ancestors of
the gate, so two independent branches do not block each other. `scope: "run"`
considers everything in the run.

When a gate blocks, downstream tasks become `BLOCKED` — not `FAILED`:

```text
✓ extract
✓ transform
✓ quality checks
✓ quality gate      1 of 5 quality check(s) did not pass: customer_id_unique
⚠ load              BLOCKED
```

The run fails, the destination never executed, and the run page says which check
caused it. That is the difference between "the load failed" and "we deliberately
did not load bad data".

## Previewing before publishing

`POST /api/v1/preview/quality` evaluates checks against sample rows without a
run, so an author can tune a threshold before it gates production:

```bash
curl -X POST localhost:3000/api/v1/preview/quality \
  -H 'content-type: application/json' \
  -d '{"checks":[{"id":"c","type":"not_null","column":"email"}],"rows":[{"email":null},{"email":"a@b.co"}]}'
```

## Quality over time

Results accumulate per dataset. The dataset page shows the recent history and the
current status, the dashboard counts failures in the window, and repeated
failures open an incident whose evidence is the failing checks themselves.

## What this is not

There is no anomaly detection and no learned baseline. Every check is a
deterministic assertion that a human wrote. A system that decides on its own that
today's numbers look unusual is a different product, and a much harder one to
trust at 02:00.
