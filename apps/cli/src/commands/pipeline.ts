import { readFile } from "node:fs/promises";
import { parseWorkflow, type WorkflowDefinition } from "@dataflow-studio/workflow-engine";
import { flagBoolean, flagList, flagNumber, flagString, parseParams } from "../args.js";
import { colorState, duration, json, print, printError, relativeTime, stateSymbol, style, table } from "../output.js";
import type { CommandContext } from "./index.js";

/** Strips colour codes so JSON output is machine-readable. */
function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001B\[[0-9;]*m/g, "");
}

async function readDefinition(path: string): Promise<WorkflowDefinition> {
  const contents = await readFile(path, "utf8").catch(() => {
    throw new Error(`Cannot read "${path}"`);
  });
  return parseWorkflow(contents);
}

/** Resolves a pipeline by id or by name, so the CLI is pleasant in CI scripts. */
async function resolvePipeline({ client }: CommandContext, reference: string): Promise<{ id: string; name: string }> {
  if (reference.startsWith("pipe_")) {
    const detail = await client.pipelines.get(reference);
    return { id: detail.pipeline.id, name: detail.pipeline.name };
  }
  const page = await client.pipelines.list({ search: reference, limit: 50 });
  const exact = page.items.find((p) => p.name === reference);
  if (exact) return { id: exact.id, name: exact.name };
  if (page.items.length === 1) return { id: page.items[0]!.id, name: page.items[0]!.name };
  if (!page.items.length) throw new Error(`No pipeline matches "${reference}"`);
  throw new Error(`"${reference}" is ambiguous: ${page.items.map((p) => p.name).join(", ")}`);
}

export async function list(context: CommandContext): Promise<number> {
  const page = await context.client.pipelines.list({
    ...(flagString(context.args.flags, "search") ? { search: flagString(context.args.flags, "search")! } : {}),
    ...(flagNumber(context.args.flags, "limit") ? { limit: flagNumber(context.args.flags, "limit")! } : {}),
  });
  if (context.args.flags["json"]) { json(page); return 0; }

  print(table(page.items.map((pipeline) => ({
    name: pipeline.isDemo ? `${pipeline.name} ${style.grey("DEMO")}` : pipeline.name,
    version: pipeline.publishedVersion ? `v${pipeline.publishedVersion}` : style.grey("unpublished"),
    "last run": pipeline.latestRun ? colorState(pipeline.latestRun.state) : style.grey("never"),
    when: relativeTime(pipeline.latestRun?.queuedAt),
    schedules: String(pipeline.scheduleCount),
    id: style.grey(pipeline.id),
  }))));
  if (page.nextCursor) print(style.grey(`\nMore results: --cursor ${page.nextCursor}`));
  return 0;
}

export async function get(context: CommandContext): Promise<number> {
  const reference = context.args.positional[0];
  if (!reference) { printError("Usage: dataflow pipeline get <id|name>"); return 1; }
  const { id } = await resolvePipeline(context, reference);
  const detail = await context.client.pipelines.get(id);
  if (context.args.flags["json"]) { json(detail); return 0; }

  print(style.bold(detail.pipeline.name));
  if (detail.pipeline.description) print(style.grey(detail.pipeline.description));
  print("");
  print(`${style.bold("Published")}  ${detail.versions.find((v) => v.status === "published")?.version ?? style.grey("none")}`);
  print(`${style.bold("Versions")}   ${detail.versions.map((v) => `v${v.version}:${v.status}`).join("  ")}`);
  print(`${style.bold("Schedules")}  ${detail.schedules.length ? detail.schedules.map((s) => s.description).join("; ") : style.grey("none")}`);

  if (detail.validation && !detail.validation.valid) {
    print(`\n${style.red("Current version does not validate:")}`);
    for (const issue of detail.validation.errors) print(`  ${style.red("•")} ${issue.message}`);
  }
  if (detail.recentRuns.length) {
    print(`\n${style.bold("Recent runs")}`);
    print(table(detail.recentRuns.map((run) => ({
      run: style.grey(run.id),
      state: colorState(run.state),
      trigger: run.trigger,
      duration: duration(run.durationMs),
      started: relativeTime(run.queuedAt),
    }))));
  }
  return 0;
}

export async function validate(context: CommandContext): Promise<number> {
  const path = context.args.positional[0];
  if (!path) { printError("Usage: dataflow pipeline validate <file.json>"); return 1; }

  const definition = await readDefinition(path);
  const result = await context.client.pipelines.validate(definition);
  if (context.args.flags["json"]) { json(result); return result.valid ? 0 : 2; }

  if (result.valid && !result.warnings.length) {
    print(`${style.green("✓")} ${path} is valid (${definition.nodes.length} nodes, ${definition.edges.length} edges)`);
    return 0;
  }
  if (!result.valid) {
    print(style.red("Pipeline cannot run"));
    print("");
    for (const issue of result.errors) {
      print(`${style.red("Error")}${issue.nodeId ? ` [${issue.nodeId}]` : ""}: ${issue.message}`);
      if (issue.hint) print(`  ${style.grey(issue.hint)}`);
    }
  }
  for (const issue of result.warnings) {
    print(`${style.yellow("Warning")}${issue.nodeId ? ` [${issue.nodeId}]` : ""}: ${issue.message}`);
  }
  return result.valid ? 0 : 2;
}

/**
 * Creates or updates a pipeline from a file. Publishing is opt-in: CI should be
 * able to validate and stage a change without promoting it to production.
 */
export async function deploy(context: CommandContext): Promise<number> {
  const path = context.args.positional[0];
  if (!path) { printError("Usage: dataflow pipeline deploy <file.json> [--publish]"); return 1; }
  const definition = await readDefinition(path);

  const existing = await context.client.pipelines.list({ search: definition.name, limit: 50 });
  const match = existing.items.find((p) => p.name === definition.name);

  const detail = match
    ? await context.client.pipelines.update(match.id, { definition })
    : await context.client.pipelines.create({ name: definition.name, definition });

  print(`${style.green(match ? "Updated" : "Created")} ${style.bold(definition.name)} (${detail.pipeline.id})`);
  const draft = detail.versions.find((v) => v.status === "draft");
  if (draft) print(`  draft v${draft.version}`);

  if (!flagBoolean(context.args.flags, "publish")) {
    print(style.grey("  Not published. Re-run with --publish to promote it."));
    return 0;
  }

  const published = await context.client.pipelines.publish(detail.pipeline.id);
  print(`${style.green("Published")} v${published.version.version}`);
  for (const line of published.diff && typeof published.diff === "object" && "summary" in published.diff
    ? ((published.diff as { summary: string[] }).summary ?? [])
    : []) {
    print(`  ${line}`);
  }
  return 0;
}

export async function runPipeline(context: CommandContext): Promise<number> {
  const reference = context.args.positional[0];
  if (!reference) { printError("Usage: dataflow pipeline run <id|name> [--wait] [--param key=value]"); return 1; }
  const { id, name } = await resolvePipeline(context, reference);

  const params = parseParams(flagList(context.args.flags, "param"));
  const run = await context.client.pipelines.run(id, {
    ...(Object.keys(params).length ? { params } : {}),
    ...(flagString(context.args.flags, "logicalDate") ? { logicalDate: flagString(context.args.flags, "logicalDate")! } : {}),
    ...(flagBoolean(context.args.flags, "draft") ? { useDraft: true } : {}),
  });

  if (context.args.flags["json"] && !flagBoolean(context.args.flags, "wait")) { json(run); return 0; }
  print(`${style.green("Started")} ${style.bold(name)} run ${style.grey(run.id)}`);

  if (!flagBoolean(context.args.flags, "wait")) {
    print(style.grey(`  dataflow run get ${run.id}`));
    return 0;
  }

  const finished = await context.client.runs.waitFor(run.id, {
    ...(flagNumber(context.args.flags, "timeout") ? { timeoutMs: flagNumber(context.args.flags, "timeout")! * 1000 } : {}),
    pollMs: 1000,
  });
  const detail = await context.client.runs.get(finished.id);
  if (context.args.flags["json"]) { json(detail); return finished.state === "SUCCESS" ? 0 : 2; }

  print("");
  for (const task of detail.tasks) {
    print(`  ${stateSymbol(task.state)} ${task.nodeId} ${style.grey(duration(task.durationMs))}${task.error ? ` ${style.red(task.error)}` : ""}`);
  }
  print("");
  print(`${colorState(finished.state)} in ${duration(finished.durationMs)}`);
  if (finished.error) printError(finished.error);
  return finished.state === "SUCCESS" ? 0 : 2;
}

interface PipelineExpectation {
  dataset?: string;
  minRows?: number;
  maxRows?: number;
  notNull?: string[];
  nonNegative?: string[];
  unique?: string[];
}

/**
 * Pipeline-level tests.
 *
 * A definition file may declare `metadata.tests` with the expectations a run must
 * satisfy. `dataflow pipeline test` deploys the file as a draft, runs it and checks
 * those expectations against the run's real quality results and row counts -
 * so CI can gate publication on behaviour, not just on validation.
 */
export async function test(context: CommandContext): Promise<number> {
  const path = context.args.positional[0];
  if (!path) { printError("Usage: dataflow pipeline test <file.json>"); return 1; }
  const definition = await readDefinition(path);

  const expectations = (definition.metadata?.["tests"] ?? []) as unknown as PipelineExpectation[];
  if (!Array.isArray(expectations) || !expectations.length) {
    printError("This definition declares no tests. Add `metadata.tests` with the expectations to check.");
    print(style.grey('  e.g. { "metadata": { "tests": [{ "dataset": "daily_sales", "minRows": 1, "notNull": ["customer_id"] }] } }'));
    return 1;
  }

  const validation = await context.client.pipelines.validate(definition);
  if (!validation.valid) {
    print(style.red("Validation failed; not running tests"));
    for (const issue of validation.errors) print(`  ${style.red("•")} ${issue.message}`);
    return 2;
  }

  const existing = await context.client.pipelines.list({ search: definition.name, limit: 50 });
  const match = existing.items.find((p) => p.name === definition.name);
  const detail = match
    ? await context.client.pipelines.update(match.id, { definition })
    : await context.client.pipelines.create({ name: definition.name, definition });

  print(`${style.bold("Running")} ${definition.name} (draft) to evaluate ${expectations.length} expectation(s)`);
  const run = await context.client.pipelines.run(detail.pipeline.id, { useDraft: true });
  const finished = await context.client.runs.waitFor(run.id, { pollMs: 1000 });
  const runDetail = await context.client.runs.get(run.id);

  let failures = 0;
  const report: Array<{ check: string; result: string; detail: string }> = [];

  if (finished.state !== "SUCCESS") {
    failures++;
    report.push({ check: "run completes", result: style.red("FAIL"), detail: finished.error ?? finished.state });
  } else {
    report.push({ check: "run completes", result: style.green("PASS"), detail: duration(finished.durationMs) });
  }

  for (const expectation of expectations) {
    const dataset = expectation.dataset;
    const datasetDetail = dataset
      ? await context.client.datasets.get(dataset).catch(() => null)
      : null;
    const rowCount = (datasetDetail?.["dataset"] as { rowCount?: number } | undefined)?.rowCount ?? null;

    if (expectation.minRows !== undefined) {
      const ok = rowCount !== null && rowCount >= expectation.minRows;
      if (!ok) failures++;
      report.push({
        check: `${dataset ?? "run"} rows >= ${expectation.minRows}`,
        result: ok ? style.green("PASS") : style.red("FAIL"),
        detail: rowCount === null ? "dataset not found" : String(rowCount),
      });
    }
    if (expectation.maxRows !== undefined) {
      const ok = rowCount !== null && rowCount <= expectation.maxRows;
      if (!ok) failures++;
      report.push({
        check: `${dataset ?? "run"} rows <= ${expectation.maxRows}`,
        result: ok ? style.green("PASS") : style.red("FAIL"),
        detail: rowCount === null ? "dataset not found" : String(rowCount),
      });
    }

    for (const [kind, columns] of [["not null", expectation.notNull], ["unique", expectation.unique], ["non-negative", expectation.nonNegative]] as const) {
      for (const column of columns ?? []) {
        const matching = runDetail.quality.filter((q) => q.column === column);
        const relevant = matching.filter((q) =>
          kind === "not null" ? q.checkType === "not_null" : kind === "unique" ? q.checkType === "unique" : q.checkType === "range",
        );
        if (!relevant.length) {
          failures++;
          report.push({
            check: `${column} ${kind}`,
            result: style.red("FAIL"),
            detail: `no ${kind} quality check ran for "${column}"`,
          });
          continue;
        }
        const passed = relevant.every((q) => q.status === "PASSED");
        if (!passed) failures++;
        report.push({
          check: `${column} ${kind}`,
          result: passed ? style.green("PASS") : style.red("FAIL"),
          detail: relevant.map((q) => `${q.actual} of ${q.expected}`).join("; "),
        });
      }
    }
  }

  if (context.args.flags["json"]) {
    json({ runId: run.id, state: finished.state, failures, report: report.map((r) => ({ ...r, result: stripAnsi(r.result) })) });
    return failures ? 2 : 0;
  }
  print("");
  print(table(report));
  print("");
  print(failures ? style.red(`${failures} expectation(s) failed`) : style.green("All expectations passed"));
  return failures ? 2 : 0;
}

export async function diff(context: CommandContext): Promise<number> {
  const reference = context.args.positional[0];
  const from = flagNumber(context.args.flags, "from");
  const to = flagNumber(context.args.flags, "to");
  if (!reference || from === undefined || to === undefined) {
    printError("Usage: dataflow pipeline diff <id|name> --from 1 --to 2");
    return 1;
  }
  const { id } = await resolvePipeline(context, reference);
  const result = await context.client.pipelines.compare(id, from, to);
  if (context.args.flags["json"]) { json(result); return 0; }

  print(`${style.bold(`v${from}`)} → ${style.bold(`v${to}`)}`);
  for (const line of result.diff.summary) {
    const colour = line.startsWith("+") ? style.green : line.startsWith("-") ? style.red : line.startsWith("~") ? style.yellow : style.bold;
    print(`  ${colour(line)}`);
  }
  return 0;
}
