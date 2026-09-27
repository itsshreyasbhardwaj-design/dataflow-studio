import type { FieldSchema } from "./schema.js";
import type { NodeKind, NodeType } from "./types.js";

export interface NodeTypeDefinition {
  type: NodeType;
  kind: NodeKind;
  label: string;
  description: string;
  /** Minimum / maximum number of inbound edges. */
  inputs: { min: number; max: number };
  /** Named output ports. Most nodes have a single `default` port. */
  outputs: readonly string[];
  fields: readonly FieldSchema[];
  /**
   * A destructive node mutates an external system. The retry planner refuses to
   * retry these unless the node opts in with `idempotent: true` in its config.
   */
  destructive?: boolean;
  /** Registers a dataset in the catalog when it runs. */
  producesDataset?: boolean;
  /** Requires a connector record of this family. */
  connectorFamily?: "postgres" | "mysql" | "http" | "s3" | "file" | null;
  /** Nodes flagged experimental are usable but surfaced as such in the editor. */
  experimental?: boolean;
}

const DATASET_FIELD: FieldSchema = {
  name: "dataset",
  type: "string",
  label: "Dataset name",
  description: "Catalog name recorded for lineage and schema tracking.",
  pattern: "^[a-z0-9][a-z0-9_.-]{0,127}$",
  placeholder: "daily_sales",
};

const LIMIT_FIELD: FieldSchema = {
  name: "limit",
  type: "integer",
  label: "Row limit",
  description: "Hard cap on rows read. Protects against accidental full-table scans.",
  min: 1,
  max: 5_000_000,
  default: 100_000,
};

const CONNECTION_FIELD: FieldSchema = {
  name: "connectionId",
  type: "string",
  label: "Connection",
  description: "ID of a stored connector. Credentials are resolved by the worker.",
  required: true,
};

const definitions: NodeTypeDefinition[] = [
  // ---------------------------------------------------------------- sources
  {
    type: "postgres.source",
    kind: "source",
    label: "PostgreSQL source",
    description: "Reads rows from a PostgreSQL table or query.",
    inputs: { min: 0, max: 0 },
    outputs: ["default"],
    connectorFamily: "postgres",
    producesDataset: true,
    fields: [
      CONNECTION_FIELD,
      { name: "mode", type: "enum", label: "Read mode", options: ["table", "query"], default: "table", required: true },
      { name: "table", type: "string", label: "Table", pattern: "^[A-Za-z_][A-Za-z0-9_$]*(\\.[A-Za-z_][A-Za-z0-9_$]*)?$", visibleWhen: { field: "mode", equals: ["table"] }, required: true },
      { name: "query", type: "sql", label: "SQL query", visibleWhen: { field: "mode", equals: ["query"] }, required: true, max: 50_000 },
      { name: "incrementalColumn", type: "string", label: "Incremental column", description: "When set, only rows greater than the last watermark are read." },
      LIMIT_FIELD,
      DATASET_FIELD,
    ],
  },
  {
    type: "mysql.source",
    kind: "source",
    label: "MySQL source",
    description: "Reads rows from a MySQL table or query.",
    inputs: { min: 0, max: 0 },
    outputs: ["default"],
    connectorFamily: "mysql",
    producesDataset: true,
    fields: [
      CONNECTION_FIELD,
      { name: "mode", type: "enum", label: "Read mode", options: ["table", "query"], default: "table", required: true },
      { name: "table", type: "string", label: "Table", visibleWhen: { field: "mode", equals: ["table"] }, required: true },
      { name: "query", type: "sql", label: "SQL query", visibleWhen: { field: "mode", equals: ["query"] }, required: true, max: 50_000 },
      LIMIT_FIELD,
      DATASET_FIELD,
    ],
  },
  {
    type: "csv.source",
    kind: "source",
    label: "CSV source",
    description: "Reads a delimited file that has been uploaded or is reachable on disk.",
    inputs: { min: 0, max: 0 },
    outputs: ["default"],
    connectorFamily: "file",
    producesDataset: true,
    fields: [
      { name: "fileId", type: "string", label: "Uploaded file", required: true, description: "ID returned by the file upload endpoint." },
      { name: "delimiter", type: "string", label: "Delimiter", default: ",", max: 4 },
      { name: "hasHeader", type: "boolean", label: "First row is a header", default: true },
      { name: "inferTypes", type: "boolean", label: "Infer column types", default: true },
      { name: "nullValues", type: "string[]", label: "Values treated as NULL", default: ["", "NULL", "null", "\\N"] },
      LIMIT_FIELD,
      DATASET_FIELD,
    ],
  },
  {
    type: "json.source",
    kind: "source",
    label: "JSON source",
    description: "Reads a JSON array or newline-delimited JSON file.",
    inputs: { min: 0, max: 0 },
    outputs: ["default"],
    connectorFamily: "file",
    producesDataset: true,
    fields: [
      { name: "fileId", type: "string", label: "Uploaded file", required: true },
      { name: "format", type: "enum", label: "Format", options: ["array", "ndjson"], default: "array" },
      { name: "recordPath", type: "string", label: "Record path", description: "Dot path to the array of records, e.g. `data.items`." },
      LIMIT_FIELD,
      DATASET_FIELD,
    ],
  },
  {
    type: "http.source",
    kind: "source",
    label: "HTTP API source",
    description: "Fetches records from an HTTP endpoint. Subject to SSRF policy.",
    inputs: { min: 0, max: 0 },
    outputs: ["default"],
    connectorFamily: "http",
    producesDataset: true,
    fields: [
      { name: "url", type: "string", label: "URL", required: true, pattern: "^https?://", placeholder: "https://api.example.com/v1/orders" },
      { name: "method", type: "enum", label: "Method", options: ["GET", "POST"], default: "GET" },
      { name: "headers", type: "object", label: "Headers", description: "Values may be secret references.", default: {} },
      { name: "query", type: "object", label: "Query parameters", default: {} },
      { name: "body", type: "object", label: "Request body", visibleWhen: { field: "method", equals: ["POST"] } },
      { name: "recordPath", type: "string", label: "Record path", description: "Dot path to the array of records in the response." },
      { name: "pagination", type: "enum", label: "Pagination", options: ["none", "page", "cursor"], default: "none" },
      { name: "pageParam", type: "string", label: "Page parameter", default: "page", visibleWhen: { field: "pagination", equals: ["page"] } },
      { name: "cursorPath", type: "string", label: "Cursor path", visibleWhen: { field: "pagination", equals: ["cursor"] } },
      { name: "maxPages", type: "integer", label: "Max pages", default: 10, min: 1, max: 1000 },
      { name: "timeoutSeconds", type: "integer", label: "Timeout (s)", default: 30, min: 1, max: 300 },
      { name: "maxResponseBytes", type: "integer", label: "Max response size (bytes)", default: 10_485_760, min: 1024 },
      DATASET_FIELD,
    ],
  },
  {
    type: "s3.source",
    kind: "source",
    label: "Object storage source",
    description: "Reads CSV or JSON objects from an S3-compatible bucket.",
    inputs: { min: 0, max: 0 },
    outputs: ["default"],
    connectorFamily: "s3",
    producesDataset: true,
    fields: [
      CONNECTION_FIELD,
      { name: "key", type: "string", label: "Object key", required: true },
      { name: "format", type: "enum", label: "Format", options: ["csv", "json", "ndjson"], default: "csv" },
      LIMIT_FIELD,
      DATASET_FIELD,
    ],
  },
  {
    type: "inline.source",
    kind: "source",
    label: "Inline rows",
    description: "Literal rows defined in the workflow. Used by examples, tests and demo pipelines.",
    inputs: { min: 0, max: 0 },
    outputs: ["default"],
    connectorFamily: null,
    producesDataset: true,
    fields: [
      { name: "rows", type: "array", label: "Rows", required: true, default: [] },
      DATASET_FIELD,
    ],
  },
  {
    type: "generator.source",
    kind: "source",
    label: "Synthetic data generator",
    description: "Deterministically generates rows from a seed. Used for demos and load testing.",
    inputs: { min: 0, max: 0 },
    outputs: ["default"],
    connectorFamily: null,
    producesDataset: true,
    fields: [
      { name: "preset", type: "enum", label: "Preset", options: ["sales", "customers", "events"], default: "sales", required: true },
      { name: "rowCount", type: "integer", label: "Rows", default: 500, min: 1, max: 500_000 },
      { name: "seed", type: "integer", label: "Seed", default: 42 },
      { name: "nullRate", type: "number", label: "Null rate", default: 0, min: 0, max: 1, description: "Fraction of nullable values emitted as NULL." },
      DATASET_FIELD,
    ],
  },

  // ------------------------------------------------------------- transforms
  {
    type: "sql.transform",
    kind: "sql",
    label: "SQL transform",
    description: "Runs a SELECT over the inbound batches. Inputs are addressable by node ID or alias.",
    inputs: { min: 1, max: 8 },
    outputs: ["default"],
    producesDataset: true,
    fields: [
      { name: "query", type: "sql", label: "SQL", required: true, max: 100_000, placeholder: "SELECT customer_id, SUM(amount) AS revenue FROM input GROUP BY customer_id" },
      { name: "aliases", type: "object", label: "Input aliases", description: "Maps a table name used in the query to an upstream node ID.", default: {} },
      DATASET_FIELD,
    ],
  },
  {
    type: "filter.transform",
    kind: "filter",
    label: "Filter",
    description: "Keeps rows matching a set of predicates.",
    inputs: { min: 1, max: 1 },
    outputs: ["default"],
    fields: [
      { name: "predicates", type: "array", label: "Predicates", required: true, default: [], description: 'e.g. [{ "column": "amount", "op": "gte", "value": 0 }]' },
      { name: "combine", type: "enum", label: "Combine with", options: ["and", "or"], default: "and" },
      { name: "onEmpty", type: "enum", label: "If no rows remain", options: ["continue", "fail"], default: "continue" },
      DATASET_FIELD,
    ],
  },
  {
    type: "aggregate.transform",
    kind: "aggregate",
    label: "Aggregate",
    description: "Groups rows and computes aggregate measures.",
    inputs: { min: 1, max: 1 },
    outputs: ["default"],
    producesDataset: true,
    fields: [
      { name: "groupBy", type: "string[]", label: "Group by", default: [] },
      { name: "measures", type: "array", label: "Measures", required: true, default: [], description: 'e.g. [{ "column": "amount", "fn": "sum", "as": "revenue" }]' },
      DATASET_FIELD,
    ],
  },
  {
    type: "join.transform",
    kind: "join",
    label: "Join",
    description: "Joins exactly two inbound batches on one or more key pairs.",
    inputs: { min: 2, max: 2 },
    outputs: ["default"],
    producesDataset: true,
    fields: [
      { name: "left", type: "string", label: "Left input node", required: true },
      { name: "right", type: "string", label: "Right input node", required: true },
      { name: "on", type: "array", label: "Key pairs", required: true, default: [], description: 'e.g. [{ "left": "customer_id", "right": "id" }]' },
      { name: "type", type: "enum", label: "Join type", options: ["inner", "left", "right", "full"], default: "inner" },
      { name: "rightPrefix", type: "string", label: "Right column prefix", default: "", description: "Applied to colliding column names from the right side." },
      DATASET_FIELD,
    ],
  },
  {
    type: "python.transform",
    kind: "python",
    label: "Python transform",
    description: "Runs a Python function in an isolated sandbox. Never executed in the API process.",
    inputs: { min: 1, max: 4 },
    outputs: ["default"],
    experimental: true,
    fields: [
      { name: "code", type: "python", label: "Python", required: true, max: 200_000, placeholder: "def transform(rows):\n    return [r for r in rows if r[\"amount\"] > 0]" },
      { name: "entrypoint", type: "string", label: "Entrypoint", default: "transform", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
      { name: "requirements", type: "string[]", label: "Requirements", default: [] },
      { name: "timeoutSeconds", type: "integer", label: "Timeout (s)", default: 60, min: 1, max: 1800 },
      { name: "memoryLimitMb", type: "integer", label: "Memory limit (MB)", default: 512, min: 64, max: 8192 },
      { name: "networkAccess", type: "boolean", label: "Allow network", default: false },
      DATASET_FIELD,
    ],
  },

  // ----------------------------------------------------- validation / gates
  {
    type: "schema.validate",
    kind: "validate",
    label: "Validate schema",
    description: "Compares the inbound schema against the registered contract and classifies drift.",
    inputs: { min: 1, max: 1 },
    outputs: ["default"],
    fields: [
      { name: "dataset", type: "string", label: "Dataset", required: true, pattern: "^[a-z0-9][a-z0-9_.-]{0,127}$" },
      { name: "expected", type: "array", label: "Expected columns", description: "Optional explicit contract. Defaults to the latest registered version.", default: [] },
      { name: "onBreaking", type: "enum", label: "On breaking change", options: ["fail", "warn"], default: "fail" },
      { name: "onWarning", type: "enum", label: "On warning", options: ["fail", "warn"], default: "warn" },
      { name: "register", type: "boolean", label: "Register new schema version", default: true },
    ],
  },
  {
    type: "quality.check",
    kind: "validate",
    label: "Data quality checks",
    description: "Evaluates quality expectations and records the results against the run.",
    inputs: { min: 1, max: 1 },
    outputs: ["default"],
    fields: [
      { name: "checks", type: "array", label: "Checks", required: true, default: [] },
      { name: "dataset", type: "string", label: "Dataset", pattern: "^[a-z0-9][a-z0-9_.-]{0,127}$" },
      { name: "onFailure", type: "enum", label: "On failure", options: ["fail", "warn"], default: "warn", description: "`warn` records the failure and continues; pair with a quality gate to block." },
    ],
  },
  {
    type: "quality.gate",
    kind: "quality_gate",
    label: "Quality gate",
    description: "Blocks downstream nodes when quality results for this run do not meet the threshold.",
    inputs: { min: 1, max: 1 },
    outputs: ["default"],
    fields: [
      { name: "severity", type: "enum", label: "Block on", options: ["any_failure", "error_only", "score_below"], default: "any_failure" },
      { name: "minScore", type: "number", label: "Minimum pass rate", default: 1, min: 0, max: 1, visibleWhen: { field: "severity", equals: ["score_below"] } },
      { name: "scope", type: "enum", label: "Scope", options: ["upstream", "run"], default: "upstream", description: "`upstream` only considers checks produced by ancestor nodes." },
    ],
  },

  // ----------------------------------------------------------- destinations
  {
    type: "postgres.destination",
    kind: "destination",
    label: "PostgreSQL destination",
    description: "Writes rows to a PostgreSQL table.",
    inputs: { min: 1, max: 1 },
    outputs: ["default"],
    connectorFamily: "postgres",
    destructive: true,
    producesDataset: true,
    fields: [
      CONNECTION_FIELD,
      { name: "table", type: "string", label: "Table", required: true, pattern: "^[A-Za-z_][A-Za-z0-9_$]*(\\.[A-Za-z_][A-Za-z0-9_$]*)?$" },
      { name: "writeMode", type: "enum", label: "Write mode", options: ["append", "replace", "upsert"], default: "append", required: true },
      { name: "keyColumns", type: "string[]", label: "Key columns", default: [], visibleWhen: { field: "writeMode", equals: ["upsert"] } },
      { name: "createTable", type: "boolean", label: "Create table if missing", default: false },
      { name: "batchSize", type: "integer", label: "Batch size", default: 1000, min: 1, max: 50_000 },
      { name: "idempotent", type: "boolean", label: "Safe to retry", default: false, description: "Set only when the write is idempotent (e.g. upsert on a stable key)." },
      DATASET_FIELD,
    ],
  },
  {
    type: "mysql.destination",
    kind: "destination",
    label: "MySQL destination",
    description: "Writes rows to a MySQL table.",
    inputs: { min: 1, max: 1 },
    outputs: ["default"],
    connectorFamily: "mysql",
    destructive: true,
    producesDataset: true,
    fields: [
      CONNECTION_FIELD,
      { name: "table", type: "string", label: "Table", required: true },
      { name: "writeMode", type: "enum", label: "Write mode", options: ["append", "replace", "upsert"], default: "append", required: true },
      { name: "keyColumns", type: "string[]", label: "Key columns", default: [], visibleWhen: { field: "writeMode", equals: ["upsert"] } },
      { name: "batchSize", type: "integer", label: "Batch size", default: 1000, min: 1, max: 50_000 },
      { name: "idempotent", type: "boolean", label: "Safe to retry", default: false },
      DATASET_FIELD,
    ],
  },
  {
    type: "s3.destination",
    kind: "destination",
    label: "Object storage destination",
    description: "Writes a CSV or JSON object to an S3-compatible bucket.",
    inputs: { min: 1, max: 1 },
    outputs: ["default"],
    connectorFamily: "s3",
    destructive: true,
    producesDataset: true,
    fields: [
      CONNECTION_FIELD,
      { name: "key", type: "string", label: "Object key", required: true, description: "Supports `{{ run.date }}` and `{{ run.id }}` templating." },
      { name: "format", type: "enum", label: "Format", options: ["csv", "json", "ndjson"], default: "csv" },
      { name: "idempotent", type: "boolean", label: "Safe to retry", default: true, description: "A keyed object write overwrites deterministically." },
      DATASET_FIELD,
    ],
  },
  {
    type: "dataset.destination",
    kind: "destination",
    label: "Managed dataset",
    description: "Writes rows into a DataFlow-managed dataset. Requires no external system.",
    inputs: { min: 1, max: 1 },
    outputs: ["default"],
    connectorFamily: null,
    producesDataset: true,
    fields: [
      { name: "dataset", type: "string", label: "Dataset", required: true, pattern: "^[a-z0-9][a-z0-9_.-]{0,127}$" },
      { name: "writeMode", type: "enum", label: "Write mode", options: ["append", "replace"], default: "replace" },
      { name: "retainRows", type: "integer", label: "Rows retained for preview", default: 1000, min: 0, max: 50_000 },
      { name: "idempotent", type: "boolean", label: "Safe to retry", default: true },
    ],
  },

  // --------------------------------------------------------------- control
  {
    type: "http.request",
    kind: "http",
    label: "HTTP request",
    description: "Calls an HTTP endpoint as a side effect and passes its input through.",
    inputs: { min: 1, max: 1 },
    outputs: ["default"],
    connectorFamily: "http",
    destructive: true,
    fields: [
      { name: "url", type: "string", label: "URL", required: true, pattern: "^https?://" },
      { name: "method", type: "enum", label: "Method", options: ["GET", "POST", "PUT", "PATCH", "DELETE"], default: "POST" },
      { name: "headers", type: "object", label: "Headers", default: {} },
      { name: "body", type: "object", label: "Body" },
      { name: "timeoutSeconds", type: "integer", label: "Timeout (s)", default: 30, min: 1, max: 300 },
      { name: "idempotent", type: "boolean", label: "Safe to retry", default: false },
    ],
  },
  {
    type: "webhook.notify",
    kind: "webhook",
    label: "Webhook notification",
    description: "Posts a run summary to a webhook URL.",
    inputs: { min: 1, max: 1 },
    outputs: ["default"],
    connectorFamily: "http",
    destructive: true,
    fields: [
      { name: "url", type: "string", label: "URL", required: true, pattern: "^https://" },
      { name: "secret", type: "secret", label: "Signing secret", description: "Used to sign the payload with HMAC-SHA256." },
      { name: "includeRowCounts", type: "boolean", label: "Include row counts", default: true },
      { name: "idempotent", type: "boolean", label: "Safe to retry", default: true },
    ],
  },
  {
    type: "delay.wait",
    kind: "delay",
    label: "Delay",
    description: "Waits before releasing downstream nodes. Useful for eventual-consistency windows.",
    inputs: { min: 1, max: 1 },
    outputs: ["default"],
    fields: [
      { name: "seconds", type: "integer", label: "Seconds", required: true, default: 5, min: 1, max: 86_400 },
    ],
  },
  {
    type: "condition.branch",
    kind: "condition",
    label: "Condition",
    description: "Routes execution to the `true` or `false` port. The unselected branch is skipped.",
    inputs: { min: 1, max: 1 },
    outputs: ["true", "false"],
    fields: [
      { name: "expression", type: "enum", label: "Condition", options: ["row_count_gt", "row_count_eq", "has_column", "param_equals"], required: true, default: "row_count_gt" },
      { name: "column", type: "string", label: "Column", visibleWhen: { field: "expression", equals: ["has_column"] } },
      { name: "param", type: "string", label: "Parameter", visibleWhen: { field: "expression", equals: ["param_equals"] } },
      { name: "value", type: "json", label: "Value", default: 0 },
    ],
  },
];

const registry = new Map<NodeType, NodeTypeDefinition>(definitions.map((d) => [d.type, d]));

export function getNodeType(type: NodeType): NodeTypeDefinition | undefined {
  return registry.get(type);
}

export function listNodeTypes(): NodeTypeDefinition[] {
  return [...registry.values()];
}

export function nodeTypesByKind(kind: NodeKind): NodeTypeDefinition[] {
  return listNodeTypes().filter((d) => d.kind === kind);
}

export function isKnownNodeType(type: string): boolean {
  return registry.has(type);
}

/**
 * Registers an additional node type. Third-party connectors use this at worker
 * start-up; the API validates against whatever the worker fleet reports.
 */
export function registerNodeType(definition: NodeTypeDefinition): void {
  if (registry.has(definition.type)) {
    throw new Error(`Node type "${definition.type}" is already registered`);
  }
  registry.set(definition.type, definition);
}
