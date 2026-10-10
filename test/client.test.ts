import { describe, expect, it, vi } from "vitest";
import {
  RAPIDAPI_HOST,
  TwittrApiClient,
  TwittrApiError,
  buildHeaders,
  buildUrl,
  configFromEnv,
  mapHttpError,
} from "../src/client.js";

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    }),
  );
}

describe("configFromEnv", () => {
  it("prefers TWITTRAPI_API_KEY and default base URL", () => {
    expect(configFromEnv({ TWITTRAPI_API_KEY: "k", RAPIDAPI_KEY: "r" })).toEqual({
      mode: "direct",
      apiKey: "k",
      baseUrl: "https://api.twittrapi.com",
    });
  });
  it("uses TWITTRAPI_BASE_URL when set", () => {
    expect(configFromEnv({ TWITTRAPI_API_KEY: "k", TWITTRAPI_BASE_URL: "http://x.test" }).baseUrl).toBe("http://x.test");
  });
  it("falls back to RapidAPI", () => {
    expect(configFromEnv({ RAPIDAPI_KEY: "r" })).toEqual({ mode: "rapidapi", apiKey: "r" });
  });
  it("returns no key when nothing is set", () => {
    expect(configFromEnv({}).apiKey).toBeUndefined();
  });
});

describe("buildUrl", () => {
  it("joins base, path and query, dropping empty values", () => {
    expect(
      buildUrl("https://api.example.com/", { path: "/user/1/tweets", query: { count: 20, cursor: undefined, x: "" } }),
    ).toBe("https://api.example.com/user/1/tweets?count=20");
  });
  it("encodes query values", () => {
    const url = buildUrl("https://a.test", { path: "/search", query: { searchItem: "from:jack \"hello world\" #x" } });
    expect(new URL(url).searchParams.get("searchItem")).toBe("from:jack \"hello world\" #x");
  });
});

describe("headers", () => {
  it("direct mode sends X-API-KEY", () => {
    const h = buildHeaders({ mode: "direct", apiKey: "abc" });
    expect(h["X-API-KEY"]).toBe("abc");
    expect(h["x-rapidapi-key"]).toBeUndefined();
  });
  it("rapidapi mode sends x-rapidapi-key and host", () => {
    const h = buildHeaders({ mode: "rapidapi", apiKey: "abc" });
    expect(h["x-rapidapi-key"]).toBe("abc");
    expect(h["x-rapidapi-host"]).toBe(RAPIDAPI_HOST);
    expect(h["X-API-KEY"]).toBeUndefined();
  });
});

describe("TwittrApiClient.get", () => {
  it("calls the direct base URL with the key", async () => {
    const f = mockFetch(200, { data: { ok: 1 } });
    const c = new TwittrApiClient({ mode: "direct", apiKey: "k1", baseUrl: "https://api.example.com", fetch: f });
    const res = await c.get({ path: "/user/by/username/jack" });
    expect(res.data).toEqual({ data: { ok: 1 } });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.example.com/user/by/username/jack");
    expect((init!.headers as Record<string, string>)["X-API-KEY"]).toBe("k1");
  });
  it("calls RapidAPI host in rapidapi mode, ignoring baseUrl", async () => {
    const f = mockFetch(200, {});
    const c = new TwittrApiClient({ mode: "rapidapi", apiKey: "r1", baseUrl: "https://ignored.test", fetch: f });
    await c.get({ path: "/tweet/1" });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://twitter-aio.p.rapidapi.com/tweet/1");
    const h = init!.headers as Record<string, string>;
    expect(h["x-rapidapi-key"]).toBe("r1");
    expect(h["x-rapidapi-host"]).toBe("twitter-aio.p.rapidapi.com");
  });
  it("errors without calling fetch when no key is set", async () => {
    const f = mockFetch(200, {});
    const c = new TwittrApiClient({ mode: "direct", fetch: f });
    await expect(c.get({ path: "/x" })).rejects.toThrow(/No API key configured/);
    expect(f).not.toHaveBeenCalled();
  });
  it.each([
    [402, { error: "Insufficient balance" }, /No balance left.*Insufficient balance/],
    [429, { error: "Too many requests" }, /Rate limit hit \(429\).*Retry-After: 7s/],
    [401, { error: "Invalid API key" }, /Authentication failed.*TWITTRAPI_API_KEY/],
    [404, { error: "NOT_FOUND" }, /Not found \(404\)/],
    [422, { error: "Invalid tweet ID" }, /Invalid input \(422\).*Invalid tweet ID/],
    [500, { error: "boom" }, /upstream error \(500\).*boom/],
    [503, "<html>bad gateway</html>", /upstream error \(503\).*bad gateway/],
  ])("maps HTTP %i to a readable error", async (status, body, re) => {
    const f = mockFetch(status, body, { "retry-after": "7" });
    const c = new TwittrApiClient({ mode: "direct", apiKey: "k", fetch: f });
    const err = await c.get({ path: "/x" }).catch((e) => e);
    expect(err).toBeInstanceOf(TwittrApiError);
    expect(err.status).toBe(status);
    expect(err.message).toMatch(re);
  });
  it("names RAPIDAPI_KEY on 401 in rapidapi mode", () => {
    expect(mapHttpError(401, { message: "You are not subscribed" }, "", "rapidapi").message).toMatch(
      /RAPIDAPI_KEY.*not subscribed/,
    );
  });
  it("maps network failures", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const c = new TwittrApiClient({ mode: "direct", apiKey: "k", fetch: f as unknown as typeof fetch });
    await expect(c.get({ path: "/x" })).rejects.toThrow(/Could not reach TwittrAPI: fetch failed/);
  });
});
