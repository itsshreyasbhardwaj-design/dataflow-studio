import { flagNumber, flagString } from "../args.js";
import { json, print, printError, relativeTime, style, table } from "../output.js";
import type { CommandContext } from "./index.js";

export async function datasetList(context: CommandContext): Promise<number> {
  const page = await context.client.datasets.list({
    ...(flagString(context.args.flags, "search") ? { search: flagString(context.args.flags, "search")! } : {}),
    ...(flagNumber(context.args.flags, "limit") ? { limit: flagNumber(context.args.flags, "limit")! } : {}),
  });
  if (context.args.flags["json"]) { json(page); return 0; }

  print(table(page.items.map((dataset) => ({
    dataset: dataset.name,
    rows: dataset.rowCount?.toLocaleString("en-US") ?? "-",
    schema: dataset.latestSchemaVersion ? `v${dataset.latestSchemaVersion}` : "-",
    quality: dataset.qualityStatus === "failing"
      ? style.red("failing")
      : dataset.qualityStatus === "passing" ? style.green("passing") : style.grey("unknown"),
    updated: relativeTime(dataset.lastUpdatedAt),
  }))));
  return 0;
}

export async function datasetGet(context: CommandContext): Promise<number> {
  const name = context.args.positional[0];
  if (!name) { printError("Usage: dataflow dataset get <name>"); return 1; }
  const detail = await context.client.datasets.get(name);
  if (context.args.flags["json"]) { json(detail); return 0; }

  const dataset = detail["dataset"] as { name: string; rowCount?: number; lastUpdatedAt?: string };
  const schemas = (detail["schemas"] ?? []) as Array<{ version: number; columns: Array<{ name: string; type: string; nullable: boolean }> }>;
  const quality = (detail["quality"] ?? []) as Array<{ checkId: string; status: string; actual: string; expected: string }>;
  const upstream = (detail["upstream"] ?? []) as Array<{ id: string; type: string }>;
  const downstream = (detail["downstream"] ?? []) as Array<{ id: string; type: string }>;

  print(style.bold(dataset.name));
  print(`${style.bold("Rows")}     ${dataset.rowCount?.toLocaleString("en-US") ?? "-"}`);
  print(`${style.bold("Updated")}  ${relativeTime(dataset.lastUpdatedAt)}`);

  const latest = schemas.at(-1);
  if (latest) {
    print(`\n${style.bold(`Schema v${latest.version}`)}`);
    for (const column of latest.columns) {
      print(`  ${column.name.padEnd(24)} ${style.grey(column.type)}${column.nullable ? style.grey(" NULL") : ""}`);
    }
  }
  if (quality.length) {
    print(`\n${style.bold("Latest quality results")}`);
    print(table(quality.slice(0, 10).map((result) => ({
      check: result.checkId,
      status: result.status === "PASSED" ? style.green(result.status) : style.red(result.status),
      actual: result.actual,
    }))));
  }
  if (upstream.length || downstream.length) {
    print(`\n${style.bold("Lineage")}`);
    print(`  upstream:   ${upstream.map((n) => n.id).join(", ") || style.grey("none recorded")}`);
    print(`  downstream: ${downstream.map((n) => n.id).join(", ") || style.grey("none recorded")}`);
  }
  return 0;
}

export async function incidentList(context: CommandContext): Promise<number> {
  const page = await context.client.incidents.list({
    status: flagString(context.args.flags, "status") ?? "open",
    ...(flagNumber(context.args.flags, "limit") ? { limit: flagNumber(context.args.flags, "limit")! } : {}),
  });
  if (context.args.flags["json"]) { json(page); return 0; }
  if (!page.items.length) { print(style.green("No open incidents")); return 0; }

  print(table(page.items.map((incident) => ({
    severity: incident.severity === "high" ? style.red(incident.severity) : incident.severity === "medium" ? style.yellow(incident.severity) : style.grey(incident.severity),
    kind: incident.kind,
    title: incident.title,
    seen: `${incident.occurrences}x`,
    last: relativeTime(incident.lastSeenAt),
  }))));
  return page.items.some((incident) => incident.severity === "high") ? 2 : 0;
}

export async function lineage(context: CommandContext): Promise<number> {
  const graph = await context.client.lineage.get({
    ...(flagString(context.args.flags, "pipeline") ? { pipelineId: flagString(context.args.flags, "pipeline")! } : {}),
  });
  if (context.args.flags["json"]) { json(graph); return 0; }

  const edges = graph.edges as Array<{ from: string; to: string; fromType: string; toType: string; transformation?: string }>;
  const unresolved = graph.unresolved as Array<{ nodeId: string; reason: string }>;

  for (const edge of edges) {
    const arrow = edge.transformation ? `${style.grey(`--[${edge.transformation}]->`)}` : style.grey("-->");
    print(`  ${label(edge.fromType, edge.from)} ${arrow} ${label(edge.toType, edge.to)}`);
  }
  if (!edges.length) print(style.grey("No lineage recorded. Publish a pipeline that names its datasets."));
  if (unresolved.length) {
    print(`\n${style.yellow("Unresolved")} (lineage cannot be asserted for these nodes)`);
    for (const entry of unresolved) print(`  ${entry.nodeId}: ${style.grey(entry.reason)}`);
  }
  return 0;
}

function label(type: string, id: string): string {
  return type === "dataset" ? style.cyan(id) : id;
}
