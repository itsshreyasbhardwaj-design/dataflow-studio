import { describe, expect, it } from "vitest";
import {
  ancestors, buildIndex, criticalPathLength, descendants, findCycles, hasCycle,
  isolatedNodes, leaves, roots, topologicalLayers, topologicalOrder, weaklyConnectedComponents,
} from "./dag.js";
import type { WorkflowDefinition, WorkflowEdge } from "./types.js";

function wf(nodeIds: string[], edges: Array<[string, string, string?]>): WorkflowDefinition {
  return {
    name: "t",
    version: 1,
    nodes: nodeIds.map((id) => ({ id, type: "inline.source", config: {} })),
    edges: edges.map(([from, to, port]) => ({ from, to, ...(port ? { port } : {}) }) as WorkflowEdge),
  };
}

describe("buildIndex", () => {
  it("builds upstream and downstream adjacency", () => {
    const index = buildIndex(wf(["a", "b", "c"], [["a", "b"], ["b", "c"]]));
    expect(index.downstream.get("a")).toEqual(["b"]);
    expect(index.upstream.get("c")).toEqual(["b"]);
    expect(index.upstream.get("a")).toEqual([]);
  });

  it("deduplicates identical edges", () => {
    const index = buildIndex(wf(["a", "b"], [["a", "b"], ["a", "b"]]));
    expect(index.edges).toHaveLength(1);
    expect(index.downstream.get("a")).toEqual(["b"]);
  });

  it("keeps parallel edges that differ by port", () => {
    const index = buildIndex(wf(["a", "b"], [["a", "b", "true"], ["a", "b", "false"]]));
    expect(index.edges).toHaveLength(2);
  });

  it("ignores edges pointing at unknown nodes", () => {
    const index = buildIndex(wf(["a"], [["a", "ghost"]]));
    expect(index.upstream.has("ghost")).toBe(false);
    expect(index.downstream.get("a")).toEqual(["ghost"]);
  });
});

describe("findCycles", () => {
  it("returns no cycles for a DAG", () => {
    expect(findCycles(buildIndex(wf(["a", "b", "c"], [["a", "b"], ["a", "c"], ["b", "c"]])))).toEqual([]);
  });

  it("detects a two-node cycle", () => {
    const cycles = findCycles(buildIndex(wf(["a", "b"], [["a", "b"], ["b", "a"]])));
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toHaveLength(2);
  });

  it("detects a long cycle", () => {
    const cycles = findCycles(buildIndex(wf(["a", "b", "c", "d"], [["a", "b"], ["b", "c"], ["c", "d"], ["d", "b"]])));
    expect(cycles).toHaveLength(1);
    expect(new Set(cycles[0])).toEqual(new Set(["b", "c", "d"]));
  });

  it("detects a self loop", () => {
    expect(hasCycle(buildIndex(wf(["a"], [["a", "a"]])))).toBe(true);
  });

  it("reports each distinct cycle once", () => {
    const cycles = findCycles(buildIndex(wf(
      ["a", "b", "c", "d"],
      [["a", "b"], ["b", "a"], ["c", "d"], ["d", "c"]],
    )));
    expect(cycles).toHaveLength(2);
  });

  it("does not stack overflow on a deep chain", () => {
    const ids = Array.from({ length: 20_000 }, (_, i) => `n${i}`);
    const edges: Array<[string, string]> = ids.slice(0, -1).map((id, i) => [id, ids[i + 1]!]);
    expect(hasCycle(buildIndex(wf(ids, edges)))).toBe(false);
  });
});

describe("topologicalLayers", () => {
  it("groups independent nodes into the same layer", () => {
    const layers = topologicalLayers(buildIndex(wf(
      ["extract", "clean", "enrich", "load"],
      [["extract", "clean"], ["extract", "enrich"], ["clean", "load"], ["enrich", "load"]],
    )));
    expect(layers).toEqual([["extract"], ["clean", "enrich"], ["load"]]);
  });

  it("throws on a cyclic graph", () => {
    expect(() => topologicalLayers(buildIndex(wf(["a", "b"], [["a", "b"], ["b", "a"]]))))
      .toThrow(/cycle/i);
  });

  it("orders a diamond correctly", () => {
    const order = topologicalOrder(buildIndex(wf(["a", "b", "c", "d"], [["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"]])));
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("d"));
  });
});

describe("graph shape helpers", () => {
  const index = buildIndex(wf(["a", "b", "c", "d", "lonely"], [["a", "b"], ["b", "c"], ["a", "d"]]));

  it("finds roots and leaves", () => {
    expect(roots(index)).toEqual(["a", "lonely"]);
    expect(leaves(index)).toEqual(["c", "d", "lonely"]);
  });

  it("walks descendants and ancestors transitively", () => {
    expect(descendants(index, "a")).toEqual(new Set(["b", "c", "d"]));
    expect(ancestors(index, "c")).toEqual(new Set(["a", "b"]));
    expect(descendants(index, "c").size).toBe(0);
  });

  it("finds isolated nodes", () => {
    expect(isolatedNodes(index)).toEqual(["lonely"]);
    expect(isolatedNodes(buildIndex(wf(["only"], [])))).toEqual([]);
  });

  it("splits weakly connected components", () => {
    const components = weaklyConnectedComponents(index);
    expect(components).toHaveLength(2);
    expect(components.map((c) => c.length).sort()).toEqual([1, 4]);
  });

  it("measures the critical path", () => {
    expect(criticalPathLength(index)).toBe(3);
  });
});
