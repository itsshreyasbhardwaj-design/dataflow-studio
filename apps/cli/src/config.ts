import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CliConfig {
  apiUrl: string;
  apiKey?: string;
  organizationId?: string;
}

export function configPath(): string {
  return process.env["DATAFLOW_CONFIG"] ?? join(homedir(), ".dataflow", "config.json");
}

const DEFAULT_API_URL = "http://localhost:3000";

/**
 * Resolves configuration from, in order: environment variables, the config file,
 * then defaults. Environment first is what makes the CLI usable in CI without a
 * login step.
 */
export async function loadConfig(): Promise<CliConfig> {
  let fileConfig: Partial<CliConfig> = {};
  try {
    fileConfig = JSON.parse(await readFile(configPath(), "utf8")) as Partial<CliConfig>;
  } catch {
    // No config file is a normal state.
  }
  return {
    apiUrl: process.env["DATAFLOW_API_URL"] ?? fileConfig.apiUrl ?? DEFAULT_API_URL,
    ...(process.env["DATAFLOW_API_KEY"] ?? fileConfig.apiKey ? { apiKey: process.env["DATAFLOW_API_KEY"] ?? fileConfig.apiKey } : {}),
    ...(process.env["DATAFLOW_ORGANIZATION_ID"] ?? fileConfig.organizationId
      ? { organizationId: process.env["DATAFLOW_ORGANIZATION_ID"] ?? fileConfig.organizationId }
      : {}),
  };
}

/** Writes the config file with 0600 permissions: it holds an API key. */
export async function saveConfig(config: CliConfig): Promise<string> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

export async function clearConfig(): Promise<void> {
  const config = await loadConfig();
  await saveConfig({ apiUrl: config.apiUrl });
}
