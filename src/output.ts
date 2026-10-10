export const DEFAULT_MAX_CHARS = 50_000;
export const MIN_MAX_CHARS = 1_000;
export const MAX_MAX_CHARS = 1_000_000;

export interface Cursors {
  next?: string;
  previous?: string;
}

/**
 * Finds pagination cursors in X's GraphQL JSON. X puts them in timeline entries shaped like
 * { cursorType: "Bottom" | "Top", value: "..." } (sometimes nested under content/itemContent).
 * Plain next_cursor / nextCursor fields are also picked up in case a response is pre-shaped.
 * The deepest-first order of X timelines means the first Bottom cursor found is the one to use.
 */
export function extractCursors(data: unknown): Cursors {
  const out: Cursors = {};
  const stack: unknown[] = [data];
  let visited = 0;
  while (stack.length > 0 && visited < 500_000) {
    const node = stack.pop();
    visited++;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
      continue;
    }
    if (!node || typeof node !== "object") continue;
    const obj = node as Record<string, unknown>;
    const type = obj.cursorType ?? obj.cursor_type;
    if (typeof obj.value === "string" && (type === "Bottom" || type === "Top")) {
      if (type === "Bottom" && out.next === undefined) out.next = obj.value;
      if (type === "Top" && out.previous === undefined) out.previous = obj.value;
    }
    for (const key of ["next_cursor", "nextCursor"]) {
      const v = obj[key];
      if (typeof v === "string" && v && v !== "0" && out.next === undefined) out.next = v;
    }
    if (out.next !== undefined && out.previous !== undefined) break;
    const values = Object.values(obj);
    for (let i = values.length - 1; i >= 0; i--) {
      const v = values[i];
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return out;
}

/** Cuts text to maxChars and appends a marker that says how much was dropped and what to do. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const dropped = text.length - maxChars;
  return (
    text.slice(0, maxChars) +
    `\n\n[TRUNCATED: showing the first ${maxChars} of ${text.length} characters (${dropped} cut). ` +
    "The JSON above is incomplete. To see more, raise max_chars, request a smaller count, or page with the cursor.]"
  );
}

/**
 * Builds the text returned to the model: a short header with pagination cursors (kept outside the
 * truncation budget so it is never cut), then the JSON. cursorSource lets cursors come from the
 * raw response when `data` is a simplified version of it.
 */
export function formatResult(
  data: unknown,
  opts: { maxChars?: number; paginated?: boolean; cursorSource?: unknown } = {},
): string {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const json = typeof data === "string" ? data : JSON.stringify(data);
  const header: string[] = [];
  if (opts.paginated) {
    const source = opts.cursorSource ?? data;
    const cursors = typeof source === "string" ? {} : extractCursors(source);
    header.push(
      cursors.next
        ? `next_cursor: ${cursors.next}`
        : "next_cursor: none found (this may be the last page)",
    );
    if (cursors.previous) header.push(`previous_cursor: ${cursors.previous}`);
    header.push("Pass next_cursor as `cursor` to get the next page.");
  }
  const body = truncate(json ?? "null", maxChars);
  return header.length ? `${header.join("\n")}\n\n${body}` : body;
}
