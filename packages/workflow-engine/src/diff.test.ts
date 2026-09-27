import { describe, expect, it } from "vitest";
import { diffConfig, diffWorkflows } from "./diff.js";
import { canonicalize, definitionHash, parseWorkflow, WorkflowParseError } from "./serialize.js";
import type { WorkflowDefinition } from "./types.js";

const v1: WorkflowDefinition = {
  name: "daily-sales",
  version: 1,
  nodes: [
    { id: "extract", type: "generator.source", config: { preset: "sales", rowCount: 100 }, metadata: { position: { x: 0, y: 0 } } },
    { id: "load", type: "dataset.destination", config: { dataset: "out", writeMode: "replace" } },
  ],
  edges: [{ from: "extract", to: "load" }],
};

describe("diffWorkflows", () => {
  it("reports no semantic change for an identical definition", () => {
    const diff = diffWorkflows(v1, structuredClone(v1));
    expect(diff.semanticallyEqual).toBe(true);
    expect(diff.summary).toEqual(["No semantic changes"]);
  });

  it("treats a canvas move as non-semantic", () => {
    const moved = structuredClone(v1);
    moved.nodes[0]!.metadata = { position: { x: 400, y: 120 } };
    const diff = diffWorkflows(v1, moved);
    expect(diff.semanticallyEqual).toBe(true);
    expect(diff.changedNodes[0]?.positionOnly).toBe(true);
  });

  it("summarises added nodes, edges and config changes", () => {
    const v2 = structuredClone(v1);
    v2.version = 2;
    v2.nodes[0]!.config["rowCount"] = 500;
    v2.nodes.push({ id: "quality", type: "quality.check", config: { checks: [] } });
    v2.nodes.push({ id: "gate", type: "quality.gate", config: { severity: "any_failure" } });
    v2.edges = [
      { from: "extract", to: "quality" },
      { from: "quality", to: "gate" },
      { from: "gate", to: "load" },
    ];
    const diff = diffWorkflows(v1, v2);
    expect(diff.semanticallyEqual).toBe(false);
    expect(diff.addedNodes.map((n) => n.id)).toEqual(["quality", "gate"]);
    expect(diff.addedEdges).toHaveLength(3);
    expect(diff.removedEdges).toHaveLength(1);
    expect(diff.summary).toContain("+ 2 nodes");
    expect(diff.summary).toContain("~ 1 configuration changed");
    expect(diff.summary).toContain("+ quality check (quality)");
    expect(diff.summary).toContain("+ quality gate (gate)");
  });

  it("reports removals", () => {
    const v2 = structuredClone(v1);
    v2.nodes = [v2.nodes[0]!];
    v2.edges = [];
    const diff = diffWorkflows(v1, v2);
    expect(diff.removedNodes.map((n) => n.id)).toEqual(["load"]);
    expect(diff.summary).toContain("- 1 node");
  });

  it("detects a node type change", () => {
    const v2 = structuredClone(v1);
    v2.nodes[1] = { id: "load", type: "s3.destination", config: { connectionId: "c", key: "k" } };
    const change = diffWorkflows(v1, v2).changedNodes[0]!;
    expect(change.previousType).toBe("dataset.destination");
  });

  it("detects a retry policy change", () => {
    const v2 = structuredClone(v1);
    v2.nodes[0]!.retry = { maxAttempts: 5, strategy: "fixed" };
    const diff = diffWorkflows(v1, v2);
    expect(diff.changedNodes[0]?.retryChanged).toBe(true);
    expect(diff.summary.join("\n")).toContain("retry policy on extract");
  });
});

describe("diffConfig", () => {
  it("produces a path per changed leaf", () => {
    expect(diffConfig({ a: 1, b: { c: "x" } }, { a: 2, b: { c: "x" } })).toEqual([
      { path: "a", before: 1, after: 2 },
    ]);
  });

  it("descends into arrays", () => {
    const changes = diffConfig({ keyColumns: ["id"] }, { keyColumns: ["id", "region"] });
    expect(changes.map((c) => c.path)).toEqual(["keyColumns[1]"]);
  });

  it("reports added and removed keys", () => {
    const changes = diffConfig({ a: 1 }, { b: 2 });
    expect(changes).toEqual([
      { path: "a", before: 1, after: undefined },
      { path: "b", before: undefined, after: 2 },
    ]);
  });
});

describe("canonicalize / definitionHash", () => {
  it("is stable under node reordering and key ordering", () => {
    const reordered: WorkflowDefinition = {
      ...v1,
      nodes: [...v1.nodes].reverse().map((n) => ({ type: n.type, config: n.config, id: n.id })),
    };
    expect(canonicalize(reordered)).toBe(canonicalize(v1));
    expect(definitionHash(reordered)).toBe(definitionHash(v1));
  });

  it("ignores canvas positions", () => {
    const moved = structuredClone(v1);
    moved.nodes[0]!.metadata = { position: { x: 999, y: 999 } };
    expect(definitionHash(moved)).toBe(definitionHash(v1));
  });

  it("changes when configuration changes", () => {
    const changed = structuredClone(v1);
    changed.nodes[0]!.config["rowCount"] = 101;
    expect(definitionHash(changed)).not.toBe(definitionHash(v1));
  });

  it("ignores the version number", () => {
    expect(definitionHash({ ...v1, version: 9 })).toBe(definitionHash(v1));
  });
});

describe("parseWorkflow", () => {
  it("parses a valid definition", () => {
    const parsed = parseWorkflow(JSON.stringify(v1));
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.edges[0]).toEqual({ from: "extract", to: "load" });
  });

  it("defaults the version to 1", () => {
    expect(parseWorkflow('{"name":"x","nodes":[]}').version).toBe(1);
  });

  it("rejects malformed JSON", () => {
    expect(() => parseWorkflow("{nope")).toThrow(WorkflowParseError);
  });

  it("rejects a non-object root", () => {
    expect(() => parseWorkflow("[]")).toThrow(/must be a JSON object/);
  });

  it("rejects missing or mistyped fields with a path", () => {
    expect(() => parseWorkflow('{"nodes":[]}')).toThrow(/`name` must be a string/);
    expect(() => parseWorkflow('{"name":"x","nodes":{}}')).toThrow(/`nodes` must be an array/);
    expect(() => parseWorkflow('{"name":"x","nodes":[{"type":"a"}]}')).toThrow(/nodes\[0\]\.id/);
    expect(() => parseWorkflow('{"name":"x","nodes":[{"id":"a","type":"t","config":[]}]}')).toThrow(/config must be an object/);
    expect(() => parseWorkflow('{"name":"x","nodes":[],"edges":[{"from":"a"}]}')).toThrow(/requires string/);
  });

  it("rejects an oversized definition", () => {
    const huge = JSON.stringify({ name: "x", nodes: [], pad: "a".repeat(5 * 1024 * 1024) });
    expect(() => parseWorkflow(huge)).toThrow(/exceeds/);
  });

  it("drops unknown top-level keys rather than trusting them", () => {
    const parsed = parseWorkflow('{"name":"x","nodes":[],"__proto__evil":1,"organizationId":"other-org"}') as Record<string, unknown>;
    expect(parsed["organizationId"]).toBeUndefined();
  });
});
