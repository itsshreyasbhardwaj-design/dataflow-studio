import { inferSchema, makeBatch, type DataBatch, type Row } from "@dataflow-studio/schema-registry";
import { ConnectorError } from "./types.js";

/**
 * Deterministic synthetic data. A mulberry32 PRNG keeps the output identical for
 * a given seed across processes and platforms, which is what lets demo pipelines
 * have reproducible quality results and lets tests assert on real numbers.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type GeneratorPreset = "sales" | "customers" | "events";

export interface GenerateOptions {
  preset?: GeneratorPreset;
  rowCount?: number;
  seed?: number;
  /** Fraction of nullable fields emitted as NULL, so quality checks have something to find. */
  nullRate?: number;
  /** Base timestamp; defaults to a fixed date so output is fully deterministic. */
  startDate?: Date;
}

const REGIONS = ["north", "south", "east", "west"] as const;
const STATUSES = ["pending", "paid", "shipped", "refunded"] as const;
const NAMES = [
  "Ada Lovelace", "Grace Hopper", "Alan Turing", "Katherine Johnson", "Edsger Dijkstra",
  "Barbara Liskov", "Ken Thompson", "Margaret Hamilton", "Leslie Lamport", "Radia Perlman",
] as const;

export function generateRows(options: GenerateOptions = {}): DataBatch {
  const preset = options.preset ?? "sales";
  const rowCount = options.rowCount ?? 500;
  if (rowCount < 0 || rowCount > 500_000) {
    throw new ConnectorError("rowCount must be between 0 and 500000", "configuration");
  }
  const random = mulberry32(options.seed ?? 42);
  const nullRate = Math.min(Math.max(options.nullRate ?? 0, 0), 1);
  const start = options.startDate ?? new Date("2026-01-01T00:00:00Z");
  const maybeNull = <T>(value: T): T | null => (random() < nullRate ? null : value);

  const rows: Row[] = [];
  for (let i = 0; i < rowCount; i++) {
    const at = new Date(start.getTime() + i * 3600_000).toISOString();
    switch (preset) {
      case "sales":
        rows.push({
          order_id: i + 1,
          customer_id: maybeNull(`c${1 + Math.floor(random() * Math.max(1, rowCount / 5))}`),
          region: REGIONS[Math.floor(random() * REGIONS.length)]!,
          status: STATUSES[Math.floor(random() * STATUSES.length)]!,
          amount: Number((random() * 500).toFixed(2)),
          created_at: at,
        });
        break;
      case "customers":
        rows.push({
          id: `c${i + 1}`,
          name: NAMES[Math.floor(random() * NAMES.length)]!,
          email: maybeNull(`user${i + 1}@example.com`),
          tier: random() < 0.2 ? "gold" : random() < 0.5 ? "silver" : "bronze",
          lifetime_value: Number((random() * 10_000).toFixed(2)),
          signed_up_at: at,
        });
        break;
      case "events":
        rows.push({
          event_id: `e${i + 1}`,
          user_id: `u${1 + Math.floor(random() * Math.max(1, rowCount / 10))}`,
          event_name: ["page_view", "signup", "purchase", "churn"][Math.floor(random() * 4)]!,
          properties_source: ["web", "ios", "android"][Math.floor(random() * 3)]!,
          value: maybeNull(Number((random() * 100).toFixed(2))),
          occurred_at: at,
        });
        break;
      default:
        throw new ConnectorError(`Unknown generator preset "${preset}"`, "configuration");
    }
  }
  return makeBatch(rows, inferSchema(rows));
}
