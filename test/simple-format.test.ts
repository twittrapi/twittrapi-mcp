// The simple response format (format=simple), used by default for tool results. Fixtures in
// test/fixtures/simple are real API responses converted by the API's own normalize code (copied from
// its testdata).
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  DEFAULT_FORMAT,
  TwittrApiClient,
  configFromEnv,
  parseResponseFormat,
  type ClientConfig,
} from "../src/client.js";
import { getEndpoint } from "../src/endpoints.js";
import { isSimplePage, nextPageCursor } from "../src/output.js";
import { inputShape, runEndpoint, serverInstructions, SERVER_INSTRUCTIONS } from "../src/server.js";

function simple(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`./fixtures/simple/${name}.json`, import.meta.url), "utf8"));
}

function setup(body: unknown, config: Partial<ClientConfig> = {}) {
  const f = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify(body)));
  const client = new TwittrApiClient({ mode: "direct", apiKey: "k", fetch: f as unknown as typeof fetch, ...config });
  const url = (i = 0) => new URL(String(f.mock.calls[i]![0]));
  return { client, f, url };
}

async function run(client: TwittrApiClient, tool: string, args: Record<string, unknown>) {
  const res = await runEndpoint(client, getEndpoint(tool)!, args);
  expect(res.isError, (res.content[0] as { text: string }).text).toBeFalsy();
  return (res.content[0] as { text: string }).text;
}

describe("format selection", () => {
  it("defaults to simple and sends format=simple", async () => {
    expect(DEFAULT_FORMAT).toBe("simple");
    const { client, url } = setup(simple("user-by-username-username"));
    await run(client, "get_user_by_username", { username: "XDevelopers" });
    expect(url().pathname).toBe("/user/by/username/XDevelopers");
    expect(url().searchParams.get("format")).toBe("simple");
  });

  it("keeps the other query parameters", async () => {
    const { client, url } = setup(simple("user-userid-followers"));
    await run(client, "get_followers", { username: "@XDevelopers", count: 20, cursor: "C" });
    expect(Object.fromEntries(url().searchParams)).toEqual({ username: "XDevelopers", count: "20", cursor: "C", format: "simple" });
  });

  it("format: raw on a tool call sends no format parameter", async () => {
    const { client, url } = setup({ data: {} });
    await run(client, "get_user_by_id", { userId: "12", format: "raw" });
    expect(url().search).toBe("");
  });

  it("a raw server default can be overridden per call with format: simple", async () => {
    const { client, url } = setup({ data: {} }, { format: "raw" });
    await run(client, "get_user_by_id", { userId: "12" });
    await run(client, "get_user_by_id", { userId: "12", format: "simple" });
    expect(url(0).searchParams.get("format")).toBeNull();
    expect(url(1).searchParams.get("format")).toBe("simple");
  });

  it("every tool has a format argument that accepts only simple and raw", () => {
    const shape = inputShape(getEndpoint("search_tweets")!);
    const schema = shape.format as z.ZodType;
    expect(schema.safeParse("simple").success).toBe(true);
    expect(schema.safeParse("raw").success).toBe(true);
    expect(schema.safeParse(undefined).success).toBe(true);
    expect(schema.safeParse("json").success).toBe(false);
    expect(schema.description).toMatch(/default simple/);
    expect((inputShape(getEndpoint("search_tweets")!, "raw").format as z.ZodType).description).toMatch(/default raw/);
  });

  it("server instructions describe the default format", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/simple format by default/);
    expect(serverInstructions("raw")).toMatch(/raw GraphQL JSON by default/);
  });
});

describe("TWITTRAPI_RESPONSE_FORMAT", () => {
  it("parses simple and raw, case-insensitive; empty means default", () => {
    expect(parseResponseFormat("raw")).toBe("raw");
    expect(parseResponseFormat(" SIMPLE ")).toBe("simple");
    expect(parseResponseFormat("")).toBeUndefined();
    expect(parseResponseFormat(undefined)).toBeUndefined();
    expect(() => parseResponseFormat("json")).toThrow(/Invalid TWITTRAPI_RESPONSE_FORMAT value "json"/);
  });

  it("configFromEnv carries the format", () => {
    expect(configFromEnv({ TWITTRAPI_API_KEY: "k", TWITTRAPI_RESPONSE_FORMAT: "raw" }).format).toBe("raw");
    expect(configFromEnv({ RAPIDAPI_KEY: "r", TWITTRAPI_RESPONSE_FORMAT: "raw" }).format).toBe("raw");
    expect(configFromEnv({ TWITTRAPI_API_KEY: "k" }).format).toBeUndefined();
    expect(() => configFromEnv({ TWITTRAPI_API_KEY: "k", TWITTRAPI_RESPONSE_FORMAT: "xml" })).toThrow(/Invalid/);
  });
});

describe("simple results", () => {
  it("returns the simple JSON unchanged (compact, no pretty-printing)", async () => {
    const body = simple("user-by-username-username");
    const { client } = setup(body);
    const text = await run(client, "get_user_by_username", { username: "XDevelopers" });
    expect(text).toBe(JSON.stringify(body));
    expect(JSON.parse(text).data.username).toBe("XDevelopers");
  });

  it("prints nextCursor as next_cursor on paginated tools", async () => {
    const body = simple("user-userid-tweets");
    const { client } = setup(body);
    const text = await run(client, "get_user_tweets", { userId: "2244994945" });
    expect(text.split("\n")[0]).toBe(`next_cursor: ${body.nextCursor}`);
    expect(text).toContain(JSON.stringify(body));
  });

  it("follower cursors (with the | separator) pass through", async () => {
    const body = simple("user-userid-followers");
    const { client } = setup(body);
    const text = await run(client, "get_followers", { userId: "1" });
    expect(text).toMatch(/^next_cursor: 1000000000000000000\|/);
  });

  it("reports the last page when hasNextPage is false", async () => {
    const { client } = setup(simple("tweet-tweetid-favorites"));
    const text = await run(client, "search_tweets", { searchItem: "nothing here" });
    expect(text.split("\n")[0]).toBe("next_cursor: none (last page, no more results)");
  });

  it("non-paginated tools print no cursor header", async () => {
    const body = simple("trends-locationid");
    const { client } = setup(body);
    expect(await run(client, "get_trends", { locationId: "1" })).toBe(JSON.stringify(body));
  });

  it("tweets_by_ids returns the found tweets in request order, without a cursor header", async () => {
    const body = simple("tweet-tweets-by-ids");
    const { client, url } = setup(body);
    const text = await run(client, "tweets_by_ids", { ids: ["2019881223666233717", "20", "1"] });
    expect(url().pathname).toBe("/tweet/tweets/by/ids");
    expect(url().searchParams.get("ids")).toBe("2019881223666233717,20,1");
    expect(url().searchParams.get("format")).toBe("simple");
    expect(text).toBe(JSON.stringify(body));
    expect(JSON.parse(text).data.map((t: { id: string }) => t.id)).toEqual(["2019881223666233717", "20"]);
  });

  it("tweets_by_ids in the raw format keeps an empty object for an ID without a tweet", async () => {
    const body = { data: { tweetResult: [{ result: { __typename: "Tweet", rest_id: "20" } }, {}] } };
    const { client, url } = setup(body);
    const text = await run(client, "tweets_by_ids", { ids: ["20", "1"], format: "raw" });
    expect(url().searchParams.has("format")).toBe(false);
    expect(JSON.parse(text).data.tweetResult).toEqual(body.data.tweetResult);
  });

  it("slice-based pages (community search) use nextCursor too", async () => {
    const body = simple("communities-search-searchterm");
    const { client } = setup(body);
    const text = await run(client, "search_communities", { searchTerm: "golang" });
    expect(text.split("\n")[0]).toBe(`next_cursor: ${body.nextCursor}`);
  });

  it("raw format output still uses the raw cursor detection", async () => {
    const raw = { data: { timeline: { instructions: [{ entries: [{ entryId: "tweet-1", content: {} }, { entryId: "cursor-bottom-1", content: { cursorType: "Bottom", value: "RAW_NEXT" } }] }] } } };
    const { client } = setup(raw);
    const text = await run(client, "get_list_tweets", { listId: "5", format: "raw" });
    expect(text.split("\n")[0]).toBe("next_cursor: RAW_NEXT");
  });
});

describe("nextPageCursor on simple pages", () => {
  const page = (nextCursor: string | null, hasNextPage: boolean, data: unknown[] = [{ id: "1" }]) => ({
    data,
    nextCursor,
    previousCursor: null,
    hasNextPage,
  });

  it("uses nextCursor only while hasNextPage is true", () => {
    expect(nextPageCursor(page("N", true))).toBe("N");
    expect(nextPageCursor(page("N", false))).toBeUndefined();
    expect(nextPageCursor(page(null, false))).toBeUndefined();
    expect(nextPageCursor(page("", true))).toBeUndefined();
  });

  it("treats a cursor equal to the request cursor as the end", () => {
    expect(nextPageCursor(page("SAME", true), "SAME")).toBeUndefined();
  });

  it("isSimplePage tells simple envelopes from raw JSON and single objects", () => {
    expect(isSimplePage(simple("user-userid-followers"))).toBe(true);
    expect(isSimplePage(simple("tweet-tweetid-retweets"))).toBe(true);
    expect(isSimplePage(simple("user-by-username-username"))).toBe(false);
    expect(isSimplePage(simple("username-to-id-username"))).toBe(false);
    expect(isSimplePage({ data: { user: {} } })).toBe(false);
    expect(isSimplePage(null)).toBe(false);
  });
});
