# Security policy

## Reporting a vulnerability

Report privately through a
[GitHub security advisory](https://github.com/itsshreyasbhardwaj-design/dataflow-studio/security/advisories/new).
Please do not open a public issue for anything exploitable.

Include the version or commit, what an attacker can do, and the smallest
reproduction you have. A proof of concept against a local instance is ideal;
never test against infrastructure you do not own.

You can expect an acknowledgement within 72 hours, an assessment within a week,
and a fix or a documented mitigation before any public disclosure. If you would
like credit in the advisory, say so.

## Scope

In scope: the execution engine, the REST API, authentication and RBAC, secret
storage and resolution, the connector egress policy, SQL identifier handling,
the Python sandbox boundary, tenant isolation, and the published container and
deployment guidance.

Out of scope: findings that require an already-compromised host or database,
denial of service through deliberately absurd but authenticated input beyond the
documented limits, and vulnerabilities in a dependency without a demonstrated
path through this code.

## What the system already assumes

These are deliberate properties, not oversights. If you can break one of them,
that is a vulnerability.

- **A pipeline definition is untrusted input.** Node configuration comes from
  users. Table and column identifiers are validated against a strict pattern and
  quoted; source queries must parse as a single `SELECT`; transform SQL executes
  in this project's own engine over in-memory batches and never reaches a
  database.
- **A URL in a node is an SSRF attempt until proven otherwise.** HTTP and object
  storage nodes resolve DNS before connecting, reject private, loopback,
  link-local and carrier-grade-NAT ranges, re-validate every redirect hop, and
  honour an optional hostname allowlist. Credentials embedded in a URL are
  rejected.
- **Secrets are write-only over HTTP.** No endpoint returns a secret value.
  Values are sealed with AES-256-GCM under a key derived per organization, and
  are decrypted only in the worker at the moment a task needs them. Every read is
  written to the audit log.
- **Logs are redacted at the sink.** Passwords, tokens, authorization headers and
  credentials embedded in connection strings are replaced before a record is
  written, so a connector that prints its own configuration cannot leak one.
- **User Python never runs in the API or worker process.** The default provider
  refuses to execute. `PYTHON_SANDBOX=subprocess` runs a scrubbed interpreter
  with resource limits and is suitable for single-tenant deployments where the
  code authors are already trusted; multi-tenant deployments must supply a
  provider with real isolation.
- **Tenancy is enforced in the persistence layer.** Every store method is
  organization-scoped, so a forgotten filter in a route handler cannot leak data.
  An optional migration adds PostgreSQL row-level security as a second line.

## Hardening a deployment

See [`docs/security.md`](docs/security.md) for the full checklist. The short
version: set `ENCRYPTION_KEY`, set `AUTH_MODE=clerk` (or another real identity
provider), leave `CONNECTOR_ALLOW_PRIVATE_NETWORKS` off, set
`CONNECTOR_ALLOWED_HOSTS`, run workers with network egress restricted at the
infrastructure level, and give the application database role no more than
`SELECT/INSERT/UPDATE/DELETE` on its own schema.

## Supported versions

This project is pre-1.0. Security fixes land on `main` and in the next release;
there are no long-term support branches yet.
