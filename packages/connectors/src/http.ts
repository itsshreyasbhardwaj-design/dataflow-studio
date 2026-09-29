import { makeBatch, type DataBatch } from "@dataflow-studio/schema-registry";
import type { NodeConfig } from "@dataflow-studio/workflow-engine";
import { extractPath, parseJsonRecords } from "./formats.js";
import {
  assertUrlAllowed, DEFAULT_EGRESS_POLICY, sanitizeHeaders, type EgressPolicy,
} from "./ssrf.js";
import { ConnectorError, NotSupportedError, describeError, type ConnectionResult, type DataConnector, type DataSchemaDescriptor, type ReadRequest, type WriteRequest, type WriteResult } from "./types.js";

export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  timeoutMs?: number;
  policy?: EgressPolicy;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  bytes: number;
  durationMs: number;
  truncated: boolean;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * A single guarded HTTP request. Redirects are followed manually so that each
 * hop is re-validated against the egress policy - otherwise a 302 to
 * http://169.254.169.254 would walk straight past the first check.
 */
export async function httpRequest(rawUrl: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
  const policy = { ...DEFAULT_EGRESS_POLICY, ...options.policy };
  const maxBytes = policy.maxResponseBytes ?? DEFAULT_EGRESS_POLICY.maxResponseBytes!;
  const timeoutMs = options.timeoutMs ?? policy.timeoutMs ?? DEFAULT_EGRESS_POLICY.timeoutMs!;
  const startedAt = Date.now();

  let currentUrl = rawUrl;
  let redirects = 0;

  for (;;) {
    const { url } = await assertUrlAllowed(currentUrl, policy);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value === null || value === undefined) continue;
        url.searchParams.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
    const onAbort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    let response: Response;
    try {
      const headers = sanitizeHeaders(options.headers ?? {});
      const method = (options.method ?? "GET").toUpperCase();
      const hasBody = options.body !== undefined && options.body !== null && method !== "GET" && method !== "HEAD";
      if (hasBody && !headers["content-type"]) headers["content-type"] = "application/json";

      response = await fetch(url, {
        method,
        headers,
        ...(hasBody ? { body: typeof options.body === "string" ? options.body : JSON.stringify(options.body) } : {}),
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      const message = (error as Error).message;
      throw new ConnectorError(
        `HTTP request to ${url.origin}${url.pathname} failed: ${message}`,
        /abort|timed out/i.test(message) ? "timeout" : "connection",
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new ConnectorError(`Received ${response.status} without a Location header`, "transient");
      }
      if (++redirects > (policy.maxRedirects ?? 3)) {
        throw new ConnectorError(`Exceeded ${policy.maxRedirects ?? 3} redirects`, "transient");
      }
      currentUrl = new URL(location, url).toString();
      continue;
    }

    // Read with a hard byte cap rather than trusting Content-Length.
    const { text, bytes, truncated } = await readCapped(response, maxBytes);

    if (!response.ok) {
      throw new ConnectorError(
        `HTTP ${response.status} from ${url.origin}${url.pathname}: ${text.slice(0, 500)}`,
        response.status === 401 || response.status === 403
          ? "permission"
          : response.status === 404
            ? "not_found"
            : response.status === 429
              ? "rate_limit"
              : RETRYABLE_STATUS.has(response.status)
                ? "transient"
                : "validation",
      );
    }

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: text,
      bytes,
      truncated,
      durationMs: Date.now() - startedAt,
    };
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!response.body) {
    const text = await response.text();
    return { text, bytes: Buffer.byteLength(text), truncated: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      throw new ConnectorError(
        `Response exceeded the ${maxBytes} byte limit; narrow the query or raise CONNECTOR_MAX_RESPONSE_BYTES`,
        "validation",
      );
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), bytes, truncated };
}

/** Reads records from an HTTP endpoint, with optional page or cursor pagination. */
export class HttpConnector implements DataConnector {
  readonly family = "http" as const;

  constructor(private readonly policy: EgressPolicy = {}) {}

  async testConnection(config: NodeConfig, signal?: AbortSignal): Promise<ConnectionResult> {
    const url = String(config["url"] ?? "");
    const startedAt = Date.now();
    try {
      const response = await httpRequest(url, {
        method: "GET",
        headers: (config["headers"] as Record<string, unknown>) ?? {},
        query: (config["query"] as Record<string, unknown>) ?? {},
        timeoutMs: Number(config["timeoutSeconds"] ?? 10) * 1000,
        policy: this.policy,
        ...(signal ? { signal } : {}),
      });
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        message: `HTTP ${response.status}, ${response.bytes} bytes`,
        details: { status: response.status, contentType: response.headers["content-type"] ?? null },
      };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - startedAt, message: describeError(error) };
    }
  }

  async read(request: ReadRequest): Promise<DataBatch> {
    const config = request.config;
    const url = String(config["url"] ?? "");
    const pagination = String(config["pagination"] ?? "none");
    const maxPages = pagination === "none" ? 1 : Number(config["maxPages"] ?? 10);
    const limit = request.limit ?? Number(config["limit"] ?? 100_000);
    const recordPath = config["recordPath"] ? String(config["recordPath"]) : undefined;
    const policy: EgressPolicy = {
      ...this.policy,
      ...(config["maxResponseBytes"] ? { maxResponseBytes: Number(config["maxResponseBytes"]) } : {}),
    };

    const rows: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    let truncated = false;

    for (let page = 1; page <= maxPages; page++) {
      const query: Record<string, unknown> = { ...((config["query"] as Record<string, unknown>) ?? {}) };
      if (pagination === "page") query[String(config["pageParam"] ?? "page")] = page;
      if (pagination === "cursor" && cursor) query[String(config["cursorParam"] ?? "cursor")] = cursor;

      const response = await httpRequest(url, {
        method: String(config["method"] ?? "GET"),
        headers: (config["headers"] as Record<string, unknown>) ?? {},
        query,
        ...(config["body"] !== undefined ? { body: config["body"] } : {}),
        timeoutMs: Number(config["timeoutSeconds"] ?? 30) * 1000,
        policy,
        ...(request.signal ? { signal: request.signal } : {}),
      });

      const batch = parseJsonRecords(response.body, {
        format: "array",
        ...(recordPath ? { recordPath } : {}),
        limit: limit - rows.length,
      });
      rows.push(...batch.rows);

      if (rows.length >= limit) { truncated = true; break; }
      if (batch.rowCount === 0) break;

      if (pagination === "cursor") {
        const cursorPath = config["cursorPath"] ? String(config["cursorPath"]) : "next_cursor";
        let parsed: unknown;
        try { parsed = JSON.parse(response.body); } catch { parsed = null; }
        const next = extractPath(parsed, cursorPath);
        if (next === undefined || next === null || next === "") break;
        cursor = String(next);
      } else if (pagination === "none") {
        break;
      }
    }

    const batch = parseJsonRecords(JSON.stringify(rows.slice(0, limit)), {});
    return makeBatch(batch.rows, batch.columns, {
      ...(truncated ? { truncated: true } : {}),
      ...(config["dataset"] ? { dataset: String(config["dataset"]) } : {}),
    });
  }

  async write(request: WriteRequest): Promise<WriteResult> {
    const config = request.config;
    const url = String(config["url"] ?? "");
    const includeRowCounts = config["includeRowCounts"] !== false;
    const body = config["body"] !== undefined
      ? config["body"]
      : { rows: includeRowCounts ? request.batch.rowCount : undefined, columns: request.batch.columns.map((c) => c.name) };

    const response = await httpRequest(url, {
      method: String(config["method"] ?? "POST"),
      headers: (config["headers"] as Record<string, unknown>) ?? {},
      body,
      timeoutMs: Number(config["timeoutSeconds"] ?? 30) * 1000,
      policy: this.policy,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    return {
      rowsWritten: request.batch.rowCount,
      target: url,
      details: { status: response.status, durationMs: response.durationMs },
    };
  }

  async getSchema(config: NodeConfig, signal?: AbortSignal): Promise<DataSchemaDescriptor> {
    const batch = await this.read({ config, limit: 100, ...(signal ? { signal } : {}) });
    return { columns: batch.columns, source: String(config["url"] ?? "") };
  }
}

export { NotSupportedError };
