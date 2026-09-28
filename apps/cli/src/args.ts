export interface ParsedArgs {
  command: string[];
  flags: Record<string, string | boolean | string[]>;
  positional: string[];
}

/**
 * Minimal argument parser: `--flag`, `--flag=value`, `--flag value`, `-f`, and
 * repeated flags collected into arrays. Written by hand so the CLI has no runtime
 * dependencies beyond the SDK.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | boolean | string[]> = {};
  const positional: string[] = [];
  let afterDoubleDash = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (afterDoubleDash) { positional.push(token); continue; }
    if (token === "--") { afterDoubleDash = true; continue; }

    if (token.startsWith("--")) {
      const [rawName, inlineValue] = token.slice(2).split("=", 2);
      const name = camel(rawName!);
      let value: string | boolean;
      if (inlineValue !== undefined) value = inlineValue;
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("-")) value = argv[++i]!;
      else value = true;

      const existing = flags[name];
      if (existing === undefined) flags[name] = value;
      else if (Array.isArray(existing)) existing.push(String(value));
      else flags[name] = [String(existing), String(value)];
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      for (const letter of token.slice(1)) flags[letter] = true;
      continue;
    }
    positional.push(token);
  }

  const command: string[] = [];
  while (positional.length && !positional[0]!.startsWith("-") && command.length < 2) {
    command.push(positional.shift()!);
  }
  return { command, flags, positional };
}

function camel(value: string): string {
  return value.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

export function flagString(flags: ParsedArgs["flags"], name: string): string | undefined {
  const value = flags[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

export function flagBoolean(flags: ParsedArgs["flags"], name: string): boolean {
  return flags[name] === true || flags[name] === "true";
}

export function flagNumber(flags: ParsedArgs["flags"], name: string): number | undefined {
  const value = flagString(flags, name);
  return value === undefined ? undefined : Number(value);
}

export function flagList(flags: ParsedArgs["flags"], name: string): string[] {
  const value = flags[name];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return [];
}

/** Parses `--param key=value` pairs into an object. */
export function parseParams(values: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of values) {
    const index = entry.indexOf("=");
    if (index < 1) throw new Error(`Invalid --param "${entry}": expected key=value`);
    out[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return out;
}
