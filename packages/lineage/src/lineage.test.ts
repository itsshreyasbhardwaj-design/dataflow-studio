import { describe, expect, it } from "vitest";
import { PIPELINE_TEMPLATES, type WorkflowDefinition } from "@dataflow-studio/workflow-engine";
import { buildLineage, datasetOf, mergeGraphs, traverse } from "./build.js";
import { columnLineage, unusedColumns } from "./columns.js";

const demo = PIPELINE_TEMPLATES.find((t) => t.id === "zero-infra-demo")!.definition;

describe("datasetOf", () => {
  it("prefers an explicit dataset, then a table, then an object key", () => {
    expect(datasetOf({ id: "a", type: "t", config: { dataset: "d", table: "t1" } })).toBe("d");
    expect(datasetOf({ id: "a", type: "t", config: { table: "public.sales" } })).toBe("public.sales");
    expect(datasetOf({ id: "a", type: "t", config: { key: "exports/x.csv" } })).toBe("exports/x.csv");
    expect(datasetOf({ id: "a", type: "t", config: {} })).toBeNull();
  });
});

describe("buildLineage", () => {
  it("connects source dataset, nodes and destination dataset", () => {
    const graph = buildLineage(demo, { pipelineId: "pipe_1", pipelineName: "demo-daily-sales", pipelineVersionId: "ver_1" });
    const datasets = graph.nodes.filter((n) => n.type === "dataset").map((n) => n.id).sort();
    expect(datasets).toContain("demo_raw_sales");
    expect(datasets).toContain("demo_customer_revenue");
    expect(graph.edges.every((e) => e.pipelineId === "pipe_1")).toBe(true);
  });

  it("reports nodes whose dataset cannot be determined", () => {
    const workflow: WorkflowDefinition = {
      name: "gap",
      version: 1,
      nodes: [
        { id: "src", type: "generator.source", config: { preset: "sales" } },
        { id: "sink", type: "dataset.destination", config: { dataset: "out" } },
      ],
      edges: [{ from: "src", to: "sink" }],
    };
    const graph = buildLineage(workflow);
    expect(graph.unresolved).toHaveLength(1);
    expect(graph.unresolved[0]).toMatchObject({ nodeId: "src" });
    expect(graph.unresolved[0]!.reason).toMatch(/upstream origin is unknown/);
  });

  it("does not invent an edge between unrelated datasets", () => {
    const graph = buildLineage(demo);
    const direct = graph.edges.find((e) => e.fromType === "dataset" && e.from === "demo_raw_sales" && e.toType === "dataset");
    expect(direct).toBeUndefined();
  });

  it("deduplicates repeated edges", () => {
    const workflow: WorkflowDefinition = {
      name: "dupes",
      version: 1,
      nodes: [
        { id: "src", type: "generator.source", config: { preset: "sales", dataset: "raw" } },
        { id: "sink", type: "dataset.destination", config: { dataset: "out" } },
      ],
      edges: [{ from: "src", to: "sink" }, { from: "src", to: "sink" }],
    };
    const graph = buildLineage(workflow);
    const keys = graph.edges.map((e) => `${e.from}->${e.to}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("traverse", () => {
  const graph = buildLineage(demo, { pipelineId: "pipe_1" });

  it("finds upstream dependencies of the published dataset", () => {
    const { upstream, downstream } = traverse(graph, "demo_customer_revenue", "dataset");
    expect(upstream.map((n) => n.id)).toContain("demo_raw_sales");
    expect(upstream.map((n) => n.id)).toContain("generate_sales");
    expect(downstream.length).toBeGreaterThanOrEqual(0);
  });

  it("finds downstream consumers of the source dataset", () => {
    const { downstream } = traverse(graph, "demo_raw_sales", "dataset");
    expect(downstream.map((n) => n.id)).toContain("demo_customer_revenue");
  });

  it("returns empty sets for an unknown node", () => {
    expect(traverse(graph, "nope", "dataset")).toEqual({ upstream: [], downstream: [] });
  });

  it("does not loop on a cyclic graph", () => {
    const cyclic = {
      nodes: [
        { id: "a", type: "dataset" as const, label: "a" },
        { id: "b", type: "dataset" as const, label: "b" },
      ],
      edges: [
        { from: "a", fromType: "dataset" as const, to: "b", toType: "dataset" as const },
        { from: "b", fromType: "dataset" as const, to: "a", toType: "dataset" as const },
      ],
      unresolved: [],
    };
    expect(traverse(cyclic, "a").downstream.map((n) => n.id)).toEqual(["b"]);
  });
});

describe("mergeGraphs", () => {
  it("merges shared datasets across pipelines", () => {
    const a = buildLineage(demo, { pipelineId: "p1" });
    const b = buildLineage(
      { ...demo, name: "other", nodes: demo.nodes.map((n) => ({ ...n, id: `${n.id}_2` })), edges: demo.edges.map((e) => ({ from: `${e.from}_2`, to: `${e.to}_2` })) },
      { pipelineId: "p2" },
    );
    const merged = mergeGraphs([a, b]);
    const datasetIds = merged.nodes.filter((n) => n.type === "dataset").map((n) => n.id);
    expect(new Set(datasetIds).size).toBe(datasetIds.length);
    expect(merged.edges.length).toBeGreaterThan(a.edges.length);
  });
});

describe("columnLineage", () => {
  it("maps output columns to their sources", () => {
    expect(columnLineage([
      { name: "customer_id", sources: ["customer_id"], expression: "customer_id", isStar: false },
      { name: "revenue", sources: ["amount"], expression: "sum(amount)", isStar: false },
    ])).toEqual([
      { column: "customer_id", sources: ["customer_id"], expression: "customer_id", resolved: true },
      { column: "revenue", sources: ["amount"], expression: "sum(amount)", resolved: true },
    ]);
  });

  it("marks SELECT * as unresolved instead of guessing", () => {
    expect(columnLineage([{ name: "*", sources: [], expression: "*", isStar: true }])).toEqual([
      { column: "*", sources: [], expression: "*", resolved: false },
    ]);
  });

  it("finds unused input columns only when every mapping resolved", () => {
    const lineage = columnLineage([{ name: "a", sources: ["a"], expression: "a", isStar: false }]);
    expect(unusedColumns(lineage, ["a", "b"])).toEqual(["b"]);
    expect(unusedColumns(columnLineage([{ name: "*", sources: [], expression: "*", isStar: true }]), ["a"])).toEqual([]);
  });
});
