# Security

This document describes the trust boundaries, what each one enforces, and what a
production deployment must configure.

## Trust boundaries

```text
browser / CLI / CI
        │  session cookie or API key
        ▼
┌───────────────────────────────────────────────┐
│ API   authenticate → RBAC → rate limit → audit│
└───────────────┬───────────────────────────────┘
                │  organization-scoped store calls
                ▼
┌───────────────────────────────────────────────┐
│ Store  every method takes organizationId      │  ← tenancy enforced here
└───────────────┬───────────────────────────────┘
                ▼
┌───────────────────────────────────────────────┐
│ Worker  resolves secrets · egress policy      │  ← the only place plaintext exists
└───────────────┬───────────────────────────────┘
                ▼
        external systems
```

A pipeline definition is untrusted input at every one of those boundaries. It is
authored by a user, stored, and later executed by our infrastructure against our
network — which is the same shape as an SSRF or an injection, and is treated that
way.

## Authentication

Three providers behind one interface (`apps/api/src/auth.ts`):

| Provider | Use |
| --- | --- |
| `ApiKeyAuthProvider` | `Authorization: Bearer dfs_live_...` for the CLI, CI and the SDK. |
| `ClerkAuthProvider` | Browser sessions. Verification is delegated to the host app, so any OIDC provider fits the same interface. |
| `LocalAuthProvider` | Single user, everything permitted. `AUTH_MODE=local`. The UI states it. **Never in production.** |

API keys are shown once. Only a SHA-256 hash is stored, comparison is constant
time, and revocation and expiry are checked on every request. A key cannot be
created with a role that exceeds its creator's.

## Authorization

Four roles, one permission matrix, enforced in the **service layer** rather than
in route handlers — so an endpoint added later cannot forget the check.

| Permission | viewer | developer | admin | owner |
| --- | :-: | :-: | :-: | :-: |
| `pipeline.read`, `connection.read`, `dataset.read`, `incident.read`, `analytics.read` | ● | ● | ● | ● |
| `pipeline.create`, `pipeline.edit`, `pipeline.execute`, `pipeline.cancel` | | ● | ● | ● |
| `workflow.publish`, `workflow.schedule`, `backfill.create` | | ● | ● | ● |
| `connection.create`, `connection.edit`, `secret.create`, `secret.read`¹ | | ● | ● | ● |
| `incident.edit` | | ● | ● | ● |
| `pipeline.delete`, `connection.delete`, `secret.delete` | | | ● | ● |
| `quality.override`, `audit.read`, `apikey.read`, `apikey.create`, `member.manage` | | | ● | ● |
| `organization.edit` | | | | ● |

¹ `secret.read` grants access to **metadata** — name, fingerprint, last used. No
role can read a secret value through the API, because no such endpoint exists.

Each role's permissions are a strict superset of the one below it, and a test
asserts that.

## Tenancy

Every `Store` method takes an `organizationId`. There is no method that reads
across tenants. A forgotten `WHERE` in a route handler therefore cannot leak
data — the leak would have to be in the store itself, which has a conformance
suite run against both drivers.

For deployments where the database is reachable by something other than this
application (a Supabase-style setup), `0002_row_level_security.sql` adds
PostgreSQL RLS policies keyed on a session GUC:

```sql
SET LOCAL dataflow.organization_id = 'org_123';
```

It is opt-in (`DATAFLOW_ENABLE_RLS=true`) because it requires a non-superuser
application role.

`tests/security.test.ts` attempts cross-tenant reads and writes against
pipelines, runs, datasets, secrets, search, audit and lineage, and asserts 404 or
an empty result for every one.

## Secrets

```json
{ "password": { "secretRef": "prod-postgres-password" } }
```

- **At rest:** AES-256-GCM. The data key is derived per organization with HKDF
  from `ENCRYPTION_KEY`, and the organization and secret name are bound in as
  additional authenticated data. A ciphertext from one tenant cannot be decrypted
  for another, and tampering fails the authentication tag.
- **In transit to the user:** never. No endpoint returns a value; the UI shows a
  fingerprint so you can see *that* a value changed without seeing it.
- **In a definition:** references only. The API rejects an inline credential in a
  connection config with a message naming the field.
- **At execution:** resolved in the worker, at the moment the task needs it, and
  every read is written to the audit log with the run and node that caused it.
- **In logs:** the sink redacts sensitive keys, `scheme://user:password@host`
  patterns, bearer tokens and known key shapes (`sk-`, `ghp_`, `AKIA`, `xoxb-`,
  JWTs) before a record is written. A `secretRef` is a pointer, not a secret, and
  stays readable.

Without `ENCRYPTION_KEY` the managed provider is unavailable and only
environment-injected secrets (`DATAFLOW_SECRET_*`) resolve. The application says
so at startup rather than pretending to encrypt.

## Connector egress (SSRF)

Every user-supplied URL goes through `assertUrlAllowed`:

- Scheme and port allowlists; credentials in the URL rejected.
- Hostname deny list, then allow list (`CONNECTOR_ALLOWED_HOSTS`).
- `localhost`, `*.local`, `*.internal`, `*.home.arpa` refused without resolving.
- **DNS resolved, every address range-checked** — loopback, private, link-local
  (`169.254.169.254`), CGNAT, multicast, reserved, IPv6 ULA/link-local, and
  IPv4-mapped IPv6.
- Redirects followed manually and re-validated at every hop.
- Response read with a hard byte cap; forbidden and CRLF-containing headers
  rejected.

`CONNECTOR_ALLOW_PRIVATE_NETWORKS=true` exists for pointing a node at a local dev
API. It must never be set in production, and the variable is named so that it is
obvious in a diff.

Defence in depth: restrict worker egress at the infrastructure level too, with a
security group, network policy or egress proxy.

## SQL

- **Identifiers** (tables, columns) cannot be parameterized, so they are
  validated against a strict pattern *and* quoted. `users"; DROP TABLE users; --`
  is rejected, not escaped.
- **Source queries** must parse as a single `SELECT`. Stacked statements, DML,
  DDL and `COPY` are refused before a connection opens, and a comment cannot hide
  a second statement.
- **Transform SQL** never reaches a database. It is parsed and evaluated by this
  project's own engine over in-memory batches, and the grammar cannot express
  anything but `SELECT`.

## Code execution

User Python is never evaluated in the API or worker process. The default provider
refuses with an explanation.

`PYTHON_SANDBOX=subprocess` runs a scrubbed interpreter: `-I` isolated mode, a
temporary working directory, an environment with no credentials or proxy
settings, `RLIMIT_AS`/`RLIMIT_NPROC`/`RLIMIT_FSIZE`, a hard timeout and an output
cap. Only JSON crosses the boundary.

That is suitable for a single-tenant deployment where the code authors are
already trusted. **It is not a security sandbox against hostile code.** A
multi-tenant deployment must supply a provider with real isolation — a
microVM, gVisor, or a remote task runner. The interface exists precisely so that
substitution is a configuration change.

## Auditing

Every mutation writes an entry: actor, actor type, action, resource, result,
request ID, IP and timestamp. Denied attempts are recorded as `denied`, not
dropped. Secret reads by the worker are recorded as `system` with the run and
node. The request ID appears in the error envelope, the logs and the audit row,
so a user-reported failure can be traced end to end.

## Rate limiting

Sliding window per principal and route class: 600/min default, 60/min for run
creation, 120/min for writes, 30/min for unauthenticated requests by IP. `429`
responses carry `Retry-After`.

The in-memory limiter is correct for a single instance. A multi-instance
deployment should point `REDIS_URL` at shared Redis and use `RedisRateLimiter`,
because per-process counters multiply the effective limit by the instance count.

## Input limits

| Limit | Value |
| --- | --- |
| Request body | 8 MB |
| File upload | 64 MB |
| Workflow definition | 4 MB |
| Nodes per pipeline | 500 |
| Edges per pipeline | 2,000 |
| Intermediate batch between tasks | 32 MB |
| HTTP response | 10 MB (configurable) |
| Secret value | 64 KB |
| Backfill runs | 10,000, with confirmation above 100 |

## Production checklist

- [ ] `ENCRYPTION_KEY` set to 32 random bytes and stored in a secret manager.
- [ ] `AUTH_MODE=clerk` (or another real provider). Not `local`.
- [ ] `DATABASE_URL` set; the application role has only DML on its own schema.
- [ ] `CONNECTOR_ALLOW_PRIVATE_NETWORKS` unset or `false`.
- [ ] `CONNECTOR_ALLOWED_HOSTS` set if pipelines only need known endpoints.
- [ ] Worker egress restricted at the network level.
- [ ] `PYTHON_SANDBOX` left disabled unless you run a real isolation provider.
- [ ] `REDIS_URL` set if more than one API instance runs.
- [ ] TLS terminated in front of the app; `NEXT_PUBLIC_APP_URL` uses `https`.
- [ ] Audit log retention and export configured.
- [ ] `0002_row_level_security.sql` applied if the database is reachable
      elsewhere.

## Reporting

See [SECURITY.md](../SECURITY.md). Please report privately.
