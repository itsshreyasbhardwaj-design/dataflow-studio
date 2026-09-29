# Example pipelines

These files are the portable workflow format described in
[`docs/workflow-engine.md`](../../docs/workflow-engine.md). They are version-controlled
definitions: the same JSON the visual editor produces, the CLI deploys and the
worker executes.

| File | External systems needed |
| --- | --- |
| `daily-sales.json` | **None.** Generated source, managed dataset destination. Runs anywhere. |
| `csv-import.json` | An uploaded CSV and a PostgreSQL connection. |
| `customer-sync.json` | A PostgreSQL connection with read and write access. |
| `api-analytics.json` | An allowlisted HTTP endpoint, a stored API token, an S3-compatible connection. |

Placeholders spelled `REPLACE_WITH_...` must be substituted with real IDs before
these can be published. Validation rejects them if the referenced connection or
secret does not exist, so a half-configured pipeline cannot reach production.

## Using them

```bash
# Validate without deploying (exit code 2 on failure - useful in CI)
dataflow pipeline validate examples/pipelines/daily-sales.json

# Deploy as a draft, then publish explicitly
dataflow pipeline deploy examples/pipelines/daily-sales.json
dataflow pipeline deploy examples/pipelines/daily-sales.json --publish

# Run and block until it finishes; exits non-zero if the run fails
dataflow pipeline run daily-sales --wait

# Run the expectations declared under metadata.tests
dataflow pipeline test examples/pipelines/daily-sales.json
```
