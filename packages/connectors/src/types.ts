import type { ColumnSchema, DataBatch, Row } from "@dataflow-studio/schema-registry";
import type { NodeConfig } from "@dataflow-studio/workflow-engine";

export type ConnectorFamily = "postgres" | "mysql" | "http" | "s3" | "file" | "memory";

export interface ConnectionResult {
  ok: boolean;
  /** Round-trip latency of the probe, in milliseconds. */
  latencyMs: number;
  message: string;
  /** Server version or similar, when the driver exposes it. */
  details?: Record<string, unknown>;
}

export interface ReadRequest {
  /** Resolved node configuration: secrets are already plaintext. */
  config: NodeConfig;
  limit?: number;
  /** Incremental read watermark from the previous successful run. */
  since?: unknown;
  signal?: AbortSignal;
}

export interface WriteRequest {
  config: NodeConfig;
  batch: DataBatch;
  signal?: AbortSignal;
}

export interface WriteResult {
  rowsWritten: number;
  /** Where the data landed: table name, object key, dataset name. */
  target: string;
  details?: Record<string, unknown>;
}

export interface DataSchemaDescriptor {
  columns: ColumnSchema[];
  /** Object, table or endpoint the schema was read from. */
  source: string;
}

/**
 * The contract every connector implements. Read and write are the only data-plane
 * operations; everything else is metadata. Connectors never log their config and
 * never see a secret reference - the worker resolves those first.
 */
export interface DataConnector {
  readonly family: ConnectorFamily;
  testConnection(config: NodeConfig, signal?: AbortSignal): Promise<ConnectionResult>;
  read(request: ReadRequest): Promise<DataBatch>;
  write(request: WriteRequest): Promise<WriteResult>;
  getSchema(config: NodeConfig, signal?: AbortSignal): Promise<DataSchemaDescriptor>;
  /** Releases pooled resources. Called when a worker shuts down. */
  close?(): Promise<void>;
}

export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly errorClass:
      | "connection" | "timeout" | "permission" | "not_found"
      | "configuration" | "validation" | "rate_limit" | "transient" | "unknown" = "unknown",
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "ConnectorError";
  }
}

export class NotSupportedError extends ConnectorError {
  constructor(family: string, operation: string) {
    super(`The ${family} connector does not support ${operation}`, "configuration");
    this.name = "NotSupportedError";
  }
}

/**
 * Turns a thrown value into a message a user can act on.
 *
 * `error.message` is not enough on its own. Node raises an `AggregateError` with
 * an empty message when every address for a host fails - a `pg` connection to an
 * unreachable `localhost` produces exactly that - so a bare `.message` leaves the
 * reason blank in the one place it matters most: the connection-test panel. This
 * unwraps aggregate errors, falls back to the error name, and finally to the
 * stringified value, so the result is never empty.
 */
export function describeError(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  if (!(error instanceof Error)) return String(error ?? "Unknown error");

  if (error.message.trim()) return error.message;

  const nested = (error as { errors?: unknown }).errors;
  if (Array.isArray(nested) && nested.length) {
    const parts = [...new Set(nested.map((inner) => describeError(inner)))];
    if (parts.length) return `${error.name || "AggregateError"}: ${parts.join("; ")}`;
  }

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code) return `${error.name || "Error"}: ${code}`;
  return error.name || "Unknown error";
}

/** Storage for uploaded files, so file connectors do not touch the filesystem directly. */
export interface FileStore {
  readFile(organizationId: string, fileId: string): Promise<{ content: Buffer; filename: string; contentType?: string }>;
  writeFile(organizationId: string, filename: string, content: Buffer, contentType?: string): Promise<{ fileId: string; bytes: number }>;
}

export type { Row, DataBatch, ColumnSchema };
