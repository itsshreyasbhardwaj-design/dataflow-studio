export type LineageNodeType = "dataset" | "node";

export interface LineageNode {
  id: string;
  type: LineageNodeType;
  label: string;
  /** For pipeline nodes: the node type. For datasets: the producing node type. */
  nodeType?: string;
  pipelineId?: string;
  pipelineName?: string;
}

export interface LineageEdge {
  from: string;
  fromType: LineageNodeType;
  to: string;
  toType: LineageNodeType;
  /** Pipeline node responsible for the edge. */
  nodeId?: string;
  transformation?: string;
  pipelineId?: string;
  pipelineVersionId?: string;
}

export interface LineageGraph {
  nodes: LineageNode[];
  edges: LineageEdge[];
  /**
   * Nodes whose input or output dataset could not be determined. Surfaced in the
   * UI so a gap in lineage is visible rather than silently implied to be absent.
   */
  unresolved: Array<{ nodeId: string; nodeType: string; reason: string }>;
}

export interface ColumnLineage {
  /** Output column of the transformation. */
  column: string;
  /** Input columns it is derived from, when derivable from the expression. */
  sources: string[];
  expression: string;
  /** False when the mapping could not be derived (e.g. `SELECT *`). */
  resolved: boolean;
}
