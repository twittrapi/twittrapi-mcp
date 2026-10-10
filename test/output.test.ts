import { describe, expect, it } from "vitest";
import { extractCursors, formatResult, truncate } from "../src/output.js";

const timeline = {
  data: {
    user: {
      result: {
        timeline: {
          timeline: {
            instructions: [
              {
                type: "TimelineAddEntries",
                entries: [
                  { entryId: "tweet-1", content: { itemContent: { tweet_results: {} } } },
                  { entryId: "cursor-top-1", content: { entryType: "TimelineTimelineCursor", value: "TOP_CUR", cursorType: "Top" } },
                  { entryId: "cursor-bottom-1", content: { entryType: "TimelineTimelineCursor", value: "BOTTOM_CUR", cursorType: "Bottom" } },
                ],
              },
            ],
          },
        },
      },
    },
  },
};

describe("extractCursors", () => {
  it("finds Top and Bottom cursors in X timeline JSON", () => {
    expect(extractCursors(timeline)).toEqual({ next: "BOTTOM_CUR", previous: "TOP_CUR" });
  });
  it("returns nothing when there are no cursors", () => {
    expect(extractCursors({ a: [1, 2, { b: "c" }] })).toEqual({});
  });
  it("reads plain next_cursor fields", () => {
    expect(extractCursors({ next_cursor: "N" })).toEqual({ next: "N" });
  });
});

describe("truncate", () => {
  it("leaves short text alone", () => {
    expect(truncate("abc", 10)).toBe("abc");
  });
  it("cuts long text and adds a marker", () => {
    const out = truncate("x".repeat(5000), 1000);
    expect(out.startsWith("x".repeat(1000) + "\n\n[TRUNCATED")).toBe(true);
    expect(out).toContain("first 1000 of 5000 characters (4000 cut)");
  });
});

describe("formatResult", () => {
  it("puts cursors above the JSON, outside the truncation budget", () => {
    const big = { ...timeline, padding: "y".repeat(10_000) };
    const out = formatResult(big, { maxChars: 1000, paginated: true });
    expect(out.split("\n")[0]).toBe("next_cursor: BOTTOM_CUR");
    expect(out).toContain("previous_cursor: TOP_CUR");
    expect(out).toContain("[TRUNCATED");
  });
  it("says when no cursor was found", () => {
    expect(formatResult({}, { paginated: true })).toMatch(/^next_cursor: none found/);
  });
  it("omits the cursor header for non-paginated tools", () => {
    expect(formatResult({ a: 1 }, { paginated: false })).toBe('{"a":1}');
  });
  it("uses cursorSource when data was simplified", () => {
    const out = formatResult({ tweets: [] }, { paginated: true, cursorSource: timeline });
    expect(out).toContain("next_cursor: BOTTOM_CUR");
    expect(out).toContain('{"tweets":[]}');
  });
});
