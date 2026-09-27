import {
  inferSchema, makeBatch, type ColumnSchema, type DataBatch, type Row,
} from "@dataflow-studio/schema-registry";
import type { NodeConfig } from "@dataflow-studio/workflow-engine";
import { parseCsv, parseJsonRecords, writeCsv, writeJson } from "./formats.js";
import { generateRows, type GeneratorPreset } from "./generator.js";
import {
  ConnectorError, NotSupportedError,
  type ConnectionResult, type DataConnector, type DataSchemaDescriptor, type FileStore,
  type ReadRequest, type WriteRequest, type WriteResult,
} from "./types.js";

/** Rows defined inline in the workflow. Used by examples and tests. */
export class InlineConnector implements DataConnector {
  readonly family = "memory" as const;

  async testConnection(): Promise<ConnectionResult> {
    return { ok: true, latencyMs: 0, message: "Inline rows require no connection" };
  }

  async read(request: ReadRequest): Promise<DataBatch> {
    const raw = request.config["rows"];
    if (!Array.isArray(raw)) throw new ConnectorError("`rows` must be an array of objects", "configuration");
    const limit = request.limit ?? Number(request.config["limit"] ?? 1_000_000);
    const rows = raw.slice(0, limit).map((entry, index) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new ConnectorError(`rows[${index}] must be an object`, "configuration");
      }
      return entry as Row;
    });
    return makeBatch(rows, inferSchema(rows), {
      ...(raw.length > limit ? { truncated: true } : {}),
      ...(request.config["dataset"] ? { dataset: String(request.config["dataset"]) } : {}),
    });
  }

  async write(): Promise<WriteResult> {
    throw new NotSupportedError("inline", "writing");
  }

  async getSchema(config: NodeConfig): Promise<DataSchemaDescriptor> {
    const batch = await this.read({ config });
    return { columns: batch.columns, source: "inline" };
  }
}

/** Deterministic synthetic data for demos, load tests and onboarding. */
export class GeneratorConnector implements DataConnector {
  readonly family = "memory" as const;

  async testConnection(): Promise<ConnectionResult> {
    return { ok: true, latencyMs: 0, message: "Generator requires no connection" };
  }

  async read(request: ReadRequest): Promise<DataBatch> {
    const config = request.config;
    const batch = generateRows({
      preset: String(config["preset"] ?? "sales") as GeneratorPreset,
      rowCount: Math.min(Number(config["rowCount"] ?? 500), request.limit ?? Number.MAX_SAFE_INTEGER),
      seed: Number(config["seed"] ?? 42),
      nullRate: Number(config["nullRate"] ?? 0),
    });
    return makeBatch(batch.rows, batch.columns, {
      ...(config["dataset"] ? { dataset: String(config["dataset"]) } : {}),
    });
  }

  async write(): Promise<WriteResult> {
    throw new NotSupportedError("generator", "writing");
  }

  async getSchema(config: NodeConfig): Promise<DataSchemaDescriptor> {
    const batch = await this.read({ config, limit: 10 });
    return { columns: batch.columns, source: `generator:${String(config["preset"] ?? "sales")}` };
  }
}

/** Storage for managed datasets - the zero-infrastructure destination. */
export interface DatasetStore {
  putDataset(
    organizationId: string,
    dataset: string,
    payload: { rows: Row[]; columns: ColumnSchema[]; rowCount: number; writeMode: "append" | "replace"; runId?: string },
  ): Promise<{ rowCount: number }>;
  getDataset(
    organizationId: string,
    dataset: string,
  ): Promise<{ rows: Row[]; columns: ColumnSchema[]; rowCount: number } | null>;
}

/**
 * Writes into a DataFlow-managed dataset. This is what makes the product usable
 * on a laptop with no warehouse: the pipeline still ends in a durable, queryable,
 * catalogued dataset with a schema and quality history.
 */
export class DatasetConnector implements DataConnector {
  readonly family = "memory" as const;

  constructor(
    private readonly store: DatasetStore,
    private readonly organizationId: string,
    private readonly runId?: string,
  ) {}

  async testConnection(): Promise<ConnectionResult> {
    return { ok: true, latencyMs: 0, message: "Managed datasets require no external connection" };
  }

  async read(request: ReadRequest): Promise<DataBatch> {
    const dataset = String(request.config["dataset"] ?? "");
    const stored = await this.store.getDataset(this.organizationId, dataset);
    if (!stored) throw new ConnectorError(`Dataset "${dataset}" does not exist`, "not_found");
    const limit = request.limit ?? Number(request.config["limit"] ?? 100_000);
    return makeBatch(stored.rows.slice(0, limit), stored.columns, { dataset });
  }

  async write(request: WriteRequest): Promise<WriteResult> {
    const dataset = String(request.config["dataset"] ?? "");
    if (!dataset) throw new ConnectorError("Managed dataset destination requires a dataset name", "configuration");
    const writeMode = request.config["writeMode"] === "append" ? "append" : "replace";
    const retain = Number(request.config["retainRows"] ?? 1000);

    const result = await this.store.putDataset(this.organizationId, dataset, {
      rows: request.batch.rows.slice(0, Math.max(0, retain)),
      columns: request.batch.columns,
      rowCount: request.batch.rowCount,
      writeMode,
      ...(this.runId ? { runId: this.runId } : {}),
    });
    return {
      rowsWritten: request.batch.rowCount,
      target: dataset,
      details: { writeMode, retainedRows: Math.min(request.batch.rowCount, retain), storedRowCount: result.rowCount },
    };
  }

  async getSchema(config: NodeConfig): Promise<DataSchemaDescriptor> {
    const dataset = String(config["dataset"] ?? "");
    const stored = await this.store.getDataset(this.organizationId, dataset);
    if (!stored) throw new ConnectorError(`Dataset "${dataset}" does not exist`, "not_found");
    return { columns: stored.columns, source: dataset };
  }
}

/** Reads uploaded CSV and JSON files through the file store. */
export class FileConnector implements DataConnector {
  readonly family = "file" as const;

  constructor(
    private readonly store: FileStore,
    private readonly organizationId: string,
    private readonly format: "csv" | "json",
  ) {}

  async testConnection(config: NodeConfig): Promise<ConnectionResult> {
    const startedAt = Date.now();
    try {
      const { filename, content } = await this.store.readFile(this.organizationId, String(config["fileId"] ?? ""));
      return { ok: true, latencyMs: Date.now() - startedAt, message: `Read ${filename} (${content.byteLength} bytes)` };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - startedAt, message: (error as Error).message };
    }
  }

  async read(request: ReadRequest): Promise<DataBatch> {
    const config = request.config;
    const fileId = String(config["fileId"] ?? "");
    if (!fileId) throw new ConnectorError("File source requires an uploaded file", "configuration");
    const { content } = await this.store.readFile(this.organizationId, fileId);
    const text = content.toString("utf8");
    const limit = request.limit ?? Number(config["limit"] ?? 100_000);

    const batch = this.format === "csv"
      ? parseCsv(text, {
          delimiter: String(config["delimiter"] ?? ","),
          hasHeader: config["hasHeader"] !== false,
          inferTypes: config["inferTypes"] !== false,
          ...(Array.isArray(config["nullValues"]) ? { nullValues: config["nullValues"] as string[] } : {}),
          limit,
        })
      : parseJsonRecords(text, {
          format: config["format"] === "ndjson" ? "ndjson" : "array",
          ...(config["recordPath"] ? { recordPath: String(config["recordPath"]) } : {}),
          limit,
        });

    return makeBatch(batch.rows, batch.columns, {
      ...(batch.truncated ? { truncated: true } : {}),
      ...(config["dataset"] ? { dataset: String(config["dataset"]) } : {}),
    });
  }

  async write(request: WriteRequest): Promise<WriteResult> {
    const filename = String(request.config["filename"] ?? `export.${this.format}`);
    const content = this.format === "csv" ? writeCsv(request.batch) : writeJson(request.batch);
    const result = await this.store.writeFile(
      this.organizationId,
      filename,
      Buffer.from(content, "utf8"),
      this.format === "csv" ? "text/csv" : "application/json",
    );
    return { rowsWritten: request.batch.rowCount, target: result.fileId, details: { filename, bytes: result.bytes } };
  }

  async getSchema(config: NodeConfig): Promise<DataSchemaDescriptor> {
    const batch = await this.read({ config, limit: 200 });
    return { columns: batch.columns, source: String(config["fileId"] ?? "") };
  }
}
