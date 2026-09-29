import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    environment: "node",
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts"],
    },
  },
  resolve: {
    alias: aliases(),
  },
});

/**
 * Tests run against package sources, not build output, so a failing test points
 * at the line that caused it and no build step sits between edit and result.
 */
function aliases(): Record<string, string> {
  const packages = [
    "workflow-engine", "execution-engine", "scheduler", "connectors",
    "transformations", "data-quality", "lineage", "schema-registry",
    "secrets", "observability", "database", "api-client", "sdk",
  ];
  const apps = ["api", "worker"];
  const out: Record<string, string> = {};
  for (const name of packages) {
    out[`@dataflow-studio/${name}`] = new URL(`./packages/${name}/src/index.ts`, import.meta.url).pathname;
  }
  for (const name of apps) {
    out[`@dataflow-studio/${name}`] = new URL(`./apps/${name}/src/index.ts`, import.meta.url).pathname;
  }
  return out;
}
