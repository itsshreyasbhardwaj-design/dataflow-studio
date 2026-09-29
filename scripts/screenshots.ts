/**
 * Captures the screenshots used in the README.
 *
 * Run against a server with demo data seeded:
 *
 *   pnpm --filter @dataflow-studio/web run dev &
 *   pnpm seed
 *   pnpm exec tsx scripts/screenshots.ts        # or: node --experimental-strip-types
 *
 * They are regenerated rather than hand-cropped, so the README cannot drift from
 * what the product actually looks like.
 */
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";

const baseURL = process.env["SCREENSHOT_URL"] ?? "http://localhost:3000";
const output = new URL("../docs/images/", import.meta.url).pathname;
await mkdir(output, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

async function shot(path: string, file: string, options: { wait?: number; fullPage?: boolean } = {}): Promise<void> {
  await page.goto(`${baseURL}${path}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(options.wait ?? 1500);
  await page.screenshot({ path: `${output}${file}`, fullPage: options.fullPage ?? false });
  process.stdout.write(`captured ${file}\n`);
}

// Resolve the seeded pipeline and its most recent run.
const pipelines = await (await page.request.get(`${baseURL}/api/v1/pipelines`)).json() as { items: Array<{ id: string }> };
const pipelineId = pipelines.items[0]?.id;
const runs = await (await page.request.get(`${baseURL}/api/v1/runs`)).json() as { items: Array<{ id: string }> };
const runId = runs.items[0]?.id;

await shot("/", "dashboard.png");
await shot("/pipelines", "pipelines.png");
if (pipelineId) await shot(`/pipelines/${pipelineId}/editor`, "editor.png", { wait: 4000 });
if (runId) await shot(`/runs/${runId}`, "run.png", { wait: 2500 });
await shot("/datasets", "datasets.png");
await shot("/lineage", "lineage.png", { wait: 2500 });

await browser.close();
