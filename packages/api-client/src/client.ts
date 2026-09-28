import { DataFlowApiError, DataFlowNetworkError } from "./errors.js";

export interface DataFlowClientOptions {
  /** Base URL of the API, e.g. `https://dataflow.example.com`. */
  baseUrl?: string;
  apiKey?: string;
  /** Extra headers, e.g. an organization selector for session auth. */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Attempts for retryable failures, including the first. */
  maxRetries?: number;
  /** Base delay for exponential backoff between retries. */
  retryDelayMs?: number;
  userAgent?: string;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | string[]>;
  body?: unknown;
  signal?: AbortSignal;
  /** Overrides the client default for this call. */
  maxRetries?: number;
  idempotencyKey?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Transport for the DataFlow Studio REST API.
 *
 * Retries only what is safe to retry - a 429 or 5xx on a GET, or any request the
 * caller tagged with an idempotency key - and surfaces the server's request id on
 * every error so a failure in CI can be traced to a line in the audit log.
 */
export class DataFlowHttpClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: DataFlowClientOptions = {}) {
    const base = options.baseUrl ?? process.env["DATAFLOW_API_URL"] ?? "http://localhost:3000";
    this.baseUrl = base.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error("No fetch implementation available; pass one via `fetch` in the client options");
    }
  }

  private headers(options: RequestOptions, hasBody: boolean): Record<string, string> {
    const apiKey = this.options.apiKey ?? process.env["DATAFLOW_API_KEY"];
    return {
      accept: "application/json",
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...(this.options.userAgent ? { "user-agent": this.options.userAgent } : {}),
      ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
      ...this.options.headers,
    };
  }

  private url(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const entry of value) url.searchParams.append(key, entry);
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const maxRetries = options.maxRetries ?? this.options.maxRetries ?? 3;
    const retryDelayMs = this.options.retryDelayMs ?? 250;
    const idempotent = method === "GET" || method === "HEAD" || Boolean(options.idempotencyKey);
    const hasBody = options.body !== undefined;
    let lastError: unknown;

    for (let attempt = 1; attempt <= Math.max(1, maxRetries); attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error(`Request timed out after ${this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`)),
        this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      const onAbort = (): void => controller.abort(options.signal?.reason);
      options.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const response = await this.fetchImpl(this.url(path, options.query), {
          method,
          headers: this.headers(options, hasBody),
          ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
          signal: controller.signal,
        });

        const text = await response.text();
        const payload = text ? safeJson(text) : null;

        if (!response.ok) {
          const error = DataFlowApiError.fromResponse(response.status, payload, `${method} ${path} failed with ${response.status}`);
          if (error.retryable && idempotent && attempt < maxRetries) {
            const retryAfter = Number(response.headers.get("retry-after") ?? 0);
            await delay(retryAfter ? retryAfter * 1000 : retryDelayMs * 2 ** (attempt - 1));
            lastError = error;
            continue;
          }
          throw error;
        }
        return payload as T;
      } catch (error) {
        if (error instanceof DataFlowApiError) throw error;
        const message = (error as Error).message;
        const wrapped = new DataFlowNetworkError(`${method} ${path}: ${message}`, { cause: error });
        if (idempotent && attempt < maxRetries && !options.signal?.aborted) {
          await delay(retryDelayMs * 2 ** (attempt - 1));
          lastError = wrapped;
          continue;
        }
        throw wrapped;
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
      }
    }
    throw lastError ?? new DataFlowNetworkError(`${method} ${path} failed`);
  }

  get<T>(path: string, options: Omit<RequestOptions, "body"> = {}): Promise<T> {
    return this.request<T>("GET", path, options);
  }
  post<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("POST", path, { ...options, ...(body !== undefined ? { body } : {}) });
  }
  patch<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("PATCH", path, { ...options, ...(body !== undefined ? { body } : {}) });
  }
  delete<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("DELETE", path, options);
  }

  /** Streams server-sent events for a live run. */
  async *streamEvents(
    path: string,
    options: { signal?: AbortSignal; lastEventId?: number } = {},
  ): AsyncGenerator<{ id?: number; type: string; data: unknown }> {
    const response = await this.fetchImpl(this.url(path), {
      headers: {
        ...this.headers({}, false),
        accept: "text/event-stream",
        ...(options.lastEventId ? { "last-event-id": String(options.lastEventId) } : {}),
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok || !response.body) {
      throw DataFlowApiError.fromResponse(response.status, await response.json().catch(() => null), "Event stream failed");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event: { id?: number; type: string; data: unknown } = { type: "message", data: null };
        for (const line of chunk.split("\n")) {
          if (line.startsWith("id:")) event.id = Number(line.slice(3).trim());
          else if (line.startsWith("event:")) event.type = line.slice(6).trim();
          else if (line.startsWith("data:")) event.data = safeJson(line.slice(5).trim());
        }
        yield event;
      }
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
