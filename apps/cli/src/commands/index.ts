import type { DataFlowClient } from "@dataflow-studio/sdk";
import type { ParsedArgs } from "../args.js";
import type { CliConfig } from "../config.js";
import { print, style } from "../output.js";
import * as auth from "./auth.js";
import * as pipeline from "./pipeline.js";
import * as run from "./run.js";
import * as catalog from "./catalog.js";

export interface CommandContext {
  client: DataFlowClient;
  config: CliConfig;
  args: ParsedArgs;
}

export const USAGE = `${style.bold("dataflow")} - control plane for data workflows

${style.bold("USAGE")}
  dataflow <command> [subcommand] [options]

${style.bold("AUTHENTICATION")}
  login --api-key <key> [--url <url>]   Store credentials in ~/.dataflow/config.json
  logout                               Remove the stored API key
  whoami                               Show the authenticated principal and permissions

${style.bold("PIPELINES")}
  pipeline list [--search <text>]      List pipelines with their last run
  pipeline get <id|name>               Show a pipeline, its versions and schedules
  pipeline validate <file>             Validate a definition file without deploying
  pipeline deploy <file> [--publish]   Create or update a pipeline from a file
  pipeline run <id|name> [--wait]      Trigger a run; --wait exits non-zero on failure
  pipeline test <file>                 Run declared expectations against a draft run
  pipeline diff <id|name> --from N --to M

${style.bold("RUNS")}
  run list [--pipeline <id>] [--state FAILED]
  run get <run-id>                     Show a run, its tasks and quality results
  run cancel <run-id>
  run retry <run-id> [--all]
  logs <run-id> [--follow] [--level error] [--task <task-id>]

${style.bold("CATALOG")}
  dataset list [--search <text>]
  dataset get <name>                   Schema history, quality and lineage
  incident list [--status open]
  lineage [--pipeline <id>]

${style.bold("GLOBAL OPTIONS")}
  --json                Machine-readable output (for scripting and CI)
  --url <url>           Override the API URL for this invocation
  --help, --version

${style.bold("EXIT CODES")}
  0 success   1 request or validation failure   2 pipeline/test assertion failed
  69 API unreachable   70 server error

${style.grey("Docs: https://github.com/itsshreyasbhardwaj-design/dataflow-studio/tree/main/docs/cli.md")}`;

type Handler = (context: CommandContext) => Promise<number>;

const commands: Record<string, Record<string, Handler> | Handler> = {
  login: auth.login,
  logout: auth.logout,
  whoami: auth.whoami,
  logs: run.logs,
  lineage: catalog.lineage,
  pipeline: {
    list: pipeline.list,
    get: pipeline.get,
    validate: pipeline.validate,
    deploy: pipeline.deploy,
    run: pipeline.runPipeline,
    test: pipeline.test,
    diff: pipeline.diff,
  },
  run: {
    list: run.list,
    get: run.get,
    cancel: run.cancel,
    retry: run.retry,
    logs: run.logs,
  },
  dataset: {
    list: catalog.datasetList,
    get: catalog.datasetGet,
  },
  incident: {
    list: catalog.incidentList,
  },
};

export async function runCommand(context: CommandContext): Promise<number> {
  const [group, sub] = context.args.command;
  const entry = commands[group!];

  if (!entry) {
    print(`${style.red("Unknown command")} "${group}"\n`);
    print(USAGE);
    return 1;
  }
  if (typeof entry === "function") return entry(context);

  const handler = sub ? entry[sub] : undefined;
  if (!handler) {
    print(`${style.red("Unknown subcommand")} "${group} ${sub ?? ""}"`);
    print(`Available: ${Object.keys(entry).join(", ")}`);
    return 1;
  }
  return handler(context);
}
