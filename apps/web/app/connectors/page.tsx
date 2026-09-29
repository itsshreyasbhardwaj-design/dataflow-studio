import { hasPermission, services } from "@dataflow-studio/api";
import { getServerContext } from "@/lib/server";
import { Badge, Card, CardHeader, EmptyState, Table, Td, Th } from "@/components/ui";
import { ConnectionDialog, DeleteButton, SecretDialog, TestConnectionButton } from "@/components/connector-actions";
import { formatRelative } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Connectors" };

export default async function ConnectorsPage() {
  const context = await getServerContext();
  const [connections, secrets] = await Promise.all([
    services.connections.listConnections(context),
    services.secrets.listSecrets(context),
  ]);
  const role = context.principal.role;

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4">
      <div>
        <h1 className="text-[18px] font-semibold tracking-tight">Connectors</h1>
        <p className="text-[12.5px] text-[var(--color-text-muted)]">
          Connections hold non-secret settings and reference credentials by name. Credential values are
          resolved by the worker at run time and are never returned by the API.
        </p>
      </div>

      <Card>
        <CardHeader
          title="Connections"
          description="A pipeline node points at a connection; the connection points at a secret."
          actions={hasPermission(role, "connection.create") ? <ConnectionDialog secrets={secrets.map((secret) => ({ name: secret.name }))} /> : undefined}
        />
        {connections.length === 0
          ? <EmptyState title="No connections" description="Create one to read from or write to PostgreSQL, MySQL, object storage or an HTTP API." />
          : (
            <Table>
              <thead>
                <tr><Th>Name</Th><Th>Family</Th><Th>Settings</Th><Th>Credentials</Th><Th>Last test</Th><Th /></tr>
              </thead>
              <tbody>
                {connections.map((connection) => (
                  <tr key={connection.id} className="align-top hover:bg-[var(--color-surface-raised)]">
                    <Td>
                      <div className="font-medium">{connection.name}</div>
                      <div className="mono text-[11px] text-[var(--color-text-subtle)]">{connection.id}</div>
                    </Td>
                    <Td><Badge mono>{connection.family}</Badge></Td>
                    <Td>
                      <pre className="mono max-w-xs overflow-x-auto text-[10.5px] text-[var(--color-text-muted)]">
                        {JSON.stringify(connection.config, null, 1)}
                      </pre>
                    </Td>
                    <Td>
                      {Object.keys(connection.secretRefs).length === 0
                        ? <span className="text-[11.5px] text-[var(--color-text-subtle)]">none</span>
                        : (
                          <ul className="space-y-0.5">
                            {Object.entries(connection.secretRefs).map(([field, secret]) => (
                              <li key={field} className="mono text-[11px]">
                                {field} → {secret}
                              </li>
                            ))}
                          </ul>
                        )}
                    </Td>
                    <Td>
                      {connection.lastTestedAt
                        ? (
                          <div>
                            <Badge tone={connection.lastTestOk ? "success" : "danger"}>{connection.lastTestOk ? "ok" : "failed"}</Badge>
                            <div className="mt-0.5 text-[11px] text-[var(--color-text-subtle)]">{formatRelative(connection.lastTestedAt)}</div>
                            {!connection.lastTestOk && connection.lastTestMessage && (
                              <div className="mono mt-0.5 max-w-xs text-[10.5px] text-[var(--color-danger)]">{connection.lastTestMessage}</div>
                            )}
                          </div>
                        )
                        : <span className="text-[11.5px] text-[var(--color-text-subtle)]">never tested</span>}
                    </Td>
                    <Td align="right">
                      <div className="flex items-center justify-end gap-1.5">
                        <TestConnectionButton connectionId={connection.id} />
                        {hasPermission(role, "connection.delete") && (
                          <DeleteButton path={`/api/v1/connections/${connection.id}`} label="Delete" confirmText="Pipelines using this connection will fail validation until they are updated." />
                        )}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
      </Card>

      <Card>
        <CardHeader
          title="Secrets"
          description="Envelope-encrypted with a key derived per organization. There is no API endpoint that reads a value back."
          actions={hasPermission(role, "secret.create") ? <SecretDialog /> : undefined}
        />
        {secrets.length === 0
          ? <EmptyState title="No secrets" description="Store a credential here, then reference it from a connection or an HTTP header." />
          : (
            <Table>
              <thead><tr><Th>Name</Th><Th>Backend</Th><Th>Fingerprint</Th><Th align="right">Updated</Th><Th align="right">Last used</Th><Th /></tr></thead>
              <tbody>
                {secrets.map((secret) => (
                  <tr key={secret.name} className="hover:bg-[var(--color-surface-raised)]">
                    <Td><span className="mono font-medium">{secret.name}</span>
                      {secret.description && <div className="text-[11px] text-[var(--color-text-subtle)]">{secret.description}</div>}
                    </Td>
                    <Td><Badge mono tone={secret.backend === "managed" ? "success" : "neutral"}>{secret.backend}</Badge></Td>
                    <Td><span className="mono text-[11px] text-[var(--color-text-subtle)]">{secret.fingerprint}</span></Td>
                    <Td align="right"><span className="text-[11.5px] text-[var(--color-text-muted)]">{formatRelative(secret.updatedAt)}</span></Td>
                    <Td align="right"><span className="text-[11.5px] text-[var(--color-text-muted)]">{formatRelative(secret.lastUsedAt)}</span></Td>
                    <Td align="right">
                      {hasPermission(role, "secret.delete") && (
                        <DeleteButton path={`/api/v1/secrets/${encodeURIComponent(secret.name)}`} label="Delete" />
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
      </Card>
    </div>
  );
}
