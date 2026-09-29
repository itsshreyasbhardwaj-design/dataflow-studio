/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript-built ESM; Next transpiles them so the
  // same source is used by the server, the worker and the browser bundle.
  transpilePackages: [
    "@dataflow-studio/api",
    "@dataflow-studio/connectors",
    "@dataflow-studio/data-quality",
    "@dataflow-studio/database",
    "@dataflow-studio/execution-engine",
    "@dataflow-studio/lineage",
    "@dataflow-studio/observability",
    "@dataflow-studio/scheduler",
    "@dataflow-studio/schema-registry",
    "@dataflow-studio/secrets",
    "@dataflow-studio/transformations",
    "@dataflow-studio/workflow-engine",
    "@dataflow-studio/worker",
  ],
  serverExternalPackages: ["pg", "mysql2"],
  experimental: { optimizePackageImports: ["lucide-react", "recharts"] },
  // The API sets its own cache headers; these are the defaults for every route.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "x-content-type-options", value: "nosniff" },
          { key: "referrer-policy", value: "strict-origin-when-cross-origin" },
          { key: "x-frame-options", value: "DENY" },
          { key: "permissions-policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
