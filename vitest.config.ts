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

function aliases(): Record<string, string> {
  const pkgs = [
    "workflow-engine", "execution-engine", "scheduler", "connectors",
    "transformations", "data-quality", "lineage", "schema-registry",
    "secrets", "observability", "database", "api-client", "sdk",
  ];
  const out: Record<string, string> = {};
  for (const p of pkgs) {
    out[`@dataflow-studio/${p}`] = new URL(`./packages/${p}/src/index.ts`, import.meta.url).pathname;
  }
  return out;
}
