import { createHash } from "node:crypto";
import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from "./types.js";

/**
 * Canonical form. Two workflows that execute identically must produce identical
 * bytes here, so that a "publish" that only moved nodes around on the canvas can
 * be recognised as a no-op.
 */
export function canonicalize(workflow: WorkflowDefinition): string {
  const nodes = [...workflow.nodes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((node) => canonicalNode(node));
  const edges = [...workflow.edges]
    .map((e) => ({ from: e.from, to: e.to, port: e.port ?? "default" }))
    .sort((a, b) => `${a.from}|${a.to}|${a.port}`.localeCompare(`${b.from}|${b.to}|${b.port}`));

  return stableStringify({
    name: workflow.name,
    description: workflow.description ?? "",
    nodes,
    edges,
    params: workflow.params ?? {},
    defaults: workflow.defaults ?? {},
  });
}

function canonicalNode(node: WorkflowNode): Record<string, unknown> {
  return {
    id: node.id,
    type: node.type,
    config: node.config ?? {},
    retry: node.retry ?? null,
    timeoutSeconds: node.timeoutSeconds ?? null,
    continueOnFailure: node.continueOnFailure ?? false,
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export { stableStringify };

/** Content hash of the executable definition, ignoring canvas positions. */
export function definitionHash(workflow: WorkflowDefinition): string {
  return createHash("sha256").update(canonicalize(workflow)).digest("hex").slice(0, 32);
}

export class WorkflowParseError extends Error {
  /** Lets the API map a hostile definition to 422 rather than 500. */
  readonly errorClass = "validation";

  constructor(message: string, readonly path?: string) {
    super(message);
    this.name = "WorkflowParseError";
  }
}

const MAX_DEFINITION_BYTES = 4 * 1024 * 1024;

/**
 * Parses untrusted JSON into a WorkflowDefinition. This is a hostile-input
 * boundary: the CLI, the API and CI all hand us files we did not write.
 */
export function parseWorkflow(input: string | unknown): WorkflowDefinition {
  let raw: unknown = input;
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > MAX_DEFINITION_BYTES) {
      throw new WorkflowParseError(
        `Workflow definition exceeds ${MAX_DEFINITION_BYTES} bytes`,
      );
    }
    try {
      raw = JSON.parse(input);
    } catch (error) {
      throw new WorkflowParseError(`Workflow is not valid JSON: ${(error as Error).message}`);
    }
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorkflowParseError("Workflow must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj["name"] !== "string") throw new WorkflowParseError("`name` must be a string", "name");
  if (obj["version"] !== undefined && typeof obj["version"] !== "number") {
    throw new WorkflowParseError("`version` must be a number", "version");
  }
  if (!Array.isArray(obj["nodes"])) throw new WorkflowParseError("`nodes` must be an array", "nodes");
  if (obj["edges"] !== undefined && !Array.isArray(obj["edges"])) {
    throw new WorkflowParseError("`edges` must be an array", "edges");
  }

  const nodes: WorkflowNode[] = (obj["nodes"] as unknown[]).map((entry, i) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new WorkflowParseError(`nodes[${i}] must be an object`, `nodes[${i}]`);
    }
    const n = entry as Record<string, unknown>;
    if (typeof n["id"] !== "string") throw new WorkflowParseError(`nodes[${i}].id must be a string`, `nodes[${i}].id`);
    if (typeof n["type"] !== "string") throw new WorkflowParseError(`nodes[${i}].type must be a string`, `nodes[${i}].type`);
    if (n["config"] !== undefined && (typeof n["config"] !== "object" || n["config"] === null || Array.isArray(n["config"]))) {
      throw new WorkflowParseError(`nodes[${i}].config must be an object`, `nodes[${i}].config`);
    }
    return {
      id: n["id"] as string,
      type: n["type"] as string,
      config: (n["config"] ?? {}) as WorkflowNode["config"],
      ...(n["retry"] !== undefined ? { retry: n["retry"] as WorkflowNode["retry"] } : {}),
      ...(n["timeoutSeconds"] !== undefined ? { timeoutSeconds: Number(n["timeoutSeconds"]) } : {}),
      ...(n["continueOnFailure"] !== undefined ? { continueOnFailure: Boolean(n["continueOnFailure"]) } : {}),
      ...(n["metadata"] !== undefined ? { metadata: n["metadata"] as WorkflowNode["metadata"] } : {}),
    };
  });

  const edges: WorkflowEdge[] = ((obj["edges"] ?? []) as unknown[]).map((entry, i) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new WorkflowParseError(`edges[${i}] must be an object`, `edges[${i}]`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e["from"] !== "string" || typeof e["to"] !== "string") {
      throw new WorkflowParseError(`edges[${i}] requires string \`from\` and \`to\``, `edges[${i}]`);
    }
    return {
      from: e["from"],
      to: e["to"],
      ...(typeof e["port"] === "string" ? { port: e["port"] } : {}),
    };
  });

  return {
    name: obj["name"] as string,
    version: (obj["version"] as number) ?? 1,
    ...(typeof obj["description"] === "string" ? { description: obj["description"] } : {}),
    nodes,
    edges,
    ...(obj["params"] ? { params: obj["params"] as WorkflowDefinition["params"] } : {}),
    ...(obj["defaults"] ? { defaults: obj["defaults"] as WorkflowDefinition["defaults"] } : {}),
    ...(obj["metadata"] ? { metadata: obj["metadata"] as WorkflowDefinition["metadata"] } : {}),
  };
}

export function serializeWorkflow(workflow: WorkflowDefinition): string {
  return JSON.stringify(workflow, null, 2) + "\n";
}
