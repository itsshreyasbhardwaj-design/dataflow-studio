/**
 * A tiny, dependency-free config schema. It exists because three different
 * consumers need the same description of a node's configuration:
 *
 *  - the validator, which must reject a pipeline before it runs;
 *  - the visual editor, which renders a form from it;
 *  - the docs generator, which tabulates it.
 *
 * Keeping it in the workflow engine means the editor and the worker can never
 * disagree about what a valid `sql.transform` looks like.
 */
import { isSecretReference, type ConfigValue, type NodeConfig } from "./types.js";

export type FieldType =
  | "string"
  | "text"
  | "sql"
  | "python"
  | "number"
  | "integer"
  | "boolean"
  | "enum"
  | "string[]"
  | "json"
  | "duration"
  | "object"
  | "array"
  | "secret";

export interface FieldSchema {
  name: string;
  type: FieldType;
  label: string;
  description?: string;
  required?: boolean;
  default?: ConfigValue;
  /** Allowed values for `enum`. */
  options?: readonly string[];
  min?: number;
  max?: number;
  pattern?: string;
  placeholder?: string;
  /** When true, a `{ secretRef }` is accepted in place of a literal. */
  secretAllowed?: boolean;
  /** Only show/require this field when another field has one of these values. */
  visibleWhen?: { field: string; equals: readonly string[] };
}

export interface FieldIssue {
  field: string;
  message: string;
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isVisible(field: FieldSchema, config: NodeConfig): boolean {
  if (!field.visibleWhen) return true;
  const actual = config[field.visibleWhen.field];
  return typeof actual === "string" && field.visibleWhen.equals.includes(actual);
}

export function validateConfig(fields: readonly FieldSchema[], config: NodeConfig): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const known = new Set(fields.map((f) => f.name));

  for (const field of fields) {
    if (!isVisible(field, config)) continue;
    const value = config[field.name];

    if (value === undefined || value === null || value === "") {
      if (field.required && field.default === undefined) {
        issues.push({ field: field.name, message: `"${field.label}" is required` });
      }
      continue;
    }

    if (isSecretReference(value)) {
      if (!field.secretAllowed && field.type !== "secret") {
        issues.push({ field: field.name, message: `"${field.label}" does not accept a secret reference` });
      } else if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value.secretRef)) {
        issues.push({ field: field.name, message: `Invalid secret name "${value.secretRef}"` });
      }
      continue;
    }

    switch (field.type) {
      case "secret":
        issues.push({
          field: field.name,
          message: `"${field.label}" must be a secret reference, not a literal value`,
        });
        break;
      case "string":
      case "text":
      case "sql":
      case "python":
      case "duration":
        if (typeof value !== "string") {
          issues.push({ field: field.name, message: `"${field.label}" must be a string (got ${typeName(value)})` });
        } else if (field.pattern && !new RegExp(field.pattern).test(value)) {
          issues.push({ field: field.name, message: `"${field.label}" does not match ${field.pattern}` });
        } else if (field.max !== undefined && value.length > field.max) {
          issues.push({ field: field.name, message: `"${field.label}" exceeds ${field.max} characters` });
        }
        break;
      case "number":
      case "integer":
        if (typeof value !== "number" || Number.isNaN(value)) {
          issues.push({ field: field.name, message: `"${field.label}" must be a number (got ${typeName(value)})` });
        } else {
          if (field.type === "integer" && !Number.isInteger(value)) {
            issues.push({ field: field.name, message: `"${field.label}" must be an integer` });
          }
          if (field.min !== undefined && value < field.min) {
            issues.push({ field: field.name, message: `"${field.label}" must be >= ${field.min}` });
          }
          if (field.max !== undefined && value > field.max) {
            issues.push({ field: field.name, message: `"${field.label}" must be <= ${field.max}` });
          }
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") {
          issues.push({ field: field.name, message: `"${field.label}" must be true or false` });
        }
        break;
      case "enum":
        if (typeof value !== "string" || !field.options?.includes(value)) {
          issues.push({
            field: field.name,
            message: `"${field.label}" must be one of: ${(field.options ?? []).join(", ")}`,
          });
        }
        break;
      case "string[]":
        if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
          issues.push({ field: field.name, message: `"${field.label}" must be a list of strings` });
        } else if (field.min !== undefined && value.length < field.min) {
          issues.push({ field: field.name, message: `"${field.label}" needs at least ${field.min} entries` });
        }
        break;
      case "object":
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          issues.push({ field: field.name, message: `"${field.label}" must be an object` });
        }
        break;
      case "array":
        if (!Array.isArray(value)) {
          issues.push({ field: field.name, message: `"${field.label}" must be an array` });
        } else if (field.min !== undefined && value.length < field.min) {
          issues.push({ field: field.name, message: `"${field.label}" needs at least ${field.min} entries` });
        } else if (field.max !== undefined && value.length > field.max) {
          issues.push({ field: field.name, message: `"${field.label}" accepts at most ${field.max} entries` });
        }
        break;
      case "json":
        // Any JSON value is acceptable; node executors validate the shape they need.
        break;
    }
  }

  for (const key of Object.keys(config)) {
    if (!known.has(key)) {
      issues.push({ field: key, message: `Unknown configuration key "${key}"` });
    }
  }

  return issues;
}

/** Fills declared defaults without mutating the input. */
export function applyDefaults(fields: readonly FieldSchema[], config: NodeConfig): NodeConfig {
  const out: NodeConfig = { ...config };
  for (const field of fields) {
    if (field.default !== undefined && out[field.name] === undefined && isVisible(field, out)) {
      out[field.name] = field.default;
    }
  }
  return out;
}

/** Every secret reference used by a config, for permission pre-flight checks. */
export function collectSecretRefs(config: NodeConfig): string[] {
  const refs: string[] = [];
  const walk = (value: unknown): void => {
    if (isSecretReference(value)) { refs.push(value.secretRef); return; }
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === "object") { Object.values(value).forEach(walk); }
  };
  walk(config);
  return [...new Set(refs)];
}
