export type TokenType = "identifier" | "quoted_identifier" | "number" | "string" | "operator" | "punctuation" | "keyword" | "eof";

export interface Token {
  type: TokenType;
  value: string;
  /** Upper-cased value for keyword comparisons. */
  upper: string;
  start: number;
}

export const KEYWORDS = new Set([
  "SELECT", "DISTINCT", "FROM", "WHERE", "GROUP", "BY", "HAVING", "ORDER", "LIMIT", "OFFSET",
  "AS", "AND", "OR", "NOT", "NULL", "IS", "IN", "BETWEEN", "LIKE", "ILIKE", "CASE", "WHEN",
  "THEN", "ELSE", "END", "CAST", "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "ON",
  "ASC", "DESC", "NULLS", "FIRST", "LAST", "TRUE", "FALSE", "CROSS", "USING", "WITH",
]);

/** Multi-character operators, longest first so `<=` wins over `<`. */
const OPERATORS = ["<>", "!=", "<=", ">=", "||", "=", "<", ">", "+", "-", "*", "/", "%"];

export class SqlSyntaxError extends Error {
  readonly errorClass = "validation";
  constructor(message: string, readonly position?: number) {
    super(position === undefined ? message : `${message} (at offset ${position})`);
    this.name = "SqlSyntaxError";
  }
}

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const push = (type: TokenType, value: string, start: number): void => {
    tokens.push({ type, value, upper: value.toUpperCase(), start });
  };

  while (i < sql.length) {
    const char = sql[i]!;

    if (/\s/.test(char)) { i++; continue; }

    if (char === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (char === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) throw new SqlSyntaxError("Unterminated block comment", i);
      i = end + 2;
      continue;
    }

    if (char === "'") {
      const start = i;
      i++;
      let value = "";
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { value += "'"; i += 2; continue; }
          break;
        }
        value += sql[i];
        i++;
      }
      if (i >= sql.length) throw new SqlSyntaxError("Unterminated string literal", start);
      i++;
      push("string", value, start);
      continue;
    }

    if (char === '"') {
      const start = i;
      i++;
      let value = "";
      while (i < sql.length && sql[i] !== '"') { value += sql[i]; i++; }
      if (i >= sql.length) throw new SqlSyntaxError("Unterminated quoted identifier", start);
      i++;
      push("quoted_identifier", value, start);
      continue;
    }

    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(sql[i + 1] ?? ""))) {
      const start = i;
      while (i < sql.length && /[0-9.]/.test(sql[i]!)) i++;
      if (sql[i] === "e" || sql[i] === "E") {
        i++;
        if (sql[i] === "+" || sql[i] === "-") i++;
        while (i < sql.length && /[0-9]/.test(sql[i]!)) i++;
      }
      push("number", sql.slice(start, i), start);
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      const start = i;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i]!)) i++;
      const value = sql.slice(start, i);
      push(KEYWORDS.has(value.toUpperCase()) ? "keyword" : "identifier", value, start);
      continue;
    }

    const operator = OPERATORS.find((op) => sql.startsWith(op, i));
    if (operator) {
      push("operator", operator, i);
      i += operator.length;
      continue;
    }

    if ("(),.;".includes(char)) {
      push("punctuation", char, i);
      i++;
      continue;
    }

    throw new SqlSyntaxError(`Unexpected character "${char}"`, i);
  }

  push("eof", "", sql.length);
  return tokens;
}
