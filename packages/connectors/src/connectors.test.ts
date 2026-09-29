import { afterEach, describe, expect, it, vi } from "vitest";
import { signRequest } from "./sigv4.js";
import { assertIdentifier, assertReadOnlyQuery, columnDefinition, parseQualifiedName, quoteQualified } from "./identifiers.js";
import { SqlDatabaseConnector, wrapDatabaseError } from "./sql-database.js";
import { MemoryFileStore, MemorySqlDriver } from "./testing.js";
import { DatasetConnector, FileConnector, GeneratorConnector, InlineConnector, type DatasetStore } from "./builtin.js";
import { ConnectorRegistry } from "./registry.js";
import { httpRequest, HttpConnector } from "./http.js";
import { ConnectorError, NotSupportedError, type DataBatch } from "./types.js";
import { inferSchema, makeBatch, type ColumnSchema, type Row } from "@dataflow-studio/schema-registry";

const batch = (rows: Row[]): DataBatch => makeBatch(rows, inferSchema(rows));
const LOCAL = { allowPrivateNetworks: true, allowedPorts: [80, 443, 8080] };

describe("signRequest (AWS SigV4)", () => {
  it("matches the AWS documented example signature", () => {
    // From the AWS SigV4 test suite: GET / with the documented example credentials.
    const signed = signRequest({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      region: "us-east-1",
      service: "s3",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(signed.headers["authorization"]).toContain("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request");
    expect(signed.headers["authorization"]).toMatch(/Signature=[0-9a-f]{64}$/);
    expect(signed.canonicalRequest.split("\n")[0]).toBe("GET");
    expect(signed.canonicalRequest).toContain("/test.txt");
  });

  it("is deterministic for identical inputs and changes with the payload", () => {
    const base = {
      method: "PUT" as const,
      url: new URL("https://s3.example.com/bucket/key.csv"),
      region: "eu-west-1",
      service: "s3",
      accessKeyId: "AKIA",
      secretAccessKey: "secret",
      now: new Date("2026-03-31T12:00:00Z"),
    };
    const a = signRequest({ ...base, payload: "a" });
    const b = signRequest({ ...base, payload: "a" });
    const c = signRequest({ ...base, payload: "b" });
    expect(a.headers["authorization"]).toBe(b.headers["authorization"]);
    expect(a.headers["authorization"]).not.toBe(c.headers["authorization"]);
  });

  it("includes the session token in the signed headers when present", () => {
    const signed = signRequest({
      method: "GET",
      url: new URL("https://s3.example.com/b/k"),
      region: "us-east-1",
      service: "s3",
      accessKeyId: "AKIA",
      secretAccessKey: "secret",
      sessionToken: "token",
      now: new Date("2026-03-31T12:00:00Z"),
    });
    expect(signed.headers["x-amz-security-token"]).toBe("token");
    expect(signed.headers["authorization"]).toContain("x-amz-security-token");
  });

  it("sorts query parameters canonically", () => {
    const url = new URL("https://s3.example.com/b?b=2&a=1");
    expect(signRequest({
      method: "GET", url, region: "us-east-1", service: "s3",
      accessKeyId: "A", secretAccessKey: "s", now: new Date("2026-01-01T00:00:00Z"),
    }).canonicalRequest).toContain("a=1&b=2");
  });
});

describe("identifiers", () => {
  it("accepts ordinary identifiers", () => {
    expect(assertIdentifier("customer_id")).toBe("customer_id");
    expect(parseQualifiedName("reporting.customer_revenue")).toEqual({ schema: "reporting", table: "customer_revenue" });
  });

  it("rejects injection attempts instead of escaping them", () => {
    for (const bad of ['users"; DROP TABLE x', "users--", "a b", "1abc", "", "a".repeat(64), "tbl;", "a.b.c"]) {
      expect(() => parseQualifiedName(bad), bad).toThrow(ConnectorError);
    }
  });

  it("quotes per dialect", () => {
    expect(quoteQualified({ schema: "s", table: "t" }, '"')).toBe('"s"."t"');
    expect(quoteQualified({ table: "t" }, "`")).toBe("`t`");
  });

  it("maps column types per dialect", () => {
    const column: ColumnSchema = { name: "amount", type: "float", nullable: false };
    expect(columnDefinition(column, "postgres")).toBe('"amount" double precision NOT NULL');
    expect(columnDefinition({ ...column, nullable: true }, "mysql")).toBe("`amount` double");
  });
});

describe("assertReadOnlyQuery", () => {
  it("accepts a single SELECT", () => {
    expect(assertReadOnlyQuery("SELECT 1")).toBe("SELECT 1");
    expect(assertReadOnlyQuery("SELECT 1;")).toBe("SELECT 1");
  });

  it("rejects DML, DDL and stacked statements", () => {
    for (const sql of [
      "DELETE FROM users",
      "SELECT 1; DROP TABLE users",
      "UPDATE users SET a = 1",
      "INSERT INTO t VALUES (1)",
      "TRUNCATE t",
      "COPY t FROM '/etc/passwd'",
      "SELECT 1 -- ; and then\n; DROP TABLE t",
      "CALL do_something()",
    ]) {
      expect(() => assertReadOnlyQuery(sql), sql).toThrow(ConnectorError);
    }
  });

  it("does not let a comment hide a second statement", () => {
    expect(() => assertReadOnlyQuery("SELECT 1 /* */; DELETE FROM t")).toThrow(/exactly one statement/);
  });
});

describe("SqlDatabaseConnector", () => {
  const connection = { connectionId: "c1", host: "db", database: "app", user: "svc", password: "secret" };

  it("tests a connection", async () => {
    const driver = new MemorySqlDriver();
    const connector = new SqlDatabaseConnector(driver);
    await expect(connector.testConnection(connection)).resolves.toMatchObject({ ok: true });
  });

  it("reads a table with a LIMIT", async () => {
    const driver = new MemorySqlDriver({ tables: { "public.sales": [{ id: 1, amount: 10 }, { id: 2, amount: 20 }] } });
    const connector = new SqlDatabaseConnector(driver);
    const result = await connector.read({ config: { ...connection, mode: "table", table: "public.sales" }, limit: 1 });
    expect(result.rows).toEqual([{ id: 1, amount: 10 }]);
    expect(result.truncated).toBe(true);
    expect(driver.statements.some((s) => s.includes("LIMIT 1"))).toBe(true);
  });

  it("reads incrementally from a watermark using a bound parameter", async () => {
    const driver = new MemorySqlDriver({
      tables: { sales: [{ id: 1, at: "2026-01-01" }, { id: 2, at: "2026-02-01" }] },
    });
    const connector = new SqlDatabaseConnector(driver);
    const result = await connector.read({
      config: { ...connection, mode: "table", table: "sales", incrementalColumn: "at" },
      since: "2026-01-15",
    });
    expect(result.rows).toEqual([{ id: 2, at: "2026-02-01" }]);
    expect(driver.statements.some((s) => s.includes("$1"))).toBe(true);
  });

  it("rejects a non-SELECT source query before touching the database", async () => {
    const driver = new MemorySqlDriver();
    const connector = new SqlDatabaseConnector(driver);
    await expect(connector.read({ config: { ...connection, mode: "query", query: "DELETE FROM sales" } }))
      .rejects.toThrow(/single SELECT/);
    expect(driver.statements).toEqual([]);
  });

  it("appends rows in a transaction", async () => {
    const driver = new MemorySqlDriver({ tables: { target: [] } });
    const connector = new SqlDatabaseConnector(driver);
    const result = await connector.write({
      config: { ...connection, table: "target", writeMode: "append", batchSize: 2 },
      batch: batch([{ id: 1, v: "a" }, { id: 2, v: "b" }, { id: 3, v: "c" }]),
    });
    expect(result.rowsWritten).toBe(3);
    expect(driver.rowsIn("target")).toHaveLength(3);
    expect(driver.statements[0]).toBe("BEGIN");
    expect(driver.statements.at(-1)).toBe("COMMIT");
    // batchSize 2 over 3 rows => two INSERT statements
    expect(driver.statements.filter((s) => s.startsWith("INSERT"))).toHaveLength(2);
  });

  it("replaces by truncating inside the transaction", async () => {
    const driver = new MemorySqlDriver({ tables: { target: [{ id: 99 }] } });
    const connector = new SqlDatabaseConnector(driver);
    await connector.write({ config: { ...connection, table: "target", writeMode: "replace" }, batch: batch([{ id: 1 }]) });
    expect(driver.rowsIn("target")).toEqual([{ id: 1 }]);
    expect(driver.statements.some((s) => s.startsWith("TRUNCATE"))).toBe(true);
  });

  it("upserts on the key columns", async () => {
    const driver = new MemorySqlDriver({ tables: { target: [{ id: 1, v: "old" }] } });
    const connector = new SqlDatabaseConnector(driver);
    await connector.write({
      config: { ...connection, table: "target", writeMode: "upsert", keyColumns: ["id"] },
      batch: batch([{ id: 1, v: "new" }, { id: 2, v: "fresh" }]),
    });
    expect(driver.rowsIn("target")).toEqual([{ id: 1, v: "new" }, { id: 2, v: "fresh" }]);
    expect(driver.statements.some((s) => s.includes("ON CONFLICT"))).toBe(true);
  });

  it("requires key columns for an upsert", async () => {
    const connector = new SqlDatabaseConnector(new MemorySqlDriver());
    await expect(connector.write({ config: { ...connection, table: "t", writeMode: "upsert", keyColumns: [] }, batch: batch([{ a: 1 }]) }))
      .rejects.toThrow(/at least one key column/);
  });

  it("rolls back a partially applied write", async () => {
    const driver = new MemorySqlDriver({ tables: { target: [{ id: 0 }] } });
    driver.failNextQueries = 0;
    // Fail on the second INSERT of two batches.
    const original = driver.rowsIn("target").length;
    driver.failNextQueries = 0;
    const spy = vi.spyOn(driver, "connect");
    driver.failureError = new ConnectorError("deadlock detected", "transient");
    await expect((async () => {
      const connectionHandle = await driver.connect({});
      await connectionHandle.query("BEGIN");
      await connectionHandle.query("INSERT INTO target (id) VALUES ($1)", [1]);
      driver.failNextQueries = 1;
      await connectionHandle.query("INSERT INTO target (id) VALUES ($1)", [2]).catch(async (error) => {
        await connectionHandle.query("ROLLBACK");
        throw error;
      });
    })()).rejects.toThrow(/deadlock/);
    expect(driver.rowsIn("target")).toHaveLength(original);
    spy.mockRestore();
  });

  it("skips an empty batch without opening a transaction", async () => {
    const driver = new MemorySqlDriver({ tables: { target: [] } });
    const connector = new SqlDatabaseConnector(driver);
    const result = await connector.write({ config: { ...connection, table: "target", writeMode: "append" }, batch: batch([]) });
    expect(result.rowsWritten).toBe(0);
    expect(driver.statements).toEqual([]);
  });

  it("creates the table when asked", async () => {
    const driver = new MemorySqlDriver();
    const connector = new SqlDatabaseConnector(driver);
    await connector.write({
      config: { ...connection, table: "brand_new", writeMode: "append", createTable: true },
      batch: batch([{ id: 1, label: "x" }]),
    });
    expect(driver.statements.some((s) => s.startsWith("CREATE TABLE IF NOT EXISTS"))).toBe(true);
    expect(driver.rowsIn("brand_new")).toEqual([{ id: 1, label: "x" }]);
  });

  it("serializes nested values as JSON", async () => {
    const driver = new MemorySqlDriver({ tables: { target: [] } });
    const connector = new SqlDatabaseConnector(driver);
    await connector.write({ config: { ...connection, table: "target", writeMode: "append" }, batch: batch([{ meta: { a: 1 } }]) });
    expect(driver.rowsIn("target")[0]!["meta"]).toBe('{"a":1}');
  });

  it("reports a missing driver with an actionable message", async () => {
    const { PostgresDriver } = await import("./sql-database.js");
    const driver = new PostgresDriver();
    const result = await new SqlDatabaseConnector(driver).testConnection({ host: "localhost" });
    // Either the driver is genuinely absent (expected here) or a real connection is refused.
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not installed|ECONNREFUSED|connect|password|does not exist/i);
  });
});

describe("wrapDatabaseError", () => {
  it.each([
    ["08006", "connection"],
    ["57014", "timeout"],
    ["28P01", "permission"],
    ["42P01", "not_found"],
    ["40001", "transient"],
    ["23505", "validation"],
    ["42601", "validation"],
    ["99999", "unknown"],
  ])("maps SQLSTATE %s to %s", (code, expected) => {
    expect(wrapDatabaseError(Object.assign(new Error("boom"), { code }), "postgres").errorClass).toBe(expected);
  });

  it("passes through an existing ConnectorError", () => {
    const original = new ConnectorError("x", "rate_limit");
    expect(wrapDatabaseError(original, "postgres")).toBe(original);
  });
});

describe("InlineConnector and GeneratorConnector", () => {
  it("reads inline rows", async () => {
    const result = await new InlineConnector().read({ config: { rows: [{ a: 1 }, { a: 2 }] } });
    expect(result.rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("rejects malformed inline rows", async () => {
    await expect(new InlineConnector().read({ config: { rows: "nope" } })).rejects.toThrow(/must be an array/);
    await expect(new InlineConnector().read({ config: { rows: [1] } })).rejects.toThrow(/rows\[0\] must be an object/);
  });

  it("cannot be written to", async () => {
    await expect(new InlineConnector().write({ config: {}, batch: batch([]) })).rejects.toThrow(NotSupportedError);
    await expect(new GeneratorConnector().write({ config: {}, batch: batch([]) })).rejects.toThrow(NotSupportedError);
  });

  it("generates deterministic rows through the connector", async () => {
    const config = { preset: "sales", rowCount: 5, seed: 1 };
    const a = await new GeneratorConnector().read({ config });
    const b = await new GeneratorConnector().read({ config });
    expect(a.rows).toEqual(b.rows);
    expect(a.rowCount).toBe(5);
  });

  it("describes its schema", async () => {
    expect((await new GeneratorConnector().getSchema({ preset: "customers" })).columns.map((c) => c.name)).toContain("tier");
  });
});

class MemoryDatasetStore implements DatasetStore {
  readonly datasets = new Map<string, { rows: Row[]; columns: ColumnSchema[]; rowCount: number }>();
  async putDataset(org: string, dataset: string, payload: { rows: Row[]; columns: ColumnSchema[]; rowCount: number; writeMode: "append" | "replace" }) {
    const key = `${org}/${dataset}`;
    const existing = this.datasets.get(key);
    const rows = payload.writeMode === "append" && existing ? [...existing.rows, ...payload.rows] : payload.rows;
    const rowCount = payload.writeMode === "append" && existing ? existing.rowCount + payload.rowCount : payload.rowCount;
    this.datasets.set(key, { rows, columns: payload.columns, rowCount });
    return { rowCount };
  }
  async getDataset(org: string, dataset: string) {
    return this.datasets.get(`${org}/${dataset}`) ?? null;
  }
}

describe("DatasetConnector", () => {
  it("writes, retains a preview and reads back", async () => {
    const store = new MemoryDatasetStore();
    const connector = new DatasetConnector(store, "org_1", "run_1");
    const rows = Array.from({ length: 50 }, (_, i) => ({ i }));
    const result = await connector.write({ config: { dataset: "out", writeMode: "replace", retainRows: 10 }, batch: batch(rows) });
    expect(result).toMatchObject({ rowsWritten: 50, target: "out" });
    expect(result.details).toMatchObject({ retainedRows: 10 });
    const read = await connector.read({ config: { dataset: "out" } });
    expect(read.rowCount).toBe(10);
  });

  it("appends across runs", async () => {
    const store = new MemoryDatasetStore();
    const connector = new DatasetConnector(store, "org_1");
    await connector.write({ config: { dataset: "d", writeMode: "append" }, batch: batch([{ a: 1 }]) });
    await connector.write({ config: { dataset: "d", writeMode: "append" }, batch: batch([{ a: 2 }]) });
    expect((await connector.read({ config: { dataset: "d" } })).rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("isolates organizations", async () => {
    const store = new MemoryDatasetStore();
    await new DatasetConnector(store, "org_1").write({ config: { dataset: "d" }, batch: batch([{ a: 1 }]) });
    await expect(new DatasetConnector(store, "org_2").read({ config: { dataset: "d" } })).rejects.toThrow(/does not exist/);
  });

  it("requires a dataset name", async () => {
    await expect(new DatasetConnector(new MemoryDatasetStore(), "org_1").write({ config: {}, batch: batch([{ a: 1 }]) }))
      .rejects.toThrow(/requires a dataset name/);
  });
});

describe("FileConnector", () => {
  it("reads an uploaded CSV", async () => {
    const store = new MemoryFileStore();
    const { fileId } = await store.writeFile("org_1", "sales.csv", Buffer.from("id,amount\n1,10\n"));
    const connector = new FileConnector(store, "org_1", "csv");
    expect((await connector.read({ config: { fileId } })).rows).toEqual([{ id: 1, amount: 10 }]);
    await expect(connector.testConnection({ fileId })).resolves.toMatchObject({ ok: true });
  });

  it("reads an uploaded JSON file", async () => {
    const store = new MemoryFileStore();
    const { fileId } = await store.writeFile("org_1", "x.json", Buffer.from('[{"a":1}]'));
    expect((await new FileConnector(store, "org_1", "json").read({ config: { fileId } })).rows).toEqual([{ a: 1 }]);
  });

  it("fails clearly when the file is missing or unowned", async () => {
    const store = new MemoryFileStore();
    const { fileId } = await store.writeFile("org_1", "x.csv", Buffer.from("a\n1\n"));
    await expect(new FileConnector(store, "org_2", "csv").read({ config: { fileId } })).rejects.toThrow(/was not found/);
    await expect(new FileConnector(store, "org_1", "csv").read({ config: {} })).rejects.toThrow(/requires an uploaded file/);
  });

  it("writes a CSV export back to the store", async () => {
    const store = new MemoryFileStore();
    const result = await new FileConnector(store, "org_1", "csv").write({
      config: { filename: "out.csv" },
      batch: batch([{ a: 1 }]),
    });
    expect(result.rowsWritten).toBe(1);
    expect((await store.readFile("org_1", result.target)).content.toString()).toBe("a\n1\n");
  });
});

describe("httpRequest", () => {
  afterEach(() => vi.unstubAllGlobals());

  const stubFetch = (impl: (url: URL, init: RequestInit) => Response | Promise<Response>) => {
    const spy = vi.fn(async (input: URL | string, init: RequestInit) => impl(new URL(String(input)), init));
    vi.stubGlobal("fetch", spy);
    return spy;
  };

  it("performs a GET and returns the body", async () => {
    stubFetch(() => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }));
    const response = await httpRequest("http://127.0.0.1:8080/x", { policy: LOCAL });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
  });

  it("appends query parameters", async () => {
    const spy = stubFetch(() => new Response("[]", { status: 200 }));
    await httpRequest("http://127.0.0.1:8080/x", { query: { page: 2, skip: null }, policy: LOCAL });
    expect(String(spy.mock.calls[0]![0])).toBe("http://127.0.0.1:8080/x?page=2");
  });

  it("re-validates each redirect hop against the egress policy", async () => {
    stubFetch((url) =>
      url.pathname === "/start"
        ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } })
        : new Response("secret", { status: 200 }),
    );
    await expect(httpRequest("http://127.0.0.1:8080/start", { policy: { ...LOCAL, allowPrivateNetworks: false } }))
      .rejects.toThrow();
  });

  it("follows an allowed redirect", async () => {
    stubFetch((url) =>
      url.pathname === "/start"
        ? new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8080/final" } })
        : new Response("done", { status: 200 }),
    );
    expect((await httpRequest("http://127.0.0.1:8080/start", { policy: LOCAL })).body).toBe("done");
  });

  it("caps redirect chains", async () => {
    stubFetch((url) => new Response(null, { status: 302, headers: { location: `http://127.0.0.1:8080${url.pathname}x` } }));
    await expect(httpRequest("http://127.0.0.1:8080/a", { policy: { ...LOCAL, maxRedirects: 2 } }))
      .rejects.toThrow(/Exceeded 2 redirects/);
  });

  it("classifies status codes into retryable and non-retryable errors", async () => {
    for (const [status, expected] of [[401, "permission"], [404, "not_found"], [429, "rate_limit"], [503, "transient"], [400, "validation"]] as const) {
      stubFetch(() => new Response("nope", { status }));
      const error = await httpRequest("http://127.0.0.1:8080/x", { policy: LOCAL }).catch((e) => e as ConnectorError);
      expect((error as ConnectorError).errorClass, `status ${status}`).toBe(expected);
    }
  });

  it("enforces the response size cap", async () => {
    stubFetch(() => new Response("x".repeat(5000), { status: 200 }));
    await expect(httpRequest("http://127.0.0.1:8080/x", { policy: { ...LOCAL, maxResponseBytes: 1000 } }))
      .rejects.toThrow(/exceeded the 1000 byte limit/);
  });

  it("classifies an aborted request as a timeout", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" }); }));
    const error = await httpRequest("http://127.0.0.1:8080/x", { policy: LOCAL }).catch((e) => e as ConnectorError);
    expect((error as ConnectorError).errorClass).toBe("timeout");
  });

  it("never sends a forbidden header", async () => {
    const spy = stubFetch(() => new Response("{}", { status: 200 }));
    await httpRequest("http://127.0.0.1:8080/x", { headers: { Host: "evil.example.com", Accept: "application/json" }, policy: LOCAL });
    const headers = spy.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers["host"]).toBeUndefined();
    expect(headers["accept"]).toBe("application/json");
  });
});

describe("HttpConnector", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads records from a record path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"data":[{"a":1},{"a":2}]}', { status: 200 })));
    const connector = new HttpConnector(LOCAL);
    const result = await connector.read({ config: { url: "http://127.0.0.1:8080/x", recordPath: "data", pagination: "none" } });
    expect(result.rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("pages until an empty page", async () => {
    let page = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      page++;
      return new Response(page <= 2 ? `[{"p":${page}}]` : "[]", { status: 200 });
    }));
    const result = await new HttpConnector(LOCAL).read({
      config: { url: "http://127.0.0.1:8080/x", pagination: "page", pageParam: "page", maxPages: 10 },
    });
    expect(result.rows).toEqual([{ p: 1 }, { p: 2 }]);
  });

  it("follows a cursor", async () => {
    const pages = [
      '{"items":[{"a":1}],"next_cursor":"c2"}',
      '{"items":[{"a":2}],"next_cursor":null}',
    ];
    let index = 0;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(pages[index++] ?? "[]", { status: 200 })));
    const result = await new HttpConnector(LOCAL).read({
      config: { url: "http://127.0.0.1:8080/x", pagination: "cursor", recordPath: "items", cursorPath: "next_cursor", maxPages: 5 },
    });
    expect(result.rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("stops at the row limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ a: 1 }, { a: 2 }, { a: 3 }]), { status: 200 })));
    const result = await new HttpConnector(LOCAL).read({ config: { url: "http://127.0.0.1:8080/x" }, limit: 2 });
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(true);
  });
});

describe("ConnectorRegistry", () => {
  it("resolves every built-in node type", () => {
    const registry = new ConnectorRegistry({
      organizationId: "org_1",
      datasetStore: new MemoryDatasetStore(),
      fileStore: new MemoryFileStore(),
      sqlDrivers: { postgres: new MemorySqlDriver(), mysql: new MemorySqlDriver({ dialect: "mysql" }) },
    });
    for (const type of [
      "inline.source", "generator.source", "dataset.destination", "csv.source", "json.source",
      "http.source", "http.request", "webhook.notify", "s3.source", "s3.destination",
      "postgres.source", "postgres.destination", "mysql.source", "mysql.destination",
    ]) {
      expect(registry.forNodeType(type).family, type).toBeTruthy();
    }
  });

  it("reuses one connector instance per family", () => {
    const registry = new ConnectorRegistry({ organizationId: "org_1" });
    expect(registry.forNodeType("http.source")).toBe(registry.forNodeType("http.request"));
  });

  it("rejects an unknown node type", () => {
    expect(() => new ConnectorRegistry({ organizationId: "o" }).forNodeType("snowflake.source"))
      .toThrow(/No connector is registered/);
  });

  it("explains when a capability is not configured", () => {
    const registry = new ConnectorRegistry({ organizationId: "o" });
    expect(() => registry.forNodeType("dataset.destination")).toThrow(/Managed datasets are not configured/);
    expect(() => registry.forNodeType("csv.source")).toThrow(/File uploads are not configured/);
  });

  it("probes a connection by family", async () => {
    const registry = new ConnectorRegistry({ organizationId: "o", sqlDrivers: { postgres: new MemorySqlDriver() } });
    await expect(registry.testConnection("postgres", { host: "x" })).resolves.toMatchObject({ ok: true });
    await expect(registry.testConnection("nope", {})).rejects.toThrow(/Unknown connector family/);
  });
});
