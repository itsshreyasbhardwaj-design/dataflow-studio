# Connectors

A connector is the only thing in the system that talks to an external system.
Everything else operates on batches of rows.

## The interface

```ts
interface DataConnector {
  readonly family: "postgres" | "mysql" | "http" | "s3" | "file" | "memory";
  testConnection(config: NodeConfig, signal?: AbortSignal): Promise<ConnectionResult>;
  read(request: ReadRequest): Promise<DataBatch>;
  write(request: WriteRequest): Promise<WriteResult>;
  getSchema(config: NodeConfig, signal?: AbortSignal): Promise<DataSchemaDescriptor>;
  close?(): Promise<void>;
}
```

By the time a connector is called, its configuration has already been merged with
the stored connection record and every `{ secretRef }` has been resolved to a
plaintext value. A connector never sees a secret *reference*, and it never logs
its own configuration — the log sink redacts credentials regardless, but the
contract is that connectors do not try.

## Built in

| Node type | Family | Notes |
| --- | --- | --- |
| `postgres.source` / `postgres.destination` | postgres | Table or query reads, incremental watermarks, append/replace/upsert writes in a transaction. Needs the optional `pg` driver. |
| `mysql.source` / `mysql.destination` | mysql | Same surface. Needs the optional `mysql2` driver. |
| `http.source` / `http.request` / `webhook.notify` | http | Page or cursor pagination, SSRF policy, response size caps. |
| `s3.source` / `s3.destination` | s3 | Any S3-compatible endpoint. SigV4 implemented directly — no vendor SDK. |
| `csv.source` / `json.source` | file | Uploaded files, parsed server-side with a row limit. |
| `inline.source` | memory | Literal rows in the definition. Used by examples and tests. |
| `generator.source` | memory | Deterministic synthetic data from a seed. |
| `dataset.destination` | memory | A DataFlow-managed dataset. Requires no external system. |

Optional drivers are optional on purpose: a deployment that only reads HTTP APIs
should not ship a PostgreSQL client. If a node needs one that is missing, the
error says exactly what to install.

## Relational connectors

**Reads** are either a table or a single `SELECT`. `assertReadOnlyQuery` rejects
anything else before a connection is opened — no DML, no DDL, no stacked
statements, and comments cannot hide a second statement. A `LIMIT` is always
applied.

Incremental reads take a watermark:

```json
{ "mode": "table", "table": "public.events", "incrementalColumn": "created_at", "limit": 100000 }
```

which becomes `WHERE "created_at" > $1 ORDER BY "created_at" ASC LIMIT 100000`,
with the watermark bound as a parameter.

**Writes** run inside a transaction. `replace` truncates inside that transaction,
so an aborted load leaves the previous data intact. `upsert` becomes
`ON CONFLICT (...) DO UPDATE` on PostgreSQL and `ON DUPLICATE KEY UPDATE` on
MySQL. Rows go out in batches (`batchSize`, default 1000).

Table and column names cannot be bound as parameters, so they are validated
against `^[A-Za-z_][A-Za-z0-9_$]{0,62}$` **and** quoted. Anything that does not
match is rejected rather than escaped:

```ts
parseQualifiedName('users"; DROP TABLE users; --')  // throws
parseQualifiedName("reporting.customer_revenue")     // { schema: "reporting", table: "customer_revenue" }
```

PostgreSQL `SQLSTATE` codes are mapped to error classes so the retry planner does
the right thing: `40001` (serialization failure) is transient and retried,
`42P01` (undefined table) is not.

## HTTP connector and the egress policy

Every HTTP request from a pipeline goes through `assertUrlAllowed` first:

1. Scheme must be `http` or `https`.
2. Port must be on the allowed list (80, 443, 8080, 8443 by default).
3. Credentials in the URL are rejected — use a header with a secret reference.
4. The hostname is checked against the deny list, then the allow list.
5. `localhost`, `*.local`, `*.internal`, `*.localhost` and `*.home.arpa` are
   refused without resolving.
6. **DNS is resolved, and every resulting address is range-checked.** Loopback,
   private, link-local (including `169.254.169.254`), carrier-grade NAT,
   multicast, reserved, IPv6 unique-local and IPv4-mapped IPv6 are all blocked.

Redirects are followed manually so each hop is re-validated. A public host that
302s to the metadata service does not get followed.

Responses are read with a hard byte cap rather than trusting `Content-Length`.
Forbidden headers (`Host`, `X-Forwarded-For`, `Metadata-Flavor`, …) are stripped,
and a header value containing CRLF is rejected.

```bash
CONNECTOR_ALLOWED_HOSTS=api.stripe.com,api.internal-partner.com
CONNECTOR_BLOCKED_HOSTS=admin.example.com
CONNECTOR_ALLOW_PRIVATE_NETWORKS=false   # never true in production
```

## Object storage

`s3.source` and `s3.destination` speak plain S3 REST with AWS Signature V4
implemented in `packages/connectors/src/sigv4.ts`. That is about 90 lines and it
means the connector works against AWS S3, MinIO, Cloudflare R2, Backblaze B2 and
Ceph with no vendor SDK and no transitive supply chain. The signer is verified
against AWS's published test vectors.

Object keys support templating: `exports/events/{{ run.date }}/events.csv`.

## File parsing

CSV parsing is RFC 4180: quoted fields, embedded delimiters, embedded newlines,
doubled quotes, CRLF, and a UTF-8 BOM. Type inference runs over a sample and
unifies across rows — `integer` and `float` become `float`, anything ambiguous
becomes `string`. A 20-digit run of digits stays a string, because it is far more
likely to be an identifier than a number.

Uploads are parsed server-side with a row limit and returned as a bounded
preview. A 60 MB CSV is never shipped to the browser to be looked at.

## Adding a connector

1. Implement `DataConnector`.
2. Add node types to `packages/workflow-engine/src/node-types.ts`, with the field
   schema the editor should render and `destructive: true` if it writes.
3. Register it in `ConnectorRegistry.forNodeType`.
4. Map the system's error codes to error classes, so retries behave.
5. Test it against `MemorySqlDriver` or a stubbed `fetch`; add an adversarial
   test if it takes a URL or an identifier from configuration.

The registry is one `switch`. That is intentional: a new connector is a small,
reviewable diff rather than a plugin with its own lifecycle.

## Testing without the real thing

`MemorySqlDriver` implements the narrow statement set `SqlDatabaseConnector`
emits — transactions, create-if-not-exists, truncate, parameterized multi-row
insert with conflict handling, and limited selects. It is a test double, not a
database: arbitrary SQL is rejected rather than half-interpreted, which keeps it
honest. It is what lets the engine's write paths be tested end to end with no
server running.
