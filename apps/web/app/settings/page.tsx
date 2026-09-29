import { hasPermission, permissionsFor, services } from "@dataflow-studio/api";
import { getServerContext } from "@/lib/server";
import { Badge, Banner, Card, CardHeader, EmptyState, Table, Td, Th } from "@/components/ui";
import { ApiKeyDialog, DeleteButton } from "@/components/actions";
import { formatDateTime, formatRelative } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const context = await getServerContext();
  const role = context.principal.role;
  const organization = await context.store.getOrganization(context.principal.organizationId);

  const [apiKeys, audit, members] = await Promise.all([
    hasPermission(role, "apikey.read") ? services.apiKeys.listApiKeys(context) : Promise.resolve([]),
    hasPermission(role, "audit.read") ? services.analytics.listAudit(context, { limit: 30 }) : Promise.resolve({ items: [] }),
    context.store.listMembers(context.principal.organizationId),
  ]);

  return (
    <div className="mx-auto max-w-[1200px] space-y-4 p-4">
      <div>
        <h1 className="text-[18px] font-semibold tracking-tight">Settings</h1>
        <p className="text-[12.5px] text-[var(--color-text-muted)]">Organization, access and audit.</p>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader title="Organization" />
          <dl className="divide-y divide-[var(--color-border)] text-[12.5px]">
            <Row label="Name" value={organization?.name ?? "–"} />
            <Row label="Slug" value={<span className="mono">{organization?.slug ?? "–"}</span>} />
            <Row label="Organization ID" value={<span className="mono">{context.principal.organizationId}</span>} />
            <Row label="Created" value={formatDateTime(organization?.createdAt)} />
            <Row label="Store driver" value={<Badge tone={context.store.driver === "postgres" ? "success" : "warning"} mono>{context.store.driver}</Badge>} />
          </dl>
        </Card>

        <Card>
          <CardHeader title="Your access" description="Permissions are enforced server-side on every call." />
          <dl className="divide-y divide-[var(--color-border)] text-[12.5px]">
            <Row label="User" value={<span className="mono">{context.principal.userId}</span>} />
            <Row label="Role" value={<Badge tone="accent">{role}</Badge>} />
            <Row label="Authenticated via" value={<span className="mono">{context.principal.actorType}</span>} />
          </dl>
          <div className="border-t border-[var(--color-border)] px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">Granted permissions</div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {permissionsFor(role).map((permission) => <Badge key={permission} mono>{permission}</Badge>)}
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Members" description={`${members.length} member(s) in this organization.`} />
        <Table>
          <thead><tr><Th>User</Th><Th>Role</Th><Th>Email</Th><Th align="right">Joined</Th></tr></thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.userId}>
                <Td><span className="mono">{member.userId}</span></Td>
                <Td><Badge tone={member.role === "owner" ? "accent" : "neutral"}>{member.role}</Badge></Td>
                <Td><span className="text-[var(--color-text-muted)]">{member.email ?? "–"}</span></Td>
                <Td align="right"><span className="text-[11.5px] text-[var(--color-text-muted)]">{formatRelative(member.createdAt)}</span></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      {hasPermission(role, "apikey.read") && (
        <Card>
          <CardHeader
            title="API keys"
            description="Used by the CLI, CI and the SDK. Only a SHA-256 hash is stored."
            actions={hasPermission(role, "apikey.create") ? <ApiKeyDialog /> : undefined}
          />
          {apiKeys.length === 0
            ? <EmptyState title="No API keys" description="Create one to use `dataflow login` or the SDK." />
            : (
              <Table>
                <thead><tr><Th>Name</Th><Th>Prefix</Th><Th>Role</Th><Th align="right">Created</Th><Th align="right">Last used</Th><Th /></tr></thead>
                <tbody>
                  {apiKeys.map((key) => (
                    <tr key={key.id}>
                      <Td>
                        <span className="font-medium">{key.name}</span>
                        {key.revokedAt && <Badge className="ml-2" tone="danger">revoked</Badge>}
                        {key.expiresAt && !key.revokedAt && new Date(key.expiresAt) < new Date() && <Badge className="ml-2" tone="warning">expired</Badge>}
                      </Td>
                      <Td><span className="mono text-[11.5px]">{key.prefix}…</span></Td>
                      <Td><Badge>{key.role}</Badge></Td>
                      <Td align="right"><span className="text-[11.5px] text-[var(--color-text-muted)]">{formatRelative(key.createdAt)}</span></Td>
                      <Td align="right"><span className="text-[11.5px] text-[var(--color-text-muted)]">{formatRelative(key.lastUsedAt)}</span></Td>
                      <Td align="right">
                        {!key.revokedAt && <DeleteButton path={`/api/v1/api-keys/${key.id}`} label="Revoke" confirmText="Any process using this key will stop working immediately." />}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
        </Card>
      )}

      {hasPermission(role, "audit.read") ? (
        <Card>
          <CardHeader title="Audit log" description="Every mutation, who made it, and the result." />
          <Table>
            <thead><tr><Th>When</Th><Th>Actor</Th><Th>Action</Th><Th>Resource</Th><Th>Result</Th><Th>Request</Th></tr></thead>
            <tbody>
              {audit.items.map((entry) => (
                <tr key={entry.id}>
                  <Td><span className="mono text-[11.5px]">{formatDateTime(entry.createdAt)}</span></Td>
                  <Td><span className="mono text-[11.5px]">{entry.actor}</span><span className="ml-1 text-[10.5px] text-[var(--color-text-subtle)]">{entry.actorType}</span></Td>
                  <Td><span className="mono">{entry.action}</span></Td>
                  <Td><span className="mono text-[11px] text-[var(--color-text-muted)]">{entry.resourceType}{entry.resourceId ? `/${entry.resourceId}` : ""}</span></Td>
                  <Td>
                    <Badge tone={entry.result === "success" ? "success" : entry.result === "denied" ? "warning" : "danger"}>{entry.result}</Badge>
                  </Td>
                  <Td><span className="mono text-[10.5px] text-[var(--color-text-subtle)]">{entry.requestId ?? "–"}</span></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : (
        <Banner tone="info">Your role cannot read the audit log. Ask an administrator for access.</Banner>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2">
      <dt className="text-[var(--color-text-subtle)]">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}
