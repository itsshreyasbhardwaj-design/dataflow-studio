import type { WorkflowDefinition } from "./types.js";

export interface PipelineTemplate {
  id: string;
  name: string;
  title: string;
  description: string;
  /** Every template is an example. The UI labels it as such and never auto-publishes. */
  category: "database" | "file" | "api" | "storage" | "demo";
  /** External resources the user must supply before the template can run. */
  requires: string[];
  definition: WorkflowDefinition;
}

const at = (x: number, y: number) => ({ position: { x, y } });

export const PIPELINE_TEMPLATES: PipelineTemplate[] = [
  {
    id: "postgres-to-postgres",
    name: "postgres-to-postgres",
    title: "PostgreSQL → PostgreSQL",
    description:
      "Reads a table, aggregates it with SQL, validates the result and upserts into a reporting table.",
    category: "database",
    requires: ["A PostgreSQL connection with read access to the source table", "Write access to the destination table"],
    definition: {
      name: "postgres-to-postgres",
      version: 1,
      description: "EXAMPLE TEMPLATE - replace connection IDs and table names before publishing.",
      nodes: [
        {
          id: "extract_sales",
          type: "postgres.source",
          config: { connectionId: "REPLACE_ME_POSTGRES", mode: "table", table: "public.sales", limit: 100000, dataset: "raw_sales" },
          metadata: { ...at(0, 0), label: "Extract sales" },
        },
        {
          id: "aggregate_revenue",
          type: "sql.transform",
          config: {
            query:
              "SELECT customer_id, COUNT(*) AS order_count, SUM(amount) AS revenue\nFROM input\nWHERE amount IS NOT NULL\nGROUP BY customer_id",
            dataset: "customer_revenue",
          },
          metadata: { ...at(280, 0), label: "Aggregate revenue" },
        },
        {
          id: "check_revenue",
          type: "quality.check",
          config: {
            dataset: "customer_revenue",
            checks: [
              { id: "customer_id_not_null", type: "not_null", column: "customer_id" },
              { id: "customer_id_unique", type: "unique", column: "customer_id" },
              { id: "revenue_non_negative", type: "range", column: "revenue", min: 0 },
              { id: "has_rows", type: "row_count", min: 1 },
            ],
            onFailure: "warn",
          },
          metadata: { ...at(560, 0), label: "Quality checks" },
        },
        {
          id: "gate",
          type: "quality.gate",
          config: { severity: "any_failure", scope: "upstream" },
          metadata: { ...at(840, 0), label: "Quality gate" },
        },
        {
          id: "load_reporting",
          type: "postgres.destination",
          config: {
            connectionId: "REPLACE_ME_POSTGRES",
            table: "reporting.customer_revenue",
            writeMode: "upsert",
            keyColumns: ["customer_id"],
            idempotent: true,
            dataset: "reporting.customer_revenue",
          },
          metadata: { ...at(1120, 0), label: "Load reporting table" },
        },
      ],
      edges: [
        { from: "extract_sales", to: "aggregate_revenue" },
        { from: "aggregate_revenue", to: "check_revenue" },
        { from: "check_revenue", to: "gate" },
        { from: "gate", to: "load_reporting" },
      ],
    },
  },
  {
    id: "csv-to-postgres",
    name: "csv-to-postgres",
    title: "CSV → PostgreSQL",
    description: "Imports an uploaded CSV, drops invalid rows, validates the schema and appends to a table.",
    category: "file",
    requires: ["An uploaded CSV file", "A PostgreSQL connection with write access"],
    definition: {
      name: "csv-to-postgres",
      version: 1,
      description: "EXAMPLE TEMPLATE - upload a CSV and replace the file and connection IDs.",
      nodes: [
        {
          id: "read_csv",
          type: "csv.source",
          config: { fileId: "REPLACE_ME_FILE", hasHeader: true, inferTypes: true, limit: 100000, dataset: "csv_import" },
          metadata: { ...at(0, 0), label: "Read CSV" },
        },
        {
          id: "drop_invalid",
          type: "filter.transform",
          config: { predicates: [{ column: "id", op: "not_null" }], combine: "and", onEmpty: "fail" },
          metadata: { ...at(280, 0), label: "Drop rows without an id" },
        },
        {
          id: "validate_schema",
          type: "schema.validate",
          config: { dataset: "csv_import", onBreaking: "fail", register: true },
          metadata: { ...at(560, 0), label: "Validate schema" },
        },
        {
          id: "load_table",
          type: "postgres.destination",
          config: { connectionId: "REPLACE_ME_POSTGRES", table: "staging.csv_import", writeMode: "append", batchSize: 1000, dataset: "staging.csv_import" },
          metadata: { ...at(840, 0), label: "Append to staging" },
        },
      ],
      edges: [
        { from: "read_csv", to: "drop_invalid" },
        { from: "drop_invalid", to: "validate_schema" },
        { from: "validate_schema", to: "load_table" },
      ],
    },
  },
  {
    id: "http-to-postgres",
    name: "http-api-to-postgres",
    title: "HTTP API → PostgreSQL",
    description: "Pages through an HTTP API, flattens the records and upserts them into PostgreSQL.",
    category: "api",
    requires: ["An API endpoint on the connector allowlist", "An API token stored as a secret", "A PostgreSQL connection"],
    definition: {
      name: "http-api-to-postgres",
      version: 1,
      description: "EXAMPLE TEMPLATE - replace the URL, secret name and connection ID.",
      nodes: [
        {
          id: "fetch_orders",
          type: "http.source",
          config: {
            url: "https://api.example.com/v1/orders",
            method: "GET",
            headers: { Authorization: { secretRef: "example-api-token" } },
            recordPath: "data",
            pagination: "page",
            pageParam: "page",
            maxPages: 10,
            timeoutSeconds: 30,
            dataset: "api_orders",
          },
          metadata: { ...at(0, 0), label: "Fetch orders" },
        },
        {
          id: "normalize",
          type: "sql.transform",
          config: {
            query: "SELECT id AS order_id, customer_id, status, amount FROM input WHERE status <> 'test'",
            dataset: "orders_normalized",
          },
          metadata: { ...at(280, 0), label: "Normalize" },
        },
        {
          id: "quality",
          type: "quality.check",
          config: {
            dataset: "orders_normalized",
            checks: [
              { id: "order_id_unique", type: "unique", column: "order_id" },
              { id: "status_allowed", type: "accepted_values", column: "status", values: ["pending", "paid", "shipped", "refunded"] },
            ],
            onFailure: "warn",
          },
          metadata: { ...at(560, 0), label: "Quality checks" },
        },
        {
          id: "load_orders",
          type: "postgres.destination",
          config: {
            connectionId: "REPLACE_ME_POSTGRES",
            table: "public.orders",
            writeMode: "upsert",
            keyColumns: ["order_id"],
            idempotent: true,
            dataset: "public.orders",
          },
          metadata: { ...at(840, 0), label: "Upsert orders" },
        },
      ],
      edges: [
        { from: "fetch_orders", to: "normalize" },
        { from: "normalize", to: "quality" },
        { from: "quality", to: "load_orders" },
      ],
    },
  },
  {
    id: "postgres-to-object-storage",
    name: "postgres-to-object-storage",
    title: "PostgreSQL → Object storage",
    description: "Exports a daily snapshot from PostgreSQL to an S3-compatible bucket as CSV.",
    category: "storage",
    requires: ["A PostgreSQL connection", "An S3-compatible connection with write access"],
    definition: {
      name: "postgres-to-object-storage",
      version: 1,
      description: "EXAMPLE TEMPLATE - replace both connection IDs and the object key prefix.",
      nodes: [
        {
          id: "extract",
          type: "postgres.source",
          config: {
            connectionId: "REPLACE_ME_POSTGRES",
            mode: "query",
            query: "SELECT * FROM public.events WHERE created_at >= now() - interval '1 day'",
            limit: 1000000,
            dataset: "events_daily",
          },
          metadata: { ...at(0, 0), label: "Extract last 24h" },
        },
        {
          id: "freshness",
          type: "quality.check",
          config: {
            dataset: "events_daily",
            checks: [
              { id: "has_rows", type: "row_count", min: 1 },
              { id: "fresh", type: "freshness", column: "created_at", maxAgeSeconds: 86400 },
            ],
            onFailure: "warn",
          },
          metadata: { ...at(280, 0), label: "Freshness check" },
        },
        {
          id: "gate",
          type: "quality.gate",
          config: { severity: "any_failure", scope: "upstream" },
          metadata: { ...at(560, 0), label: "Quality gate" },
        },
        {
          id: "export",
          type: "s3.destination",
          config: { connectionId: "REPLACE_ME_S3", key: "exports/events/{{ run.date }}/events.csv", format: "csv", idempotent: true, dataset: "s3.events_daily" },
          metadata: { ...at(840, 0), label: "Write to bucket" },
        },
      ],
      edges: [
        { from: "extract", to: "freshness" },
        { from: "freshness", to: "gate" },
        { from: "gate", to: "export" },
      ],
    },
  },
  {
    id: "zero-infra-demo",
    name: "demo-daily-sales",
    title: "Demo: daily sales (no external systems)",
    description:
      "A complete pipeline that runs with no database, queue or credentials: generated source, SQL aggregation, quality gate and a managed dataset.",
    category: "demo",
    requires: [],
    definition: {
      name: "demo-daily-sales",
      version: 1,
      description: "DEMO pipeline. Generated data, runs anywhere, safe to execute.",
      nodes: [
        {
          id: "generate_sales",
          type: "generator.source",
          config: { preset: "sales", rowCount: 2000, seed: 7, nullRate: 0.01, dataset: "demo_raw_sales" },
          metadata: { ...at(0, 0), label: "Generate sales" },
        },
        {
          id: "drop_null_customers",
          type: "filter.transform",
          config: { predicates: [{ column: "customer_id", op: "not_null" }], combine: "and", onEmpty: "fail", dataset: "demo_clean_sales" },
          metadata: { ...at(260, 0), label: "Drop null customers" },
        },
        {
          id: "revenue_by_customer",
          type: "sql.transform",
          config: {
            query:
              "SELECT customer_id,\n       COUNT(*) AS order_count,\n       COUNT(DISTINCT region) AS regions,\n       ROUND(SUM(amount), 2) AS revenue\nFROM input\nGROUP BY customer_id\nORDER BY revenue DESC",
            dataset: "demo_customer_revenue",
          },
          metadata: { ...at(520, 0), label: "Revenue by customer" },
        },
        {
          id: "quality",
          type: "quality.check",
          config: {
            dataset: "demo_customer_revenue",
            checks: [
              { id: "customer_id_not_null", type: "not_null", column: "customer_id" },
              { id: "customer_id_unique", type: "unique", column: "customer_id" },
              { id: "revenue_non_negative", type: "range", column: "revenue", min: 0 },
              { id: "order_count_positive", type: "range", column: "order_count", min: 1 },
              { id: "has_rows", type: "row_count", min: 1 },
            ],
            onFailure: "warn",
          },
          metadata: { ...at(780, 0), label: "Quality checks" },
        },
        {
          id: "gate",
          type: "quality.gate",
          config: { severity: "any_failure", scope: "upstream" },
          metadata: { ...at(1040, 0), label: "Quality gate" },
        },
        {
          id: "publish",
          type: "dataset.destination",
          config: { dataset: "demo_customer_revenue", writeMode: "replace", retainRows: 1000, idempotent: true },
          metadata: { ...at(1300, 0), label: "Publish dataset" },
        },
      ],
      edges: [
        { from: "generate_sales", to: "drop_null_customers" },
        { from: "drop_null_customers", to: "revenue_by_customer" },
        { from: "revenue_by_customer", to: "quality" },
        { from: "quality", to: "gate" },
        { from: "gate", to: "publish" },
      ],
    },
  },
];

export function getTemplate(id: string): PipelineTemplate | undefined {
  return PIPELINE_TEMPLATES.find((t) => t.id === id);
}
