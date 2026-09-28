import { flagBoolean, flagList, flagNumber, flagString } from "../args.js";
import { colorState, duration, json, print, printError, relativeTime, stateSymbol, style, table } from "../output.js";
import type { CommandContext } from "./index.js";

export async function list(context: CommandContext): Promise<number> {
  const page = await context.client.runs.list({
    ...(flagString(context.args.flags, "pipeline") ? { pipelineId: flagString(context.args.flags, "pipeline")! } : {}),
    ...(flagList(context.args.flags, "state").length ? { state: flagList(context.args.flags, "state") } : {}),
    ...(flagNumber(context.args.flags, "limit") ? { limit: flagNumber(context.args.flags, "limit")! } : {}),
  });
  if (context.args.flags["json"]) { json(page); return 0; }

  print(table(page.items.map((run) => ({
    run: style.grey(run.id),
    pipeline: run.pipelineName,
    version: `v${run.version}`,
    state: colorState(run.state),
    trigger: run.trigger,
    duration: duration(run.durationMs),
    started: relativeTime(run.queuedAt),
  }))));
  return 0;
}

export async function get(context: CommandContext): Promise<number> {
  const runId = context.args.positional[0];
  if (!runId) { printError("Usage: dataflow run get <run-id>"); return 1; }
  const detail = await context.client.runs.get(runId);
  if (context.args.flags["json"]) { json(detail); return 0; }

  const { run } = detail;
  print(`${style.bold("Pipeline")}     ${run.pipelineName} v${run.version}`);
  print(`${style.bold("Run ID")}       ${run.id}`);
  print(`${style.bold("Started")}      ${run.startedAt ?? run.queuedAt}`);
  print(`${style.bold("Duration")}     ${duration(run.durationMs)}`);
  print(`${style.bold("Status")}       ${colorState(run.state)}`);
  print(`${style.bold("Triggered by")} ${run.triggeredBy} (${run.trigger})`);
  if (run.logicalDate) print(`${style.bold("Logical date")} ${run.logicalDate}`);
  print("");

  for (const task of detail.tasks) {
    const attempts = task.attempt > 1 ? style.grey(` (attempt ${task.attempt}/${task.maxAttempts})`) : "";
    print(`  ${stateSymbol(task.state)} ${task.nodeId.padEnd(24)} ${style.grey(duration(task.durationMs))}${attempts}`);
    if (task.error) print(`      ${style.red(task.error)}`);
    const rows = task.output?.["rowsRead"] ?? task.output?.["rowsOut"] ?? task.output?.["rowsWritten"];
    if (typeof rows === "number") print(`      ${style.grey(`${rows.toLocaleString("en-US")} rows`)}`);
  }

  if (detail.quality.length) {
    print(`\n${style.bold("Data quality")}`);
    print(table(detail.quality.map((result) => ({
      check: result.checkId,
      column: result.column ?? "-",
      expected: result.expected,
      actual: result.actual,
      status: result.status === "PASSED" ? style.green(result.status) : style.red(result.status),
    }))));
  }
  if (run.error) { print(""); printError(run.error); }
  return run.state === "FAILED" ? 2 : 0;
}

export async function cancel(context: CommandContext): Promise<number> {
  const runId = context.args.positional[0];
  if (!runId) { printError("Usage: dataflow run cancel <run-id>"); return 1; }
  const run = await context.client.runs.cancel(runId);
  print(`${style.yellow("Cancellation requested")} for ${runId} (state: ${colorState(run.state)})`);
  return 0;
}

export async function retry(context: CommandContext): Promise<number> {
  const runId = context.args.positional[0];
  if (!runId) { printError("Usage: dataflow run retry <run-id> [--all] [--from node-id]"); return 1; }
  const run = await context.client.runs.retry(runId, {
    ...(flagBoolean(context.args.flags, "all") ? { allNodes: true } : {}),
    ...(flagList(context.args.flags, "from").length ? { fromNodes: flagList(context.args.flags, "from") } : {}),
  });
  print(`${style.green("Retrying")} as ${style.grey(run.id)}`);
  return flagBoolean(context.args.flags, "wait")
    ? get({ ...context, args: { ...context.args, positional: [run.id] } })
    : 0;
}

/** `dataflow logs RUN_ID [--follow]` - the command people actually live in. */
export async function logs(context: CommandContext): Promise<number> {
  const runId = context.args.positional[0];
  if (!runId) { printError("Usage: dataflow logs <run-id> [--follow] [--level error]"); return 1; }

  const filter = {
    ...(flagString(context.args.flags, "task") ? { taskRunId: flagString(context.args.flags, "task")! } : {}),
    ...(flagString(context.args.flags, "level") ? { level: flagString(context.args.flags, "level")! } : {}),
    ...(flagString(context.args.flags, "search") ? { search: flagString(context.args.flags, "search")! } : {}),
    limit: flagNumber(context.args.flags, "limit") ?? 200,
  };

  const printPage = async (cursor?: string): Promise<string | undefined> => {
    const page = await context.client.runs.logs(runId, { ...filter, ...(cursor ? { cursor } : {}) });
    for (const entry of page.items) {
      const time = entry.timestamp.slice(11, 19);
      const level = entry.level.toUpperCase().padEnd(5);
      const coloured = entry.level === "error" ? style.red(level) : entry.level === "warn" ? style.yellow(level) : style.grey(level);
      print(`${style.grey(time)} ${coloured} ${entry.message}`);
    }
    return page.nextCursor;
  };

  let cursor = await printPage();
  while (cursor) cursor = await printPage(cursor);

  if (!flagBoolean(context.args.flags, "follow")) return 0;

  // Follow mode: stream events, printing log lines as they arrive.
  const detail = await context.client.runs.get(runId);
  if (["SUCCESS", "FAILED", "CANCELLED"].includes(detail.run.state)) {
    print(style.grey(`Run already ${detail.run.state}`));
    return detail.run.state === "FAILED" ? 2 : 0;
  }

  for await (const event of context.client.runs.stream(runId)) {
    if (event.type === "task.started") print(`${style.blue("▶")} ${String(event.data["nodeId"])} started`);
    else if (event.type === "task.finished") {
      const state = String(event.data["state"]);
      print(`${stateSymbol(state)} ${String(event.data["nodeId"])} ${colorState(state)}`);
      const newCursor = await printPage();
      void newCursor;
    } else if (event.type === "run.finished") {
      print(`\n${colorState(String(event.data["state"]))}`);
      return event.data["state"] === "SUCCESS" ? 0 : 2;
    }
  }
  return 0;
}
