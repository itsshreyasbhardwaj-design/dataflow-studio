import type {
  BinaryOperator, Expr, JoinClause, JoinType, OrderTerm, SelectColumn, SelectStatement, TableRef,
} from "./ast.js";
import { SqlSyntaxError, tokenize, type Token } from "./tokenizer.js";

/** Reserved words that double as function names. */
const FUNCTION_KEYWORDS = new Set(["LEFT", "RIGHT"]);
/** Functions callable without parentheses, as in PostgreSQL. */
const NILADIC_FUNCTIONS = new Set(["CURRENT_DATE", "CURRENT_TIMESTAMP"]);

/** Binding powers. Higher binds tighter. */
const PRECEDENCE: Record<string, number> = {
  OR: 1, AND: 2,
  "=": 4, "<>": 4, "<": 4, "<=": 4, ">": 4, ">=": 4,
  "||": 5,
  "+": 6, "-": 6,
  "*": 7, "/": 7, "%": 7,
};

/**
 * A Pratt parser for the SELECT subset DataFlow supports. Only SELECT is
 * accepted: a transformation node must not be able to issue DDL or DML, and the
 * cleanest way to guarantee that is a grammar that cannot express it.
 */
export class SqlParser {
  private position = 0;
  private readonly tokens: Token[];

  constructor(sql: string) {
    this.tokens = tokenize(sql);
  }

  static parse(sql: string): SelectStatement {
    return new SqlParser(sql).parseStatement();
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.position + offset, this.tokens.length - 1)]!;
  }

  private next(): Token {
    const token = this.peek();
    if (token.type !== "eof") this.position++;
    return token;
  }

  private at(upper: string): boolean {
    const token = this.peek();
    return (token.type === "keyword" || token.type === "operator" || token.type === "punctuation") && token.upper === upper;
  }

  private eat(upper: string): boolean {
    if (!this.at(upper)) return false;
    this.position++;
    return true;
  }

  private expect(upper: string): Token {
    if (!this.at(upper)) {
      const token = this.peek();
      throw new SqlSyntaxError(`Expected ${upper} but found ${token.value || "end of input"}`, token.start);
    }
    return this.next();
  }

  parseStatement(): SelectStatement {
    if (this.at("WITH")) {
      throw new SqlSyntaxError("Common table expressions are not supported; split the query into separate transform nodes");
    }
    this.expect("SELECT");
    const distinct = this.eat("DISTINCT");
    const columns = this.parseSelectList();

    let from: TableRef | undefined;
    const joins: JoinClause[] = [];
    if (this.eat("FROM")) {
      from = this.parseTableRef();
      for (;;) {
        const join = this.tryParseJoin();
        if (!join) break;
        joins.push(join);
      }
    }

    const where = this.eat("WHERE") ? this.parseExpression() : undefined;

    const groupBy: Expr[] = [];
    if (this.eat("GROUP")) {
      this.expect("BY");
      do { groupBy.push(this.parseExpression()); } while (this.eat(","));
    }

    const having = this.eat("HAVING") ? this.parseExpression() : undefined;

    const orderBy: OrderTerm[] = [];
    if (this.eat("ORDER")) {
      this.expect("BY");
      do { orderBy.push(this.parseOrderTerm()); } while (this.eat(","));
    }

    let limit: number | undefined;
    let offset: number | undefined;
    // Accept either order: `LIMIT n OFFSET m` and `OFFSET m LIMIT n`.
    for (let i = 0; i < 2; i++) {
      if (this.eat("LIMIT")) limit = this.parseNonNegativeInteger("LIMIT");
      else if (this.eat("OFFSET")) offset = this.parseNonNegativeInteger("OFFSET");
      else break;
    }

    this.eat(";");
    const trailing = this.peek();
    if (trailing.type !== "eof") {
      throw new SqlSyntaxError(`Unexpected ${trailing.value}; only a single SELECT statement is supported`, trailing.start);
    }

    return {
      distinct,
      columns,
      ...(from ? { from } : {}),
      joins,
      ...(where ? { where } : {}),
      groupBy,
      ...(having ? { having } : {}),
      orderBy,
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
    };
  }

  private parseNonNegativeInteger(clause: string): number {
    const token = this.next();
    const value = Number(token.value);
    if (token.type !== "number" || !Number.isInteger(value) || value < 0) {
      throw new SqlSyntaxError(`${clause} requires a non-negative integer`, token.start);
    }
    return value;
  }

  private parseSelectList(): SelectColumn[] {
    const columns: SelectColumn[] = [];
    do {
      if (this.at("*")) {
        this.next();
        columns.push({ expr: { kind: "star" } });
        continue;
      }
      // `table.*`
      const token = this.peek();
      if ((token.type === "identifier" || token.type === "quoted_identifier") && this.peek(1).upper === "." && this.peek(2).upper === "*") {
        this.next(); this.next(); this.next();
        columns.push({ expr: { kind: "star", table: token.value } });
        continue;
      }
      const expr = this.parseExpression();
      let alias: string | undefined;
      if (this.eat("AS")) {
        alias = this.parseIdentifier("column alias");
      } else {
        const candidate = this.peek();
        if (candidate.type === "identifier" || candidate.type === "quoted_identifier") {
          alias = this.next().value;
        }
      }
      columns.push({ expr, ...(alias ? { alias } : {}) });
    } while (this.eat(","));
    return columns;
  }

  private parseIdentifier(context: string): string {
    const token = this.next();
    if (token.type !== "identifier" && token.type !== "quoted_identifier") {
      throw new SqlSyntaxError(`Expected ${context} but found ${token.value || "end of input"}`, token.start);
    }
    return token.value;
  }

  private parseTableRef(): TableRef {
    if (this.at("(")) {
      throw new SqlSyntaxError("Subqueries are not supported; model the inner query as its own transform node", this.peek().start);
    }
    const name = this.parseIdentifier("table name");
    let alias: string | undefined;
    if (this.eat("AS")) alias = this.parseIdentifier("table alias");
    else {
      const candidate = this.peek();
      if (candidate.type === "identifier" || candidate.type === "quoted_identifier") alias = this.next().value;
    }
    return { name, ...(alias ? { alias } : {}) };
  }

  private tryParseJoin(): JoinClause | null {
    let type: JoinType | null = null;
    if (this.at("JOIN")) type = "inner";
    else if (this.at("INNER")) { this.next(); type = "inner"; }
    else if (this.at("LEFT")) { this.next(); this.eat("OUTER"); type = "left"; }
    else if (this.at("RIGHT")) { this.next(); this.eat("OUTER"); type = "right"; }
    else if (this.at("FULL")) { this.next(); this.eat("OUTER"); type = "full"; }
    else if (this.at("CROSS")) { this.next(); type = "cross"; }
    if (type === null) return null;

    this.expect("JOIN");
    const table = this.parseTableRef();

    if (type === "cross") return { type, table };

    if (this.eat("USING")) {
      this.expect("(");
      const using: string[] = [];
      do { using.push(this.parseIdentifier("join column")); } while (this.eat(","));
      this.expect(")");
      return { type, table, using };
    }
    this.expect("ON");
    return { type, table, on: this.parseExpression() };
  }

  private parseOrderTerm(): OrderTerm {
    const expr = this.parseExpression();
    let direction: "asc" | "desc" = "asc";
    if (this.eat("DESC")) direction = "desc";
    else this.eat("ASC");
    // PostgreSQL default: NULLs sort as larger than any value.
    let nulls: "first" | "last" = direction === "asc" ? "last" : "first";
    if (this.eat("NULLS")) {
      if (this.eat("FIRST")) nulls = "first";
      else { this.expect("LAST"); nulls = "last"; }
    }
    return { expr, direction, nulls };
  }

  parseExpression(minPrecedence = 0): Expr {
    let left = this.parseUnary();

    for (;;) {
      left = this.parsePostfix(left);
      const token = this.peek();
      const op = token.upper;
      const precedence = PRECEDENCE[op];
      if (
        precedence === undefined ||
        precedence < minPrecedence ||
        (token.type !== "operator" && token.type !== "keyword")
      ) {
        break;
      }
      this.next();
      const right = this.parseExpression(precedence + 1);
      left = { kind: "binary", op: op as BinaryOperator, left, right };
    }
    return left;
  }

  /** IS NULL / IN / BETWEEN / LIKE bind tighter than AND but looser than comparison. */
  private parsePostfix(expr: Expr): Expr {
    for (;;) {
      if (this.at("IS")) {
        this.next();
        const negated = this.eat("NOT");
        this.expect("NULL");
        expr = { kind: "isNull", expr, negated };
        continue;
      }
      const negated = this.at("NOT") && ["IN", "BETWEEN", "LIKE", "ILIKE"].includes(this.peek(1).upper);
      if (negated) this.next();

      if (this.at("IN")) {
        this.next();
        this.expect("(");
        const list: Expr[] = [];
        if (!this.at(")")) {
          do { list.push(this.parseExpression()); } while (this.eat(","));
        }
        this.expect(")");
        expr = { kind: "in", expr, list, negated };
        continue;
      }
      if (this.at("BETWEEN")) {
        this.next();
        const low = this.parseExpression(PRECEDENCE["AND"]! + 1);
        this.expect("AND");
        const high = this.parseExpression(PRECEDENCE["AND"]! + 1);
        expr = { kind: "between", expr, low, high, negated };
        continue;
      }
      if (this.at("LIKE") || this.at("ILIKE")) {
        const caseInsensitive = this.peek().upper === "ILIKE";
        this.next();
        const pattern = this.parseExpression(PRECEDENCE["||"]!);
        expr = { kind: "like", expr, pattern, negated, caseInsensitive };
        continue;
      }
      if (negated) {
        throw new SqlSyntaxError("NOT must be followed by IN, BETWEEN, LIKE or an expression", this.peek().start);
      }
      return expr;
    }
  }

  private parseUnary(): Expr {
    if (this.at("NOT")) { this.next(); return { kind: "unary", op: "NOT", expr: this.parseExpression(3) }; }
    if (this.at("-")) { this.next(); return { kind: "unary", op: "-", expr: this.parseUnary() }; }
    if (this.at("+")) { this.next(); return this.parseUnary(); }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const token = this.peek();

    // A few function names are also keywords (LEFT/RIGHT collide with joins).
    // Treat them as functions when they are immediately applied.
    if (token.type === "keyword" && FUNCTION_KEYWORDS.has(token.upper) && this.peek(1).upper === "(") {
      this.next();
      return this.parseCallArguments(token.value);
    }

    if (this.eat("(")) {
      const expr = this.parseExpression();
      this.expect(")");
      return expr;
    }
    if (this.at("CASE")) return this.parseCase();
    if (this.at("CAST")) {
      this.next();
      this.expect("(");
      const expr = this.parseExpression();
      this.expect("AS");
      const to = this.parseIdentifier("cast target type");
      this.expect(")");
      return { kind: "cast", expr, to };
    }
    if (this.eat("NULL")) return { kind: "literal", value: null };
    if (this.eat("TRUE")) return { kind: "literal", value: true };
    if (this.eat("FALSE")) return { kind: "literal", value: false };

    if (token.type === "number") {
      this.next();
      const value = Number(token.value);
      if (Number.isNaN(value)) throw new SqlSyntaxError(`Invalid number "${token.value}"`, token.start);
      return { kind: "literal", value };
    }
    if (token.type === "string") {
      this.next();
      return { kind: "literal", value: token.value };
    }

    if (token.type === "identifier" || token.type === "quoted_identifier") {
      this.next();
      // Function call
      if (this.at("(")) return this.parseCallArguments(token.value);
      // `CURRENT_DATE` and friends take no parentheses.
      if (NILADIC_FUNCTIONS.has(token.upper)) {
        return { kind: "function", name: token.value, args: [], distinct: false };
      }
      // Qualified column
      if (this.at(".")) {
        this.next();
        const name = this.parseIdentifier("column name");
        return { kind: "column", table: token.value, name };
      }
      return { kind: "column", name: token.value };
    }

    throw new SqlSyntaxError(`Unexpected ${token.value || "end of input"} in expression`, token.start);
  }

  private parseCallArguments(name: string): Expr {
    this.expect("(");
    const distinct = this.eat("DISTINCT");
    const args: Expr[] = [];
    if (this.at("*")) {
      this.next();
      args.push({ kind: "star" });
    } else if (!this.at(")")) {
      do { args.push(this.parseExpression()); } while (this.eat(","));
    }
    this.expect(")");
    return { kind: "function", name, args, distinct };
  }

  private parseCase(): Expr {
    this.expect("CASE");
    const operand = this.at("WHEN") ? undefined : this.parseExpression();
    const whens: Array<{ when: Expr; then: Expr }> = [];
    while (this.eat("WHEN")) {
      const when = this.parseExpression();
      this.expect("THEN");
      whens.push({ when, then: this.parseExpression() });
    }
    if (!whens.length) throw new SqlSyntaxError("CASE requires at least one WHEN branch", this.peek().start);
    const elseExpr = this.eat("ELSE") ? this.parseExpression() : undefined;
    this.expect("END");
    return { kind: "case", ...(operand ? { operand } : {}), whens, ...(elseExpr ? { else: elseExpr } : {}) };
  }
}

export function parseSelect(sql: string): SelectStatement {
  return SqlParser.parse(sql);
}
