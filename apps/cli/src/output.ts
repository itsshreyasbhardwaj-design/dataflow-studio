const useColor = process.env["NO_COLOR"] === undefined && process.stdout.isTTY === true;

const code = (open: number, close: number) => (text: string): string =>
  useColor ? `\u001B[${open}m${text}\u001B[${close}m` : text;

export const style = {
  bold: code(1, 22),
  dim: code(2, 22),
  red: code(31, 39),
  green: code(32, 39),
  yellow: code(33, 39),
  blue: code(34, 39),
  cyan: code(36, 39),
  grey: code(90, 39),
};

export const symbols = {
  success: useColor ? style.green("✓") : "OK",
  failure: useColor ? style.red("✗") : "FAIL",
  pending: useColor ? style.grey("○") : "..",
  running: useColor ? style.blue("●") : ">>",
  warning: useColor ? style.yellow("!") : "!",
};

export function stateSymbol(state: string): string {
  switch (state) {
    case "SUCCESS": return symbols.success;
    case "FAILED": return symbols.failure;
    case "RUNNING": return symbols.running;
    case "BLOCKED": return symbols.warning;
    case "CANCELLED": return useColor ? style.grey("–") : "--";
    default: return symbols.pending;
  }
}

export function colorState(state: string): string {
  switch (state) {
    case "SUCCESS": return style.green(state);
    case "FAILED": return style.red(state);
    case "RUNNING": case "QUEUED": return style.blue(state);
    case "BLOCKED": return style.yellow(state);
    default: return style.grey(state);
  }
}

/** Left-aligned columns, sized to content. */
export function table(rows: Array<Record<string, string>>, columns?: string[]): string {
  if (!rows.length) return style.grey("(no results)");
  const keys = columns ?? Object.keys(rows[0]!);
  const widths = keys.map((key) => Math.max(key.length, ...rows.map((row) => stripAnsi(row[key] ?? "").length)));

  const header = keys.map((key, i) => style.bold(key.toUpperCase().padEnd(widths[i]!))).join("  ");
  const body = rows.map((row) =>
    keys.map((key, i) => pad(row[key] ?? "", widths[i]!)).join("  "),
  );
  return [header, ...body].join("\n");
}

function pad(value: string, width: number): string {
  const visible = stripAnsi(value).length;
  return value + " ".repeat(Math.max(0, width - visible));
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001B\[[0-9;]*m/g, "");
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "-";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "-";
  const delta = Math.round((now - new Date(iso).getTime()) / 1000);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86_400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86_400)}d ago`;
}

export function print(line = ""): void {
  process.stdout.write(`${line}\n`);
}

export function printError(message: string): void {
  process.stderr.write(`${style.red("error")} ${message}\n`);
}

export function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
