export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "–";
  return value.toLocaleString("en-US");
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "–";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined) return "–";
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "–";
  const delta = Math.round((now - new Date(iso).getTime()) / 1000);
  if (Math.abs(delta) < 10) return "just now";
  if (delta < 0) return `in ${formatRelative(new Date(now - delta * 1000).toISOString(), now).replace(" ago", "")}`;
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86_400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 2_592_000) return `${Math.floor(delta / 86_400)}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "–";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export const STATE_TONE: Record<string, "success" | "danger" | "info" | "warning" | "neutral"> = {
  SUCCESS: "success",
  FAILED: "danger",
  RUNNING: "info",
  QUEUED: "info",
  RETRYING: "warning",
  BLOCKED: "warning",
  CANCELLED: "neutral",
  SKIPPED: "neutral",
  PENDING: "neutral",
};

export function nodeKindLabel(nodeType: string): string {
  const [system, action] = nodeType.split(".");
  return `${system}${action ? ` · ${action}` : ""}`;
}
