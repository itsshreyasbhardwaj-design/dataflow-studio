import type { UploadedFile } from "@dataflow-studio/database";
import { parseCsv, parseJsonRecords } from "@dataflow-studio/connectors";
import { profileRows, type ColumnProfile } from "@dataflow-studio/schema-registry";
import { newId } from "@dataflow-studio/observability";
import { ApiError } from "../errors.js";
import { audited, authorize, type ApiContext } from "../context.js";

export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const PREVIEW_ROWS = 100;

export interface UploadResult {
  file: UploadedFile;
  preview: {
    rows: Array<Record<string, unknown>>;
    profile: ColumnProfile[];
    rowCount: number;
    truncated: boolean;
  };
}

/**
 * Accepts a CSV or JSON upload and returns a bounded preview.
 *
 * Parsing happens here, server-side, with a row limit: a 60 MB CSV must never be
 * shipped to the browser to be previewed, and the inferred schema the user sees is
 * the same one the pipeline will use.
 */
export async function uploadFile(
  context: ApiContext,
  input: { filename: string; contentType?: string; content: Buffer },
): Promise<UploadResult> {
  authorize(context, "pipeline.edit");
  if (!input.content.byteLength) throw ApiError.validation("Uploaded file is empty");
  if (input.content.byteLength > MAX_UPLOAD_BYTES) {
    throw new ApiError("payload_too_large", `Uploads are limited to ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`);
  }
  const filename = input.filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200) || "upload";
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  if (!["csv", "tsv", "json", "ndjson", "jsonl", "txt"].includes(extension)) {
    throw new ApiError("unsupported_media_type", `Unsupported file type ".${extension}". Upload CSV or JSON.`);
  }

  const text = input.content.toString("utf8");
  const batch = ["json", "ndjson", "jsonl"].includes(extension)
    ? parseJsonRecords(text, { format: extension === "json" ? "array" : "ndjson", limit: 50_000 })
    : parseCsv(text, { delimiter: extension === "tsv" ? "\t" : ",", limit: 50_000 });

  const file: UploadedFile = {
    id: newId("evt"),
    organizationId: context.principal.organizationId,
    filename,
    ...(input.contentType ? { contentType: input.contentType } : {}),
    bytes: input.content.byteLength,
    createdBy: context.principal.userId,
    createdAt: context.now.toISOString(),
  };

  return audited(
    context,
    { action: "file.upload", resourceType: "file", resourceId: file.id, metadata: { filename, bytes: file.bytes } },
    async () => {
      const stored = await context.store.putFile(file, input.content);
      return {
        file: stored,
        preview: {
          rows: batch.rows.slice(0, PREVIEW_ROWS),
          profile: profileRows(batch.rows.slice(0, 1000)),
          rowCount: batch.rowCount,
          truncated: batch.truncated ?? false,
        },
      };
    },
  );
}

export async function listFiles(context: ApiContext): Promise<UploadedFile[]> {
  authorize(context, "pipeline.read");
  return context.store.listFiles(context.principal.organizationId);
}
