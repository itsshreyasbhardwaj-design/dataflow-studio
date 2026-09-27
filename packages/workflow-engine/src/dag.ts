import type { WorkflowDefinition, WorkflowEdge } from "./types.js";

export interface AdjacencyIndex {
  readonly nodeIds: string[];
  /** node -> direct successors */
  readonly downstream: Map<string, string[]>;
  /** node -> direct predecessors */
  readonly upstream: Map<string, string[]>;
  readonly edges: WorkflowEdge[];
}

export function buildIndex(workflow: WorkflowDefinition): AdjacencyIndex {
  const nodeIds = workflow.nodes.map((n) => n.id);
  const downstream = new Map<string, string[]>();
  const upstream = new Map<string, string[]>();
  for (const id of nodeIds) {
    downstream.set(id, []);
    upstream.set(id, []);
  }
  const edges: WorkflowEdge[] = [];
  const seen = new Set<string>();
  for (const edge of workflow.edges) {
    const key = `${edge.from}->${edge.to}:${edge.port ?? "default"}`;
    if (seen.has(key)) continue; // duplicate edges are a no-op, not an error
    seen.add(key);
    edges.push(edge);
    if (downstream.has(edge.from)) downstream.get(edge.from)!.push(edge.to);
    if (upstream.has(edge.to)) upstream.get(edge.to)!.push(edge.from);
  }
  return { nodeIds, downstream, upstream, edges };
}

/**
 * Returns every simple cycle in the graph, using an iterative DFS so that a
 * pathological 10k-node pipeline cannot blow the stack.
 */
export function findCycles(index: AdjacencyIndex): string[][] {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>(index.nodeIds.map((id) => [id, WHITE]));
  const cycles: string[][] = [];
  const fingerprints = new Set<string>();

  for (const root of index.nodeIds) {
    if (color.get(root) !== WHITE) continue;
    const path: string[] = [];
    const stack: Array<{ node: string; childIndex: number }> = [{ node: root, childIndex: 0 }];
    color.set(root, GREY);
    path.push(root);

    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const children = index.downstream.get(frame.node) ?? [];
      if (frame.childIndex >= children.length) {
        color.set(frame.node, BLACK);
        stack.pop();
        path.pop();
        continue;
      }
      const child = children[frame.childIndex++]!;
      const state = color.get(child) ?? WHITE;
      if (state === GREY) {
        const start = path.indexOf(child);
        if (start >= 0) {
          const cycle = path.slice(start);
          const fp = canonicalCycle(cycle);
          if (!fingerprints.has(fp)) {
            fingerprints.add(fp);
            cycles.push(cycle);
          }
        }
      } else if (state === WHITE) {
        color.set(child, GREY);
        path.push(child);
        stack.push({ node: child, childIndex: 0 });
      }
    }
  }
  return cycles;
}

function canonicalCycle(cycle: string[]): string {
  let min = 0;
  for (let i = 1; i < cycle.length; i++) if (cycle[i]! < cycle[min]!) min = i;
  return [...cycle.slice(min), ...cycle.slice(0, min)].join("->");
}

export function hasCycle(index: AdjacencyIndex): boolean {
  return findCycles(index).length > 0;
}

/**
 * Kahn's algorithm, grouped into layers. Layer N contains every node whose
 * dependencies are all in layers < N, which is exactly the set the executor can
 * dispatch in parallel.
 */
export function topologicalLayers(index: AdjacencyIndex): string[][] {
  const indegree = new Map<string, number>();
  for (const id of index.nodeIds) indegree.set(id, (index.upstream.get(id) ?? []).length);

  const layers: string[][] = [];
  let frontier = index.nodeIds.filter((id) => indegree.get(id) === 0).sort();
  let visited = 0;

  while (frontier.length) {
    layers.push(frontier);
    visited += frontier.length;
    const next: string[] = [];
    for (const node of frontier) {
      for (const child of index.downstream.get(node) ?? []) {
        const remaining = (indegree.get(child) ?? 0) - 1;
        indegree.set(child, remaining);
        if (remaining === 0) next.push(child);
      }
    }
    frontier = next.sort();
  }

  if (visited !== index.nodeIds.length) {
    throw new Error("Cannot compute topological layers: graph contains a cycle");
  }
  return layers;
}

export function topologicalOrder(index: AdjacencyIndex): string[] {
  return topologicalLayers(index).flat();
}

export function roots(index: AdjacencyIndex): string[] {
  return index.nodeIds.filter((id) => (index.upstream.get(id) ?? []).length === 0);
}

export function leaves(index: AdjacencyIndex): string[] {
  return index.nodeIds.filter((id) => (index.downstream.get(id) ?? []).length === 0);
}

function traverse(index: AdjacencyIndex, start: string, direction: "downstream" | "upstream"): Set<string> {
  const out = new Set<string>();
  const stack = [...(index[direction].get(start) ?? [])];
  while (stack.length) {
    const node = stack.pop()!;
    if (out.has(node)) continue;
    out.add(node);
    for (const next of index[direction].get(node) ?? []) if (!out.has(next)) stack.push(next);
  }
  return out;
}

export function descendants(index: AdjacencyIndex, node: string): Set<string> {
  return traverse(index, node, "downstream");
}

export function ancestors(index: AdjacencyIndex, node: string): Set<string> {
  return traverse(index, node, "upstream");
}

/** Nodes that are neither reachable from a root nor reach a leaf through edges. */
export function isolatedNodes(index: AdjacencyIndex): string[] {
  if (index.nodeIds.length <= 1) return [];
  return index.nodeIds.filter(
    (id) => (index.upstream.get(id) ?? []).length === 0 && (index.downstream.get(id) ?? []).length === 0,
  );
}

/** Weakly-connected components: a pipeline with more than one is usually a mistake. */
export function weaklyConnectedComponents(index: AdjacencyIndex): string[][] {
  const seen = new Set<string>();
  const components: string[][] = [];
  for (const start of index.nodeIds) {
    if (seen.has(start)) continue;
    const component: string[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const node = stack.pop()!;
      component.push(node);
      for (const n of [...(index.downstream.get(node) ?? []), ...(index.upstream.get(node) ?? [])]) {
        if (!seen.has(n)) { seen.add(n); stack.push(n); }
      }
    }
    components.push(component.sort());
  }
  return components;
}

/** Longest path length in nodes. Useful for surfacing absurdly deep pipelines. */
export function criticalPathLength(index: AdjacencyIndex): number {
  const order = topologicalOrder(index);
  const depth = new Map<string, number>(index.nodeIds.map((id) => [id, 1]));
  for (const node of order) {
    for (const child of index.downstream.get(node) ?? []) {
      depth.set(child, Math.max(depth.get(child) ?? 1, (depth.get(node) ?? 1) + 1));
    }
  }
  return Math.max(0, ...depth.values());
}
