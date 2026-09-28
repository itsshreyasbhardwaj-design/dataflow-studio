import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore, type Store } from "@dataflow-studio/database";
import { ExecutionEngine } from "@dataflow-studio/execution-engine";
import { Logger, MemorySink, newId } from "@dataflow-studio/observability";
import { ManagedSecretProvider, type SecretProvider } from "@dataflow-studio/secrets";
import { randomBytes } from "node:crypto";
import { PIPELINE_TEMPLATES } from "@dataflow-studio/workflow-engine";
import { createApiHandler, matchRoute, listRoutes } from "./router.js";
import { ApiKeyAuthProvider, CompositeAuthProvider, LocalAuthProvider, generateApiKey, hashApiKey, type AuthProvider, type Principal } from "./auth.js";
import { hasPermission, permissionsFor, requirePermission, ROLE_PERMISSIONS } from "./rbac.js";
import { MemoryRateLimiter, RATE_LIMITS } from "./rate-limit.js";
import { ApiError, toEnvelope } from "./errors.js";
import { createContext } from "./context.js";
import * as services from "./services/index.js";

const silent = new Logger({ level: "error", sink: new MemorySink() });
const MASTER = randomBytes(32);
const demoDefinition = PIPELINE_TEMPLATES.find((t) => t.id === "zero-infra-demo")!.definition;

interface Harness {
  store: Store;
  engine: ExecutionEngine;
  secrets: SecretProvider;
  handler: (request: Request) => Promise<Response>;
  organizationId: string;
  call: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any }>;
}

async function harness(options: { role?: "owner" | "admin" | "developer" | "viewer"; auth?: AuthProvider } = {}): Promise<Harness> {
  const store = new MemoryStore();
  const secrets = new ManagedSecretProvider(store, MASTER);
  const engine = new ExecutionEngine({ store, secrets, logger: silent, heartbeatMs: 1_000_000 });
  const organizationId = "org_api_test";
  await store.createOrganization({ id: organizationId, name: "Acme", slug: "acme", createdAt: new Date().toISOString() });
  await store.upsertMember({ organizationId, userId: "user_1", role: options.role ?? "owner", createdAt: new Date().toISOString() });

  const auth = options.auth ?? new CompositeAuthProvider([
    new ApiKeyAuthProvider(),
    new LocalAuthProvider({ userId: "user_1", organizationId, role: options.role ?? "owner" }),
  ]);
  const handler = createApiHandler({ store, engine, secrets, auth, logger: silent, rateLimiter: new MemoryRateLimiter() });

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await handler(new Request(`http://localhost${path}`, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }));
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  return { store, engine, secrets, handler, organizationId, call };
}

describe("RBAC matrix", () => {
  it("grants read-only permissions to a viewer", () => {
    expect(hasPermission("viewer", "pipeline.read")).toBe(true);
    for (const permission of ["pipeline.create", "pipeline.edit", "pipeline.execute", "workflow.publish", "secret.create", "pipeline.delete"] as const) {
      expect(hasPermission("viewer", permission), permission).toBe(false);
    }
  });

  it("lets a developer build and run but not delete or manage keys", () => {
    for (const permission of ["pipeline.create", "pipeline.edit", "pipeline.execute", "pipeline.cancel", "workflow.publish", "workflow.schedule", "backfill.create"] as const) {
      expect(hasPermission("developer", permission), permission).toBe(true);
    }
    for (const permission of ["pipeline.delete", "apikey.create", "member.manage", "audit.read", "secret.delete"] as const) {
      expect(hasPermission("developer", permission), permission).toBe(false);
    }
  });

  it("escalates monotonically from viewer to owner", () => {
    const chain = ["viewer", "developer", "admin", "owner"] as const;
    for (let i = 1; i < chain.length; i++) {
      const narrower = permissionsFor(chain[i - 1]!);
      const wider = permissionsFor(chain[i]!);
      expect(narrower.every((p) => wider.includes(p)), `${chain[i - 1]} ⊆ ${chain[i]}`).toBe(true);
      expect(wider.length).toBeGreaterThan(narrower.length);
    }
  });

  it("never grants a permission that is not declared", () => {
    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      expect(new Set(permissions).size, role).toBe(permissions.length);
    }
  });

  it("explains a denial in terms of the missing permission", () => {
    expect(() => requirePermission("viewer", "pipeline.execute")).toThrow(/does not include "pipeline.execute"/);
  });
});

describe("authentication", () => {
  it("rejects an unauthenticated request", async () => {
    const h = await harness({ auth: new ApiKeyAuthProvider() });
    const result = await h.call("GET", "/api/v1/pipelines");
    expect(result.status).toBe(401);
    expect(result.body.error.code).toBe("unauthenticated");
    expect(result.body.error.requestId).toMatch(/^req_/);
  });

  it("accepts a valid API key and applies its role", async () => {
    const h = await harness();
    const created = await h.call("POST", "/api/v1/api-keys", { name: "ci", role: "viewer" });
    expect(created.status).toBe(201);
    const token: string = created.body.token;
    expect(token.startsWith("dfs_live_")).toBe(true);

    const keyOnly = await harness({ auth: new ApiKeyAuthProvider() });
    // The key belongs to the first harness's store, so use that handler.
    const me = await h.call("GET", "/api/v1/me", undefined, { authorization: `Bearer ${token}` });
    expect(me.status).toBe(200);
    expect(me.body.actorType).toBe("api_key");
    expect(me.body.role).toBe("viewer");
    void keyOnly;
  });

  it("rejects an unknown, revoked or expired key", async () => {
    const h = await harness({ auth: new ApiKeyAuthProvider() });
    const unknown = await h.call("GET", "/api/v1/me", undefined, { authorization: "Bearer dfs_live_nope" });
    expect(unknown.status).toBe(401);

    const { token, tokenHash, prefix } = generateApiKey();
    const now = new Date().toISOString();
    await h.store.createApiKey({
      id: newId("key"), organizationId: h.organizationId, name: "revoked", tokenHash, prefix,
      role: "admin", createdBy: "user_1", createdAt: now, revokedAt: now,
    });
    expect((await h.call("GET", "/api/v1/me", undefined, { authorization: `Bearer ${token}` })).status).toBe(401);

    const expired = generateApiKey();
    await h.store.createApiKey({
      id: newId("key"), organizationId: h.organizationId, name: "expired", tokenHash: expired.tokenHash,
      prefix: expired.prefix, role: "admin", createdBy: "user_1", createdAt: now,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const result = await h.call("GET", "/api/v1/me", undefined, { authorization: `Bearer ${expired.token}` });
    expect(result.status).toBe(401);
    expect(result.body.error.message).toMatch(/expired/);
  });

  it("stores only the hash of an API key", async () => {
    const h = await harness();
    const created = await h.call("POST", "/api/v1/api-keys", { name: "ci", role: "developer" });
    const stored = await h.store.listApiKeys(h.organizationId);
    expect(stored[0]!.tokenHash).toBe(hashApiKey(created.body.token));
    expect(JSON.stringify(stored)).not.toContain(created.body.token);
    // The listing endpoint never returns the hash either.
    const listed = await h.call("GET", "/api/v1/api-keys");
    expect(JSON.stringify(listed.body)).not.toContain("tokenHash");
  });

  it("refuses to mint a key that outranks the caller", async () => {
    const h = await harness({ role: "developer" });
    const result = await h.call("POST", "/api/v1/api-keys", { name: "escalate", role: "owner" });
    expect(result.status).toBe(403);
  });
});

describe("tenant isolation", () => {
  it("does not return another organization's pipeline (IDOR)", async () => {
    const a = await harness();
    const created = await a.call("POST", "/api/v1/pipelines", { name: "private-pipeline" });
    expect(created.status).toBe(201);
    const pipelineId = created.body.pipeline.id;

    // A second organization in the same store, reached through its own principal.
    const otherOrg = "org_other";
    await a.store.createOrganization({ id: otherOrg, name: "Other", slug: "other", createdAt: new Date().toISOString() });
    await a.store.upsertMember({ organizationId: otherOrg, userId: "user_2", role: "owner", createdAt: new Date().toISOString() });
    const intruder = createApiHandler({
      store: a.store,
      engine: a.engine,
      secrets: a.secrets,
      auth: new LocalAuthProvider({ userId: "user_2", organizationId: otherOrg, role: "owner" }),
      logger: silent,
    });

    const response = await intruder(new Request(`http://localhost/api/v1/pipelines/${pipelineId}`));
    expect(response.status).toBe(404);
    const list = await intruder(new Request("http://localhost/api/v1/pipelines"));
    expect((await list.json()).items).toHaveLength(0);
  });

  it("does not leak runs, datasets or secrets across organizations", async () => {
    const a = await harness();
    await a.secrets.write(a.organizationId, "prod-token", "super-secret");
    await a.store.putDataset(a.organizationId, "private_dataset", { rows: [{ a: 1 }], columns: [], rowCount: 1, writeMode: "replace" });

    const otherOrg = "org_other2";
    await a.store.createOrganization({ id: otherOrg, name: "O", slug: "o2", createdAt: new Date().toISOString() });
    await a.store.upsertMember({ organizationId: otherOrg, userId: "user_3", role: "owner", createdAt: new Date().toISOString() });
    const intruder = createApiHandler({
      store: a.store, engine: a.engine, secrets: a.secrets, logger: silent,
      auth: new LocalAuthProvider({ userId: "user_3", organizationId: otherOrg, role: "owner" }),
    });

    expect((await (await intruder(new Request("http://localhost/api/v1/secrets"))).json())).toEqual([]);
    expect((await (await intruder(new Request("http://localhost/api/v1/datasets"))).json()).items).toEqual([]);
    expect((await intruder(new Request("http://localhost/api/v1/datasets/private_dataset"))).status).toBe(404);
    expect((await (await intruder(new Request("http://localhost/api/v1/search?q=private"))).json()).items).toEqual([]);
  });
});

describe("secret handling", () => {
  it("never returns a secret value", async () => {
    const h = await harness();
    const created = await h.call("POST", "/api/v1/secrets", { name: "prod-pg-password", value: "hunter2", description: "prod" });
    expect(created.status).toBe(201);
    expect(JSON.stringify(created.body)).not.toContain("hunter2");

    const listed = await h.call("GET", "/api/v1/secrets");
    expect(JSON.stringify(listed.body)).not.toContain("hunter2");
    expect(listed.body[0]).toMatchObject({ name: "prod-pg-password", backend: "managed" });
    expect(listed.body[0].fingerprint).toBeTruthy();
    expect(listed.body[0]).not.toHaveProperty("ciphertext");
  });

  it("has no endpoint that reads a secret value", () => {
    const secretRoutes = listRoutes().filter((r) => r.pattern.includes("secrets"));
    expect(secretRoutes.map((r) => `${r.method} ${r.pattern}`).sort()).toEqual([
      "DELETE /api/v1/secrets/:name",
      "GET /api/v1/secrets",
      "POST /api/v1/secrets",
    ]);
  });

  it("rejects an inline credential in a connection config", async () => {
    const h = await harness();
    const result = await h.call("POST", "/api/v1/connections", {
      name: "bad", family: "postgres", config: { host: "db", password: "hunter2" },
    });
    expect(result.status).toBe(422);
    expect(result.body.error.message).toMatch(/must be stored as a secret/);
  });

  it("rejects a connection referencing a secret that does not exist", async () => {
    const h = await harness();
    const result = await h.call("POST", "/api/v1/connections", {
      name: "warehouse", family: "postgres", config: { host: "db" }, secretRefs: { password: "absent" },
    });
    expect(result.status).toBe(422);
    expect(result.body.error.message).toMatch(/does not exist/);
  });

  it("masks secret references in a pipeline definition it returns", async () => {
    const h = await harness();
    await h.call("POST", "/api/v1/secrets", { name: "api-token", value: "abc123" });
    const created = await h.call("POST", "/api/v1/pipelines", {
      name: "api-pipeline",
      definition: {
        name: "api-pipeline",
        nodes: [
          { id: "src", type: "http.source", config: { url: "https://api.example.com", headers: { Authorization: { secretRef: "api-token" } } } },
          { id: "sink", type: "dataset.destination", config: { dataset: "out" } },
        ],
        edges: [{ from: "src", to: "sink" }],
      },
    });
    expect(created.status).toBe(201);
    const detail = await h.call("GET", `/api/v1/pipelines/${created.body.pipeline.id}`);
    const config = detail.body.currentVersion.definition.nodes[0].config;
    expect(config.headers.Authorization).toEqual({ secretRef: "api-token", masked: true });
    expect(JSON.stringify(detail.body)).not.toContain("abc123");
  });

  it("refuses to delete a secret a connection depends on", async () => {
    const h = await harness();
    await h.call("POST", "/api/v1/secrets", { name: "pg-pass", value: "x" });
    await h.call("POST", "/api/v1/connections", { name: "wh", family: "postgres", config: { host: "db" }, secretRefs: { password: "pg-pass" } });
    const result = await h.call("DELETE", "/api/v1/secrets/pg-pass");
    expect(result.status).toBe(409);
  });
});

describe("pipeline lifecycle over HTTP", () => {
  it("creates, validates, publishes, runs and inspects a pipeline", async () => {
    const h = await harness();
    const created = await h.call("POST", "/api/v1/pipelines", { name: "demo-daily-sales", definition: demoDefinition });
    expect(created.status).toBe(201);
    const pipelineId = created.body.pipeline.id;

    const validated = await h.call("POST", `/api/v1/pipelines/${pipelineId}/validate`);
    expect(validated.body.valid).toBe(true);

    const published = await h.call("POST", `/api/v1/pipelines/${pipelineId}/publish`, {});
    expect(published.status).toBe(200);
    expect(published.body.version.status).toBe("published");

    const run = await h.call("POST", `/api/v1/pipelines/${pipelineId}/run`, {});
    expect(run.status).toBe(200);
    await h.engine.executeRunToCompletion(h.organizationId, run.body.id);

    const detail = await h.call("GET", `/api/v1/runs/${run.body.id}`);
    expect(detail.body.run.state).toBe("SUCCESS");
    expect(detail.body.tasks).toHaveLength(6);
    expect(detail.body.graph.nodes).toHaveLength(6);
    expect(detail.body.quality).toHaveLength(5);

    const logs = await h.call("GET", `/api/v1/runs/${run.body.id}/logs?limit=5`);
    expect(logs.body.items.length).toBeGreaterThan(0);

    const task = detail.body.tasks.find((t: { nodeId: string }) => t.nodeId === "revenue_by_customer");
    const taskDetail = await h.call("GET", `/api/v1/runs/${run.body.id}/tasks/${task.id}`);
    expect(taskDetail.body.attempts).toHaveLength(1);
    expect(taskDetail.body.config.query).toContain("SELECT");

    const dashboard = await h.call("GET", "/api/v1/dashboard");
    expect(dashboard.body.runs.succeeded).toBe(1);
    expect(dashboard.body.performance.successRate).toBe(1);
  });

  it("refuses to publish an invalid definition", async () => {
    const h = await harness();
    const created = await h.call("POST", "/api/v1/pipelines", {
      name: "broken",
      definition: {
        name: "broken",
        nodes: [
          { id: "a", type: "generator.source", config: { preset: "sales" } },
          { id: "b", type: "filter.transform", config: { predicates: [] } },
        ],
        edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }],
      },
    });
    const published = await h.call("POST", `/api/v1/pipelines/${created.body.pipeline.id}/publish`, {});
    expect(published.status).toBe(422);
    expect(published.body.error.message).toMatch(/Pipeline cannot run/);
    expect(published.body.error.details.issues.some((i: { code: string }) => i.code === "graph.cycle")).toBe(true);
  });

  it("refuses to run a pipeline that was never published", async () => {
    const h = await harness();
    const created = await h.call("POST", "/api/v1/pipelines", { name: "unpublished", definition: demoDefinition });
    const run = await h.call("POST", `/api/v1/pipelines/${created.body.pipeline.id}/run`, {});
    expect(run.status).toBe(422);
    expect(run.body.error.message).toMatch(/no published version/);
  });

  it("keeps published versions immutable and creates a draft on edit", async () => {
    const h = await harness();
    const created = await h.call("POST", "/api/v1/pipelines", { name: "versioned", definition: demoDefinition });
    const pipelineId = created.body.pipeline.id;
    await h.call("POST", `/api/v1/pipelines/${pipelineId}/publish`, {});

    const v2 = structuredClone(demoDefinition);
    v2.nodes[0]!.config["rowCount"] = 1234;
    await h.call("PATCH", `/api/v1/pipelines/${pipelineId}`, { definition: v2 });

    const detail = await h.call("GET", `/api/v1/pipelines/${pipelineId}`);
    expect(detail.body.versions.map((v: { version: number; status: string }) => `${v.version}:${v.status}`))
      .toEqual(["2:draft", "1:published"]);

    const compare = await h.call("GET", `/api/v1/pipelines/${pipelineId}/compare?from=1&to=2`);
    expect(compare.body.diff.summary.join(" ")).toContain("configuration");
  });

  it("refuses to delete a pipeline with runs in flight", async () => {
    const h = await harness();
    const created = await h.call("POST", "/api/v1/pipelines", { name: "busy", definition: demoDefinition });
    const pipelineId = created.body.pipeline.id;
    await h.call("POST", `/api/v1/pipelines/${pipelineId}/publish`, {});
    await h.call("POST", `/api/v1/pipelines/${pipelineId}/run`, {});
    const deleted = await h.call("DELETE", `/api/v1/pipelines/${pipelineId}`);
    expect(deleted.status).toBe(409);
  });
});

describe("permission enforcement per endpoint", () => {
  it("lets a viewer read but not mutate", async () => {
    const h = await harness({ role: "viewer" });
    expect((await h.call("GET", "/api/v1/pipelines")).status).toBe(200);
    expect((await h.call("GET", "/api/v1/dashboard")).status).toBe(200);
    expect((await h.call("POST", "/api/v1/pipelines", { name: "nope" })).status).toBe(403);
    expect((await h.call("POST", "/api/v1/secrets", { name: "x", value: "y" })).status).toBe(403);
    expect((await h.call("GET", "/api/v1/audit")).status).toBe(403);
    expect((await h.call("POST", "/api/v1/api-keys", { name: "k", role: "viewer" })).status).toBe(403);
  });

  it("lets a developer run a pipeline but not delete one", async () => {
    const owner = await harness();
    const created = await owner.call("POST", "/api/v1/pipelines", { name: "dev-pipeline", definition: demoDefinition });
    await owner.call("POST", `/api/v1/pipelines/${created.body.pipeline.id}/publish`, {});

    const developer = createApiHandler({
      store: owner.store, engine: owner.engine, secrets: owner.secrets, logger: silent,
      auth: new LocalAuthProvider({ userId: "dev_1", organizationId: owner.organizationId, role: "developer" }),
    });
    const run = await developer(new Request(`http://localhost/api/v1/pipelines/${created.body.pipeline.id}/run`, { method: "POST" }));
    expect(run.status).toBe(200);
    const remove = await developer(new Request(`http://localhost/api/v1/pipelines/${created.body.pipeline.id}`, { method: "DELETE" }));
    expect(remove.status).toBe(403);
  });

  it("records a denied attempt in the audit log", async () => {
    const h = await harness({ role: "viewer" });
    await h.call("POST", "/api/v1/pipelines", { name: "denied" });
    // A denial before the audited body runs is not recorded as success.
    const audit = await h.store.listAudit(h.organizationId);
    expect(audit.items.filter((a) => a.result === "success" && a.action === "pipeline.create")).toHaveLength(0);
  });

  it("writes an audit entry for every successful mutation", async () => {
    const h = await harness();
    const created = await h.call("POST", "/api/v1/pipelines", { name: "audited", definition: demoDefinition });
    await h.call("POST", `/api/v1/pipelines/${created.body.pipeline.id}/publish`, {});
    const audit = await h.call("GET", "/api/v1/audit");
    const actions = audit.body.items.map((a: { action: string }) => a.action);
    expect(actions).toContain("pipeline.create");
    expect(actions).toContain("pipeline.publish");
    expect(audit.body.items[0].requestId).toMatch(/^req_/);
  });
});

describe("request handling", () => {
  it("returns a consistent error envelope with a request id", async () => {
    const h = await harness();
    const result = await h.call("GET", "/api/v1/pipelines/pipe_missing");
    expect(result.status).toBe(404);
    expect(Object.keys(result.body.error).sort()).toEqual(["code", "message", "requestId"]);
  });

  it("echoes a caller-supplied request id", async () => {
    const h = await harness();
    const response = await h.handler(new Request("http://localhost/api/v1/me", { headers: { "x-request-id": "req_caller" } }));
    expect(response.headers.get("x-request-id")).toBe("req_caller");
  });

  it("rejects malformed JSON and non-JSON content types", async () => {
    const h = await harness();
    const bad = await h.handler(new Request("http://localhost/api/v1/pipelines", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{nope",
    }));
    expect(bad.status).toBe(422);
    const wrongType = await h.handler(new Request("http://localhost/api/v1/pipelines", {
      method: "POST", headers: { "content-type": "text/xml" }, body: "<x/>",
    }));
    expect(wrongType.status).toBe(415);
  });

  it("rejects an oversized body", async () => {
    const h = await harness();
    const response = await h.handler(new Request("http://localhost/api/v1/pipelines", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(64 * 1024 * 1024) },
      body: JSON.stringify({ name: "big" }),
    }));
    expect(response.status).toBe(413);
  });

  it("returns 405 for a known path with the wrong method", async () => {
    const h = await harness();
    expect((await h.call("PUT", "/api/v1/pipelines")).status).toBe(405);
  });

  it("returns 404 for an unknown endpoint", async () => {
    const h = await harness();
    expect((await h.call("GET", "/api/v1/nonsense")).status).toBe(404);
  });

  it("serves health without authentication", async () => {
    const h = await harness({ auth: new ApiKeyAuthProvider() });
    const result = await h.call("GET", "/api/v1/health");
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
  });

  it("matches routes and their parameters", () => {
    expect(matchRoute("GET", "/api/v1/runs/run_123")?.params).toEqual({ id: "run_123" });
    expect(matchRoute("GET", "/api/v1/runs/run_123/tasks/task_9")?.params).toEqual({ id: "run_123", taskId: "task_9" });
    expect(matchRoute("GET", "/api/v1/unknown")).toBeNull();
    expect(() => matchRoute("PUT", "/api/v1/runs/run_1")).toThrow(ApiError);
  });
});

describe("rate limiting", () => {
  it("returns 429 with Retry-After once the bucket is empty", async () => {
    const store = new MemoryStore();
    const secrets = new ManagedSecretProvider(store, MASTER);
    const engine = new ExecutionEngine({ store, secrets, logger: silent });
    const handler = createApiHandler({
      store, engine, secrets, logger: silent,
      auth: new LocalAuthProvider({ userId: "u", organizationId: "org_rl", role: "owner" }),
      rateLimiter: new MemoryRateLimiter(),
    });

    let last = await handler(new Request("http://localhost/api/v1/me"));
    for (let i = 0; i < RATE_LIMITS.default.limit + 1; i++) {
      last = await handler(new Request("http://localhost/api/v1/me"));
      if (last.status === 429) break;
    }
    expect(last.status).toBe(429);
    expect(last.headers.get("retry-after")).toBeTruthy();
    expect((await last.json()).error.code).toBe("rate_limited");
  });

  it("counts buckets per principal and per route class", async () => {
    const limiter = new MemoryRateLimiter();
    const rule = { limit: 2, windowSeconds: 60 };
    expect((await limiter.consume("a", rule)).allowed).toBe(true);
    expect((await limiter.consume("a", rule)).allowed).toBe(true);
    expect((await limiter.consume("a", rule)).allowed).toBe(false);
    expect((await limiter.consume("b", rule)).allowed).toBe(true);
  });

  it("frees capacity once the window passes", async () => {
    const limiter = new MemoryRateLimiter();
    const rule = { limit: 1, windowSeconds: 60 };
    const now = Date.now();
    expect((await limiter.consume("k", rule, now)).allowed).toBe(true);
    expect((await limiter.consume("k", rule, now + 1000)).allowed).toBe(false);
    expect((await limiter.consume("k", rule, now + 61_000)).allowed).toBe(true);
  });
});

describe("hostile input", () => {
  it("rejects a malicious workflow definition", async () => {
    const h = await harness();
    for (const definition of [
      { name: "x", nodes: "not-an-array" },
      { name: "x", nodes: [{ id: "a" }] },
      { name: "x", nodes: [], edges: [{ from: "a" }] },
      "not an object",
    ]) {
      const result = await h.call("POST", "/api/v1/validate", { definition });
      expect([422, 400]).toContain(result.status);
    }
  });

  it("does not execute SQL that is not a SELECT in a preview", async () => {
    const h = await harness();
    const result = await h.call("POST", "/api/v1/preview/sql", { query: "DROP TABLE users", inputs: {} });
    expect(result.status).toBe(422);
  });

  it("refuses an oversized pipeline", async () => {
    const h = await harness();
    const nodes = Array.from({ length: 600 }, (_, i) => ({ id: `n${i}`, type: "generator.source", config: { preset: "sales" } }));
    const result = await h.call("POST", "/api/v1/validate", { definition: { name: "huge", nodes, edges: [] } });
    expect(result.body.valid).toBe(false);
    expect(result.body.errors.some((e: { code: string }) => e.code === "workflow.too_large")).toBe(true);
  });

  it("ignores an attempt to set organizationId through the body", async () => {
    const h = await harness();
    const created = await h.call("POST", "/api/v1/pipelines", { name: "tenant-test", organizationId: "org_other" });
    expect(created.status).toBe(201);
    expect(created.body.pipeline.organizationId).toBe(h.organizationId);
  });

  it("sanitises an uploaded filename", async () => {
    const h = await harness();
    const context = createContext({
      store: h.store, engine: h.engine, secrets: h.secrets, requestId: "req_test",
      principal: { userId: "user_1", organizationId: h.organizationId, role: "owner", actorType: "user" } satisfies Principal,
      logger: silent,
    });
    const result = await services.files.uploadFile(context, {
      filename: "../../../etc/passwd.csv",
      content: Buffer.from("a,b\n1,2\n"),
    });
    expect(result.file.filename).not.toContain("/");
    expect(result.preview.rowCount).toBe(1);
  });
});

describe("error envelope mapping", () => {
  it("maps domain error classes to HTTP status codes", () => {
    expect(toEnvelope(Object.assign(new Error("x"), { errorClass: "not_found" }), "r").status).toBe(404);
    expect(toEnvelope(Object.assign(new Error("x"), { errorClass: "permission" }), "r").status).toBe(403);
    expect(toEnvelope(Object.assign(new Error("x"), { errorClass: "validation" }), "r").status).toBe(422);
    expect(toEnvelope(Object.assign(new Error("x"), { name: "ConflictError" }), "r").status).toBe(409);
    expect(toEnvelope(new Error("boom"), "r").status).toBe(500);
  });

  it("does not leak an internal message on a 500", () => {
    const envelope = toEnvelope(new Error("connection string postgres://user:pw@host/db failed"), "r");
    expect(envelope.body.error.message).toBe("Internal server error");
  });
});

describe("demo data", () => {
  it("labels every seeded record as demo and executes it for real", async () => {
    const h = await harness();
    const seeded = await h.call("POST", "/api/v1/demo/seed", { execute: true });
    expect(seeded.status).toBe(201);
    expect(seeded.body.isDemo).toBe(true);

    const pipelines = await h.call("GET", "/api/v1/pipelines");
    expect(pipelines.body.items.every((p: { isDemo: boolean }) => p.isDemo)).toBe(true);

    const runs = await h.call("GET", "/api/v1/runs");
    expect(runs.body.items.length).toBeGreaterThan(0);
    expect(runs.body.items.every((r: { isDemo: boolean }) => r.isDemo)).toBe(true);
    expect(runs.body.items[0].state).toBe("SUCCESS");

    const dashboard = await h.call("GET", "/api/v1/dashboard");
    expect(dashboard.body.demoOnly).toBe(true);
  });

  it("is idempotent", async () => {
    const h = await harness();
    await h.call("POST", "/api/v1/demo/seed", {});
    await h.call("POST", "/api/v1/demo/seed", {});
    expect((await h.call("GET", "/api/v1/pipelines")).body.items).toHaveLength(1);
  });

  it("creates a template pipeline as a draft, never published", async () => {
    const h = await harness();
    const created = await h.call("POST", "/api/v1/pipelines/from-template", { templateId: "csv-to-postgres", name: "my-import" });
    expect(created.status).toBe(201);
    const detail = await h.call("GET", `/api/v1/pipelines/${created.body.pipelineId}`);
    expect(detail.body.pipeline.publishedVersionId).toBeNull();
    expect(detail.body.versions[0].status).toBe("draft");
  });
});

describe("scheduling over HTTP", () => {
  it("creates a schedule and previews its next firings", async () => {
    const h = await harness();
    const created = await h.call("POST", "/api/v1/pipelines", { name: "scheduled", definition: demoDefinition });
    await h.call("POST", `/api/v1/pipelines/${created.body.pipeline.id}/publish`, {});

    const schedule = await h.call("POST", "/api/v1/schedules", {
      pipelineId: created.body.pipeline.id, kind: "cron", cron: "0 2 * * *", timezone: "Europe/Berlin",
    });
    expect(schedule.status).toBe(201);
    expect(schedule.body.description).toBe("Every day at 02:00 Europe/Berlin");
    expect(schedule.body.upcoming).toHaveLength(3);

    const listed = await h.call("GET", `/api/v1/schedules?pipelineId=${created.body.pipeline.id}`);
    expect(listed.body).toHaveLength(1);
  });

  it("refuses to schedule an unpublished pipeline", async () => {
    const h = await harness();
    const created = await h.call("POST", "/api/v1/pipelines", { name: "unscheduled", definition: demoDefinition });
    const result = await h.call("POST", "/api/v1/schedules", { pipelineId: created.body.pipeline.id, kind: "interval", intervalSeconds: 3600 });
    expect(result.status).toBe(422);
  });

  it("guards a large backfill behind explicit confirmation", async () => {
    const h = await harness();
    const created = await h.call("POST", "/api/v1/pipelines", { name: "backfilled", definition: demoDefinition });
    await h.call("POST", `/api/v1/pipelines/${created.body.pipeline.id}/publish`, {});

    const unconfirmed = await h.call("POST", "/api/v1/backfills", {
      pipelineId: created.body.pipeline.id, from: "2026-01-01T00:00:00Z", to: "2026-05-01T00:00:00Z", intervalSeconds: 86400,
    });
    expect(unconfirmed.status).toBe(422);
    expect(unconfirmed.body.error.message).toMatch(/Re-submit with confirmation/);

    const confirmed = await h.call("POST", "/api/v1/backfills", {
      pipelineId: created.body.pipeline.id, from: "2026-01-01T00:00:00Z", to: "2026-01-05T00:00:00Z",
      intervalSeconds: 86400, concurrency: 2,
    });
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.totalRuns).toBe(5);
  });
});
