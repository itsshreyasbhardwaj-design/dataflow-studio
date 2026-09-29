import { makeBatch, type DataBatch } from "@dataflow-studio/schema-registry";
import type { NodeConfig } from "@dataflow-studio/workflow-engine";
import { parseCsv, parseJsonRecords, writeCsv, writeJson } from "./formats.js";
import { signRequest } from "./sigv4.js";
import { assertUrlAllowed, type EgressPolicy } from "./ssrf.js";
import { ConnectorError, describeError, type ConnectionResult, type DataConnector, type DataSchemaDescriptor, type ReadRequest, type WriteRequest, type WriteResult } from "./types.js";

export interface S3Settings {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Path-style addressing is required by most S3-compatible servers. */
  forcePathStyle?: boolean;
}

function settingsFrom(config: NodeConfig): S3Settings {
  const get = (key: string, required = true): string => {
    const value = config[key];
    if (typeof value !== "string" || value === "") {
      if (required) throw new ConnectorError(`S3 connection is missing "${key}"`, "configuration");
      return "";
    }
    return value;
  };
  return {
    endpoint: get("endpoint"),
    region: get("region", false) || "us-east-1",
    bucket: get("bucket"),
    accessKeyId: get("accessKeyId"),
    secretAccessKey: get("secretAccessKey"),
    ...(typeof config["sessionToken"] === "string" ? { sessionToken: config["sessionToken"] } : {}),
    forcePathStyle: config["forcePathStyle"] !== false,
  };
}

function objectUrl(settings: S3Settings, key: string): URL {
  const base = new URL(settings.endpoint);
  const cleanKey = key.replace(/^\/+/, "");
  if (settings.forcePathStyle) {
    base.pathname = `/${settings.bucket}/${cleanKey}`;
  } else {
    base.host = `${settings.bucket}.${base.host}`;
    base.pathname = `/${cleanKey}`;
  }
  return base;
}

/**
 * S3-compatible object storage over plain fetch + SigV4. Works with AWS S3,
 * MinIO, Cloudflare R2 and anything else that speaks the same REST dialect.
 */
export class S3Connector implements DataConnector {
  readonly family = "s3" as const;

  constructor(private readonly policy: EgressPolicy = {}) {}

  private async send(
    settings: S3Settings,
    method: string,
    key: string,
    body?: Buffer,
    signal?: AbortSignal,
    contentType?: string,
  ): Promise<{ status: number; body: Buffer; headers: Headers }> {
    const url = objectUrl(settings, key);
    // Object storage endpoints are user-supplied, so the same egress policy applies.
    await assertUrlAllowed(url.toString(), { ...this.policy, allowedPorts: [80, 443, 9000, 9001, 8443, 8080] });

    const signed = signRequest({
      method,
      url,
      region: settings.region,
      service: "s3",
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
      ...(settings.sessionToken ? { sessionToken: settings.sessionToken } : {}),
      ...(contentType ? { headers: { "content-type": contentType } } : {}),
      ...(body ? { payload: body } : {}),
    });

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: signed.headers,
        ...(body ? { body: new Uint8Array(body) } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw new ConnectorError(`Object storage request failed: ${(error as Error).message}`, "connection", { cause: error });
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      const text = buffer.toString("utf8").slice(0, 500);
      throw new ConnectorError(
        `Object storage returned ${response.status} for ${method} ${key}: ${text}`,
        response.status === 403 ? "permission" : response.status === 404 ? "not_found" : response.status >= 500 ? "transient" : "validation",
      );
    }
    return { status: response.status, body: buffer, headers: response.headers };
  }

  async testConnection(config: NodeConfig, signal?: AbortSignal): Promise<ConnectionResult> {
    const startedAt = Date.now();
    try {
      const settings = settingsFrom(config);
      // A HEAD on the bucket root verifies credentials and reachability without listing.
      await this.send(settings, "HEAD", "", undefined, signal);
      return { ok: true, latencyMs: Date.now() - startedAt, message: `Bucket "${settings.bucket}" is reachable` };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - startedAt, message: describeError(error) };
    }
  }

  async read(request: ReadRequest): Promise<DataBatch> {
    const settings = settingsFrom(request.config);
    const key = String(request.config["key"] ?? "");
    if (!key) throw new ConnectorError("S3 source requires an object key", "configuration");
    const format = String(request.config["format"] ?? "csv");
    const limit = request.limit ?? Number(request.config["limit"] ?? 100_000);

    const { body } = await this.send(settings, "GET", key, undefined, request.signal);
    const text = body.toString("utf8");
    const batch = format === "csv"
      ? parseCsv(text, { limit })
      : parseJsonRecords(text, { format: format === "ndjson" ? "ndjson" : "array", limit });

    return makeBatch(batch.rows, batch.columns, {
      ...(batch.truncated ? { truncated: true } : {}),
      ...(request.config["dataset"] ? { dataset: String(request.config["dataset"]) } : {}),
    });
  }

  async write(request: WriteRequest): Promise<WriteResult> {
    const settings = settingsFrom(request.config);
    const key = String(request.config["key"] ?? "");
    if (!key) throw new ConnectorError("S3 destination requires an object key", "configuration");
    const format = String(request.config["format"] ?? "csv");

    const content = format === "csv"
      ? writeCsv(request.batch)
      : writeJson(request.batch, { format: format === "ndjson" ? "ndjson" : "array" });
    const contentType = format === "csv" ? "text/csv" : "application/json";

    await this.send(settings, "PUT", key, Buffer.from(content, "utf8"), request.signal, contentType);
    return {
      rowsWritten: request.batch.rowCount,
      target: `s3://${settings.bucket}/${key.replace(/^\/+/, "")}`,
      details: { bytes: Buffer.byteLength(content), format },
    };
  }

  async getSchema(config: NodeConfig, signal?: AbortSignal): Promise<DataSchemaDescriptor> {
    const batch = await this.read({ config, limit: 200, ...(signal ? { signal } : {}) });
    return { columns: batch.columns, source: `s3://${settingsFrom(config).bucket}/${String(config["key"] ?? "")}` };
  }
}
