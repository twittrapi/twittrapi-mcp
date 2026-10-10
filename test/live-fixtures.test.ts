// Tests against trimmed real TwittrAPI responses (test/fixtures/live/*.json, captured 2026-10-10).
// Each fixture is { request, capturedAt, response }; only `response` is the API body.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { TwittrApiClient } from "../src/client.js";
import { getEndpoint } from "../src/endpoints.js";
import { countItems, extractCursors, formatResult, nextPageCursor } from "../src/output.js";
import { buildRequest, runEndpoint } from "../src/server.js";

function live(name: string): Record<string, unknown> {
  const url = new URL(`./fixtures/live/${name}.json`, import.meta.url);
  return (JSON.parse(readFileSync(url, "utf8")) as { response: Record<string, unknown> }).response;
}

const TIMELINES: [string, string, string?][] = [
  ["user-userid-tweets", "DAAHCgABHUS5pXT__-wL", "DAAHCgABHUS5pXUAJxEL"],
  ["user-userid-tweetsandreplies", "DAAHCgABHUS5pvk__-sL"],
  ["user-userid-media", "DAABCgABHUS5qIC___0K"],
  ["user-userid-articles", "DAABCgABHUS5rv1___sK"],
  ["user-userid-followers", "1000000000000000000|2109014666", "-1|"],
  ["user-userid-followings", "1000000000000000000|2109014676", "-1|"],
  ["user-userid-verifiedfollowers", "1000000000000000000|2109014682", "-1|"],
  ["lists-tweets", "DAABCgABHUS7Mid__58K"],
  ["lists-members", "1000000000000000000|2109016359", "-1|"],
  ["lists-followers", "1000000000000000000|2109016363", "-1|"],
  ["communities-communityid-tweets", "DAAFCgABHUS5xm5__-oL"],
  ["tweet-tweetid-retweets", "HBaAgIC+kLf1iDQAAA=="],
  ["tweet-tweetid-quotes", "DAACCgACHUS5wrfAJxAK"],
  ["tweet-tweetid", "DAAKCgABHUS5u-s__qkL"],
  ["tweet-tweetid-article", "DAAKCgABHUS5vqW__qkL"],
  ["search", "DAADDAABCgABHUS5rRGX0YcKAAIdRL"],
];

describe("live fixtures: cursors", () => {
  it.each(TIMELINES)("%s: Bottom cursor is next_cursor", (name, bottom, top) => {
    const data = live(name);
    const c = extractCursors(data);
    expect(c.next?.startsWith(bottom), `next=${c.next}`).toBe(true);
    if (top) expect(c.previous?.startsWith(top)).toBe(true);
    expect(nextPageCursor(data)).toBe(c.next);
    expect(formatResult(data, { paginated: true }).split("\n")[0]).toBe(`next_cursor: ${c.next}`);
  });

  it("followers: Bottom (before Top) wins, Top is never reported", () => {
    const out = formatResult(live("user-userid-followers"), { paginated: true, maxChars: 1000 });
    expect(out.split("\n")[0]).toMatch(/^next_cursor: 1000000000000000000\|/);
    expect(out.split("\n\n")[0]).not.toContain("-1|");
  });

  it("search wrapper {category, entries}", () => {
    const data = live("search");
    expect(data.category).toBe("Latest");
    expect(countItems(data).items).toBeGreaterThan(0);
    expect(nextPageCursor(data)).toMatch(/^DAADDAAB/);
  });

  it("slice next_cursor: community search, community members, job search", () => {
    expect(nextPageCursor(live("communities-search-searchterm"))).toBe("WzExMy41ODc5MSwxODk3OTI3NDQxNDQxNTEzNzE4XQ==");
    expect(nextPageCursor(live("communities-communityid-members"))).toMatch(/^CycRAAAAAAwABAwK/);
    expect(nextPageCursor(live("jobs-search-searchterm"))).toBe("WzMuNDcwMjg4OCwiMCIsIjE4MTMwMzEwNDExNTE3Mzc4NTgiXQ==");
    expect(nextPageCursor(live("communities-communityid-moderators"))).toBeUndefined();
  });

  it("empty likes and favorites report the last page", () => {
    for (const name of ["user-userid-likes", "tweet-tweetid-favorites"]) {
      expect(nextPageCursor(live(name)), name).toBeUndefined();
      expect(formatResult(live(name), { paginated: true }), name).toMatch(/^next_cursor: none \(last page/);
    }
  });

  it("articles with an empty tweet_results entry keep the cursor", () => {
    const data = structuredClone(live("user-userid-articles")) as any;
    data.data.user.result.timeline.timeline.instructions[0].entries.unshift({
      entryId: "tweet-1",
      content: { itemContent: { itemType: "TimelineTweet", tweet_results: {} } },
    });
    expect(nextPageCursor(data)).toMatch(/^DAABCgABHUS5rv1___sK/);
  });

  it("a page with only cursor entries, or a repeated cursor, is the last page", () => {
    const cursorOnly = {
      data: {
        timeline: {
          instructions: [
            {
              type: "TimelineAddEntries",
              entries: [
                { entryId: "cursor-top-1", content: { cursorType: "Top", value: "T" } },
                { entryId: "cursor-bottom-1", content: { cursorType: "Bottom", value: "B" } },
              ],
            },
          ],
        },
      },
    };
    expect(extractCursors(cursorOnly).next).toBe("B");
    expect(nextPageCursor(cursorOnly)).toBeUndefined();
    const followers = live("user-userid-followers");
    const next = extractCursors(followers).next!;
    expect(nextPageCursor(followers, next)).toBeUndefined();
    const emptySlice = { data: { job_search: { items_results: [], slice_info: { next_cursor: "X" } } } };
    expect(nextPageCursor(emptySlice)).toBeUndefined();
  });
});

describe("live fixtures: runEndpoint", () => {
  it("get_followers with userId and username sends only the userId", async () => {
    const f = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify(live("user-userid-followers"))));
    const client = new TwittrApiClient({ mode: "direct", apiKey: "k", fetch: f as unknown as typeof fetch });
    const res = await runEndpoint(client, getEndpoint("get_followers")!, { userId: "2244994945", username: "XDevelopers", count: 20 });
    const url = new URL(String(f.mock.calls[0]![0]));
    expect(url.pathname).toMatch(/\/user\/2244994945\/followers$/);
    expect(url.searchParams.get("username")).toBeNull();
    expect(url.searchParams.get("count")).toBe("20");
    expect((res.content[0] as { text: string }).text).toMatch(/^next_cursor: 1000000000000000000\|/);
  });

  it("reports the last page when the cursor comes back unchanged", async () => {
    const body = live("tweet-tweetid-retweets");
    const same = extractCursors(body).next!;
    const f = vi.fn(async () => new Response(JSON.stringify(body)));
    const client = new TwittrApiClient({ mode: "direct", apiKey: "k", fetch: f as unknown as typeof fetch });
    const res = await runEndpoint(client, getEndpoint("get_tweet_retweets")!, { tweetId: "1", cursor: same });
    expect((res.content[0] as { text: string }).text).toMatch(/^next_cursor: none \(last page/);
  });

  it("username only: path -1 and cleaned handle; a bare @ is rejected", () => {
    const def = getEndpoint("get_user_tweets")!;
    expect(buildRequest(def, { username: " @XDevelopers " })).toEqual({ path: "/user/-1/tweets", query: { username: "XDevelopers" } });
    expect(() => buildRequest(def, { username: " @ " })).toThrow(/userId or username/);
  });

  it("count schema accepts 1..100 only", () => {
    const schema = getEndpoint("get_followers")!.params.count.schema;
    expect(schema.safeParse(1).success).toBe(true);
    expect(schema.safeParse(100).success).toBe(true);
    expect(schema.safeParse(0).success).toBe(false);
    expect(schema.safeParse(101).success).toBe(false);
    expect(schema.safeParse(undefined).success).toBe(true);
  });
});
