"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, type ClientError } from "./api-client";
import { Badge, Button, Spinner } from "./ui";

export { ConnectionDialog, SecretDialog, DeleteButton } from "./actions";

/** Probes a connection and shows the result inline. */
export function TestConnectionButton({ connectionId }: { connectionId: string }) {
  const router = useRouter();
  const [state, setState] = useState<{ ok: boolean; message: string; latencyMs: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-1.5">
      {state && (
        <Badge tone={state.ok ? "success" : "danger"} mono>
          {state.ok ? `${state.latencyMs}ms` : "failed"}
        </Badge>
      )}
      {error && <span className="max-w-[16rem] truncate text-[11px] text-[var(--color-danger)]">{error}</span>}
      <Button
        size="sm"
        variant="ghost"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const result = await api.post<{ ok: boolean; message: string; latencyMs: number }>(`/api/v1/connections/${connectionId}/test`);
            setState(result);
            if (!result.ok) setError(result.message);
            router.refresh();
          } catch (caught) {
            setError((caught as ClientError).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <Spinner /> : "Test"}
      </Button>
    </div>
  );
}
