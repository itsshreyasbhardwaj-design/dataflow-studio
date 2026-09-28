/**
 * Keyset pagination. The cursor carries the sort value and the row id of the last
 * item, so paging stays O(1) as history grows instead of degrading with OFFSET.
 */
export interface Cursor {
  value: string;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.value}\u0000${cursor.id}`, "utf8").toString("base64url");
}

export function decodeCursor(encoded: string | undefined): Cursor | null {
  if (!encoded) return null;
  try {
    const [value, id] = Buffer.from(encoded, "base64url").toString("utf8").split("\u0000");
    if (value === undefined || id === undefined) return null;
    return { value, id };
  } catch {
    return null;
  }
}

export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

export function clampLimit(limit: number | undefined): number {
  if (!limit || limit < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(limit), MAX_PAGE_SIZE);
}

/** Applies a descending keyset page over an already-sorted array. */
export function paginate<T>(
  items: readonly T[],
  options: { limit?: number; cursor?: string; value: (item: T) => string; id: (item: T) => string; direction?: "asc" | "desc" },
): { items: T[]; nextCursor?: string; total: number } {
  const limit = clampLimit(options.limit);
  const cursor = decodeCursor(options.cursor);
  const direction = options.direction ?? "desc";

  let start = 0;
  if (cursor) {
    const index = items.findIndex((item) => options.value(item) === cursor.value && options.id(item) === cursor.id);
    if (index >= 0) {
      start = index + 1;
    } else {
      // The cursor row is gone (deleted or filtered out); fall back to the
      // position it would have occupied so paging still terminates.
      start = items.findIndex((item) =>
        direction === "desc" ? options.value(item) < cursor.value : options.value(item) > cursor.value,
      );
      if (start < 0) start = items.length;
    }
  }

  const page = items.slice(start, start + limit);
  const last = page.at(-1);
  const hasMore = start + limit < items.length;
  return {
    items: page,
    ...(hasMore && last ? { nextCursor: encodeCursor({ value: options.value(last), id: options.id(last) }) } : {}),
    total: items.length,
  };
}
