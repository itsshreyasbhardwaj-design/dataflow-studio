export type ApiErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "validation_failed"
  | "rate_limited"
  | "payload_too_large"
  | "unsupported_media_type"
  | "method_not_allowed"
  | "internal_error"
  | "not_implemented";

const STATUS: Record<ApiErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  validation_failed: 422,
  rate_limited: 429,
  payload_too_large: 413,
  unsupported_media_type: 415,
  method_not_allowed: 405,
  internal_error: 500,
  not_implemented: 501,
};

/** Every API failure is one of these, so the envelope is always the same shape. */
export class ApiError extends Error {
  readonly status: number;

  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = STATUS[code];
  }

  static unauthenticated(message = "Authentication required"): ApiError {
    return new ApiError("unauthenticated", message);
  }
  static forbidden(message = "You do not have permission to do that"): ApiError {
    return new ApiError("forbidden", message);
  }
  static notFound(what: string, id?: string): ApiError {
    return new ApiError("not_found", id ? `${what} "${id}" was not found` : `${what} was not found`);
  }
  static conflict(message: string): ApiError {
    return new ApiError("conflict", message);
  }
  static validation(message: string, details?: unknown): ApiError {
    return new ApiError("validation_failed", message, details);
  }
  static rateLimited(retryAfterSeconds: number): ApiError {
    return new ApiError("rate_limited", "Too many requests", { retryAfterSeconds });
  }
}

export interface ErrorEnvelope {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

export function toEnvelope(error: unknown, requestId: string): { status: number; body: ErrorEnvelope } {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}), requestId } },
    };
  }
  const cls = (error as { errorClass?: string } | null)?.errorClass;
  const message = error instanceof Error ? error.message : "Unexpected error";
  if (cls === "not_found") return { status: 404, body: { error: { code: "not_found", message, requestId } } };
  if (cls === "permission") return { status: 403, body: { error: { code: "forbidden", message, requestId } } };
  if (cls === "validation" || cls === "configuration") {
    return { status: 422, body: { error: { code: "validation_failed", message, requestId } } };
  }
  if ((error as Error)?.name === "ConflictError") {
    return { status: 409, body: { error: { code: "conflict", message, requestId } } };
  }
  return { status: 500, body: { error: { code: "internal_error", message: "Internal server error", requestId } } };
}
