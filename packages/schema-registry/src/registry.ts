import { createHash } from "node:crypto";
import { diffSchemas } from "./evolution.js";
import { inferSchema } from "./infer.js";
import type { ColumnSchema, DataSchema, Row, SchemaDiff } from "./types.js";

export function fingerprintColumns(columns: readonly ColumnSchema[]): string {
  const canonical = [...columns]
    .map((c) => `${c.name}:${c.type}:${c.nullable ? "null" : "notnull"}`)
    .sort()
    .join("|");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/** Storage contract the registry needs. Implemented by @dataflow-studio/database. */
export interface SchemaStore {
  latestSchema(organizationId: string, dataset: string): Promise<DataSchema | null>;
  listSchemaVersions(organizationId: string, dataset: string): Promise<DataSchema[]>;
  insertSchema(organizationId: string, schema: DataSchema): Promise<DataSchema>;
}

export interface RegisterResult {
  schema: DataSchema;
  /** Null the first time a dataset is seen. */
  previous: DataSchema | null;
  diff: SchemaDiff | null;
  /** False when the incoming schema was identical to the latest version. */
  created: boolean;
}

export class SchemaRegistry {
  constructor(private readonly store: SchemaStore) {}

  async latest(organizationId: string, dataset: string): Promise<DataSchema | null> {
    return this.store.latestSchema(organizationId, dataset);
  }

  async versions(organizationId: string, dataset: string): Promise<DataSchema[]> {
    return this.store.listSchemaVersions(organizationId, dataset);
  }

  /**
   * Registers observed columns for a dataset. Identical schemas do not create a
   * new version - schema history should reflect change, not activity.
   */
  async register(
    organizationId: string,
    dataset: string,
    columns: readonly ColumnSchema[],
    options: { runId?: string; now?: Date } = {},
  ): Promise<RegisterResult> {
    const previous = await this.store.latestSchema(organizationId, dataset);
    const fingerprint = fingerprintColumns(columns);

    if (previous && previous.fingerprint === fingerprint) {
      return { schema: previous, previous, diff: { changes: [], classification: "COMPATIBLE", compatible: true }, created: false };
    }

    const schema: DataSchema = {
      dataset,
      version: (previous?.version ?? 0) + 1,
      columns: [...columns],
      fingerprint,
      createdAt: (options.now ?? new Date()).toISOString(),
      ...(options.runId ? { observedInRunId: options.runId } : {}),
    };
    const stored = await this.store.insertSchema(organizationId, schema);
    return {
      schema: stored,
      previous,
      diff: previous ? diffSchemas(previous.columns, columns) : null,
      created: true,
    };
  }

  /** Compares observed rows against the registered contract without writing. */
  async check(
    organizationId: string,
    dataset: string,
    rows: readonly Row[],
  ): Promise<{ observed: ColumnSchema[]; diff: SchemaDiff | null; registered: DataSchema | null }> {
    const observed = inferSchema(rows);
    const registered = await this.store.latestSchema(organizationId, dataset);
    return {
      observed,
      registered,
      diff: registered ? diffSchemas(registered.columns, observed) : null,
    };
  }
}
