import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Shell } from "@/components/shell";
import { getServerContext } from "@/lib/server";
import { startEmbeddedWorker } from "@/lib/embedded-worker";

export const metadata: Metadata = {
  title: { default: "DataFlow Studio", template: "%s · DataFlow Studio" },
  description: "Control plane for data workflows: design, execute, observe and debug data pipelines.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // In in-memory mode the web process also runs the worker, so `pnpm dev` executes
  // pipelines with no extra services. With DATABASE_URL set this is a no-op.
  await startEmbeddedWorker();

  const context = await getServerContext();
  const incidents = await context.store.listIncidents(context.principal.organizationId, { status: "open", limit: 50 });

  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Shell
          principal={{
            userId: context.principal.userId,
            organizationId: context.principal.organizationId,
            role: context.principal.role,
          }}
          storeDriver={context.store.driver}
          openIncidents={incidents.items.length}
        >
          {children}
        </Shell>
      </body>
    </html>
  );
}
