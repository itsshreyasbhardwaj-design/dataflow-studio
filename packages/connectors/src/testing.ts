import type { Row } from "@dataflow-studio/schema-registry";
import type { NodeConfig } from "@dataflow-studio/workflow-engine";
import { ConnectorError } from "./types.js";
import type { SqlDriver, SqlDriverConnection } from "./sql-database.js";

interface MemoryTable {
  rows: Row[];
  columns: string[];
}

/**
 * An in-memory stand-in for a relational database.
 *
 * It understands exactly the statements {@link SqlDatabaseConnector} emits - no
 * more - which is the point: it lets the executor, retry logic and destination
 * write modes be tested end to end without a server, while the production path
 * stays a thin wrapper over the real driver. It is a test double, not a database:
 * arbitrary SQL is rejected rather than half-interpreted.
 */
export class MemorySqlDriver implements SqlDriver {
  readonly dialect: "postgres" | "mysql";
  readonly tables = new Map<string, MemoryTable>();
  readonly statements: string[] = [];
  /** Set to make the next N queries fail, for retry tests. */
  failNextQueries = 0;
  failureError: Error = new ConnectorError("connection reset by peer", "connection");

  private inTransaction = false;
  private snapshot: Map<string, MemoryTable> | null = null;

  constructor(options: { dialect?: "postgres" | "mysql"; tables?: Record<string, Row[]> } = {}) {
    this.dialect = options.dialect ?? "postgres";
    for (const [name, rows] of Object.entries(options.tables ?? {})) {
      this.tables.set(normalize(name), { rows: [...rows], columns: Object.keys(rows[0] ?? {}) });
    }
  }

  async connect(_config: NodeConfig, _signal?: AbortSignal): Promise<SqlDriverConnection> {
    const driver = this;
    return {
      async query(sql: string, params?: readonly unknown[]) {
        return driver.execute(sql, params ?? []);
      },
      async release() { /* nothing to release */ },
    };
  }

  async close(): Promise<void> {
    this.tables.clear();
  }

  rowsIn(table: string): Row[] {
    return this.tables.get(normalize(table))?.rows ?? [];
  }

  private execute(sql: string, params: readonly unknown[]): { rows: Row[]; rowCount: number; fields?: Array<{ name: string }> } {
    this.statements.push(sql);
    if (this.failNextQueries > 0 && !/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim())) {
      this.failNextQueries--;
      throw this.failureError;
    }
    const trimmed = sql.trim();

    if (/^SELECT 1 AS ok$/i.test(trimmed)) return { rows: [{ ok: 1 }], rowCount: 1 };

    if (/^BEGIN$/i.test(trimmed)) {
      this.inTransaction = true;
      this.snapshot = new Map([...this.tables].map(([k, v]) => [k, { rows: [...v.rows], columns: [...v.columns] }]));
      return { rows: [], rowCount: 0 };
    }
    if (/^COMMIT$/i.test(trimmed)) {
      this.inTransaction = false;
      this.snapshot = null;
      return { rows: [], rowCount: 0 };
    }
    if (/^ROLLBACK$/i.test(trimmed)) {
      if (this.snapshot) this.restore(this.snapshot);
      this.inTransaction = false;
      this.snapshot = null;
      return { rows: [], rowCount: 0 };
    }

    const create = trimmed.match(/^CREATE TABLE IF NOT EXISTS\s+(\S+)\s*\((.*)\)$/is);
    if (create) {
      const name = normalize(create[1]!);
      if (!this.tables.has(name)) {
        const columns = create[2]!.split(",").map((definition) => definition.trim().split(/\s+/)[0]!.replace(/["`]/g, ""));
        this.tables.set(name, { rows: [], columns });
      }
      return { rows: [], rowCount: 0 };
    }

    const truncate = trimmed.match(/^(?:TRUNCATE TABLE|DELETE FROM)\s+(\S+)$/i);
    if (truncate) {
      const table = this.table(truncate[1]!);
      const removed = table.rows.length;
      table.rows = [];
      return { rows: [], rowCount: removed };
    }

    const insert = trimmed.match(/^INSERT INTO\s+(\S+)\s*\(([^)]*)\)\s*VALUES\s*(.+?)(?:\s+ON (?:CONFLICT|DUPLICATE)(.*))?$/is);
    if (insert) return this.insert(insert, params);

    const select = trimmed.match(/^SELECT \* FROM\s+(\S+)(?:\s+WHERE\s+(\S+)\s*>\s*(?:\$1|\?))?(?:\s+ORDER BY\s+\S+\s+ASC)?(?:\s+LIMIT\s+(\d+))?$/i);
    if (select) {
      const table = this.table(select[1]!);
      let rows = [...table.rows];
      if (select[2]) {
        const column = select[2].replace(/["`]/g, "");
        const since = params[0];
        rows = rows.filter((row) => String(row[column] ?? "") > String(since ?? ""));
        rows.sort((a, b) => String(a[column] ?? "").localeCompare(String(b[column] ?? "")));
      }
      const limit = select[3] ? Number(select[3]) : rows.length;
      return {
        rows: rows.slice(0, limit),
        rowCount: Math.min(rows.length, limit),
        fields: table.columns.map((name) => ({ name })),
      };
    }

    throw new ConnectorError(
      `MemorySqlDriver received a statement it does not model: ${trimmed.slice(0, 120)}`,
      "configuration",
    );
  }

  private insert(match: RegExpMatchArray, params: readonly unknown[]): { rows: Row[]; rowCount: number } {
    const table = this.table(match[1]!, true);
    const columns = match[2]!.split(",").map((c) => c.trim().replace(/["`]/g, ""));
    const tupleCount = (match[3]!.match(/\(/g) ?? []).length;
    const conflict = match[4];

    const keyColumns = conflict?.match(/^\s*\(([^)]*)\)/)?.[1]
      ?.split(",")
      .map((c) => c.trim().replace(/["`]/g, ""));
    const doNothing = /DO NOTHING/i.test(conflict ?? "");

    let written = 0;
    for (let tuple = 0; tuple < tupleCount; tuple++) {
      const row: Row = {};
      columns.forEach((column, index) => {
        row[column] = params[tuple * columns.length + index] as Row[string];
      });

      if (keyColumns?.length) {
        const existing = table.rows.findIndex((candidate) =>
          keyColumns.every((key) => String(candidate[key] ?? "") === String(row[key] ?? "")),
        );
        if (existing >= 0) {
          if (!doNothing) table.rows[existing] = { ...table.rows[existing], ...row };
          written++;
          continue;
        }
      }
      table.rows.push(row);
      written++;
    }
    for (const column of columns) if (!table.columns.includes(column)) table.columns.push(column);
    return { rows: [], rowCount: written };
  }

  private table(rawName: string, create = false): MemoryTable {
    const name = normalize(rawName);
    const existing = this.tables.get(name);
    if (existing) return existing;
    if (!create) throw new ConnectorError(`relation "${name}" does not exist`, "not_found");
    const table: MemoryTable = { rows: [], columns: [] };
    this.tables.set(name, table);
    return table;
  }

  private restore(snapshot: Map<string, MemoryTable>): void {
    this.tables.clear();
    for (const [key, value] of snapshot) this.tables.set(key, value);
  }
}

function normalize(name: string): string {
  return name.replace(/["`]/g, "").toLowerCase();
}

/** In-memory FileStore for tests and for single-node deployments without object storage. */
export class MemoryFileStore {
  private readonly files = new Map<string, { content: Buffer; filename: string; contentType?: string }>();
  private counter = 0;

  async readFile(organizationId: string, fileId: string): Promise<{ content: Buffer; filename: string; contentType?: string }> {
    const entry = this.files.get(`${organizationId}/${fileId}`);
    if (!entry) throw new ConnectorError(`Uploaded file "${fileId}" was not found`, "not_found");
    return entry;
  }

  async writeFile(
    organizationId: string,
    filename: string,
    content: Buffer,
    contentType?: string,
  ): Promise<{ fileId: string; bytes: number }> {
    const fileId = `file_${++this.counter}`;
    this.files.set(`${organizationId}/${fileId}`, { content, filename, ...(contentType ? { contentType } : {}) });
    return { fileId, bytes: content.byteLength };
  }
}
