import { redact, redactString } from "./redaction.js";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Correlation fields. Every task log line carries enough context to be joined
 * back to the workflow, run, task and attempt that produced it.
 */
export interface LogContext {
  organizationId?: string;
  requestId?: string;
  workerId?: string;
  pipelineId?: string;
  runId?: string;
  taskId?: string;
  nodeId?: string;
  attempt?: number;
  [key: string]: unknown;
}

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  message: string;
  context: LogContext;
  fields?: Record<string, unknown>;
}

export interface LogSink {
  write(record: LogRecord): void;
}

export class JsonConsoleSink implements LogSink {
  constructor(private readonly stream: { write(chunk: string): unknown } = process.stdout) {}
  write(record: LogRecord): void {
    this.stream.write(JSON.stringify(record) + "\n");
  }
}

/** Collects records in memory. Used by tests and by the task log buffer. */
export class MemorySink implements LogSink {
  readonly records: LogRecord[] = [];
  constructor(private readonly limit = 10_000) {}
  write(record: LogRecord): void {
    this.records.push(record);
    if (this.records.length > this.limit) this.records.shift();
  }
  clear(): void {
    this.records.length = 0;
  }
}

export class MultiSink implements LogSink {
  constructor(private readonly sinks: LogSink[]) {}
  write(record: LogRecord): void {
    for (const s of this.sinks) s.write(record);
  }
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
  context?: LogContext;
  clock?: () => Date;
}

export class Logger {
  readonly level: LogLevel;
  readonly context: LogContext;
  private readonly sink: LogSink;
  private readonly clock: () => Date;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info";
    this.sink = options.sink ?? new JsonConsoleSink();
    this.context = options.context ?? {};
    this.clock = options.clock ?? (() => new Date());
  }

  child(context: LogContext): Logger {
    return new Logger({
      level: this.level,
      sink: this.sink,
      context: { ...this.context, ...context },
      clock: this.clock,
    });
  }

  withSink(sink: LogSink): Logger {
    return new Logger({ level: this.level, sink, context: this.context, clock: this.clock });
  }

  isEnabled(level: LogLevel): boolean {
    return SEVERITY[level] >= SEVERITY[this.level];
  }

  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (!this.isEnabled(level)) return;
    const record: LogRecord = {
      timestamp: this.clock().toISOString(),
      level,
      message: redactString(message),
      context: redact(this.context),
      ...(fields ? { fields: redact(fields) } : {}),
    };
    this.sink.write(record);
  }

  debug(message: string, fields?: Record<string, unknown>): void { this.log("debug", message, fields); }
  info(message: string, fields?: Record<string, unknown>): void { this.log("info", message, fields); }
  warn(message: string, fields?: Record<string, unknown>): void { this.log("warn", message, fields); }
  error(message: string, fields?: Record<string, unknown>): void { this.log("error", message, fields); }
}

/** Process-wide default. Apps replace the sink at startup. */
export const rootLogger = new Logger();
