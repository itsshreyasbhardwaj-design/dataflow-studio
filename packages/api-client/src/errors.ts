export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown; requestId: string };
}

/** Thrown for any non-2xx response, carrying the server's request id for support. */
export class DataFlowApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "DataFlowApiError";
  }

  /** True when retrying the same request could plausibly succeed. */
  get retryable(): boolean {
    return this.status === 429 || this.status === 408 || (this.status >= 500 && this.status < 600);
  }

  static fromResponse(status: number, body: unknown, fallback: string): DataFlowApiError {
    const envelope = body as ApiErrorBody | null;
    if (envelope?.error) {
      return new DataFlowApiError(status, envelope.error.code, envelope.error.message, envelope.error.requestId, envelope.error.details);
    }
    return new DataFlowApiError(status, "unknown", fallback);
  }
}

export class DataFlowNetworkError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "DataFlowNetworkError";
  }
}
