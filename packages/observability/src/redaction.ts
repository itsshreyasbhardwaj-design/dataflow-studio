/**
 * Credential redaction. Applied to every log record before it reaches a sink, so
 * that a connector or a user-authored SQL string cannot leak a secret into the
 * run log. Redaction is deliberately conservative: it is cheaper to redact a
 * harmless field than to page someone about a leaked production password.
 */

const SENSITIVE_KEY = new RegExp(
  [
    "pass(word|wd)?",
    "secret",
    "token",
    "api[-_]?key",
    "access[-_]?key",
    "private[-_]?key",
    "authorization",
    "auth",
    "credential",
    "session",
    "cookie",
    "connection[-_]?string",
    "dsn",
    "client[-_]?secret",
    "signature",
    "encryption[-_]?key",
  ].join("|"),
  "i",
);

/** `postgres://user:pass@host/db` -> password segment. */
const URI_CREDENTIALS = /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:/?#\s]+):([^@/?#\s]+)@/g;
/** `Bearer abc.def.ghi`, `Basic dXNlcjpwYXNz` */
const BEARER = /\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/** Long opaque credentials: sk-..., ghp_..., AKIA..., xoxb-... */
const KNOWN_PREFIXED = /\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{12,}|xox[abprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{4,})/g;

export const REDACTED = "[REDACTED]";

export function redactString(input: string): string {
  return input
    .replace(URI_CREDENTIALS, (_m, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`)
    .replace(BEARER, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(KNOWN_PREFIXED, REDACTED);
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/**
 * Deep-redacts a value. Keys matching {@link isSensitiveKey} are replaced
 * wholesale; string values are scrubbed for embedded credentials.
 */
export function redact<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === "string") return redactString(value) as unknown as T;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[Circular]" as unknown as T;
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, seen)) as unknown as T;
  }
  if (value instanceof Date) return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    } as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // A `secretRef` is a pointer, not a secret - it is safe and useful to log.
    if (k === "secretRef") {
      out[k] = v;
      continue;
    }
    out[k] = isSensitiveKey(k) ? REDACTED : redact(v, seen);
  }
  return out as unknown as T;
}
