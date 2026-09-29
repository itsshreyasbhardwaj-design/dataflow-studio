# CLI

```bash
pnpm add -g @dataflow-studio/cli
dataflow --help
```

Or run it from the repository: `pnpm --filter @dataflow-studio/cli run dev -- <command>`.

## Authentication

```bash
dataflow login --api-key dfs_live_... --url https://dataflow.example.com
dataflow whoami
dataflow logout
```

Credentials are written to `~/.dataflow/config.json` with mode 0600. The key is
verified before the file is written, so a typo does not leave a broken config
behind.

In CI, skip the login and set environment variables instead:

```bash
export DATAFLOW_API_URL=https://dataflow.example.com
export DATAFLOW_API_KEY=${{ secrets.DATAFLOW_API_KEY }}
```

## Pipelines

```bash
dataflow pipeline list [--search sales] [--json]
dataflow pipeline get daily-sales
dataflow pipeline validate pipelines/daily-sales.json
dataflow pipeline deploy pipelines/daily-sales.json [--publish]
dataflow pipeline run daily-sales [--wait] [--param region=north] [--draft]
dataflow pipeline test pipelines/daily-sales.json
dataflow pipeline diff daily-sales --from 1 --to 2
```

Pipelines can be addressed by ID or by name.

`deploy` creates or updates a draft. Publishing is a separate, explicit flag:
CI should be able to stage a change without promoting it.

## Runs

```bash
dataflow run list [--pipeline pipe_123] [--state FAILED]
dataflow run get run_abc123
dataflow run cancel run_abc123
dataflow run retry run_abc123 [--all] [--from node_id]
dataflow logs run_abc123 [--follow] [--level error] [--task task_xyz] [--search "null customer"]
```

`dataflow run get` renders the DAG as it executed:

```text
Pipeline     daily-sales v3
Run ID       run_abc123
Started      2026-03-31T02:00:04.221Z
Duration     42.3s
Status       SUCCESS
Triggered by schedule:sch_7 (schedule)

  ✓ extract_sales           1.2s
      48,201 rows
  ✓ clean_sales             0.8s
      47,889 rows
  ✓ aggregate_revenue       3.1s
      1,204 rows
  ✓ quality_checks          0.2s
  ✓ quality_gate            0.1s
  ✓ load_reporting          36.9s
      1,204 rows

Data quality
CHECK                 COLUMN       EXPECTED                  ACTUAL  STATUS
customer_id_not_null  customer_id  NOT NULL, expected 100%   100%    PASSED
customer_id_unique    customer_id  UNIQUE, expected 100%     100%    PASSED
revenue_non_negative  revenue      BETWEEN 0 AND +inf        100%    PASSED
```

`--follow` on `logs` streams the run's events and prints new log lines as tasks
finish.

## Catalog

```bash
dataflow dataset list [--search revenue]
dataflow dataset get customer_revenue
dataflow incident list [--status open]
dataflow lineage [--pipeline pipe_123]
```

## Pipeline tests

A definition can declare the expectations a run must satisfy:

```json
{
  "metadata": {
    "tests": [
      { "dataset": "customer_revenue", "minRows": 1, "notNull": ["customer_id"], "unique": ["customer_id"], "nonNegative": ["revenue"] }
    ]
  }
}
```

`dataflow pipeline test` validates the definition, deploys it as a draft, runs
it, and checks those expectations against the run's real quality results and row
counts:

```text
Running daily-sales (draft) to evaluate 1 expectation(s)

CHECK                          RESULT  DETAIL
run completes                  PASS    42.3s
customer_revenue rows >= 1     PASS    1204
customer_id not null           PASS    100% of NOT NULL, expected 100%
customer_id unique             PASS    100% of UNIQUE, expected 100%
revenue non-negative           PASS    100% of BETWEEN 0 AND +inf, expected 100%

All expectations passed
```

If a declared column has no matching quality check in the run, that is a failure,
not a pass — a test that silently checks nothing is worse than no test.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Request failed, usage error, or the API rejected the input |
| 2 | Validation failed, a run failed, or a test expectation failed |
| 69 | API unreachable |
| 70 | Server error (5xx) |

The distinction between 1 and 2 is what lets CI tell "the CLI could not talk to
the API" apart from "the pipeline is wrong".

## Machine-readable output

`--json` on any command prints the raw payload:

```bash
dataflow run list --state FAILED --json | jq -r '.items[].id'
dataflow pipeline validate pipeline.json --json | jq '.errors[].message'
```

## In CI

```yaml
- name: Validate pipelines
  run: |
    for file in pipelines/*.json; do
      dataflow pipeline validate "$file"
    done

- name: Test on a branch
  if: github.event_name == 'pull_request'
  run: dataflow pipeline test pipelines/daily-sales.json

- name: Deploy and publish on main
  if: github.ref == 'refs/heads/main'
  run: |
    dataflow pipeline deploy pipelines/daily-sales.json --publish
    dataflow pipeline run daily-sales --wait --timeout 1800
  env:
    DATAFLOW_API_URL: ${{ vars.DATAFLOW_API_URL }}
    DATAFLOW_API_KEY: ${{ secrets.DATAFLOW_API_KEY }}
```

Deployment to production is never implicit: it takes `--publish`, on a branch
condition you write.
