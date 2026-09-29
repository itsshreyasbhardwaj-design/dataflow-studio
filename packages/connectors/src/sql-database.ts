import { inferSchema, makeBatch, type ColumnSchema, type DataBatch, type Row } from "@dataflow-studio/schema-registry";
import type { NodeConfig } from "@dataflow-studio/workflow-engine";
import {
  assertReadOnlyQuery, columnDefinition, parseQualifiedName, quoteIdentifier, quoteQualified,
} from "./identifiers.js";
import { ConnectorError, describeError, type ConnectionResult, type DataConnector, type DataSchemaDescriptor, type ReadRequest, type WriteRequest, type WriteResult } from "./types.js";

/**
 * Minimal driver surface. Both the real drivers and the in-memory test double
 * implement it, which is what lets the executor be tested end-to-end without a
 * database while the production path stays a thin wrapper over `pg`/`mysql2`.
 */
export interface SqlDriverConnection {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number; fields?: Array<{ name: string }> }>;
  release(): Promise<void>;
}

export interface SqlDriver {
  readonly dialect: "postgres" | "mysql";
  connect(config: NodeConfig, signal?: AbortSignal): Promise<SqlDriverConnection>;
  close(): Promise<void>;
}

/**
 * Loads an optional driver. The specifier is held in a variable so that the
 * bundler and the type checker do not require the package to be present: a
 * deployment that only uses HTTP and object storage should not have to install
 * a PostgreSQL client.
 */
async function loadOptional<T>(specifier: string): Promise<T> {
  return (await import(specifier)) as T;
}

const MISSING_DRIVER_HINT = (pkg: string): string =>
  `The "${pkg}" driver is not installed. Add it to the worker image with \`pnpm add ${pkg}\` ` +
  `(it is an optional peer dependency so that deployments that do not use this connector stay lean).`;

/** Lazily loads `pg`, so a deployment that never touches PostgreSQL need not ship it. */
export class PostgresDriver implements SqlDriver {
  readonly dialect = "postgres" as const;
  private pool: { connect(): Promise<unknown>; end(): Promise<void> } | null = null;
  private poolKey: string | null = null;

  async connect(config: NodeConfig, _signal?: AbortSignal): Promise<SqlDriverConnection> {
    interface PgModule {
      Pool: new (options: Record<string, unknown>) => {
        connect(): Promise<{
          query(sql: string, params?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number | null; fields?: Array<{ name: string }> }>;
          release(): void;
        }>;
        end(): Promise<void>;
      };
    }
    let pg: PgModule;
    try {
      pg = await loadOptional<PgModule>("pg");
    } catch (error) {
      throw new ConnectorError(MISSING_DRIVER_HINT("pg"), "configuration", { cause: error });
    }

    const options = {
      ...(config["connectionString"] ? { connectionString: String(config["connectionString"]) } : {}),
      ...(config["host"] ? { host: String(config["host"]) } : {}),
      ...(config["port"] ? { port: Number(config["port"]) } : {}),
      ...(config["database"] ? { database: String(config["database"]) } : {}),
      ...(config["user"] ? { user: String(config["user"]) } : {}),
      ...(config["password"] ? { password: String(config["password"]) } : {}),
      ...(config["ssl"] !== undefined ? { ssl: config["ssl"] === false ? false : { rejectUnauthorized: config["sslRejectUnauthorized"] !== false } } : {}),
      max: Number(config["poolSize"] ?? 4),
      statement_timeout: Number(config["statementTimeoutSeconds"] ?? 300) * 1000,
      application_name: "dataflow-studio-worker",
    };
    const key = JSON.stringify(options);
    if (!this.pool || this.poolKey !== key) {
      if (this.pool) await this.pool.end().catch(() => undefined);
      this.pool = new pg.Pool(options) as never;
      this.poolKey = key;
    }

    const client = (await (this.pool as { connect(): Promise<unknown> }).connect()) as {
      query(sql: string, params?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number | null; fields?: Array<{ name: string }> }>;
      release(): void;
    };
    return {
      async query(sql, params) {
        const result = await client.query(sql, params);
        return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length, ...(result.fields ? { fields: result.fields } : {}) };
      },
      async release() { client.release(); },
    };
  }

  async close(): Promise<void> {
    await this.pool?.end().catch(() => undefined);
    this.pool = null;
  }
}

export class MySqlDriver implements SqlDriver {
  readonly dialect = "mysql" as const;
  private pool: { getConnection(): Promise<unknown>; end(): Promise<void> } | null = null;

  async connect(config: NodeConfig, _signal?: AbortSignal): Promise<SqlDriverConnection> {
    interface MySqlModule {
      createPool(options: Record<string, unknown>): {
        getConnection(): Promise<{
          query(sql: string, params?: readonly unknown[]): Promise<[Row[], Array<{ name: string }>]>;
          release(): void;
        }>;
        end(): Promise<void>;
      };
    }
    let mysql: MySqlModule;
    try {
      mysql = await loadOptional<MySqlModule>("mysql2/promise");
    } catch (error) {
      throw new ConnectorError(MISSING_DRIVER_HINT("mysql2"), "configuration", { cause: error });
    }
    this.pool ??= mysql.createPool({
      ...(config["host"] ? { host: String(config["host"]) } : {}),
      ...(config["port"] ? { port: Number(config["port"]) } : {}),
      ...(config["database"] ? { database: String(config["database"]) } : {}),
      ...(config["user"] ? { user: String(config["user"]) } : {}),
      ...(config["password"] ? { password: String(config["password"]) } : {}),
      connectionLimit: Number(config["poolSize"] ?? 4),
      namedPlaceholders: false,
      dateStrings: true,
    });

    const connection = (await this.pool.getConnection()) as {
      query(sql: string, params?: readonly unknown[]): Promise<[Row[], Array<{ name: string }>]>;
      release(): void;
    };
    return {
      async query(sql, params) {
        const [rows, fields] = await connection.query(sql, params ?? []);
        const list = Array.isArray(rows) ? rows : [];
        return { rows: list, rowCount: list.length, ...(fields ? { fields } : {}) };
      },
      async release() { connection.release(); },
    };
  }

  async close(): Promise<void> {
    await this.pool?.end().catch(() => undefined);
    this.pool = null;
  }
}

export interface SqlConnectorOptions {
  maxBatchSize?: number;
}

/**
 * Shared implementation for relational sources and destinations. The dialect
 * differences (placeholders, quoting, upsert syntax) are isolated to a handful of
 * methods so that adding another SQL database is a small, reviewable change.
 */
export class SqlDatabaseConnector implements DataConnector {
  readonly family: "postgres" | "mysql";
  private readonly quote: '"' | "`";

  constructor(private readonly driver: SqlDriver, private readonly options: SqlConnectorOptions = {}) {
    this.family = driver.dialect;
    this.quote = driver.dialect === "postgres" ? '"' : "`";
  }

  private placeholder(index: number): string {
    return this.driver.dialect === "postgres" ? `$${index}` : "?";
  }

  async testConnection(config: NodeConfig, signal?: AbortSignal): Promise<ConnectionResult> {
    const startedAt = Date.now();
    let connection: SqlDriverConnection | undefined;
    try {
      connection = await this.driver.connect(config, signal);
      const result = await connection.query("SELECT 1 AS ok");
      return {
        ok: result.rows.length === 1,
        latencyMs: Date.now() - startedAt,
        message: `Connected to ${this.family}`,
      };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - startedAt, message: describeError(error) };
    } finally {
      await connection?.release().catch(() => undefined);
    }
  }

  async read(request: ReadRequest): Promise<DataBatch> {
    const config = request.config;
    const limit = Math.max(1, request.limit ?? Number(config["limit"] ?? 100_000));
    const mode = String(config["mode"] ?? "table");

    let sql: string;
    const params: unknown[] = [];

    if (mode === "query") {
      const inner = assertReadOnlyQuery(String(config["query"] ?? ""));
      sql = `SELECT * FROM (${inner}) AS dataflow_source LIMIT ${limit}`;
    } else {
      const table = quoteQualified(parseQualifiedName(String(config["table"] ?? "")), this.quote);
      const incremental = config["incrementalColumn"] ? String(config["incrementalColumn"]) : null;
      if (incremental && request.since !== undefined && request.since !== null) {
        const column = quoteIdentifier(incremental, this.quote);
        params.push(request.since);
        sql = `SELECT * FROM ${table} WHERE ${column} > ${this.placeholder(1)} ORDER BY ${column} ASC LIMIT ${limit}`;
      } else if (incremental) {
        const column = quoteIdentifier(incremental, this.quote);
        sql = `SELECT * FROM ${table} ORDER BY ${column} ASC LIMIT ${limit}`;
      } else {
        sql = `SELECT * FROM ${table} LIMIT ${limit}`;
      }
    }

    const connection = await this.driver.connect(config, request.signal);
    try {
      const result = await connection.query(sql, params);
      const rows = result.rows.map(normalizeRow);
      const columns = rows.length
        ? inferSchema(rows)
        : (result.fields ?? []).map<ColumnSchema>((f) => ({ name: f.name, type: "unknown", nullable: true }));
      return makeBatch(rows, columns, {
        ...(rows.length >= limit ? { truncated: true } : {}),
        ...(config["dataset"] ? { dataset: String(config["dataset"]) } : {}),
      });
    } catch (error) {
      throw wrapDatabaseError(error, this.family);
    } finally {
      await connection.release().catch(() => undefined);
    }
  }

  async write(request: WriteRequest): Promise<WriteResult> {
    const config = request.config;
    const qualified = parseQualifiedName(String(config["table"] ?? ""));
    const table = quoteQualified(qualified, this.quote);
    const writeMode = String(config["writeMode"] ?? "append");
    const batchSize = Math.min(Number(config["batchSize"] ?? 1000), this.options.maxBatchSize ?? 10_000);
    const keyColumns = Array.isArray(config["keyColumns"]) ? (config["keyColumns"] as string[]) : [];

    if (writeMode === "upsert" && keyColumns.length === 0) {
      throw new ConnectorError("Upsert requires at least one key column", "configuration");
    }
    if (!request.batch.rowCount) {
      return { rowsWritten: 0, target: `${qualified.schema ? `${qualified.schema}.` : ""}${qualified.table}`, details: { skipped: "empty batch" } };
    }

    const columns = request.batch.columns.length
      ? request.batch.columns
      : inferSchema(request.batch.rows);
    const columnNames = columns.map((c) => c.name);
    const quotedColumns = columnNames.map((name) => quoteIdentifier(name, this.quote)).join(", ");

    const connection = await this.driver.connect(config, request.signal);
    let written = 0;
    try {
      await connection.query("BEGIN");

      if (config["createTable"] === true) {
        const definitions = columns.map((c) => columnDefinition(c, this.driver.dialect)).join(", ");
        await connection.query(`CREATE TABLE IF NOT EXISTS ${table} (${definitions})`);
      }
      if (writeMode === "replace") {
        // TRUNCATE inside the transaction: an aborted load leaves the old data intact.
        await connection.query(
          this.driver.dialect === "postgres" ? `TRUNCATE TABLE ${table}` : `DELETE FROM ${table}`,
        );
      }

      for (let offset = 0; offset < request.batch.rows.length; offset += batchSize) {
        request.signal?.throwIfAborted();
        const slice = request.batch.rows.slice(offset, offset + batchSize);
        const params: unknown[] = [];
        const tuples = slice.map((row) => {
          const placeholders = columnNames.map((name) => {
            params.push(serializeValue(row[name]));
            return this.placeholder(params.length);
          });
          return `(${placeholders.join(", ")})`;
        });

        let sql = `INSERT INTO ${table} (${quotedColumns}) VALUES ${tuples.join(", ")}`;
        if (writeMode === "upsert") {
          const keys = keyColumns.map((name) => quoteIdentifier(name, this.quote)).join(", ");
          const updates = columnNames
            .filter((name) => !keyColumns.includes(name))
            .map((name) => {
              const quoted = quoteIdentifier(name, this.quote);
              return this.driver.dialect === "postgres"
                ? `${quoted} = EXCLUDED.${quoted}`
                : `${quoted} = VALUES(${quoted})`;
            });
          if (this.driver.dialect === "postgres") {
            sql += updates.length
              ? ` ON CONFLICT (${keys}) DO UPDATE SET ${updates.join(", ")}`
              : ` ON CONFLICT (${keys}) DO NOTHING`;
          } else {
            sql += updates.length ? ` ON DUPLICATE KEY UPDATE ${updates.join(", ")}` : "";
          }
        }

        const result = await connection.query(sql, params);
        written += result.rowCount || slice.length;
      }

      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK").catch(() => undefined);
      throw wrapDatabaseError(error, this.family);
    } finally {
      await connection.release().catch(() => undefined);
    }

    return {
      rowsWritten: written,
      target: `${qualified.schema ? `${qualified.schema}.` : ""}${qualified.table}`,
      details: { writeMode, batchSize },
    };
  }

  async getSchema(config: NodeConfig, signal?: AbortSignal): Promise<DataSchemaDescriptor> {
    const batch = await this.read({ config, limit: 200, ...(signal ? { signal } : {}) });
    const table = String(config["table"] ?? config["query"] ?? "");
    return { columns: batch.columns, source: table };
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}

function normalizeRow(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Date ? value.toISOString() : (value as Row[string]);
  }
  return out;
}

function serializeValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value !== null && typeof value === "object" && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    return JSON.stringify(value);
  }
  return value;
}

export function wrapDatabaseError(error: unknown, family: string): ConnectorError {
  if (error instanceof ConnectorError) return error;
  const message = (error as Error)?.message ?? String(error);
  const code = (error as { code?: string })?.code ?? "";

  // PostgreSQL SQLSTATE classes we can act on.
  const classify = (): ConnectorError["errorClass"] => {
    if (/^08/.test(code) || /ECONNREFUSED|ENOTFOUND|ECONNRESET|EHOSTUNREACH/.test(code)) return "connection";
    if (code === "57014" || /timeout/i.test(message)) return "timeout";
    if (/^28/.test(code) || /^42501$/.test(code) || /permission denied|access denied/i.test(message)) return "permission";
    if (code === "42P01" || code === "42703" || /ER_NO_SUCH_TABLE|ER_BAD_FIELD_ERROR/.test(code)) return "not_found";
    if (code === "40001" || code === "40P01" || /deadlock|serialization failure/i.test(message)) return "transient";
    if (/^23/.test(code)) return "validation";
    if (/^42/.test(code)) return "validation";
    return "unknown";
  };

  return new ConnectorError(`${family}: ${message}`, classify(), { cause: error });
}
