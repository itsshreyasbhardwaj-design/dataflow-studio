#!/usr/bin/env node
import { DataFlowApiError, DataFlowClient, DataFlowNetworkError } from "@dataflow-studio/sdk";
import { flagBoolean, parseArgs } from "./args.js";
import { loadConfig } from "./config.js";
import { printError, print, style } from "./output.js";
import { runCommand, USAGE } from "./commands/index.js";

const parsed = parseArgs(process.argv.slice(2));

if (!parsed.command.length || flagBoolean(parsed.flags, "help") || flagBoolean(parsed.flags, "h")) {
  print(USAGE);
  process.exit(parsed.command.length ? 0 : 1);
}
if (parsed.command[0] === "version" || flagBoolean(parsed.flags, "version")) {
  print("dataflow 0.1.0");
  process.exit(0);
}

const config = await loadConfig();
const client = new DataFlowClient({
  baseUrl: config.apiUrl,
  ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  ...(config.organizationId ? { headers: { "x-organization-id": config.organizationId } } : {}),
});

try {
  const exitCode = await runCommand({ client, config, args: parsed });
  process.exit(exitCode);
} catch (error) {
  if (error instanceof DataFlowApiError) {
    printError(`${error.message}${error.requestId ? style.grey(` (request ${error.requestId})`) : ""}`);
    if (error.status === 401) print(style.grey("Run `dataflow login --api-key <key>` first."));
    const issues = (error.details as { issues?: Array<{ message: string; hint?: string }> } | undefined)?.issues;
    for (const issue of issues ?? []) {
      print(`  ${style.red("•")} ${issue.message}`);
      if (issue.hint) print(`    ${style.grey(issue.hint)}`);
    }
    process.exit(error.status >= 500 ? 70 : 1);
  }
  if (error instanceof DataFlowNetworkError) {
    printError(error.message);
    print(style.grey(`Is the API reachable at ${config.apiUrl}?`));
    process.exit(69);
  }
  printError((error as Error).message);
  process.exit(1);
}
