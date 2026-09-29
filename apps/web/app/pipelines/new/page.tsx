import { services } from "@dataflow-studio/api";
import { getServerContext } from "@/lib/server";
import { Card, CardHeader } from "@/components/ui";
import { CreatePipelineForm } from "@/components/actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "New pipeline" };

export default async function NewPipelinePage() {
  await getServerContext();
  const templates = services.demo.listTemplates();

  return (
    <div className="mx-auto max-w-xl space-y-4 p-4">
      <div>
        <h1 className="text-[18px] font-semibold tracking-tight">New pipeline</h1>
        <p className="text-[12.5px] text-[var(--color-text-muted)]">
          A pipeline starts as a draft. Nothing runs on a schedule until you publish it.
        </p>
      </div>
      <Card>
        <CardHeader title="Details" />
        <div className="p-4">
          <CreatePipelineForm
            templates={templates.map((template) => ({
              id: template.id,
              title: `${template.title} · ${template.nodeCount} nodes`,
              category: template.category,
              requires: template.requires,
            }))}
          />
        </div>
      </Card>
    </div>
  );
}
