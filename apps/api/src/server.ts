import { createServer } from "node:http";
import { metrics } from "@dataflow-studio/observability";
import { getRuntime } from "./bootstrap.js";

/**
 * Standalone API server.
 *
 * The Next.js app serves the same routes through its own route handler; this
 * exists so the API can be deployed and scaled on its own, and so `curl` works
 * without the web app running.
 */
const port = Number(process.env["PORT"] ?? 3001);
const runtime = await getRuntime();

const server = createServer((incoming, response) => {
  void (async () => {
    const url = `http://${incoming.headers.host ?? `localhost:${port}`}${incoming.url ?? "/"}`;

    if (incoming.url === "/metrics") {
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      response.end(metrics.render());
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    const request = new Request(url, {
      method: incoming.method ?? "GET",
      headers: Object.entries(incoming.headers).flatMap(([key, value]) =>
        value === undefined ? [] : Array.isArray(value) ? value.map((v) => [key, v] as [string, string]) : [[key, value] as [string, string]],
      ),
      ...(body && body.byteLength ? { body: new Uint8Array(body) } : {}),
    });

    const result = await runtime.handler(request);
    response.writeHead(result.status, Object.fromEntries(result.headers.entries()));

    if (!result.body) { response.end(); return; }
    const reader = result.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) response.write(Buffer.from(value));
    }
    response.end();
  })().catch((error: unknown) => {
    runtime.logger.error("Unhandled request error", { error: (error as Error).message });
    if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "internal_error", message: "Internal server error" } }));
  });
});

server.listen(port, () => {
  runtime.logger.info("DataFlow Studio API listening", { port, driver: runtime.store.driver });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    runtime.logger.info("Shutting down", { signal });
    server.close(() => void runtime.store.close?.().then(() => process.exit(0)));
  });
}
