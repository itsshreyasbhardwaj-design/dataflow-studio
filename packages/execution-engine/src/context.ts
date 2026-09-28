import type { Store, TaskRun, WorkflowRun } from "@dataflow-studio/database";
import type { ConnectorRegistry } from "@dataflow-studio/connectors";
import type { QualityResult } from "@dataflow-studio/data-quality";
import type { Logger } from "@dataflow-studio/observability";
import type { DataBatch } from "@dataflow-studio/schema-registry";
import type { SchemaRegistry } from "@dataflow-studio/schema-registry";
import type { JsonObject, NodeConfig, WorkflowDefinition, WorkflowNode } from "@dataflow-studio/workflow-engine";
import type { PythonSandbox } from "./sandbox.js";

export interface TaskContext {
  organizationId: string;
  run: WorkflowRun;
  task: TaskRun;
  node: WorkflowNode;
  definition: WorkflowDefinition;
  /** Upstream batches keyed by node id. */
  inputs: Record<string, DataBatch>;
  /** Node configuration with defaults applied and secret references resolved. */
  config: NodeConfig;
  connectors: ConnectorRegistry;
  schemaRegistry: SchemaRegistry;
  sandbox: PythonSandbox;
  store: Store;
  logger: Logger;
  /** Appends a structured log line to the task log. */
  log(level: "debug" | "info" | "warn" | "error", message: string, fields?: JsonObject): void;
  signal: AbortSignal;
  now: Date;
}

export interface TaskResult {
  /** Data handed to downstream nodes. Absent for side-effect-only nodes. */
  batch?: DataBatch;
  /** Metadata recorded on the task row: row counts, targets, timings. */
  output: JsonObject;
  /** Set by a quality gate to mark downstream tasks BLOCKED. */
  blockDownstream?: { reason: string; failedChecks: string[] };
  /** Set by a condition node: the port whose branch continues. */
  selectedPort?: string;
  /** Quality results to persist against the run. */
  qualityResults?: QualityResult[];
  /** Dataset this task materialised, for lineage and the catalog. */
  dataset?: string;
}

export interface TaskExecutor {
  (context: TaskContext): Promise<TaskResult>;
}

export class TaskFailure extends Error {
  constructor(
    message: string,
    readonly errorClass:
      | "timeout" | "connection" | "rate_limit" | "transient" | "configuration"
      | "validation" | "permission" | "not_found" | "data_quality" | "cancelled" | "unknown" = "unknown",
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "TaskFailure";
  }
}
