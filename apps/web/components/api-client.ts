"use client";

/**
 * Browser-side API access.
 *
 * Deliberately thin: the app's own REST API is the only thing the browser talks
 * to, errors carry the server's request id, and nothing here knows about
 * credentials - the session cookie or API key is attached by the browser.
 */
export interface ClientError extends Error {
  status: number;
  code: string;
  requestId?: string;
  details?: unknown;
}

export async function apiRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const envelope = payload as { error?: { code: string; message: string; requestId?: string; details?: unknown } } | null;
    const error = new Error(envelope?.error?.message ?? `Request failed with ${response.status}`) as ClientError;
    error.status = response.status;
    error.code = envelope?.error?.code ?? "unknown";
    if (envelope?.error?.requestId) error.requestId = envelope.error.requestId;
    if (envelope?.error?.details !== undefined) error.details = envelope.error.details;
    throw error;
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => apiRequest<T>(path, { ...(signal ? { signal } : {}) }),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: "POST", ...(body !== undefined ? { body } : {}) }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: "PATCH", ...(body !== undefined ? { body } : {}) }),
  delete: <T>(path: string) => apiRequest<T>(path, { method: "DELETE" }),
};

export function issuesOf(error: unknown): Array<{ message: string; hint?: string; nodeId?: string }> {
  const details = (error as ClientError | null)?.details as { issues?: Array<{ message: string; hint?: string; nodeId?: string }> } | undefined;
  return details?.issues ?? [];
}
