import Link from "next/link";
import { Button, Card, EmptyState } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl p-8">
      <Card>
        <EmptyState
          title="Not found"
          description="That pipeline, run or dataset does not exist, or it belongs to another organization."
          action={<Link href="/"><Button variant="primary" size="sm">Back to dashboard</Button></Link>}
        />
      </Card>
    </div>
  );
}
