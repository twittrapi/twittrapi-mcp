export const DEFAULT_MAX_CHARS = 50_000;
export const MIN_MAX_CHARS = 1_000;
export const MAX_MAX_CHARS = 1_000_000;

export interface Cursors {
  next?: string;
  previous?: string;
}

/**
 * Finds pagination cursors in X's GraphQL JSON. X puts them in timeline entries shaped like
 * { entryId: "cursor-bottom-...", content: { cursorType: "Bottom" | "Top", value: "..." } }
 * (sometimes nested under content.itemContent). The first match in document order wins, so in
 * follower lists, where the Bottom entry comes before the Top entry, Bottom is still the next page.
 * Slice responses (community search/members, job search) and pre-shaped responses use a plain
 * next_cursor / nextCursor field instead; that is only a fallback when no Bottom cursor exists.
 */
export function extractCursors(data: unknown): Cursors {
  const out: Cursors = {};
  let fallbackNext: string | undefined;
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
    if (typeof obj.value === "string" && obj.value) {
      if (type === "Bottom" && out.next === undefined) out.next = obj.value;
      if (type === "Top" && out.previous === undefined) out.previous = obj.value;
    }
    if (typeof obj.entryId === "string") {
      const value = cursorEntryValue(obj);
      if (value) {
        if (obj.entryId.startsWith("cursor-bottom-") && out.next === undefined) out.next = value;
        if (obj.entryId.startsWith("cursor-top-") && out.previous === undefined) out.previous = value;
      }
    }
    if (fallbackNext === undefined) {
      for (const key of ["next_cursor", "nextCursor"]) {
        const v = obj[key];
        if (typeof v === "string" && v && v !== "0") {
          fallbackNext = v;
          break;
        }
      }
    }
    if (out.next !== undefined && out.previous !== undefined) break;
    const values = Object.values(obj);
    for (let i = values.length - 1; i >= 0; i--) {
      const v = values[i];
      if (v && typeof v === "object") stack.push(v);
    }
  }
  if (out.next === undefined && fallbackNext !== undefined) out.next = fallbackNext;
  return out;
}

function cursorEntryValue(obj: Record<string, unknown>): string | undefined {
  const content = obj.content as Record<string, unknown> | undefined;
  if (!content || typeof content !== "object") return undefined;
  if (typeof content.value === "string") return content.value;
  const item = content.itemContent as Record<string, unknown> | undefined;
  if (item && typeof item === "object" && typeof item.value === "string") return item.value;
  return undefined;
}

/**
 * Counts result items and cursors in a response: timeline entries (entryId) split into content and
 * cursor entries, plus slice `items_results` elements. `lists` is false when the response has no
 * entry list or slice at all (profiles, trends, empty likes timelines).
 */
export function countItems(data: unknown): { items: number; cursors: number; lists: boolean } {
  let items = 0;
  let cursors = 0;
  let lists = false;
  const stack: unknown[] = [data];
  let visited = 0;
  while (stack.length > 0 && visited < 500_000) {
    const node = stack.pop();
    visited++;
    if (Array.isArray(node)) {
      for (const v of node) stack.push(v);
      continue;
    }
    if (!node || typeof node !== "object") continue;
    const obj = node as Record<string, unknown>;
    if (typeof obj.entryId === "string") {
      lists = true;
      if (obj.entryId.startsWith("cursor-")) cursors++;
      else items++;
      continue;
    }
    if (Array.isArray(obj.items_results)) {
      lists = true;
      items += obj.items_results.length;
      continue;
    }
    for (const v of Object.values(obj)) if (v && typeof v === "object") stack.push(v);
  }
  return { items, cursors, lists };
}

/**
 * The next-page cursor to report, or undefined when this is the last page: no Bottom cursor or
 * next_cursor, the same cursor that was used for this request, or a page that has entry lists
 * but no results (X keeps returning a cursor at the end of a timeline).
 */
export function nextPageCursor(data: unknown, requestCursor?: string): string | undefined {
  const next = extractCursors(data).next;
  if (!next) return undefined;
  if (requestCursor && next === requestCursor) return undefined;
  const { items, lists } = countItems(data);
  if (lists && items === 0) return undefined;
  return next;
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
  opts: { maxChars?: number; paginated?: boolean; cursorSource?: unknown; requestCursor?: string } = {},
): string {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const json = typeof data === "string" ? data : JSON.stringify(data);
  const header: string[] = [];
  if (opts.paginated) {
    const source = opts.cursorSource ?? data;
    const next = typeof source === "string" ? undefined : nextPageCursor(source, opts.requestCursor);
    if (next) {
      header.push(`next_cursor: ${next}`);
      header.push("Pass next_cursor as `cursor` to get the next page.");
    } else {
      header.push("next_cursor: none (last page, no more results)");
    }
  }
  const body = truncate(json ?? "null", maxChars);
  return header.length ? `${header.join("\n")}\n\n${body}` : body;
}
