import { describe, expect, it, vi, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { createApiHandler, LocalAuthProvider, ApiKeyAuthProvider, generateApiKey } from "@dataflow-studio/api";
import { MemoryStore, type Store } from "@dataflow-studio/database";
import { ExecutionEngine } from "@dataflow-studio/execution-engine";
import { Logger, MemorySink, newId, redact } from "@dataflow-studio/observability";
import { ManagedSecretProvider, deriveDataKey, encryptSecret, decryptSecret } from "@dataflow-studio/secrets";
import { Worker } from "@dataflow-studio/worker";
import { MemorySqlDriver, assertUrlAllowed, assertReadOnlyQuery, parseQualifiedName } from "@dataflow-studio/connectors";
import type { WorkflowDefinition } from "@dataflow-studio/workflow-engine";

/**
 * Adversarial tests.
 *
 * Each one is a specific attack against the running system rather than a unit
 * test of a guard in isolation: cross-tenant reads through the API, SSRF through
 * a pipeline node, SQL injection through node configuration, secret exfiltration
 * through logs and responses, privilege escalation through API keys, and
 * resource exhaustion through oversized input.
 */
const MASTER = randomBytes(32);
const silent = new Logger({ level: "error", sink: new MemorySink() });

async function harness(role: "owner" | "developer" | "viewer" = "owner", organizationId = "org_sec") {
  const store: Store = new MemoryStore();
  const secrets = new ManagedSecretProvider(store, MASTER);
  const sqlDriver = new MemorySqlDriver({ tables: { "public.targets": [] } });
  const engine = new ExecutionEngine({ store, secrets, logger: silent, heartbeatMs: 1_000_000, sqlDrivers: { postgres: sqlDriver } });
  await store.createOrganization({ id: organizationId, name: "Org", slug: organizationId, createdAt: new Date().toISOString() });

  const handler = createApiHandler({
    store, engine, secrets, logger: silent,
    auth: new LocalAuthProvider({ userId: `user_${role}`, organizationId, role }),
  });
  const worker = new Worker({ store, engine, logger: silent, concurrency: 1, idlePollMs: 1, runScheduler: false });

  const call = async (method: string, path: string, body?: unknown) => {
    const response = await handler(new Request(`http://localhost${path}`, {
      method,
      ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    }));
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  };
  const drain = async (): Promise<void> => {
    for (let i = 0; i < 50; i++) if (!(await worker.executeOne())) break;
  };

  return { store, engine, secrets, sqlDriver, handler, call, drain, organizationId };
}

describe("cross-organization access", () => {
  it("cannot read another organization's pipeline, run, dataset or secret by id", async () => {
    const victim = await harness("owner", "org_victim");
    await victim.call("POST", "/api/v1/secrets", { name: "victim-secret", value: "top-secret" });
    const pipeline = await victim.call("POST", "/api/v1/pipelines", {
      name: "victim-pipeline",
      definition: {
        name: "victim-pipeline",
        nodes: [
          { id: "src", type: "inline.source", config: { rows: [{ a: 1 }], dataset: "victim_data" } },
          { id: "sink", type: "dataset.destination", config: { dataset: "victim_data" } },
        ],
        edges: [{ from: "src", to: "sink" }],
      },
    });
    await victim.call("POST", `/api/v1/pipelines/${pipeline.body.pipeline.id}/publish`, {});
    const run = await victim.call("POST", `/api/v1/pipelines/${pipeline.body.pipeline.id}/run`, {});
    await victim.drain();

    // The attacker shares the same store but a different organization.
    const attackerHandler = createApiHandler({
      store: victim.store,
      engine: victim.engine,
      secrets: victim.secrets,
      logger: silent,
      auth: new LocalAuthProvider({ userId: "attacker", organizationId: "org_attacker", role: "owner" }),
    });
    const attack = async (path: string) => {
      const response = await attackerHandler(new Request(`http://localhost${path}`));
      return { status: response.status, body: JSON.parse((await response.text()) || "null") };
    };

    expect((await attack(`/api/v1/pipelines/${pipeline.body.pipeline.id}`)).status).toBe(404);
    expect((await attack(`/api/v1/runs/${run.body.id}`)).status).toBe(404);
    expect((await attack("/api/v1/datasets/victim_data")).status).toBe(404);
    expect((await attack("/api/v1/secrets")).body).toEqual([]);
    expect((await attack("/api/v1/pipelines")).body.items).toEqual([]);
    expect((await attack("/api/v1/runs")).body.items).toEqual([]);
    expect((await attack("/api/v1/search?q=victim")).body.items).toEqual([]);
    expect((await attack("/api/v1/audit")).body.items).toEqual([]);
    expect((await attack("/api/v1/lineage")).body.nodes).toEqual([]);
  });

  it("cannot mutate another organization's pipeline", async () => {
    const victim = await harness("owner", "org_victim2");
    const created = await victim.call("POST", "/api/v1/pipelines", { name: "target" });
    const attackerHandler = createApiHandler({
      store: victim.store, engine: victim.engine, secrets: victim.secrets, logger: silent,
      auth: new LocalAuthProvider({ userId: "attacker", organizationId: "org_attacker2", role: "owner" }),
    });

    for (const [method, path] of [
      ["PATCH", `/api/v1/pipelines/${created.body.pipeline.id}`],
      ["DELETE", `/api/v1/pipelines/${created.body.pipeline.id}`],
      ["POST", `/api/v1/pipelines/${created.body.pipeline.id}/run`],
      ["POST", `/api/v1/pipelines/${created.body.pipeline.id}/publish`],
    ] as const) {
      const response = await attackerHandler(new Request(`http://localhost${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }));
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    // The pipeline is untouched.
    expect((await victim.call("GET", `/api/v1/pipelines/${created.body.pipeline.id}`)).status).toBe(200);
  });

  it("cannot use an API key against a different organization", async () => {
    const h = await harness();
    const { token, tokenHash, prefix } = generateApiKey();
    await h.store.createApiKey({
      id: newId("key"), organizationId: "org_other_tenant", name: "other", tokenHash, prefix,
      role: "owner", createdBy: "u", createdAt: new Date().toISOString(),
    });
    await h.store.createOrganization({ id: "org_other_tenant", name: "Other", slug: "other-tenant", createdAt: new Date().toISOString() });
    await h.call("POST", "/api/v1/pipelines", { name: "ours" });

    const keyHandler = createApiHandler({
      store: h.store, engine: h.engine, secrets: h.secrets, logger: silent, auth: new ApiKeyAuthProvider(),
    });
    const response = await keyHandler(new Request("http://localhost/api/v1/pipelines", {
      headers: { authorization: `Bearer ${token}` },
    }));
    // Authenticated, but scoped to its own (empty) organization.
    expect(response.status).toBe(200);
    expect(((await response.json()) as { items: unknown[] }).items).toEqual([]);
  });
});

describe("SSRF", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refuses to fetch cloud metadata from an HTTP source node", async () => {
    const h = await harness();
    const definition: WorkflowDefinition = {
      name: "ssrf-attempt",
      version: 1,
      nodes: [
        {
          id: "steal", type: "http.source",
          config: { url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/", pagination: "none" },
          retry: { maxAttempts: 1, strategy: "fixed" },
        },
        { id: "sink", type: "dataset.destination", config: { dataset: "stolen" } },
      ],
      edges: [{ from: "steal", to: "sink" }],
    };
    const created = await h.call("POST", "/api/v1/pipelines", { name: "ssrf-attempt", definition });
    await h.call("POST", `/api/v1/pipelines/${created.body.pipeline.id}/publish`, {});
    const run = await h.call("POST", `/api/v1/pipelines/${created.body.pipeline.id}/run`, {});
    await h.drain();

    const detail = await h.call("GET", `/api/v1/runs/${run.body.id}`);
    expect(detail.body.run.state).toBe("FAILED");
    const task = detail.body.tasks.find((t: { nodeId: string }) => t.nodeId === "steal");
    expect(task.error).toMatch(/link-local|Blocked/i);
    expect(await h.store.getDatasetRows(h.organizationId, "stolen")).toBeNull();
  }, 30_000);

  it("blocks every private range and non-http scheme at the policy boundary", async () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1:5432/",
      "http://10.0.0.5/admin",
      "http://192.168.1.1/",
      "http://[::1]/",
      "file:///etc/passwd",
      "gopher://evil.example.com/",
    ]) {
      await expect(assertUrlAllowed(url, {}, async () => ["10.0.0.1"]), url).rejects.toThrow();
    }
  });

  it("re-checks the target after a redirect", async () => {
    // A public host that redirects to the metadata service must not be followed.
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }),
    ));
    const { httpRequest } = await import("@dataflow-studio/connectors");
    await expect(httpRequest("http://127.0.0.1:8080/start", {
      policy: { allowPrivateNetworks: true, allowedPorts: [8080] },
    })).rejects.toThrow();
  });
});

describe("SQL injection", () => {
  it("rejects a table name crafted to break out of quoting", async () => {
    for (const table of [
      'public.users"; DROP TABLE users; --',
      "users'; DELETE FROM users; --",
      "users`; DROP TABLE users",
      "a.b.c",
    ]) {
      expect(() => parseQualifiedName(table), table).toThrow();
    }
  });

  it("rejects a source query that is not a single SELECT", async () => {
    for (const query of [
      "SELECT 1; DROP TABLE users",
      "DELETE FROM users",
      "UPDATE users SET admin = true",
      "SELECT * FROM users; COPY users TO '/tmp/out'",
      "TRUNCATE users",
    ]) {
      expect(() => assertReadOnlyQuery(query), query).toThrow();
    }
  });

  it("fails a pipeline whose destination table is an injection attempt", async () => {
    const h = await harness();
    const connection = await h.call("POST", "/api/v1/connections", {
      name: "wh", family: "postgres", config: { host: "db.internal" },
    });
    const definition: WorkflowDefinition = {
      name: "injection",
      version: 1,
      nodes: [
        { id: "src", type: "inline.source", config: { rows: [{ a: 1 }] } },
        {
          id: "load", type: "postgres.destination",
          config: { connectionId: connection.body.id, table: 'public.t"; DROP TABLE users; --', writeMode: "append" },
          retry: { maxAttempts: 1, strategy: "fixed" },
        },
      ],
      edges: [{ from: "src", to: "load" }],
    };

    // The pattern check in the node schema rejects it before it can even publish.
    const validation = await h.call("POST", "/api/v1/validate", { definition });
    expect(validation.body.valid).toBe(false);
    expect(validation.body.errors.some((issue: { field?: string }) => issue.field === "table")).toBe(true);
  });

  it("does not let user SQL reach the database through the transform node", async () => {
    const h = await harness();
    // The SQL transform runs in our own engine over in-memory batches; a DML
    // statement is a parse error, not a database round trip.
    const result = await h.call("POST", "/api/v1/preview/sql", { query: "DROP TABLE users", inputs: {} });
    expect(result.status).toBe(422);
    expect(h.sqlDriver.statements).toEqual([]);
  });
});

describe("secret exfiltration", () => {
  it("never returns a secret value from any endpoint", async () => {
    const h = await harness();
    const value = "pk_live_supersecretvalue";
    await h.call("POST", "/api/v1/secrets", { name: "leaky", value });

    for (const path of ["/api/v1/secrets", "/api/v1/connections", "/api/v1/me", "/api/v1/dashboard", "/api/v1/audit"]) {
      const response = await h.call("GET", path);
      expect(JSON.stringify(response.body), path).not.toContain(value);
    }
  });

  it("redacts credentials that reach the logger", () => {
    const redacted: Record<string, unknown> = redact({
      password: "hunter2",
      connectionString: "postgres://user:pw@host/db",
      headers: { authorization: "Bearer abcdefghijklmnop" },
      nested: { apiKey: "sk-abcdefghijklmnop" },
      message: "connecting to postgres://user:pw@db.internal/app",
      secretRef: "prod-password",
      rows: 42,
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("abcdefghijklmnop");
    expect(serialized).not.toContain(":pw@");
    // A reference is a pointer, not a secret: it stays readable.
    expect(redacted["secretRef"]).toBe("prod-password");
    expect(redacted["rows"]).toBe(42);
  });

  it("does not write a credential into task logs", async () => {
    const h = await harness();
    await h.call("POST", "/api/v1/secrets", { name: "db-password", value: "unique-secret-42" });
    const connection = await h.call("POST", "/api/v1/connections", {
      name: "wh", family: "postgres", config: { host: "db.internal" }, secretRefs: { password: "db-password" },
    });

    const definition: WorkflowDefinition = {
      name: "logs-clean",
      version: 1,
      nodes: [
        { id: "src", type: "inline.source", config: { rows: [{ a: 1 }] } },
        {
          id: "load", type: "postgres.destination",
          config: { connectionId: connection.body.id, table: "public.targets", writeMode: "append" },
        },
      ],
      edges: [{ from: "src", to: "load" }],
    };
    const created = await h.call("POST", "/api/v1/pipelines", { name: "logs-clean", definition });
    await h.call("POST", `/api/v1/pipelines/${created.body.pipeline.id}/publish`, {});
    const run = await h.call("POST", `/api/v1/pipelines/${created.body.pipeline.id}/run`, {});
    await h.drain();

    const logs = await h.call("GET", `/api/v1/runs/${run.body.id}/logs?limit=500`);
    expect(JSON.stringify(logs.body)).not.toContain("unique-secret-42");

    const task = (await h.call("GET", `/api/v1/runs/${run.body.id}`)).body.tasks.find((t: { nodeId: string }) => t.nodeId === "load");
    const taskDetail = await h.call("GET", `/api/v1/runs/${run.body.id}/tasks/${task.id}`);
    expect(JSON.stringify(taskDetail.body)).not.toContain("unique-secret-42");
    // The configuration comes back masked, not resolved.
    expect(JSON.stringify(taskDetail.body.config)).toContain("connectionId");
  }, 30_000);

  it("encrypts secrets at rest with a per-organization key", async () => {
    const h = await harness();
    await h.call("POST", "/api/v1/secrets", { name: "at-rest", value: "plaintext-value" });
    const stored = await h.store.getSecret(h.organizationId, "at-rest");

    expect(stored?.ciphertext).toBeTruthy();
    expect(stored!.ciphertext).not.toContain("plaintext-value");
    expect(JSON.stringify(stored)).not.toContain("plaintext-value");

    // A ciphertext from one organization cannot be decrypted with another's key.
    const sealed = encryptSecret("value", deriveDataKey(MASTER, "org_a"), "org_a:name");
    expect(() => decryptSecret(sealed, deriveDataKey(MASTER, "org_b"), "org_b:name")).toThrow();
  });
});

describe("privilege escalation", () => {
  it("stops a viewer from mutating anything", async () => {
    const h = await harness("viewer");
    const mutations: Array<[string, string, unknown]> = [
      ["POST", "/api/v1/pipelines", { name: "x" }],
      ["POST", "/api/v1/secrets", { name: "x", value: "y" }],
      ["POST", "/api/v1/connections", { name: "x", family: "postgres" }],
      ["POST", "/api/v1/schedules", { pipelineId: "p", kind: "interval", intervalSeconds: 60 }],
      ["POST", "/api/v1/backfills", { pipelineId: "p", from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z" }],
      ["POST", "/api/v1/api-keys", { name: "k", role: "viewer" }],
      ["POST", "/api/v1/demo/seed", {}],
    ];
    for (const [method, path, body] of mutations) {
      expect((await h.call(method, path, body)).status, `${method} ${path}`).toBe(403);
    }
  });

  it("stops a developer from deleting or reading the audit log", async () => {
    const h = await harness("developer");
    const created = await h.call("POST", "/api/v1/pipelines", { name: "dev-owned" });
    expect(created.status).toBe(201);
    expect((await h.call("DELETE", `/api/v1/pipelines/${created.body.pipeline.id}`)).status).toBe(403);
    expect((await h.call("GET", "/api/v1/audit")).status).toBe(403);
    expect((await h.call("POST", "/api/v1/api-keys", { name: "k", role: "admin" })).status).toBe(403);
  });

  it("stops an API key from being minted above its creator's role", async () => {
    const h = await harness("developer");
    expect((await h.call("POST", "/api/v1/api-keys", { name: "escalate", role: "owner" })).status).toBe(403);
  });
});

describe("resource exhaustion", () => {
  it("rejects an oversized request body", async () => {
    const h = await harness();
    const response = await h.handler(new Request("http://localhost/api/v1/pipelines", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(100 * 1024 * 1024) },
      body: JSON.stringify({ name: "big" }),
    }));
    expect(response.status).toBe(413);
  });

  it("rejects a pipeline with more nodes than the limit", async () => {
    const h = await harness();
    const nodes = Array.from({ length: 1000 }, (_, i) => ({ id: `n${i}`, type: "generator.source", config: { preset: "sales" } }));
    const result = await h.call("POST", "/api/v1/validate", { definition: { name: "huge", nodes, edges: [] } });
    expect(result.body.valid).toBe(false);
    expect(result.body.errors.some((issue: { code: string }) => issue.code === "workflow.too_large")).toBe(true);
  });

  it("refuses a backfill that would create an absurd number of runs", async () => {
    const h = await harness();
    const created = await h.call("POST", "/api/v1/pipelines", {
      name: "bf-guard",
      definition: {
        name: "bf-guard",
        nodes: [
          { id: "src", type: "generator.source", config: { preset: "sales" } },
          { id: "sink", type: "dataset.destination", config: { dataset: "o" } },
        ],
        edges: [{ from: "src", to: "sink" }],
      },
    });
    await h.call("POST", `/api/v1/pipelines/${created.body.pipeline.id}/publish`, {});

    const result = await h.call("POST", "/api/v1/backfills", {
      pipelineId: created.body.pipeline.id,
      from: "2020-01-01T00:00:00Z",
      to: "2026-01-01T00:00:00Z",
      intervalSeconds: 60,
      confirmLargeBackfill: true,
    });
    expect(result.status).toBe(422);
    expect(result.body.error.message).toMatch(/limit/);
  });

  it("caps intermediate data passed between tasks", async () => {
    const store: Store = new MemoryStore();
    const secrets = new ManagedSecretProvider(store, MASTER);
    const engine = new ExecutionEngine({ store, secrets, logger: silent, maxBatchBytes: 4096, heartbeatMs: 1_000_000 });
    await store.createOrganization({ id: "org_cap", name: "O", slug: "cap", createdAt: new Date().toISOString() });

    const definition: WorkflowDefinition = {
      name: "too-much",
      version: 1,
      nodes: [
        { id: "src", type: "generator.source", config: { preset: "sales", rowCount: 5000 }, retry: { maxAttempts: 1, strategy: "fixed" } },
        { id: "sink", type: "dataset.destination", config: { dataset: "big" } },
      ],
      edges: [{ from: "src", to: "sink" }],
    };
    const now = new Date().toISOString();
    await store.createPipeline({ id: "p", organizationId: "org_cap", name: "too-much", publishedVersionId: "v", latestVersionNumber: 1, createdBy: "u", createdAt: now, updatedAt: now });
    await store.createVersion({ id: "v", organizationId: "org_cap", pipelineId: "p", version: 1, status: "published", definition, definitionHash: "h", createdBy: "u", createdAt: now });

    const run = await engine.startRun({
      organizationId: "org_cap", pipelineId: "p", pipelineName: "too-much", pipelineVersionId: "v",
      version: 1, definition, trigger: "manual", triggeredBy: "u",
    });
    await engine.executeRunToCompletion("org_cap", run.id);
    const tasks = await store.listTasks("org_cap", run.id);
    expect(tasks.find((task) => task.nodeId === "src")?.state).toBe("FAILED");
  }, 30_000);
});

describe("arbitrary code execution", () => {
  it("refuses to execute Python unless a sandbox is configured", async () => {
    const h = await harness();
    const definition: WorkflowDefinition = {
      name: "rce-attempt",
      version: 1,
      nodes: [
        { id: "src", type: "inline.source", config: { rows: [{ a: 1 }] } },
        {
          id: "exec", type: "python.transform",
          config: {
            code: "import os\ndef transform(rows):\n    return [{'files': os.listdir('/')}]",
            entrypoint: "transform",
          },
          retry: { maxAttempts: 1, strategy: "fixed" },
        },
      ],
      edges: [{ from: "src", to: "exec" }],
    };
    const created = await h.call("POST", "/api/v1/pipelines", { name: "rce-attempt", definition });
    await h.call("POST", `/api/v1/pipelines/${created.body.pipeline.id}/publish`, {});
    const run = await h.call("POST", `/api/v1/pipelines/${created.body.pipeline.id}/run`, {});
    await h.drain();

    const detail = await h.call("GET", `/api/v1/runs/${run.body.id}`);
    expect(detail.body.run.state).toBe("FAILED");
    const task = detail.body.tasks.find((t: { nodeId: string }) => t.nodeId === "exec");
    expect(task.error).toMatch(/Python execution is disabled/);
    expect(task.errorClass).toBe("configuration");
  }, 30_000);
});

describe("hostile workflow definitions", () => {
  it("rejects malformed definitions with 4xx, never 5xx", async () => {
    const h = await harness();
    const hostile: unknown[] = [
      "just a string",
      12345,
      [],
      { name: 42, nodes: [] },
      { name: "x", nodes: { not: "an array" } },
      { name: "x", nodes: [{ id: "a", type: "t", config: [] }] },
      { name: "x", nodes: [], edges: [{ from: 1, to: 2 }] },
      { name: "x", nodes: [{ id: "../../etc/passwd", type: "inline.source", config: {} }] },
      { name: "x", nodes: [{ id: "a", type: "inline.source", config: { rows: [] } }, { id: "a", type: "inline.source", config: { rows: [] } }] },
    ];
    for (const definition of hostile) {
      const result = await h.call("POST", "/api/v1/validate", { definition });
      expect(result.status, JSON.stringify(definition).slice(0, 60)).toBeLessThan(500);
    }
  });

  it("ignores organizationId supplied in a request body", async () => {
    const h = await harness();
    const created = await h.call("POST", "/api/v1/pipelines", { name: "spoofed", organizationId: "org_elsewhere" });
    expect(created.body.pipeline.organizationId).toBe(h.organizationId);
  });
});
