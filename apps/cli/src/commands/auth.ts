import { flagString } from "../args.js";
import { clearConfig, saveConfig } from "../config.js";
import { json, print, printError, style } from "../output.js";
import type { CommandContext } from "./index.js";

export async function login({ args, config, client }: CommandContext): Promise<number> {
  const apiKey = flagString(args.flags, "apiKey") ?? args.positional[0];
  const url = flagString(args.flags, "url") ?? config.apiUrl;
  const organizationId = flagString(args.flags, "organization");

  if (!apiKey) {
    printError("Provide an API key: dataflow login --api-key dfs_live_...");
    print(style.grey("Create one in Settings → API keys, or with `POST /api/v1/api-keys`."));
    return 1;
  }
  if (!apiKey.startsWith("dfs_")) {
    printError('That does not look like a DataFlow API key (expected a "dfs_" prefix)');
    return 1;
  }

  // Verify before writing, so a typo does not leave a broken config behind.
  const probe = new (client.constructor as typeof import("@dataflow-studio/sdk").DataFlowClient)({
    baseUrl: url,
    apiKey,
    ...(organizationId ? { headers: { "x-organization-id": organizationId } } : {}),
  });
  const me = await probe.me.get();

  const path = await saveConfig({ apiUrl: url, apiKey, ...(organizationId ? { organizationId } : {}) });
  if (args.flags["json"]) {
    json({ ok: true, configPath: path, ...me });
    return 0;
  }
  print(`${style.green("Logged in")} as ${style.bold(me.userId)} (${me.role}) at ${url}`);
  print(style.grey(`Credentials written to ${path} with 0600 permissions.`));
  return 0;
}

export async function logout(): Promise<number> {
  await clearConfig();
  print(`${style.green("Logged out")}. The stored API key was removed.`);
  return 0;
}

export async function whoami({ client, config, args }: CommandContext): Promise<number> {
  const me = await client.me.get();
  if (args.flags["json"]) {
    json(me);
    return 0;
  }
  print(`${style.bold("User")}         ${me.userId}`);
  print(`${style.bold("Organization")} ${me.organizationId}`);
  print(`${style.bold("Role")}         ${me.role}`);
  print(`${style.bold("API")}          ${config.apiUrl}`);
  print(`${style.bold("Permissions")}  ${me.permissions.length}`);
  print(style.grey(`  ${me.permissions.join(", ")}`));
  return 0;
}
