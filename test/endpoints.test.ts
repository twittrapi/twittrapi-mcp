import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { TwittrApiClient } from "../src/client.js";
import { ENDPOINTS, getEndpoint } from "../src/endpoints.js";
import { buildRequest, runEndpoint } from "../src/server.js";
import { VERSION } from "../src/version.js";

const EXPECTED = [
  "get_user_by_username", "get_user_by_id", "username_to_id", "users_by_ids", "get_user_tweets",
  "get_user_tweets_and_replies", "get_user_media", "get_followers", "get_following", "get_verified_followers",
  "search_tweets", "get_tweet", "get_tweet_retweets", "get_tweet_favorites", "get_tweet_quotes",
  "get_list_details", "get_list_tweets", "get_list_members", "get_community", "get_community_tweets",
  "search_communities", "get_trends", "get_trend_locations",
];

function ep(name: string) {
  const def = getEndpoint(name);
  if (!def) throw new Error(`missing ${name}`);
  return def;
}

describe("endpoint table", () => {
  it("has exactly the expected tools, unique and snake_case", () => {
    expect(ENDPOINTS.map((e) => e.name).sort()).toEqual([...EXPECTED].sort());
    for (const e of ENDPOINTS) expect(e.name).toMatch(/^[a-z][a-z0-9_]*$/);
  });
  it("declares every path placeholder as a path param", () => {
    for (const e of ENDPOINTS) {
      const placeholders = [...e.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const pathParams = Object.entries(e.params).filter(([, p]) => p.in === "path").map(([n, p]) => p.apiName ?? n).sort();
      expect(pathParams, e.name).toEqual(placeholders);
      expect(e.description.length, e.name).toBeGreaterThan(20);
    }
  });
  it("version constant matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(VERSION).toBe(pkg.version);
  });
});

describe("buildRequest", () => {
  it.each([
    ["get_user_by_username", { username: "@jack" }, "/user/by/username/jack", {}],
    ["get_user_by_id", { userId: "12" }, "/user/12", {}],
    ["username_to_id", { username: "jack" }, "/username/to/id/jack", {}],
    ["users_by_ids", { ids: ["1", "2", "3"] }, "/user/users/by/ids", { ids: "1,2,3" }],
    ["get_user_tweets", { userId: "12", count: 5, cursor: "C" }, "/user/12/tweets", { count: 5, cursor: "C" }],
    ["get_user_tweets", { username: "@jack" }, "/user/-1/tweets", { username: "jack" }],
    ["get_user_tweets", { userId: "12", username: "jack" }, "/user/12/tweets", {}],
    ["get_user_tweets_and_replies", { userId: "12" }, "/user/12/tweetsAndReplies", {}],
    ["get_user_media", { userId: "12" }, "/user/12/media", {}],
    ["get_followers", { userId: "12" }, "/user/12/followers", {}],
    ["get_following", { userId: "12" }, "/user/12/followings", {}],
    ["get_verified_followers", { userId: "12" }, "/user/12/verifiedFollowers", {}],
    ["search_tweets", { searchItem: "from:jack", category: "Latest", count: 10 }, "/search", { searchItem: "from:jack", category: "Latest", count: 10 }],
    ["get_tweet", { tweetId: "99", rankingMode: "Recency" }, "/tweet/99", { rankingMode: "Recency" }],
    ["get_tweet_retweets", { tweetId: "99" }, "/tweet/99/retweets", {}],
    ["get_tweet_favorites", { tweetId: "99" }, "/tweet/99/favorites", {}],
    ["get_tweet_quotes", { tweetId: "99" }, "/tweet/99/quotes", {}],
    ["get_list_details", { listId: "5" }, "/lists/details", { listId: "5" }],
    ["get_list_tweets", { listId: "5" }, "/lists/tweets", { listId: "5" }],
    ["get_list_members", { listId: "5" }, "/lists/members", { listId: "5" }],
    ["get_community", { communityId: "7" }, "/communities/7", {}],
    ["get_community_tweets", { communityId: "7" }, "/communities/7/tweets", {}],
    ["search_communities", { searchTerm: "ai art/x" }, "/communities/search/ai%20art%2Fx", {}],
    ["get_trends", { locationId: "1" }, "/trends/1", {}],
    ["get_trend_locations", {}, "/misc/locations", {}],
  ])("%s %j -> %s", (name, args, path, query) => {
    const req = buildRequest(ep(name), args);
    expect(req.path).toBe(path);
    expect(req.query).toEqual(query);
  });
  it("requires userId or username for user timelines", () => {
    expect(() => buildRequest(ep("get_followers"), {})).toThrow(/userId or username/);
  });
  it("rejects more than 500 ids at the schema level", () => {
    const schema = ep("users_by_ids").params.ids.schema;
    expect(schema.safeParse(Array.from({ length: 501 }, (_, i) => String(i))).success).toBe(false);
    expect(schema.safeParse(Array.from({ length: 500 }, (_, i) => String(i))).success).toBe(true);
    expect(schema.safeParse(["1"]).success).toBe(true);
    expect(schema.safeParse(["abc"]).success).toBe(false);
  });
});

describe("runEndpoint", () => {
  it("returns JSON text and honours max_chars", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ data: "z".repeat(5000) }), { status: 200 }));
    const client = new TwittrApiClient({ mode: "direct", apiKey: "k", fetch: f });
    const res = await runEndpoint(client, ep("get_user_by_id"), { userId: "1", max_chars: 1000 });
    expect(res.isError).toBeFalsy();
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("[TRUNCATED");
    expect(text.startsWith('{"data":"zzz')).toBe(true);
  });
  it("returns isError results for API errors", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: "no money" }), { status: 402 }));
    const client = new TwittrApiClient({ mode: "direct", apiKey: "k", fetch: f });
    const res = await runEndpoint(client, ep("get_tweet"), { tweetId: "1" });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/^Error: No balance left/);
  });
  it("applies a simplify function while keeping cursors from the raw response", async () => {
    const raw = { entries: [{ cursorType: "Bottom", value: "NEXT" }], big: "..." };
    const f = vi.fn(async () => new Response(JSON.stringify(raw), { status: 200 }));
    const client = new TwittrApiClient({ mode: "direct", apiKey: "k", fetch: f });
    const def = { ...ep("get_list_tweets"), simplify: () => ({ simplified: true }) };
    const res = await runEndpoint(client, def, { listId: "5" });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("next_cursor: NEXT");
    expect(text).toContain('{"simplified":true}');
  });
});
