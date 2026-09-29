# Documentation

| Document | What it covers |
| --- | --- |
| [architecture.md](architecture.md) | How the system is put together, the ten separations, how a run actually happens, the failure model |
| [workflow-engine.md](workflow-engine.md) | The definition format, node types, validation codes, versioning, retry policy |
| [execution.md](execution.md) | States, claiming, leases, cancellation, retries, incidents, metrics |
| [connectors.md](connectors.md) | The connector interface, the built-in set, the egress policy, adding one |
| [data-quality.md](data-quality.md) | Check types, thresholds, gates, and what a blocked load looks like |
| [lineage.md](lineage.md) | How lineage is derived, what is deliberately not claimed, column lineage |
| [scheduling.md](scheduling.md) | Cron, timezones and DST, catchup, duplicate protection, backfills |
| [security.md](security.md) | Trust boundaries, RBAC matrix, secrets, SSRF, SQL, sandboxing, production checklist |
| [api.md](api.md) | Every REST endpoint, conventions, error envelope, a worked example |
| [sdk.md](sdk.md) | The TypeScript client, streaming, waiting for runs, deploying from code |
| [cli.md](cli.md) | `dataflow` commands, pipeline tests, exit codes, CI usage |
| [self-hosting.md](self-hosting.md) | Topology, PostgreSQL setup, Docker, scaling, operating, troubleshooting |
| [development.md](development.md) | Local setup, layout, adding things, testing conventions, gotchas |

Start with [architecture.md](architecture.md) if you want to understand the
system, or [development.md](development.md) if you want to change it.
