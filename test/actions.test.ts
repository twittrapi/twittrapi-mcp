import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { TwittrApiClient, scrubSession, xSessionFromEnv, type XSession } from "../src/client.js";
import { ACTIONS, getAction } from "../src/actions.js";
import { actionInputShape, actionsFor, runAction } from "../src/server.js";

const COOKIE = "auth_token=abcdef0123456789; ct0=fedcba9876543210; twid=u%3D12";
const PROXY = "http://proxyuser:proxypass123@10.0.0.1:8080";
const session: XSession = { cookie: COOKIE, proxy: PROXY };

const EXPECTED = [
  "create_tweet", "reply_to_tweet", "delete_tweet", "like_tweet", "unlike_tweet", "retweet", "unretweet",
  "bookmark_tweet", "unbookmark_tweet", "follow_user", "unfollow_user", "list_dm_conversations", "send_dm",
  "create_list", "add_list_member", "remove_list_member", "create_draft", "list_drafts",
  "list_bookmark_folders", "list_bookmark_folder_tweets", "search_bookmarks", "list_community_memberships",
  "list_articles", "get_article", "create_article", "update_article", "publish_article", "unpublish_article",
  "delete_article",
];

function act(name: string) {
  const def = getAction(name);
  if (!def) throw new Error(`missing ${name}`);
  return def;
}

function mockFetch(status: number, body: unknown) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function sentBody(fetchMock: ReturnType<typeof mockFetch>): Record<string, unknown> {
  return JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
}

function text(result: Awaited<ReturnType<typeof runAction>>): string {
  return (result.content[0] as { text: string }).text;
}

describe("action table", () => {
  it("has exactly the expected tools, unique, snake_case, POST /client paths", () => {
    expect(ACTIONS.map((a) => a.name).sort()).toEqual([...EXPECTED].sort());
    for (const a of ACTIONS) {
      expect(a.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(a.path).toMatch(/^\/client\//);
      expect(a.description.length, a.name).toBeGreaterThan(20);
    }
  });

  it("never exposes cookie, proxy or passcode as tool arguments", () => {
    for (const a of ACTIONS) {
      const keys = Object.keys(actionInputShape(a)).map((k) => k.toLowerCase());
      for (const secret of ["cookie", "proxy", "passcode", "auth_token", "ct0"]) {
        expect(keys, a.name).not.toContain(secret);
      }
    }
  });

  it("marks deletions and undo actions destructive, reads read-only", () => {
    for (const name of [
      "delete_tweet", "unlike_tweet", "unretweet", "unbookmark_tweet", "unfollow_user", "remove_list_member",
      "unpublish_article", "delete_article",
    ]) {
      expect(act(name).destructive, name).toBe(true);
      expect(act(name).write, name).toBe(true);
    }
    for (const name of [
      "create_tweet", "like_tweet", "follow_user", "send_dm", "create_list", "create_draft",
      "create_article", "update_article", "publish_article",
    ]) {
      expect(act(name).destructive, name).toBe(false);
      expect(act(name).write, name).toBe(true);
    }
    expect(act("list_dm_conversations").write).toBe(false);
    expect(act("list_drafts").write).toBe(false);
    for (const name of [
      "list_bookmark_folders", "list_bookmark_folder_tweets", "search_bookmarks", "list_community_memberships",
      "list_articles", "get_article",
    ]) {
      expect(act(name).write, name).toBe(false);
      expect(act(name).destructive, name).toBe(false);
    }
    expect(act("publish_article").idempotent).toBe(false);
  });

  it("gives the endpoints without a simple format no format argument", () => {
    const rawOnly = ACTIONS.filter((a) => a.rawOnly).map((a) => a.name);
    expect(rawOnly.sort()).toEqual(EXPECTED.slice(EXPECTED.indexOf("list_bookmark_folders")).sort());
    for (const name of rawOnly) expect(Object.keys(actionInputShape(act(name))), name).not.toContain("format");
    expect(Object.keys(actionInputShape(act("like_tweet")))).toContain("format");
  });
});

describe("action bodies", () => {
  it.each([
    ["create_tweet", { text: "hi" }, { text: "hi" }],
    [
      "create_tweet",
      { text: "q", quoteUrl: "https://x.com/jack/status/20", whoCanReply: "only_follows" },
      { text: "q", quote_url: "https://x.com/jack/status/20", conversation_control_mode: "only_follows" },
    ],
    [
      "create_tweet",
      { text: "Which?", pollChoices: ["A", "B"], pollDurationMinutes: 60 },
      { text: "Which?", poll: { choices: ["A", "B"], duration_minutes: 60 } },
    ],
    ["create_tweet", { text: "Which?", pollChoices: ["A", "B"] }, { text: "Which?", poll: { choices: ["A", "B"] } }],
    ["reply_to_tweet", { tweetId: "20", text: "nice" }, { id: "20", text: "nice" }],
    [
      "reply_to_tweet",
      { tweetId: "20", text: "see", quoteUrl: "https://twitter.com/a/status/1" },
      { id: "20", text: "see", attachment_url: "https://twitter.com/a/status/1" },
    ],
    ["delete_tweet", { tweetId: "20" }, { tweet_id: "20" }],
    ["like_tweet", { tweetId: "20" }, { tweet_id: "20" }],
    ["unlike_tweet", { tweetId: "20" }, { tweet_id: "20" }],
    ["retweet", { tweetId: "20" }, { tweet_id: "20" }],
    ["unretweet", { tweetId: "20" }, { tweet_id: "20" }],
    ["bookmark_tweet", { tweetId: "20" }, { tweet_id: "20" }],
    ["unbookmark_tweet", { tweetId: "20" }, { tweet_id: "20" }],
    ["follow_user", { userId: "12", username: "jack" }, { user_id: "12" }],
    ["follow_user", { username: "@jack" }, { username: "jack" }],
    ["unfollow_user", { username: "jack" }, { username: "jack" }],
    ["list_dm_conversations", {}, {}],
    ["list_dm_conversations", { count: 5 }, { count: 5 }],
    ["send_dm", { userId: "12", text: "Hello" }, { user_id: "12", text: "Hello" }],
    ["send_dm", { conversationId: "12:13", userId: "12", text: "Hi" }, { conversation_id: "12:13", text: "Hi" }],
    ["create_list", { name: "AI", private: true }, { name: "AI", private: true }],
    ["create_list", { name: "AI", description: "d" }, { name: "AI", description: "d" }],
    ["add_list_member", { listId: "5", userId: "12" }, { list_id: "5", user_id: "12" }],
    ["remove_list_member", { listId: "5", username: "jack" }, { list_id: "5", username: "jack" }],
    ["create_draft", { text: "later" }, { text: "later" }],
    ["list_drafts", {}, {}],
    ["list_drafts", { ascending: true }, { ascending: true }],
    ["list_bookmark_folders", {}, {}],
    ["list_bookmark_folders", { cursor: "C" }, { cursor: "C" }],
    ["list_bookmark_folder_tweets", { folderId: "179", cursor: "C" }, { folder_id: "179", cursor: "C" }],
    ["search_bookmarks", { query: "api", count: 20 }, { query: "api", count: 20 }],
    ["list_community_memberships", {}, {}],
    ["list_articles", {}, {}],
    [
      "list_articles",
      { lifecycle: "published", userId: "12", count: 10, cursor: "C" },
      { lifecycle: "published", user_id: "12", count: 10, cursor: "C" },
    ],
    ["get_article", { articleId: "179" }, { article_id: "179" }],
    ["create_article", {}, {}],
    ["create_article", { title: "Hello", text: "One\nTwo" }, { title: "Hello", text: "One\nTwo" }],
    [
      "create_article",
      { contentState: { blocks: [], entity_map: [] } },
      { content_state: { blocks: [], entity_map: [] } },
    ],
    ["update_article", { articleId: "179", title: "New" }, { article_id: "179", title: "New" }],
    [
      "update_article",
      { articleId: "179", coverMediaId: "55", coverMediaCategory: "AmplifyVideo" },
      { article_id: "179", cover_media_id: "55", cover_media_category: "AmplifyVideo" },
    ],
    ["update_article", { articleId: "179", removeCover: true }, { article_id: "179", remove_cover: true }],
    ["publish_article", { articleId: "179" }, { article_id: "179" }],
    [
      "publish_article",
      { articleId: "179", visibility: "subscribers", replyControl: "verified", tweetText: "New article" },
      { article_id: "179", visibility: "subscribers", reply_control: "verified", tweet_text: "New article" },
    ],
    ["unpublish_article", { articleId: "179" }, { article_id: "179" }],
    ["delete_article", { articleId: "179" }, { article_id: "179" }],
  ])("%s %j", (name, args, expected) => {
    expect(act(name).body(args)).toEqual(expected);
  });

  it("rejects missing or conflicting targets", () => {
    expect(() => act("follow_user").body({})).toThrow(/userId or username/);
    expect(() => act("add_list_member").body({ listId: "5" })).toThrow(/userId or username/);
    expect(() => act("send_dm").body({ text: "x" })).toThrow(/conversationId or userId/);
    expect(() => act("create_tweet").body({ text: "x", pollDurationMinutes: 60 })).toThrow(/pollChoices/);
    expect(() => act("create_tweet").body({ text: "x", pollChoices: ["a", "b"], quoteUrl: "https://x.com/a/status/1" })).toThrow(/poll/);
    const both = { text: "a", contentState: { blocks: [], entity_map: [] } };
    expect(() => act("create_article").body(both)).toThrow(/not both/);
    expect(() => act("update_article").body({ articleId: "1", ...both })).toThrow(/not both/);
    expect(() => act("update_article").body({ articleId: "1" })).toThrow(/at least one/);
    expect(() => act("update_article").body({ articleId: "1", removeCover: false })).toThrow(/at least one/);
    expect(() => act("update_article").body({ articleId: "1", coverMediaId: "5", removeCover: true })).toThrow(/not both/);
    expect(() => act("update_article").body({ articleId: "1", coverMediaCategory: "DraftTweetGif" })).toThrow(/coverMediaId/);
  });

  it("validates arguments with the zod schemas", () => {
    const shape = z.object(actionInputShape(act("create_tweet")));
    expect(shape.safeParse({ text: "ok" }).success).toBe(true);
    expect(shape.safeParse({ text: "   " }).success).toBe(false);
    expect(shape.safeParse({ text: "x", pollChoices: ["only one"] }).success).toBe(false);
    expect(shape.safeParse({ text: "x", quoteUrl: "https://example.com/a" }).success).toBe(false);
    const like = z.object(actionInputShape(act("like_tweet")));
    expect(like.safeParse({ tweetId: "abc" }).success).toBe(false);
    const search = z.object(actionInputShape(act("search_bookmarks")));
    expect(search.safeParse({ query: "x".repeat(500) }).success).toBe(true);
    expect(search.safeParse({ query: "x".repeat(501) }).success).toBe(false);
    expect(search.safeParse({ query: "a", count: 101 }).success).toBe(false);
    const publish = z.object(actionInputShape(act("publish_article")));
    expect(publish.safeParse({ articleId: "1", tweetText: "x".repeat(257) }).success).toBe(false);
    expect(publish.safeParse({ articleId: "1", visibility: "friends" }).success).toBe(false);
    const list = z.object(actionInputShape(act("list_articles")));
    expect(list.safeParse({ lifecycle: "archived" }).success).toBe(false);
  });
});

describe("runAction", () => {
  it("POSTs the body with the session from config and format=simple", async () => {
    const fetchMock = mockFetch(200, { data: { success: true } });
    const client = new TwittrApiClient({ mode: "direct", apiKey: "k", baseUrl: "https://api.test", fetch: fetchMock, xSession: session });
    const res = await runAction(client, act("like_tweet"), session, { tweetId: "20" });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text(res))).toEqual({ data: { success: true } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.test/client/like?format=simple");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect((init?.headers as Record<string, string>)["X-API-KEY"]).toBe("k");
    expect(sentBody(fetchMock)).toEqual({ tweet_id: "20", cookie: COOKIE, proxy: PROXY });
  });

  it("adds the chat passcode to DM calls only", async () => {
    const withCode = { ...session, chatPasscode: "4821" };
    const fetchMock = mockFetch(200, { data: [] });
    const client = new TwittrApiClient({ mode: "direct", apiKey: "k", fetch: fetchMock });
    await runAction(client, act("list_dm_conversations"), withCode, {});
    expect(sentBody(fetchMock).passcode).toBe("4821");
    const fetch2 = mockFetch(200, { data: { success: true } });
    await runAction(new TwittrApiClient({ mode: "direct", apiKey: "k", fetch: fetch2 }), act("like_tweet"), withCode, { tweetId: "1" });
    expect(sentBody(fetch2).passcode).toBeUndefined();
  });

  it("unwraps the raw {status_code, response} wrapper with format raw", async () => {
    const fetchMock = mockFetch(200, { status_code: 200, response: '{"data":{"favorite_tweet":"Done"}}' });
    const client = new TwittrApiClient({ mode: "direct", apiKey: "k", baseUrl: "https://api.test", fetch: fetchMock });
    const res = await runAction(client, act("like_tweet"), session, { tweetId: "20", format: "raw" });
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.test/client/like");
    expect(JSON.parse(text(res))).toEqual({ status_code: 200, response: { data: { favorite_tweet: "Done" } } });
  });

  it("raw-only tools send no format=simple, unwrap the wrapper and print the next cursor", async () => {
    const inner = {
      data: { timeline: { instructions: [{ entries: [{ entryId: "tweet-1" }, { entryId: "cursor-bottom-1", content: { value: "NEXT" } }] }] } },
    };
    const fetchMock = mockFetch(200, { status_code: 200, response: JSON.stringify(inner) });
    const client = new TwittrApiClient({ mode: "direct", apiKey: "k", baseUrl: "https://api.test", fetch: fetchMock });
    const res = await runAction(client, act("search_bookmarks"), session, { query: "api", format: "simple" });
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.test/client/bookmarks/search");
    expect(sentBody(fetchMock)).toEqual({ query: "api", cookie: COOKIE, proxy: PROXY });
    const out = text(res);
    expect(out.startsWith("next_cursor: NEXT")).toBe(true);
    expect(JSON.parse(out.slice(out.indexOf("{")))).toEqual({ status_code: 200, response: inner });
  });

  it("does not print a cursor for non-paginated raw-only tools", async () => {
    const fetchMock = mockFetch(200, { status_code: 200, response: '{"data":{}}' });
    const client = new TwittrApiClient({ mode: "direct", apiKey: "k", fetch: fetchMock });
    const res = await runAction(client, act("delete_article"), session, { articleId: "179" });
    expect(JSON.parse(text(res))).toEqual({ status_code: 200, response: { data: {} } });
  });

  it("never returns the cookie or proxy, even when the API echoes them", async () => {
    const fetchMock = mockFetch(422, { error: `bad session ${COOKIE} via ${PROXY} pass proxypass123 token abcdef0123456789` });
    const client = new TwittrApiClient({ mode: "direct", apiKey: "k", fetch: fetchMock });
    const res = await runAction(client, act("create_tweet"), session, { text: "hi" });
    expect(res.isError).toBe(true);
    const out = text(res);
    for (const secret of [COOKIE, PROXY, "proxypass123", "abcdef0123456789", "fedcba9876543210"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toMatch(/Invalid input \(422\)/);
  });

  it("explains a 401 from X as an expired session", async () => {
    const client = new TwittrApiClient({ mode: "direct", apiKey: "k", fetch: mockFetch(401, { errors: [{ message: "Could not authenticate you" }] }) });
    const res = await runAction(client, act("like_tweet"), session, { tweetId: "1" });
    expect(text(res)).toMatch(/TWITTRAPI_X_COOKIE may be logged out/);
  });

  it("returns argument errors without calling the API", async () => {
    const fetchMock = mockFetch(200, {});
    const client = new TwittrApiClient({ mode: "direct", apiKey: "k", fetch: fetchMock });
    const res = await runAction(client, act("follow_user"), session, {});
    expect(res.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("actionsFor", () => {
  it("returns no tools without a session and send_dm only with a passcode", () => {
    expect(actionsFor(undefined)).toEqual([]);
    const names = actionsFor(session).map((a) => a.name);
    expect(names).not.toContain("send_dm");
    expect(names).toContain("list_dm_conversations");
    expect(actionsFor({ ...session, chatPasscode: "1234" }).map((a) => a.name)).toContain("send_dm");
  });
});

describe("xSessionFromEnv", () => {
  it("needs both cookie and proxy", () => {
    expect(xSessionFromEnv({})).toBeUndefined();
    expect(xSessionFromEnv({ TWITTRAPI_X_COOKIE: COOKIE })).toBeUndefined();
    expect(xSessionFromEnv({ TWITTRAPI_X_PROXY: PROXY })).toBeUndefined();
    expect(xSessionFromEnv({ TWITTRAPI_X_COOKIE: ` ${COOKIE} `, TWITTRAPI_X_PROXY: PROXY })).toEqual(session);
    expect(xSessionFromEnv({ TWITTRAPI_X_COOKIE: COOKIE, TWITTRAPI_X_PROXY: PROXY, TWITTRAPI_X_CHAT_PASSCODE: "0042" })).toEqual({
      ...session,
      chatPasscode: "0042",
    });
  });

  it("rejects a bad cookie or proxy without echoing it", () => {
    const bad = "auth_token=onlythisvalue";
    expect(() => xSessionFromEnv({ TWITTRAPI_X_COOKIE: bad, TWITTRAPI_X_PROXY: PROXY })).toThrow(/auth_token and ct0/);
    try {
      xSessionFromEnv({ TWITTRAPI_X_COOKIE: bad, TWITTRAPI_X_PROXY: PROXY });
    } catch (e) {
      expect((e as Error).message).not.toContain("onlythisvalue");
    }
    expect(() => xSessionFromEnv({ TWITTRAPI_X_COOKIE: COOKIE, TWITTRAPI_X_PROXY: "secret-host:8080" })).toThrow(/TWITTRAPI_X_PROXY/);
    expect(() => xSessionFromEnv({ TWITTRAPI_X_COOKIE: COOKIE, TWITTRAPI_X_PROXY: "socks5://u:p@h:1" })).toThrow(/TWITTRAPI_X_PROXY/);
  });
});

describe("scrubSession", () => {
  it("removes the cookie, token values, proxy and proxy credentials", () => {
    const out = scrubSession(`a ${COOKIE} b fedcba9876543210 c ${PROXY} d proxyuser e`, session);
    expect(out).not.toMatch(/abcdef0123456789|fedcba9876543210|proxypass123|proxyuser|10\.0\.0\.1:8080@/);
    expect(out).toContain("[REDACTED]");
  });
  it("leaves text alone without a session", () => {
    expect(scrubSession("abc", undefined)).toBe("abc");
  });
});
