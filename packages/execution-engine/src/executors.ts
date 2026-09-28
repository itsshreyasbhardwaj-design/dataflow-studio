import {
  parseChecks, runChecks, summarize, evaluateGate, type QualityResult,
} from "@dataflow-studio/data-quality";
import { diffSchemas, inferSchema, makeBatch, profileRows, type DataBatch } from "@dataflow-studio/schema-registry";
import {
  applyAggregate, applyFilter, applyJoin, parseJoinKeys, parseMeasures, parsePredicates, runQuery,
} from "@dataflow-studio/transformations";
import { getNodeType } from "@dataflow-studio/workflow-engine";
import { TaskFailure, type TaskContext, type TaskExecutor, type TaskResult } from "./context.js";

const EMPTY = makeBatch([], []);

function singleInput(context: TaskContext): DataBatch {
  const entries = Object.entries(context.inputs);
  if (entries.length === 0) {
    throw new TaskFailure(`Node "${context.node.id}" has no input data`, "configuration");
  }
  if (entries.length > 1) {
    throw new TaskFailure(
      `Node "${context.node.id}" received ${entries.length} inputs but accepts one; use a join node to combine them`,
      "configuration",
    );
  }
  return entries[0]![1];
}

function limitFor(context: TaskContext): number {
  const limit = context.config["limit"];
  return typeof limit === "number" ? limit : 100_000;
}

/** Substitutes `{{ run.* }}` and `{{ params.* }}` in string config values. */
export function renderTemplates(value: string, context: TaskContext): string {
  return value.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (match, path: string) => {
    const [root, ...rest] = path.split(".");
    if (root === "run") {
      const field = rest.join(".");
      if (field === "id") return context.run.id;
      if (field === "date") return (context.run.logicalDate ?? context.run.queuedAt).slice(0, 10);
      if (field === "logicalDate") return context.run.logicalDate ?? context.run.queuedAt;
      if (field === "pipeline") return context.run.pipelineName;
      if (field === "version") return String(context.run.version);
      return match;
    }
    if (root === "params") {
      const params = (context.run.params ?? {}) as Record<string, unknown>;
      const value = rest.reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), params);
      return value === undefined || value === null ? match : String(value);
    }
    return match;
  });
}

function renderConfig(context: TaskContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context.config)) {
    out[key] = typeof value === "string" ? renderTemplates(value, context) : value;
  }
  return out;
}

// -------------------------------------------------------------------- sources

const readSource: TaskExecutor = async (context): Promise<TaskResult> => {
  const connector = context.connectors.forNodeType(context.node.type);
  const config = renderConfig(context);
  const limit = limitFor(context);

  context.log("info", `Reading from ${context.node.type}`, { limit });
  const batch = await connector.read({
    config: config as never,
    limit,
    signal: context.signal,
  });
  if (batch.truncated) {
    context.log("warn", `Read was truncated at the ${limit} row limit; downstream results are partial`);
  }
  context.log("info", `Retrieved ${batch.rowCount.toLocaleString("en-US")} records`, {
    columns: batch.columns.length,
  });

  const dataset = typeof config["dataset"] === "string" ? config["dataset"] : batch.dataset;
  return {
    batch,
    output: { rowsRead: batch.rowCount, columns: batch.columns.length, truncated: batch.truncated ?? false },
    ...(dataset ? { dataset } : {}),
  };
};

// ----------------------------------------------------------------- transforms

const sqlTransform: TaskExecutor = async (context): Promise<TaskResult> => {
  const query = String(context.config["query"] ?? "");
  const aliases = (context.config["aliases"] ?? {}) as Record<string, string>;
  const inputs: Record<string, DataBatch> = { ...context.inputs };

  // `input` is the implicit alias for a single upstream node.
  const upstream = Object.keys(context.inputs);
  if (upstream.length === 1) inputs["input"] = context.inputs[upstream[0]!]!;
  for (const [alias, nodeId] of Object.entries(aliases)) {
    const batch = context.inputs[nodeId];
    if (!batch) {
      throw new TaskFailure(`Alias "${alias}" points at "${nodeId}", which produced no data`, "configuration");
    }
    inputs[alias] = batch;
  }

  context.log("info", "Starting SQL transformation", { inputs: Object.keys(context.inputs) });
  let batch: DataBatch;
  try {
    batch = runQuery(query, inputs, { now: context.now, maxOutputRows: 1_000_000 });
  } catch (error) {
    throw new TaskFailure(`SQL transformation failed: ${(error as Error).message}`, classify(error), { cause: error });
  }
  context.log("info", `Transformation completed with ${batch.rowCount.toLocaleString("en-US")} rows`);

  const dataset = typeof context.config["dataset"] === "string" ? context.config["dataset"] : undefined;
  return {
    batch,
    output: { rowsIn: sumRows(context.inputs), rowsOut: batch.rowCount, columns: batch.columns.length },
    ...(dataset ? { dataset } : {}),
  };
};

const filterTransform: TaskExecutor = async (context): Promise<TaskResult> => {
  const input = singleInput(context);
  const predicates = parsePredicates(context.config["predicates"] ?? []);
  const combine = context.config["combine"] === "or" ? "or" : "and";
  const batch = applyFilter(input, { predicates, combine });
  const removed = input.rowCount - batch.rowCount;

  if (removed > 0) context.log("warn", `Filtered out ${removed.toLocaleString("en-US")} of ${input.rowCount.toLocaleString("en-US")} rows`);
  else context.log("info", `All ${input.rowCount.toLocaleString("en-US")} rows passed the filter`);

  if (batch.rowCount === 0 && context.config["onEmpty"] === "fail") {
    throw new TaskFailure("Filter removed every row and is configured to fail when empty", "validation");
  }
  const dataset = typeof context.config["dataset"] === "string" ? context.config["dataset"] : undefined;
  return { batch, output: { rowsIn: input.rowCount, rowsOut: batch.rowCount, rowsRemoved: removed }, ...(dataset ? { dataset } : {}) };
};

const aggregateTransform: TaskExecutor = async (context): Promise<TaskResult> => {
  const input = singleInput(context);
  const groupBy = Array.isArray(context.config["groupBy"]) ? (context.config["groupBy"] as string[]) : [];
  const measures = parseMeasures(context.config["measures"]);
  const batch = applyAggregate(input, { groupBy, measures });
  context.log("info", `Aggregated ${input.rowCount.toLocaleString("en-US")} rows into ${batch.rowCount.toLocaleString("en-US")} groups`);
  const dataset = typeof context.config["dataset"] === "string" ? context.config["dataset"] : undefined;
  return { batch, output: { rowsIn: input.rowCount, groups: batch.rowCount }, ...(dataset ? { dataset } : {}) };
};

const joinTransform: TaskExecutor = async (context): Promise<TaskResult> => {
  const leftId = String(context.config["left"] ?? "");
  const rightId = String(context.config["right"] ?? "");
  const left = context.inputs[leftId];
  const right = context.inputs[rightId];
  if (!left) throw new TaskFailure(`Join input "${leftId}" produced no data`, "configuration");
  if (!right) throw new TaskFailure(`Join input "${rightId}" produced no data`, "configuration");

  const batch = applyJoin(left, right, {
    on: parseJoinKeys(context.config["on"]),
    type: (context.config["type"] as "inner" | "left" | "right" | "full" | undefined) ?? "inner",
    rightPrefix: String(context.config["rightPrefix"] ?? ""),
  });
  context.log("info", `Joined ${left.rowCount.toLocaleString("en-US")} x ${right.rowCount.toLocaleString("en-US")} rows into ${batch.rowCount.toLocaleString("en-US")}`);
  const dataset = typeof context.config["dataset"] === "string" ? context.config["dataset"] : undefined;
  return { batch, output: { leftRows: left.rowCount, rightRows: right.rowCount, rowsOut: batch.rowCount }, ...(dataset ? { dataset } : {}) };
};

const pythonTransform: TaskExecutor = async (context): Promise<TaskResult> => {
  const input = Object.values(context.inputs)[0] ?? EMPTY;
  if (!context.sandbox.available) {
    // Surfaced as a configuration failure, never as a silent pass-through.
    await context.sandbox.run({
      code: "", entrypoint: "transform", rows: [], timeoutSeconds: 1, memoryLimitMb: 64, networkAccess: false,
    });
  }
  context.log("info", `Running Python in the ${context.sandbox.name} sandbox`, { rows: input.rowCount });
  const result = await context.sandbox.run({
    code: String(context.config["code"] ?? ""),
    entrypoint: String(context.config["entrypoint"] ?? "transform"),
    rows: input.rows,
    timeoutSeconds: Number(context.config["timeoutSeconds"] ?? 60),
    memoryLimitMb: Number(context.config["memoryLimitMb"] ?? 512),
    networkAccess: context.config["networkAccess"] === true,
  });
  for (const line of result.stdout.split("\n").filter(Boolean).slice(0, 200)) {
    context.log("info", `python: ${line}`);
  }
  if (result.stderr.trim()) context.log("warn", `python stderr: ${result.stderr.trim().slice(0, 2000)}`);

  const batch = makeBatch(result.rows, inferSchema(result.rows));
  const dataset = typeof context.config["dataset"] === "string" ? context.config["dataset"] : undefined;
  return {
    batch,
    output: { rowsIn: input.rowCount, rowsOut: batch.rowCount, sandbox: context.sandbox.name, durationMs: result.durationMs },
    ...(dataset ? { dataset } : {}),
  };
};

// --------------------------------------------------------- schema and quality

const validateSchema: TaskExecutor = async (context): Promise<TaskResult> => {
  const input = singleInput(context);
  const dataset = String(context.config["dataset"] ?? "");
  const observed = inferSchema(input.rows);
  const declared = Array.isArray(context.config["expected"]) ? (context.config["expected"] as never[]) : [];

  const registered = declared.length
    ? { columns: declared as never, version: 0 }
    : await context.schemaRegistry.latest(context.organizationId, dataset);

  if (!registered) {
    context.log("info", `No registered schema for "${dataset}"; recording the observed schema as version 1`);
    if (context.config["register"] !== false) {
      await context.schemaRegistry.register(context.organizationId, dataset, observed, { runId: context.run.id, now: context.now });
    }
    return { batch: input, output: { dataset, columns: observed.length, classification: "COMPATIBLE", firstVersion: true }, dataset };
  }

  const diff = diffSchemas(registered.columns, observed);
  for (const change of diff.changes) {
    context.log(change.classification === "BREAKING" ? "error" : change.classification === "WARNING" ? "warn" : "info",
      `Schema ${change.kind.replace("_", " ")}: ${change.column} - ${change.reason}`);
  }

  const onBreaking = context.config["onBreaking"] ?? "fail";
  const onWarning = context.config["onWarning"] ?? "warn";
  if (diff.classification === "BREAKING" && onBreaking === "fail") {
    throw new TaskFailure(
      `Schema change on "${dataset}" is BREAKING: ${diff.changes.filter((c) => c.classification === "BREAKING").map((c) => c.column).join(", ")}`,
      "validation",
    );
  }
  if (diff.classification === "WARNING" && onWarning === "fail") {
    throw new TaskFailure(`Schema change on "${dataset}" needs review: ${diff.changes.map((c) => c.column).join(", ")}`, "validation");
  }

  if (context.config["register"] !== false && diff.changes.length) {
    const registration = await context.schemaRegistry.register(context.organizationId, dataset, observed, {
      runId: context.run.id,
      now: context.now,
    });
    context.log("info", `Registered schema version ${registration.schema.version} for "${dataset}"`);
  }

  return {
    batch: input,
    output: { dataset, classification: diff.classification, changes: diff.changes.length, columns: observed.length },
    dataset,
  };
};

const qualityCheck: TaskExecutor = async (context): Promise<TaskResult> => {
  const input = singleInput(context);
  const checks = parseChecks(context.config["checks"] ?? []);
  if (!checks.length) {
    context.log("warn", "Quality node has no checks configured");
    return { batch: input, output: { checks: 0 }, qualityResults: [] };
  }

  const results = runChecks(input, checks, { now: context.now });
  const summary = summarize(results);
  for (const result of results) {
    const level = result.status === "PASSED" ? "info" : result.severity === "error" ? "error" : "warn";
    context.log(level, `${result.checkId}: ${result.status} (${result.expected} -> ${result.actual})`, {
      column: result.column ?? null,
      failedRows: result.failedRows,
      totalRows: result.totalRows,
    });
  }
  context.log("info", `${summary.passed}/${summary.total} checks passed (score ${(summary.score * 100).toFixed(1)}%)`);

  if (summary.blocking && context.config["onFailure"] === "fail") {
    throw new TaskFailure(
      `Data quality checks failed: ${results.filter((r) => r.status !== "PASSED").map((r) => r.checkId).join(", ")}`,
      "data_quality",
    );
  }

  const dataset = typeof context.config["dataset"] === "string" ? context.config["dataset"] : input.dataset;
  return {
    batch: input,
    output: { checks: summary.total, passed: summary.passed, failed: summary.failed, errored: summary.errored, score: summary.score },
    qualityResults: results,
    ...(dataset ? { dataset } : {}),
  };
};

const qualityGate: TaskExecutor = async (context): Promise<TaskResult> => {
  const input = singleInput(context);
  const scope = context.config["scope"] === "run" ? "run" : "upstream";

  // Only consider results produced by ancestors of this gate, so two independent
  // branches do not block each other.
  const stored = await context.store.listQualityResults(context.organizationId, { runId: context.run.id, limit: 1000 });
  const ancestors = ancestorNodeIds(context);
  const tasks = await context.store.listTasks(context.organizationId, context.run.id);
  const taskNodeById = new Map(tasks.map((t) => [t.id, t.nodeId]));

  const relevant = stored.filter((result) => {
    if (scope === "run") return true;
    const nodeId = taskNodeById.get(result.taskRunId);
    return nodeId ? ancestors.has(nodeId) : false;
  });

  const decision = evaluateGate(
    relevant.map<QualityResult>((r) => ({
      checkId: r.checkId,
      type: r.checkType as QualityResult["type"],
      ...(r.column ? { column: r.column } : {}),
      status: r.status,
      severity: r.severity,
      expected: r.expected,
      actual: r.actual,
      passedRows: r.passedRows,
      failedRows: r.failedRows,
      totalRows: r.totalRows,
      passRate: r.passRate,
      failedSamples: [],
      message: r.message,
      durationMs: 0,
    })),
    {
      severity: (context.config["severity"] as "any_failure" | "error_only" | "score_below" | undefined) ?? "any_failure",
      minScore: typeof context.config["minScore"] === "number" ? context.config["minScore"] : 1,
      scope,
    },
  );

  context.log(decision.blocked ? "error" : "info", decision.reason, {
    evaluatedChecks: decision.evaluatedChecks,
    score: decision.score,
  });

  return {
    batch: input,
    output: {
      blocked: decision.blocked,
      reason: decision.reason,
      evaluatedChecks: decision.evaluatedChecks,
      score: decision.score,
      failedChecks: decision.failedChecks,
    },
    ...(decision.blocked ? { blockDownstream: { reason: decision.reason, failedChecks: decision.failedChecks } } : {}),
  };
};

function ancestorNodeIds(context: TaskContext): Set<string> {
  const upstream = new Map<string, string[]>();
  for (const edge of context.definition.edges) {
    const list = upstream.get(edge.to) ?? [];
    list.push(edge.from);
    upstream.set(edge.to, list);
  }
  const seen = new Set<string>();
  const stack = [...(upstream.get(context.node.id) ?? [])];
  while (stack.length) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    stack.push(...(upstream.get(node) ?? []));
  }
  return seen;
}

// --------------------------------------------------------------- destinations

const writeDestination: TaskExecutor = async (context): Promise<TaskResult> => {
  const input = singleInput(context);
  const connector = context.connectors.forNodeType(context.node.type);
  const config = renderConfig(context);

  context.log("info", `Writing ${input.rowCount.toLocaleString("en-US")} rows via ${context.node.type}`, {
    writeMode: typeof config["writeMode"] === "string" ? config["writeMode"] : null,
  });
  const result = await connector.write({ config: config as never, batch: input, signal: context.signal });
  context.log("info", `Wrote ${result.rowsWritten.toLocaleString("en-US")} rows to ${result.target}`);

  const dataset = typeof config["dataset"] === "string" ? config["dataset"] : result.target;
  return {
    batch: input,
    output: { rowsWritten: result.rowsWritten, target: result.target, ...(result.details ?? {}) },
    dataset,
  };
};

// ------------------------------------------------------------------- control

const delayWait: TaskExecutor = async (context): Promise<TaskResult> => {
  const seconds = Number(context.config["seconds"] ?? 5);
  context.log("info", `Waiting ${seconds}s before releasing downstream nodes`);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, seconds * 1000);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new TaskFailure("Delay cancelled", "cancelled"));
    };
    if (context.signal.aborted) onAbort();
    else context.signal.addEventListener("abort", onAbort, { once: true });
  });
  return { batch: Object.values(context.inputs)[0] ?? EMPTY, output: { waitedSeconds: seconds } };
};

const conditionBranch: TaskExecutor = async (context): Promise<TaskResult> => {
  const input = Object.values(context.inputs)[0] ?? EMPTY;
  const expression = String(context.config["expression"] ?? "row_count_gt");
  const value = context.config["value"];
  let outcome: boolean;

  switch (expression) {
    case "row_count_gt":
      outcome = input.rowCount > Number(value ?? 0);
      break;
    case "row_count_eq":
      outcome = input.rowCount === Number(value ?? 0);
      break;
    case "has_column":
      outcome = input.columns.some((c) => c.name === String(context.config["column"] ?? ""));
      break;
    case "param_equals": {
      const params = (context.run.params ?? {}) as Record<string, unknown>;
      outcome = String(params[String(context.config["param"] ?? "")] ?? "") === String(value ?? "");
      break;
    }
    default:
      throw new TaskFailure(`Unsupported condition expression "${expression}"`, "configuration");
  }

  context.log("info", `Condition ${expression} evaluated to ${outcome}; continuing on the "${outcome}" branch`);
  return { batch: input, output: { expression, outcome }, selectedPort: outcome ? "true" : "false" };
};

const httpSideEffect: TaskExecutor = async (context): Promise<TaskResult> => {
  const input = Object.values(context.inputs)[0] ?? EMPTY;
  const connector = context.connectors.forNodeType(context.node.type);
  const config = renderConfig(context);
  context.log("info", `Calling ${String(config["method"] ?? "POST")} ${String(config["url"] ?? "")}`);
  const result = await connector.write({ config: config as never, batch: input, signal: context.signal });
  return { batch: input, output: { target: result.target, ...(result.details ?? {}) } };
};

// ------------------------------------------------------------------ registry

const executors = new Map<string, TaskExecutor>([
  ["postgres.source", readSource],
  ["mysql.source", readSource],
  ["csv.source", readSource],
  ["json.source", readSource],
  ["http.source", readSource],
  ["s3.source", readSource],
  ["inline.source", readSource],
  ["generator.source", readSource],

  ["sql.transform", sqlTransform],
  ["filter.transform", filterTransform],
  ["aggregate.transform", aggregateTransform],
  ["join.transform", joinTransform],
  ["python.transform", pythonTransform],

  ["schema.validate", validateSchema],
  ["quality.check", qualityCheck],
  ["quality.gate", qualityGate],

  ["postgres.destination", writeDestination],
  ["mysql.destination", writeDestination],
  ["s3.destination", writeDestination],
  ["dataset.destination", writeDestination],

  ["http.request", httpSideEffect],
  ["webhook.notify", httpSideEffect],
  ["delay.wait", delayWait],
  ["condition.branch", conditionBranch],
]);

export function executorFor(nodeType: string): TaskExecutor {
  const executor = executors.get(nodeType);
  if (!executor) {
    throw new TaskFailure(
      `No executor is registered for node type "${nodeType}"` +
      (getNodeType(nodeType) ? " (the type is known but this worker cannot run it)" : ""),
      "configuration",
    );
  }
  return executor;
}

export function registerExecutor(nodeType: string, executor: TaskExecutor): void {
  executors.set(nodeType, executor);
}

export function listExecutableNodeTypes(): string[] {
  return [...executors.keys()];
}

function sumRows(inputs: Record<string, DataBatch>): number {
  return Object.values(inputs).reduce((sum, batch) => sum + batch.rowCount, 0);
}

function classify(error: unknown): TaskResult extends never ? never : TaskFailure["errorClass"] {
  const cls = (error as { errorClass?: string })?.errorClass;
  return (cls ?? "validation") as TaskFailure["errorClass"];
}

export { profileRows };
