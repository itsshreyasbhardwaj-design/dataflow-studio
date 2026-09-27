import { describe, expect, it } from "vitest";
import { makeBatch, type DataBatch } from "@dataflow-studio/schema-registry";
import { inferSchema } from "@dataflow-studio/schema-registry";
import { parseSelect } from "./parser.js";
import { runQuery } from "./execute.js";
import { SqlSyntaxError, tokenize } from "./tokenizer.js";
import { exprToString } from "./ast.js";

const batch = (rows: Array<Record<string, unknown>>): DataBatch => makeBatch(rows, inferSchema(rows));

const SALES = batch([
  { id: 1, customer_id: "c1", region: "north", amount: 100, status: "paid" },
  { id: 2, customer_id: "c1", region: "north", amount: 50.5, status: "paid" },
  { id: 3, customer_id: "c2", region: "south", amount: 200, status: "refunded" },
  { id: 4, customer_id: "c3", region: "south", amount: null, status: "paid" },
  { id: 5, customer_id: "c2", region: "east", amount: 25, status: "pending" },
]);

const CUSTOMERS = batch([
  { id: "c1", name: "Ada", tier: "gold" },
  { id: "c2", name: "Grace", tier: "silver" },
  { id: "c4", name: "Alan", tier: "gold" },
]);

const run = (sql: string, inputs: Record<string, DataBatch> = { input: SALES }) =>
  runQuery(sql, inputs, { now: new Date("2026-03-31T12:00:00Z") });

describe("tokenizer", () => {
  it("tokenizes keywords, identifiers and operators", () => {
    const tokens = tokenize("SELECT a.b, 'x' FROM t WHERE c >= 1.5");
    expect(tokens.map((t) => t.type).slice(0, 4)).toEqual(["keyword", "identifier", "punctuation", "identifier"]);
    expect(tokens.find((t) => t.type === "string")?.value).toBe("x");
    expect(tokens.find((t) => t.value === ">=")?.type).toBe("operator");
  });

  it("handles escaped quotes in strings", () => {
    expect(tokenize("SELECT 'it''s'")[1]!.value).toBe("it's");
  });

  it("strips line and block comments", () => {
    const tokens = tokenize("SELECT 1 -- ignored\n/* also ignored */ FROM t");
    expect(tokens.map((t) => t.value).filter(Boolean)).toEqual(["SELECT", "1", "FROM", "t"]);
  });

  it("rejects unterminated literals", () => {
    expect(() => tokenize("SELECT 'abc")).toThrow(SqlSyntaxError);
    expect(() => tokenize('SELECT "abc')).toThrow(SqlSyntaxError);
    expect(() => tokenize("SELECT 1 /* nope")).toThrow(SqlSyntaxError);
  });

  it("rejects stray characters", () => {
    expect(() => tokenize("SELECT a # b")).toThrow(/Unexpected character/);
  });
});

describe("parser", () => {
  it("parses a grouped aggregate query", () => {
    const statement = parseSelect(
      "SELECT customer_id, SUM(amount) AS revenue FROM input WHERE amount IS NOT NULL GROUP BY customer_id HAVING SUM(amount) > 10 ORDER BY revenue DESC LIMIT 5 OFFSET 1",
    );
    expect(statement.columns).toHaveLength(2);
    expect(statement.columns[1]!.alias).toBe("revenue");
    expect(statement.from?.name).toBe("input");
    expect(statement.groupBy.map(exprToString)).toEqual(["customer_id"]);
    expect(statement.having).toBeDefined();
    expect(statement.orderBy[0]).toMatchObject({ direction: "desc", nulls: "first" });
    expect(statement.limit).toBe(5);
    expect(statement.offset).toBe(1);
  });

  it("parses joins with aliases", () => {
    const statement = parseSelect("SELECT s.id FROM sales s LEFT OUTER JOIN customers c ON c.id = s.customer_id");
    expect(statement.from).toEqual({ name: "sales", alias: "s" });
    expect(statement.joins[0]).toMatchObject({ type: "left", table: { name: "customers", alias: "c" } });
  });

  it("parses USING and CROSS JOIN", () => {
    expect(parseSelect("SELECT * FROM a JOIN b USING (id)").joins[0]!.using).toEqual(["id"]);
    expect(parseSelect("SELECT * FROM a CROSS JOIN b").joins[0]!.type).toBe("cross");
  });

  it("respects operator precedence", () => {
    expect(exprToString(parseSelect("SELECT 1 + 2 * 3").columns[0]!.expr)).toBe("(1 + (2 * 3))");
    expect(exprToString(parseSelect("SELECT a OR b AND c").columns[0]!.expr)).toBe("(a OR (b AND c))");
    expect(exprToString(parseSelect("SELECT (1 + 2) * 3").columns[0]!.expr)).toBe("((1 + 2) * 3)");
  });

  it("parses IS NULL, IN, BETWEEN, LIKE and their negations", () => {
    expect(parseSelect("SELECT * FROM t WHERE a IS NOT NULL").where).toMatchObject({ kind: "isNull", negated: true });
    expect(parseSelect("SELECT * FROM t WHERE a NOT IN (1,2)").where).toMatchObject({ kind: "in", negated: true });
    expect(parseSelect("SELECT * FROM t WHERE a BETWEEN 1 AND 2").where).toMatchObject({ kind: "between" });
    expect(parseSelect("SELECT * FROM t WHERE a NOT ILIKE 'x%'").where).toMatchObject({ kind: "like", negated: true, caseInsensitive: true });
  });

  it("parses CASE and CAST", () => {
    expect(parseSelect("SELECT CASE WHEN a > 1 THEN 'big' ELSE 'small' END FROM t").columns[0]!.expr.kind).toBe("case");
    expect(parseSelect("SELECT CASE a WHEN 1 THEN 'one' END FROM t").columns[0]!.expr).toMatchObject({ kind: "case", operand: { kind: "column" } });
    expect(parseSelect("SELECT CAST(a AS integer) FROM t").columns[0]!.expr).toMatchObject({ kind: "cast", to: "integer" });
  });

  it("parses table.* and count(distinct x)", () => {
    expect(parseSelect("SELECT s.* FROM sales s").columns[0]!.expr).toEqual({ kind: "star", table: "s" });
    expect(parseSelect("SELECT COUNT(DISTINCT a) FROM t").columns[0]!.expr).toMatchObject({ kind: "function", distinct: true });
  });

  it("rejects anything that is not a single SELECT", () => {
    expect(() => parseSelect("DELETE FROM sales")).toThrow(/Expected SELECT/);
    expect(() => parseSelect("SELECT 1; DROP TABLE sales")).toThrow(/only a single SELECT/);
    expect(() => parseSelect("INSERT INTO t VALUES (1)")).toThrow(SqlSyntaxError);
    expect(() => parseSelect("UPDATE t SET a = 1")).toThrow(SqlSyntaxError);
    expect(() => parseSelect("WITH x AS (SELECT 1) SELECT * FROM x")).toThrow(/Common table expressions/);
    expect(() => parseSelect("SELECT * FROM (SELECT 1) t")).toThrow(/Subqueries are not supported/);
  });

  it("rejects a negative LIMIT", () => {
    expect(() => parseSelect("SELECT * FROM t LIMIT -1")).toThrow(/non-negative integer/);
  });

  it("reports the offset of a syntax error", () => {
    expect(() => parseSelect("SELECT FROM")).toThrow(/at offset/);
  });
});

describe("execute: projection and filtering", () => {
  it("selects all columns", () => {
    const result = run("SELECT * FROM input");
    expect(result.rowCount).toBe(5);
    expect(result.columns.map((c) => c.name)).toEqual(["id", "customer_id", "region", "amount", "status"]);
  });

  it("projects expressions with aliases", () => {
    const result = run("SELECT id, amount * 2 AS doubled FROM input WHERE id = 1");
    expect(result.rows).toEqual([{ id: 1, doubled: 200 }]);
  });

  it("filters with three-valued logic, excluding NULLs", () => {
    expect(run("SELECT id FROM input WHERE amount > 40").rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(run("SELECT id FROM input WHERE amount IS NULL").rows.map((r) => r.id)).toEqual([4]);
    expect(run("SELECT id FROM input WHERE NOT (amount > 40)").rows.map((r) => r.id)).toEqual([5]);
  });

  it("treats NOT IN with a NULL member as unknown", () => {
    expect(run("SELECT id FROM input WHERE status NOT IN ('paid', NULL)").rowCount).toBe(0);
    expect(run("SELECT id FROM input WHERE status IN ('paid', NULL)").rowCount).toBe(3);
  });

  it("supports LIKE and ILIKE", () => {
    expect(run("SELECT id FROM input WHERE status LIKE 'p%'").rowCount).toBe(4);
    expect(run("SELECT id FROM input WHERE region ILIKE 'NORTH'").rowCount).toBe(2);
    expect(run("SELECT id FROM input WHERE status LIKE 'pai_'").rowCount).toBe(3);
  });

  it("escapes regex metacharacters inside LIKE patterns", () => {
    const dots = batch([{ v: "a.c" }, { v: "abc" }]);
    expect(runQuery("SELECT v FROM input WHERE v LIKE 'a.c'", { input: dots }).rows).toEqual([{ v: "a.c" }]);
  });

  it("supports BETWEEN, CASE and COALESCE", () => {
    expect(run("SELECT id FROM input WHERE amount BETWEEN 25 AND 100").rows.map((r) => r.id)).toEqual([1, 2, 5]);
    expect(run("SELECT COALESCE(amount, 0) AS amt FROM input WHERE id = 4").rows).toEqual([{ amt: 0 }]);
    expect(run("SELECT CASE WHEN amount IS NULL THEN 'missing' WHEN amount > 100 THEN 'big' ELSE 'small' END AS size FROM input").rows.map((r) => r.size))
      .toEqual(["small", "small", "big", "missing", "small"]);
  });

  it("supports DISTINCT", () => {
    expect(run("SELECT DISTINCT region FROM input").rows).toEqual([{ region: "north" }, { region: "south" }, { region: "east" }]);
  });

  it("supports ORDER BY with PostgreSQL null ordering", () => {
    expect(run("SELECT id FROM input ORDER BY amount").rows.map((r) => r.id)).toEqual([5, 2, 1, 3, 4]);
    expect(run("SELECT id FROM input ORDER BY amount DESC").rows.map((r) => r.id)).toEqual([4, 3, 1, 2, 5]);
    expect(run("SELECT id FROM input ORDER BY amount NULLS FIRST").rows.map((r) => r.id)).toEqual([4, 5, 2, 1, 3]);
  });

  it("supports multi-key ORDER BY", () => {
    expect(run("SELECT id FROM input ORDER BY region ASC, amount DESC").rows.map((r) => r.id)).toEqual([5, 1, 2, 4, 3]);
  });

  it("supports LIMIT and OFFSET", () => {
    expect(run("SELECT id FROM input ORDER BY id LIMIT 2").rows.map((r) => r.id)).toEqual([1, 2]);
    expect(run("SELECT id FROM input ORDER BY id LIMIT 2 OFFSET 3").rows.map((r) => r.id)).toEqual([4, 5]);
  });

  it("orders by a column that is not selected", () => {
    expect(run("SELECT id FROM input ORDER BY status, id").rows.map((r) => r.id)).toEqual([1, 2, 4, 5, 3]);
  });

  it("evaluates a query with no FROM clause", () => {
    expect(runQuery("SELECT 1 + 1 AS two", {}).rows).toEqual([{ two: 2 }]);
  });
});

describe("execute: aggregates", () => {
  it("computes the documented revenue rollup", () => {
    const result = run(
      "SELECT customer_id, COUNT(*) AS order_count, SUM(amount) AS revenue FROM input GROUP BY customer_id ORDER BY customer_id",
    );
    expect(result.rows).toEqual([
      { customer_id: "c1", order_count: 2, revenue: 150.5 },
      { customer_id: "c2", order_count: 2, revenue: 225 },
      { customer_id: "c3", order_count: 1, revenue: null },
    ]);
  });

  it("ignores NULLs in SUM/AVG and counts only non-null in COUNT(col)", () => {
    const result = run("SELECT COUNT(*) AS rows_total, COUNT(amount) AS with_amount, AVG(amount) AS avg_amount FROM input");
    expect(result.rows[0]).toEqual({ rows_total: 5, with_amount: 4, avg_amount: 93.875 });
  });

  it("supports COUNT(DISTINCT x), MIN, MAX and STRING_AGG", () => {
    const result = run("SELECT COUNT(DISTINCT region) AS regions, MIN(amount) AS lo, MAX(amount) AS hi FROM input");
    expect(result.rows[0]).toEqual({ regions: 3, lo: 25, hi: 200 });
    expect(run("SELECT STRING_AGG(DISTINCT region, '|') AS r FROM input").rows[0]).toEqual({ r: "north|south|east" });
  });

  it("returns one row for a bare aggregate over zero rows", () => {
    const empty = batch([]);
    expect(runQuery("SELECT COUNT(*) AS n, SUM(amount) AS total FROM input", { input: empty }).rows)
      .toEqual([{ n: 0, total: null }]);
  });

  it("returns no rows for a grouped aggregate over zero rows", () => {
    expect(runQuery("SELECT region, COUNT(*) AS n FROM input GROUP BY region", { input: batch([]) }).rowCount).toBe(0);
  });

  it("filters groups with HAVING", () => {
    const result = run("SELECT region, COUNT(*) AS n FROM input GROUP BY region HAVING COUNT(*) > 1");
    expect(result.rows).toEqual([{ region: "north", n: 2 }, { region: "south", n: 2 }]);
  });

  it("groups by multiple keys", () => {
    const result = run("SELECT customer_id, region, SUM(amount) AS revenue FROM input GROUP BY customer_id, region ORDER BY customer_id, region");
    expect(result.rowCount).toBe(4);
  });

  it("rejects an ungrouped column", () => {
    expect(() => run("SELECT region, amount FROM input GROUP BY region")).toThrow(/must appear in GROUP BY/);
  });

  it("rejects SELECT * with GROUP BY", () => {
    expect(() => run("SELECT * FROM input GROUP BY region")).toThrow(/cannot be combined with GROUP BY/);
  });

  it("rejects an aggregate in WHERE", () => {
    expect(() => run("SELECT region FROM input WHERE SUM(amount) > 1 GROUP BY region")).toThrow(/not allowed in WHERE/);
  });

  it("allows an expression over a grouped column", () => {
    expect(run("SELECT UPPER(region) AS r, COUNT(*) AS n FROM input GROUP BY region ORDER BY r").rows[0]).toEqual({ r: "EAST", n: 1 });
  });

  it("rejects SUM over non-numeric data instead of silently producing NaN", () => {
    expect(() => run("SELECT SUM(status) AS s FROM input")).toThrow(/non-numeric/);
  });
});

describe("execute: joins", () => {
  const inputs = { sales: SALES, customers: CUSTOMERS };

  it("inner joins on an equality key", () => {
    const result = runQuery("SELECT s.id, c.name FROM sales s JOIN customers c ON c.id = s.customer_id ORDER BY s.id", inputs);
    expect(result.rows).toEqual([
      { id: 1, name: "Ada" }, { id: 2, name: "Ada" }, { id: 3, name: "Grace" }, { id: 5, name: "Grace" },
    ]);
  });

  it("left joins and fills unmatched rows with NULL", () => {
    const result = runQuery("SELECT s.id, c.name FROM sales s LEFT JOIN customers c ON c.id = s.customer_id ORDER BY s.id", inputs);
    expect(result.rows.find((r) => r.id === 4)).toEqual({ id: 4, name: null });
    expect(result.rowCount).toBe(5);
  });

  it("right joins and keeps unmatched right rows", () => {
    const result = runQuery("SELECT s.id, c.name FROM sales s RIGHT JOIN customers c ON c.id = s.customer_id", inputs);
    expect(result.rows.filter((r) => r.name === "Alan")).toEqual([{ id: null, name: "Alan" }]);
  });

  it("full joins from both sides", () => {
    const result = runQuery("SELECT s.id, c.name FROM sales s FULL JOIN customers c ON c.id = s.customer_id", inputs);
    expect(result.rowCount).toBe(6);
  });

  it("cross joins", () => {
    expect(runQuery("SELECT s.id, c.id AS cid FROM sales s CROSS JOIN customers c", inputs).rowCount).toBe(15);
  });

  it("joins with USING", () => {
    const left = batch([{ id: 1, v: "a" }, { id: 2, v: "b" }]);
    const right = batch([{ id: 2, w: "x" }]);
    expect(runQuery("SELECT id, v, w FROM l JOIN r USING (id)", { l: left, r: right }).rows).toEqual([{ id: 2, v: "b", w: "x" }]);
  });

  it("supports a non-equi join condition", () => {
    const a = batch([{ v: 1 }, { v: 5 }]);
    const b = batch([{ w: 3 }]);
    expect(runQuery("SELECT a.v, b.w FROM a JOIN b ON a.v < b.w", { a, b }).rows).toEqual([{ v: 1, w: 3 }]);
  });

  it("does not match NULL keys", () => {
    const left = batch([{ k: null, v: 1 }]);
    const right = batch([{ k: null, w: 2 }]);
    expect(runQuery("SELECT l.v FROM l JOIN r ON l.k = r.k", { l: left, r: right }).rowCount).toBe(0);
  });

  it("rejects an ambiguous unqualified column", () => {
    expect(() => runQuery("SELECT id FROM sales s JOIN customers c ON c.id = s.customer_id", inputs))
      .toThrow(/ambiguous/);
  });

  it("caps a runaway join", () => {
    const wide = batch(Array.from({ length: 200 }, (_, i) => ({ k: 1, i })));
    expect(() => runQuery("SELECT a.i FROM a CROSS JOIN b", { a: wide, b: wide }, { maxJoinRows: 100 }))
      .toThrow(/more than 100 rows/);
  });

  it("reports unknown tables with the available inputs", () => {
    expect(() => runQuery("SELECT * FROM ghosts", { input: SALES })).toThrow(/Available inputs: input/);
  });
});

describe("execute: scalar functions", () => {
  it.each([
    ["SELECT LOWER('AbC') AS v", "abc"],
    ["SELECT UPPER('abc') AS v", "ABC"],
    ["SELECT TRIM('  x  ') AS v", "x"],
    ["SELECT LENGTH('abcd') AS v", 4],
    ["SELECT SUBSTR('abcdef', 2, 3) AS v", "bcd"],
    ["SELECT LEFT('abcdef', 2) AS v", "ab"],
    ["SELECT RIGHT('abcdef', 2) AS v", "ef"],
    ["SELECT REPLACE('a-b-c', '-', '+') AS v", "a+b+c"],
    ["SELECT CONCAT('a', NULL, 'b') AS v", "ab"],
    ["SELECT CONCAT_WS('-', 'a', NULL, 'b') AS v", "a-b"],
    ["SELECT SPLIT_PART('a,b,c', ',', 2) AS v", "b"],
    ["SELECT ABS(-3) AS v", 3],
    ["SELECT ROUND(2.345, 2) AS v", 2.35],
    ["SELECT ROUND(2.5) AS v", 3],
    ["SELECT FLOOR(2.9) AS v", 2],
    ["SELECT CEIL(2.1) AS v", 3],
    ["SELECT MOD(7, 3) AS v", 1],
    ["SELECT POWER(2, 10) AS v", 1024],
    ["SELECT SQRT(9) AS v", 3],
    ["SELECT GREATEST(1, 9, 5) AS v", 9],
    ["SELECT LEAST(1, 9, NULL) AS v", 1],
    ["SELECT NULLIF('a', 'a') AS v", null],
    ["SELECT 'a' || 'b' AS v", "ab"],
    ["SELECT SIGN(-9) AS v", -1],
    ["SELECT POSITION('bc', 'abcd') AS v", 2],
  ])("%s", (sql, expected) => {
    expect(runQuery(sql, {}, { now: new Date("2026-03-31T12:00:00Z") }).rows[0]!["v"]).toEqual(expected);
  });

  it("uses a fixed clock for now()/current_date", () => {
    const result = runQuery("SELECT NOW() AS n, CURRENT_DATE AS d", {}, { now: new Date("2026-03-31T12:00:00Z") });
    expect(result.rows[0]).toEqual({ n: "2026-03-31T12:00:00.000Z", d: "2026-03-31" });
  });

  it("truncates dates", () => {
    const at = { now: new Date("2026-03-31T12:00:00Z") };
    expect(runQuery("SELECT DATE_TRUNC('month', '2026-03-17T05:04:03Z') AS v", {}, at).rows[0]!["v"]).toBe("2026-03-01T00:00:00.000Z");
    expect(runQuery("SELECT DATE_TRUNC('day', '2026-03-17T05:04:03Z') AS v", {}, at).rows[0]!["v"]).toBe("2026-03-17T00:00:00.000Z");
  });

  it("casts values", () => {
    expect(run("SELECT CAST('42' AS integer) AS v").rows[0]!["v"]).toBe(42);
    expect(run("SELECT CAST(1 AS boolean) AS v").rows[0]!["v"]).toBe(true);
    expect(run("SELECT CAST('2026-03-31T00:00:00Z' AS date) AS v").rows[0]!["v"]).toBe("2026-03-31");
    expect(() => run("SELECT CAST(1 AS blob) AS v")).toThrow(/Unsupported CAST target/);
  });

  it("propagates NULL through most functions", () => {
    expect(run("SELECT UPPER(NULL) AS v").rows[0]!["v"]).toBeNull();
    expect(run("SELECT NULL + 1 AS v").rows[0]!["v"]).toBeNull();
  });

  it("raises on division by zero rather than returning NULL", () => {
    expect(() => run("SELECT 1 / 0 AS v")).toThrow(/Division by zero/);
    expect(() => run("SELECT MOD(1, 0) AS v")).toThrow(/Division by zero/);
  });

  it("short-circuits AND so a guarded division is safe", () => {
    expect(run("SELECT id FROM input WHERE amount IS NOT NULL AND 100 / amount > 1").rowCount).toBeGreaterThan(0);
  });

  it("rejects an unknown function with a list of supported ones", () => {
    expect(() => run("SELECT PG_SLEEP(10) AS v")).toThrow(/Unknown function "PG_SLEEP"/);
  });

  it("checks function arity", () => {
    expect(() => run("SELECT ROUND(1, 2, 3) AS v")).toThrow(/expects 1-2 argument/);
  });

  it("reports an unknown column by name", () => {
    expect(() => run("SELECT nope FROM input")).toThrow(/Unknown column "nope"/);
  });
});

describe("execute: limits", () => {
  it("truncates at maxOutputRows and flags the batch", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ i }));
    const result = runQuery("SELECT i FROM input", { input: batch(rows) }, { maxOutputRows: 10 });
    expect(result.rowCount).toBe(10);
    expect(result.truncated).toBe(true);
  });

  it("does not flag a batch that fits", () => {
    expect(run("SELECT id FROM input").truncated).toBeUndefined();
  });
});
