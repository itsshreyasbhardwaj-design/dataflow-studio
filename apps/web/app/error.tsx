"use client";

import { Button, Card, EmptyState } from "@/components/ui";

export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-xl p-8">
      <Card>
        <EmptyState
          title="Something went wrong"
          description={
            <>
              <span className="block">{error.message}</span>
              {error.digest && <span className="mono mt-1 block text-[11px] text-[var(--color-text-subtle)]">{error.digest}</span>}
            </>
          }
          action={<Button variant="primary" size="sm" onClick={reset}>Try again</Button>}
        />
      </Card>
    </div>
  );
}
