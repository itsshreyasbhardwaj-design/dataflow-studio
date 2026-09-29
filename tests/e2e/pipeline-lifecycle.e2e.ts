import { expect, test, type Page } from "@playwright/test";

/**
 * The documented demonstration, driven through the browser.
 *
 * Sign in (local mode), seed a pipeline, open the visual editor, validate,
 * publish, run, watch the execution, inspect logs and quality results, and view
 * lineage. Nothing is stubbed: the app runs its own engine and worker.
 */

async function seedDemo(page: Page): Promise<string> {
  const response = await page.request.post("/api/v1/demo/seed", { data: { execute: true } });
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as { pipelines: Array<{ id: string }> };
  return payload.pipelines[0]!.id;
}

test.describe("pipeline lifecycle", () => {
  test("dashboard reports real execution records", async ({ page }) => {
    await seedDemo(page);
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    // The demo run really executed, so the "Succeeded" stat card is non-zero.
    await expect(page.getByRole("link", { name: /Succeeded/ })).toContainText(/[1-9]/);
    await expect(page.getByText("Demo data only")).toBeVisible();
  });

  test("pipeline list, detail and version history", async ({ page }) => {
    const pipelineId = await seedDemo(page);

    await page.goto("/pipelines");
    await expect(page.getByRole("link", { name: "demo-daily-sales" })).toBeVisible();
    await expect(page.getByText("DEMO").first()).toBeVisible();

    await page.goto(`/pipelines/${pipelineId}`);
    await expect(page.getByRole("heading", { name: "demo-daily-sales" })).toBeVisible();
    await expect(page.getByText("published v1")).toBeVisible();
    await expect(page.getByText("Recent runs")).toBeVisible();
  });

  test("visual editor renders the DAG and a node's configuration", async ({ page }) => {
    const pipelineId = await seedDemo(page);
    await page.goto(`/pipelines/${pipelineId}/editor`);

    // The canvas draws every node in the definition.
    await expect(page.locator(".react-flow__node")).toHaveCount(6, { timeout: 30_000 });
    await expect(page.getByText("6 nodes · 5 edges")).toBeVisible();
    await expect(page.getByText("valid")).toBeVisible();

    // Selecting a node opens its schema-driven configuration form.
    await page.locator(".react-flow__node", { hasText: "Revenue by customer" }).click();
    await expect(page.getByRole("heading", { name: "SQL transform" })).toBeVisible();
    await expect(page.getByLabel("Node ID")).toHaveValue("revenue_by_customer");
  });

  test("adding a node marks the draft dirty and validation runs server-side", async ({ page }) => {
    const pipelineId = await seedDemo(page);
    await page.goto(`/pipelines/${pipelineId}/editor`);
    await expect(page.locator(".react-flow__node")).toHaveCount(6, { timeout: 30_000 });

    await page.getByRole("button", { name: /Add node/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByPlaceholder("Filter node types…").fill("filter");
    await page.getByRole("button", { name: /^Filter/ }).first().click();

    // A disconnected node is a validation error, surfaced on the canvas.
    await expect(page.locator(".react-flow__node")).toHaveCount(7);
    await expect(page.getByText("unsaved")).toBeVisible();
    await expect(page.getByText("Pipeline cannot run")).toBeVisible({ timeout: 15_000 });
  });

  test("running a pipeline shows live execution, logs and quality results", async ({ page }) => {
    const pipelineId = await seedDemo(page);

    const run = await page.request.post(`/api/v1/pipelines/${pipelineId}/run`, { data: {} });
    expect(run.ok()).toBeTruthy();
    const { id } = (await run.json()) as { id: string };

    await page.goto(`/runs/${id}`);
    await expect(page.getByText("SUCCESS").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("6/6 tasks")).toBeVisible();

    // The run graph draws the executed DAG.
    await expect(page.locator(".react-flow__node")).toHaveCount(6, { timeout: 20_000 });

    // Quality results carry real numbers.
    await page.getByRole("tab", { name: /Data quality/ }).click();
    await expect(page.getByText("customer_id_unique")).toBeVisible();
    await expect(page.getByText("PASSED").first()).toBeVisible();

    // Logs are searchable.
    await page.getByRole("tab", { name: "Logs" }).click();
    await expect(page.getByText(/Retrieved/)).toBeVisible({ timeout: 20_000 });
    await page.getByLabel("Search logs").fill("Transformation");
    await expect(page.getByText(/Transformation completed/)).toBeVisible({ timeout: 20_000 });
  });

  test("catalog records the dataset with its schema and lineage", async ({ page }) => {
    await seedDemo(page);

    await page.goto("/datasets");
    await expect(page.getByRole("link", { name: "demo_customer_revenue" })).toBeVisible();

    await page.getByRole("link", { name: "demo_customer_revenue" }).click();
    await expect(page.getByRole("heading", { name: "demo_customer_revenue" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Schema", exact: true })).toBeVisible();
    await expect(page.getByText("customer_id").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Lineage", exact: true })).toBeVisible();

    await page.goto("/lineage");
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 20_000 });
  });

  test("a failing quality gate blocks the destination", async ({ page }) => {
    const created = await page.request.post("/api/v1/pipelines", {
      data: {
        name: "e2e-gated",
        definition: {
          name: "e2e-gated",
          nodes: [
            { id: "src", type: "inline.source", config: { rows: [{ id: 1, email: null }], dataset: "e2e_raw" } },
            { id: "checks", type: "quality.check", config: { dataset: "e2e_raw", checks: [{ id: "email_not_null", type: "not_null", column: "email" }] } },
            { id: "gate", type: "quality.gate", config: { severity: "any_failure" } },
            { id: "load", type: "dataset.destination", config: { dataset: "e2e_clean" } },
          ],
          edges: [
            { from: "src", to: "checks" },
            { from: "checks", to: "gate" },
            { from: "gate", to: "load" },
          ],
        },
      },
    });
    const pipelineId = ((await created.json()) as { pipeline: { id: string } }).pipeline.id;
    await page.request.post(`/api/v1/pipelines/${pipelineId}/publish`, { data: {} });
    const run = await page.request.post(`/api/v1/pipelines/${pipelineId}/run`, { data: {} });
    const runId = ((await run.json()) as { id: string }).id;

    await page.goto(`/runs/${runId}`);
    await expect(page.getByText("FAILED").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/blocked by a quality gate/)).toBeVisible();

    await page.getByRole("tab", { name: /Tasks/ }).click();
    await expect(page.getByText("BLOCKED", { exact: true }).first()).toBeVisible();

    // The incident detector opened an incident with evidence.
    await page.goto("/incidents");
    await expect(page.getByText(/data quality check/)).toBeVisible();
  });

  test("global search finds pipelines, runs and datasets", async ({ page }) => {
    await seedDemo(page);
    await page.goto("/");

    await page.getByRole("button", { name: /Search pipelines/ }).click();
    await page.getByLabel("Search query").fill("demo");
    await expect(page.getByRole("option").first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole("option").first().click();
    await expect(page).toHaveURL(/\/(pipelines|runs|datasets)\//);
  });

  test("secrets are write-only from the interface", async ({ page }) => {
    const created = await page.request.post("/api/v1/secrets", {
      data: { name: "e2e-secret", value: "never-shown-value" },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    await page.goto("/connectors");

    await expect(page.getByText("e2e-secret").first()).toBeVisible();
    // The value appears nowhere in the rendered page.
    expect(await page.content()).not.toContain("never-shown-value");
  });

  test("navigation and keyboard access work across the shell", async ({ page }) => {
    await seedDemo(page);
    await page.goto("/");

    for (const [label, pattern] of [
      ["Pipelines", /\/pipelines/],
      ["Runs", /\/runs/],
      ["Datasets", /\/datasets/],
      ["Incidents", /\/incidents/],
      ["Analytics", /\/analytics/],
      ["Connectors", /\/connectors/],
      ["Settings", /\/settings/],
    ] as const) {
      // Scope to the sidebar: dashboard stat cards are links with the same names,
      // and nav links may carry a count badge.
      await page.getByRole("navigation", { name: "Main" })
        .getByRole("link", { name: new RegExp(`^${label}`) })
        .click();
      await expect(page).toHaveURL(pattern);
    }

    // The command palette opens with the documented shortcut.
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByLabel("Search query")).toBeFocused();
    await page.keyboard.press("Escape");
  });
});
