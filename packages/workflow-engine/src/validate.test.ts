import { describe, expect, it } from "vitest";
import { extractTableNames, formatValidationResult, validateWorkflow } from "./validate.js";
import { PIPELINE_TEMPLATES } from "./templates.js";
import type { WorkflowDefinition } from "./types.js";

const base = (overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition => ({
  name: "daily-sales",
  version: 1,
  nodes: [
    { id: "extract", type: "generator.source", config: { preset: "sales", rowCount: 10 } },
    { id: "load", type: "dataset.destination", config: { dataset: "out" } },
  ],
  edges: [{ from: "extract", to: "load" }],
  ...overrides,
});

const codes = (wf: WorkflowDefinition, ctx = {}) =>
  validateWorkflow(wf, ctx).errors.map((e) => e.code);

describe("validateWorkflow", () => {
  it("accepts a minimal valid pipeline", () => {
    const result = validateWorkflow(base());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.normalized).toBeDefined();
  });

  it("applies registry defaults to the normalized definition", () => {
    const result = validateWorkflow(base());
    const generator = result.normalized!.nodes.find((n) => n.id === "extract")!;
    expect(generator.config["seed"]).toBe(42);
  });

  it("rejects an invalid pipeline name", () => {
    expect(codes(base({ name: "Daily Sales!" }))).toContain("workflow.name_invalid");
  });

  it("rejects an empty pipeline", () => {
    expect(codes(base({ nodes: [], edges: [] }))).toContain("workflow.empty");
  });

  it("rejects duplicate node IDs", () => {
    const wf = base();
    wf.nodes.push({ id: "extract", type: "generator.source", config: {} });
    expect(codes(wf)).toContain("node.id_duplicate");
  });

  it("rejects unknown node types", () => {
    const wf = base();
    wf.nodes[0] = { id: "extract", type: "snowflake.source", config: {} };
    expect(codes(wf)).toContain("node.type_unknown");
  });

  it("rejects unknown configuration keys", () => {
    const wf = base();
    wf.nodes[0]!.config["nonsense"] = 1;
    const result = validateWorkflow(wf);
    expect(result.errors.some((e) => e.code === "node.config_invalid" && /Unknown configuration key/.test(e.message))).toBe(true);
  });

  it("rejects a missing required field", () => {
    const wf = base();
    wf.nodes[1] = { id: "load", type: "dataset.destination", config: {} };
    const result = validateWorkflow(wf);
    expect(result.errors.some((e) => e.field === "dataset")).toBe(true);
  });

  it("detects cycles and names the loop", () => {
    const wf = base();
    wf.edges.push({ from: "load", to: "extract" });
    const result = validateWorkflow(wf);
    expect(result.errors.some((e) => e.code === "graph.cycle" && /extract/.test(e.message))).toBe(true);
  });

  it("rejects self loops", () => {
    const wf = base();
    wf.edges.push({ from: "load", to: "load" });
    expect(codes(wf)).toContain("edge.self_loop");
  });

  it("rejects edges to unknown nodes", () => {
    const wf = base();
    wf.edges.push({ from: "extract", to: "ghost" });
    expect(codes(wf)).toContain("edge.node_missing");
  });

  it("rejects an unknown output port", () => {
    const wf = base();
    wf.edges = [{ from: "extract", to: "load", port: "maybe" }];
    expect(codes(wf)).toContain("edge.port_unknown");
  });

  it("accepts the condition node's true/false ports", () => {
    const wf: WorkflowDefinition = {
      name: "branching",
      version: 1,
      nodes: [
        { id: "src", type: "generator.source", config: { preset: "sales", rowCount: 5 } },
        { id: "cond", type: "condition.branch", config: { expression: "row_count_gt", value: 0 } },
        { id: "sink", type: "dataset.destination", config: { dataset: "out" } },
      ],
      edges: [
        { from: "src", to: "cond" },
        { from: "cond", to: "sink", port: "true" },
      ],
    };
    expect(validateWorkflow(wf).valid).toBe(true);
  });

  it("reports a node with no inputs that requires one", () => {
    const wf = base();
    wf.edges = [];
    const result = validateWorkflow(wf);
    expect(result.errors.map((e) => e.code)).toContain("node.disconnected");
  });

  it("reports too many inputs", () => {
    const wf: WorkflowDefinition = {
      name: "too-many",
      version: 1,
      nodes: [
        { id: "a", type: "generator.source", config: { preset: "sales" } },
        { id: "b", type: "generator.source", config: { preset: "sales" } },
        { id: "f", type: "filter.transform", config: { predicates: [] } },
      ],
      edges: [{ from: "a", to: "f" }, { from: "b", to: "f" }],
    };
    expect(codes(wf)).toContain("node.too_many_inputs");
  });

  it("produces the documented error for a missing join dependency", () => {
    const wf: WorkflowDefinition = {
      name: "sales-join",
      version: 1,
      nodes: [
        { id: "clean_sales", type: "generator.source", config: { preset: "sales" } },
        { id: "customers", type: "generator.source", config: { preset: "customers" } },
        {
          id: "aggregate_sales",
          type: "join.transform",
          config: { left: "clean_sales", right: "customers", on: [{ left: "customer_id", right: "id" }] },
        },
      ],
      edges: [{ from: "customers", to: "aggregate_sales" }],
    };
    const result = validateWorkflow(wf);
    const issue = result.errors.find((e) => e.code === "dependency.not_upstream");
    expect(issue?.message).toContain('Node "aggregate_sales" requires input from "clean_sales"');
    expect(issue?.message).toContain("The dependency is missing.");
    expect(formatValidationResult(result)).toContain("Pipeline cannot run");
  });

  it("rejects a SQL transform referencing an unknown table", () => {
    const wf: WorkflowDefinition = {
      name: "sql-typo",
      version: 1,
      nodes: [
        { id: "src", type: "generator.source", config: { preset: "sales" } },
        { id: "t", type: "sql.transform", config: { query: "SELECT * FROM slaes" } },
      ],
      edges: [{ from: "src", to: "t" }],
    };
    expect(codes(wf)).toContain("dependency.unresolved");
  });

  it("accepts `input` as the implicit single-upstream alias", () => {
    const wf: WorkflowDefinition = {
      name: "sql-ok",
      version: 1,
      nodes: [
        { id: "src", type: "generator.source", config: { preset: "sales" } },
        { id: "t", type: "sql.transform", config: { query: "SELECT * FROM input" } },
        { id: "sink", type: "dataset.destination", config: { dataset: "o" } },
      ],
      edges: [{ from: "src", to: "t" }, { from: "t", to: "sink" }],
    };
    expect(validateWorkflow(wf).valid).toBe(true);
  });

  it("requires a quality gate to have an upstream check", () => {
    const wf: WorkflowDefinition = {
      name: "gate-alone",
      version: 1,
      nodes: [
        { id: "src", type: "generator.source", config: { preset: "sales" } },
        { id: "gate", type: "quality.gate", config: { severity: "any_failure", scope: "upstream" } },
        { id: "sink", type: "dataset.destination", config: { dataset: "o" } },
      ],
      edges: [{ from: "src", to: "gate" }, { from: "gate", to: "sink" }],
    };
    expect(codes(wf)).toContain("quality.gate_without_check");
  });

  it("rejects a missing connection when the context lists connections", () => {
    const wf: WorkflowDefinition = {
      name: "pg",
      version: 1,
      nodes: [
        { id: "src", type: "postgres.source", config: { connectionId: "conn_gone", mode: "table", table: "public.sales" } },
        { id: "sink", type: "dataset.destination", config: { dataset: "o" } },
      ],
      edges: [{ from: "src", to: "sink" }],
    };
    expect(codes(wf, { connections: { conn_ok: "postgres" } })).toContain("credential.connection_missing");
    expect(validateWorkflow(wf, { connections: { conn_gone: "postgres" } }).valid).toBe(true);
  });

  it("rejects a connection of the wrong family", () => {
    const wf: WorkflowDefinition = {
      name: "pg",
      version: 1,
      nodes: [
        { id: "src", type: "postgres.source", config: { connectionId: "c1", mode: "table", table: "t" } },
        { id: "sink", type: "dataset.destination", config: { dataset: "o" } },
      ],
      edges: [{ from: "src", to: "sink" }],
    };
    expect(codes(wf, { connections: { c1: "mysql" } })).toContain("credential.connection_missing");
  });

  it("rejects a missing secret reference", () => {
    const wf: WorkflowDefinition = {
      name: "api",
      version: 1,
      nodes: [
        { id: "src", type: "http.source", config: { url: "https://api.example.com", headers: { Authorization: { secretRef: "nope" } } } },
        { id: "sink", type: "dataset.destination", config: { dataset: "o" } },
      ],
      edges: [{ from: "src", to: "sink" }],
    };
    expect(codes(wf, { secrets: ["other"] })).toContain("credential.secret_missing");
    expect(validateWorkflow(wf, { secrets: ["nope"] }).valid).toBe(true);
  });

  it("rejects a literal password where a secret reference is required", () => {
    const wf: WorkflowDefinition = {
      name: "hook",
      version: 1,
      nodes: [
        { id: "src", type: "generator.source", config: { preset: "sales" } },
        { id: "hook", type: "webhook.notify", config: { url: "https://example.com/hook", secret: "hunter2" } },
      ],
      edges: [{ from: "src", to: "hook" }],
    };
    const result = validateWorkflow(wf);
    expect(result.errors.some((e) => /must be a secret reference/.test(e.message))).toBe(true);
  });

  it("rejects an unsupported connector family", () => {
    const wf: WorkflowDefinition = {
      name: "pg",
      version: 1,
      nodes: [
        { id: "src", type: "postgres.source", config: { connectionId: "c", mode: "table", table: "t" } },
        { id: "sink", type: "dataset.destination", config: { dataset: "o" } },
      ],
      edges: [{ from: "src", to: "sink" }],
    };
    expect(codes(wf, { enabledConnectorFamilies: ["http"] })).toContain("node.type_unsupported");
  });

  it("warns about a destructive node configured to retry without idempotency", () => {
    const wf: WorkflowDefinition = {
      name: "risky",
      version: 1,
      nodes: [
        { id: "src", type: "generator.source", config: { preset: "sales" } },
        {
          id: "write",
          type: "postgres.destination",
          config: { connectionId: "c", table: "t", writeMode: "append", idempotent: false },
          retry: { maxAttempts: 3, strategy: "exponential" },
        },
      ],
      edges: [{ from: "src", to: "write" }],
    };
    const result = validateWorkflow(wf);
    expect(result.valid).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain("node.destructive_retry");
  });

  it("warns when a pipeline has no destination", () => {
    const wf: WorkflowDefinition = {
      name: "read-only",
      version: 1,
      nodes: [
        { id: "src", type: "generator.source", config: { preset: "sales" } },
        { id: "f", type: "filter.transform", config: { predicates: [] } },
      ],
      edges: [{ from: "src", to: "f" }],
    };
    expect(validateWorkflow(wf).warnings.map((w) => w.code)).toContain("graph.no_destination");
  });

  it("errors when there is no source", () => {
    const wf: WorkflowDefinition = {
      name: "sourceless",
      version: 1,
      nodes: [
        { id: "f", type: "filter.transform", config: { predicates: [] } },
        { id: "sink", type: "dataset.destination", config: { dataset: "o" } },
      ],
      edges: [{ from: "f", to: "sink" }],
    };
    expect(codes(wf)).toContain("graph.no_source");
  });

  it("enforces node count limits", () => {
    const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, type: "generator.source", config: { preset: "sales" } }));
    const wf: WorkflowDefinition = { name: "big", version: 1, nodes, edges: [] };
    expect(codes(wf, { limits: { maxNodes: 10 } })).toContain("workflow.too_large");
  });

  it("rejects an out-of-range timeout", () => {
    const wf = base();
    wf.nodes[0]!.timeoutSeconds = 0;
    expect(codes(wf)).toContain("node.timeout_invalid");
  });

  it("rejects an invalid retry policy", () => {
    const wf = base();
    wf.nodes[0]!.retry = { maxAttempts: 0, strategy: "fixed" };
    expect(codes(wf)).toContain("node.retry_invalid");
  });

  it("rejects explicit backoff with too few delays", () => {
    const wf = base();
    wf.nodes[0]!.retry = { maxAttempts: 4, strategy: "explicit", delaysSeconds: [1] };
    expect(codes(wf)).toContain("node.retry_invalid");
  });

  it("validates every shipped template with its own placeholders resolved", () => {
    for (const template of PIPELINE_TEMPLATES) {
      const connections = Object.fromEntries(
        template.definition.nodes
          .map((n) => [n.config["connectionId"], n.type.split(".")[0]])
          .filter(([id]) => typeof id === "string") as Array<[string, string]>,
      );
      const result = validateWorkflow(template.definition, {
        connections,
        secrets: ["example-api-token"],
      });
      expect(result.errors, `${template.id}: ${JSON.stringify(result.errors, null, 2)}`).toEqual([]);
    }
  });
});

describe("extractTableNames", () => {
  it("finds FROM and JOIN targets", () => {
    expect(extractTableNames("SELECT * FROM sales s JOIN customers c ON c.id = s.customer_id").sort())
      .toEqual(["customers", "sales"]);
  });

  it("ignores comments", () => {
    expect(extractTableNames("-- FROM ghosts\nSELECT 1 FROM real /* FROM other */")).toEqual(["real"]);
  });

  it("strips quoting", () => {
    expect(extractTableNames('SELECT * FROM "input"')).toEqual(["input"]);
  });
});
