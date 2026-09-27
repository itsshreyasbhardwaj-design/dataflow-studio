import type { DataBatch, Row } from "@dataflow-studio/schema-registry";
import { runQuery } from "@dataflow-studio/transformations";
import type { CheckSeverity, QualityCheck, QualityResult, QualitySummary } from "./types.js";
import { CHECK_TYPES } from "./types.js";

export class QualityConfigError extends Error {
  readonly errorClass = "configuration";
  constructor(message: string) {
    super(message);
    this.name = "QualityConfigError";
  }
}

export class QualityGateError extends Error {
  readonly errorClass = "data_quality";
  constructor(message: string, readonly failedChecks: string[]) {
    super(message);
    this.name = "QualityGateError";
  }
}

const MAX_SAMPLES = 5;
const MAX_PATTERN_LENGTH = 512;

export function parseChecks(input: unknown): QualityCheck[] {
  if (!Array.isArray(input)) throw new QualityConfigError("`checks` must be an array");
  const ids = new Set<string>();
  return input.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new QualityConfigError(`checks[${index}] must be an object`);
    }
    const c = entry as Record<string, unknown>;
    const id = c["id"];
    if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
      throw new QualityConfigError(`checks[${index}].id must be a short identifier`);
    }
    if (ids.has(id)) throw new QualityConfigError(`Duplicate check id "${id}"`);
    ids.add(id);

    const type = c["type"];
    if (typeof type !== "string" || !(CHECK_TYPES as readonly string[]).includes(type)) {
      throw new QualityConfigError(`checks[${index}].type must be one of: ${CHECK_TYPES.join(", ")}`);
    }

    const needsColumn = ["not_null", "unique", "range", "regex", "accepted_values", "freshness"];
    if (needsColumn.includes(type) && typeof c["column"] !== "string") {
      throw new QualityConfigError(`checks[${index}] ("${type}") requires a column`);
    }
    if (type === "range" && c["min"] === undefined && c["max"] === undefined) {
      throw new QualityConfigError(`checks[${index}] ("range") requires min and/or max`);
    }
    if (type === "regex") {
      const pattern = c["pattern"];
      if (typeof pattern !== "string") throw new QualityConfigError(`checks[${index}] ("regex") requires a pattern`);
      if (pattern.length > MAX_PATTERN_LENGTH) {
        throw new QualityConfigError(`checks[${index}] pattern exceeds ${MAX_PATTERN_LENGTH} characters`);
      }
      try { new RegExp(pattern); } catch (error) {
        throw new QualityConfigError(`checks[${index}] pattern is invalid: ${(error as Error).message}`);
      }
    }
    if (type === "accepted_values" && (!Array.isArray(c["values"]) || c["values"].length === 0)) {
      throw new QualityConfigError(`checks[${index}] ("accepted_values") requires a non-empty values array`);
    }
    if (type === "row_count" && c["minRows"] === undefined && c["maxRows"] === undefined && c["min"] === undefined && c["max"] === undefined) {
      throw new QualityConfigError(`checks[${index}] ("row_count") requires minRows and/or maxRows`);
    }
    if (type === "freshness" && typeof c["maxAgeSeconds"] !== "number") {
      throw new QualityConfigError(`checks[${index}] ("freshness") requires maxAgeSeconds`);
    }
    if (type === "custom_sql" && typeof c["sql"] !== "string") {
      throw new QualityConfigError(`checks[${index}] ("custom_sql") requires a sql query`);
    }
    const threshold = c["threshold"];
    if (threshold !== undefined && (typeof threshold !== "number" || threshold < 0 || threshold > 1)) {
      throw new QualityConfigError(`checks[${index}].threshold must be between 0 and 1`);
    }
    const severity = c["severity"];
    if (severity !== undefined && severity !== "error" && severity !== "warn") {
      throw new QualityConfigError(`checks[${index}].severity must be "error" or "warn"`);
    }

    return {
      id,
      type: type as QualityCheck["type"],
      ...(typeof c["column"] === "string" ? { column: c["column"] } : {}),
      ...(typeof threshold === "number" ? { threshold } : {}),
      ...(severity ? { severity: severity as CheckSeverity } : {}),
      ...(typeof c["description"] === "string" ? { description: c["description"] } : {}),
      ...(typeof c["min"] === "number" ? { min: c["min"] } : {}),
      ...(typeof c["max"] === "number" ? { max: c["max"] } : {}),
      ...(typeof c["pattern"] === "string" ? { pattern: c["pattern"] } : {}),
      ...(c["caseInsensitive"] !== undefined ? { caseInsensitive: Boolean(c["caseInsensitive"]) } : {}),
      ...(Array.isArray(c["values"]) ? { values: c["values"] } : {}),
      ...(typeof c["minRows"] === "number" ? { minRows: c["minRows"] } : typeof c["min"] === "number" && type === "row_count" ? { minRows: c["min"] } : {}),
      ...(typeof c["maxRows"] === "number" ? { maxRows: c["maxRows"] } : typeof c["max"] === "number" && type === "row_count" ? { maxRows: c["max"] } : {}),
      ...(typeof c["maxAgeSeconds"] === "number" ? { maxAgeSeconds: c["maxAgeSeconds"] } : {}),
      ...(typeof c["sql"] === "string" ? { sql: c["sql"] } : {}),
    };
  });
}

const percent = (value: number): string => `${Number((value * 100).toFixed(2))}%`;

export interface RunChecksOptions {
  now?: Date;
  /** Cap on rows scanned per check. Quality must not become the slowest task. */
  maxRowsScanned?: number;
}

function assertColumnExists(batch: DataBatch, column: string): void {
  if (!batch.columns.some((c) => c.name === column) && batch.rows.length > 0) {
    throw new QualityConfigError(
      `Column "${column}" is not present in the input. Available columns: ${batch.columns.map((c) => c.name).join(", ")}`,
    );
  }
}

/** Evaluates one check. Throwing is reserved for checks that cannot be evaluated. */
function evaluateCheck(check: QualityCheck, batch: DataBatch, options: RunChecksOptions): Omit<QualityResult, "durationMs" | "severity" | "status"> {
  const now = options.now ?? new Date();
  const limit = Math.min(batch.rows.length, options.maxRowsScanned ?? 1_000_000);
  const rows = batch.rows.slice(0, limit);
  const threshold = check.threshold ?? 1;
  const samples: unknown[] = [];
  const addSample = (value: unknown): void => {
    if (samples.length < MAX_SAMPLES) samples.push(value);
  };

  const rowLevel = (
    expected: string,
    predicate: (value: unknown, row: Row) => boolean,
  ): Omit<QualityResult, "durationMs" | "severity" | "status"> => {
    assertColumnExists(batch, check.column!);
    let passed = 0;
    for (const row of rows) {
      const value = row[check.column!];
      if (predicate(value, row)) passed++;
      else addSample(value);
    }
    const total = rows.length;
    const passRate = total === 0 ? 1 : passed / total;
    return {
      checkId: check.id,
      type: check.type,
      column: check.column!,
      expected: `${expected}, expected ${percent(threshold)}`,
      actual: percent(passRate),
      passedRows: passed,
      failedRows: total - passed,
      totalRows: total,
      passRate,
      failedSamples: samples,
      message: total === 0
        ? "No rows to check"
        : passRate >= threshold
          ? `${passed}/${total} rows passed`
          : `${total - passed}/${total} rows failed`,
    };
  };

  switch (check.type) {
    case "not_null":
      return rowLevel("NOT NULL", (value) => value !== null && value !== undefined && value !== "");

    case "unique": {
      assertColumnExists(batch, check.column!);
      const counts = new Map<string, number>();
      for (const row of rows) {
        const value = row[check.column!];
        if (value === null || value === undefined) continue;
        const key = typeof value === "object" ? JSON.stringify(value) : String(value);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      let duplicated = 0;
      for (const [key, count] of counts) {
        if (count > 1) { duplicated += count; addSample(key); }
      }
      const total = rows.length;
      const passed = total - duplicated;
      const passRate = total === 0 ? 1 : passed / total;
      return {
        checkId: check.id,
        type: check.type,
        column: check.column!,
        expected: `UNIQUE, expected ${percent(threshold)}`,
        actual: percent(passRate),
        passedRows: passed,
        failedRows: duplicated,
        totalRows: total,
        passRate,
        failedSamples: samples,
        message: duplicated === 0 ? `${counts.size} distinct values, no duplicates` : `${duplicated} rows share a duplicated value`,
      };
    }

    case "range":
      return rowLevel(
        `BETWEEN ${check.min ?? "-inf"} AND ${check.max ?? "+inf"}`,
        (value) => {
          if (value === null || value === undefined) return true; // nullability is not_null's job
          const n = typeof value === "number" ? value : Number(value);
          if (!Number.isFinite(n)) return false;
          if (check.min !== undefined && n < check.min) return false;
          if (check.max !== undefined && n > check.max) return false;
          return true;
        },
      );

    case "regex": {
      const regex = new RegExp(check.pattern!, check.caseInsensitive ? "i" : "");
      return rowLevel(`MATCHES /${check.pattern}/`, (value) => {
        if (value === null || value === undefined) return true;
        return regex.test(String(value));
      });
    }

    case "accepted_values": {
      const allowed = new Set(check.values!.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))));
      return rowLevel(`IN (${check.values!.map(String).join(", ")})`, (value) => {
        if (value === null || value === undefined) return true;
        return allowed.has(typeof value === "object" ? JSON.stringify(value) : String(value));
      });
    }

    case "row_count": {
      const total = batch.rows.length;
      const okMin = check.minRows === undefined || total >= check.minRows;
      const okMax = check.maxRows === undefined || total <= check.maxRows;
      const ok = okMin && okMax;
      return {
        checkId: check.id,
        type: check.type,
        expected: `ROW COUNT between ${check.minRows ?? 0} and ${check.maxRows ?? "+inf"}`,
        actual: String(total),
        passedRows: ok ? total : 0,
        failedRows: ok ? 0 : total,
        totalRows: total,
        passRate: ok ? 1 : 0,
        failedSamples: [],
        message: ok ? `${total} rows` : `${total} rows is outside the expected range`,
      };
    }

    case "freshness": {
      assertColumnExists(batch, check.column!);
      const cutoff = now.getTime() - check.maxAgeSeconds! * 1000;
      let newest = Number.NEGATIVE_INFINITY;
      for (const row of rows) {
        const value = row[check.column!];
        if (value === null || value === undefined) continue;
        const time = value instanceof Date ? value.getTime() : Date.parse(String(value));
        if (!Number.isNaN(time)) newest = Math.max(newest, time);
      }
      const hasData = Number.isFinite(newest);
      const ok = hasData && newest >= cutoff;
      const ageSeconds = hasData ? Math.round((now.getTime() - newest) / 1000) : null;
      return {
        checkId: check.id,
        type: check.type,
        column: check.column!,
        expected: `MAX(${check.column}) newer than ${check.maxAgeSeconds}s`,
        actual: ageSeconds === null ? "no timestamps found" : `${ageSeconds}s old`,
        passedRows: ok ? rows.length : 0,
        failedRows: ok ? 0 : rows.length,
        totalRows: rows.length,
        passRate: ok ? 1 : 0,
        failedSamples: hasData ? [new Date(newest).toISOString()] : [],
        message: ok
          ? `Most recent value is ${ageSeconds}s old`
          : hasData
            ? `Data is stale: most recent value is ${ageSeconds}s old, limit is ${check.maxAgeSeconds}s`
            : `No parsable timestamp found in "${check.column}"`,
      };
    }

    case "custom_sql": {
      // dbt semantics: the query returns the rows that violate the expectation.
      const violations = runQuery(check.sql!, { input: batch }, { now, maxOutputRows: 10_000 });
      const failed = violations.rowCount;
      const total = batch.rows.length;
      const passRate = total === 0 ? 1 : Math.max(0, (total - failed) / total);
      return {
        checkId: check.id,
        type: check.type,
        ...(check.column ? { column: check.column } : {}),
        expected: "custom SQL returns no rows",
        actual: `${failed} violating row(s)`,
        passedRows: Math.max(0, total - failed),
        failedRows: failed,
        totalRows: total,
        passRate,
        failedSamples: violations.rows.slice(0, MAX_SAMPLES),
        message: failed === 0 ? "No violations" : `${failed} row(s) violate the expectation`,
      };
    }
  }
}

export function runChecks(
  batch: DataBatch,
  checks: readonly QualityCheck[],
  options: RunChecksOptions = {},
): QualityResult[] {
  return checks.map((check) => {
    const startedAt = Date.now();
    const severity: CheckSeverity = check.severity ?? "error";
    try {
      const evaluated = evaluateCheck(check, batch, options);
      const threshold = check.threshold ?? 1;
      const passed = check.type === "row_count" || check.type === "freshness"
        ? evaluated.passRate === 1
        : evaluated.passRate >= threshold;
      return {
        ...evaluated,
        severity,
        status: passed ? "PASSED" : "FAILED",
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        checkId: check.id,
        type: check.type,
        ...(check.column ? { column: check.column } : {}),
        severity,
        status: "ERRORED",
        expected: "check to be evaluable",
        actual: "error",
        passedRows: 0,
        failedRows: 0,
        totalRows: batch.rows.length,
        passRate: 0,
        failedSamples: [],
        message: `Check could not be evaluated: ${(error as Error).message}`,
        error: (error as Error).message,
        durationMs: Date.now() - startedAt,
      };
    }
  });
}

export function summarize(results: readonly QualityResult[]): QualitySummary {
  const passed = results.filter((r) => r.status === "PASSED").length;
  const failed = results.filter((r) => r.status === "FAILED").length;
  const errored = results.filter((r) => r.status === "ERRORED").length;
  const score = results.length ? results.reduce((sum, r) => sum + r.passRate, 0) / results.length : 1;
  return {
    total: results.length,
    passed,
    failed,
    errored,
    score,
    blocking: results.some((r) => r.severity === "error" && r.status !== "PASSED"),
  };
}

/** The rendering used on the run page and in CLI output. */
export function formatResult(result: QualityResult): string {
  const lines = [
    result.column ? `${result.column}` : result.checkId,
    "",
    result.expected.split(", expected ")[0] ?? result.type.toUpperCase(),
    `Expected: ${result.expected.split(", expected ")[1] ?? "-"}`,
    `Actual: ${result.actual}`,
    `Status: ${result.status}`,
  ];
  return lines.join("\n");
}
