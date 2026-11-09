import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConcurrencyLimiter, credentialFromRequest, startHttpServer } from "../src/http.js";
import { createLogger, keyId, redact } from "../src/log.js";
import { keyHash, type EventSink, type ToolCallEvent } from "../src/events.js";
import { canonicalUrl, oauthConfigFromEnv, protectedResourceMetadataUrl, wwwAuthenticate } from "../src/oauth.js";

const RESOURCE = "https://mcp.twittrapi.test/mcp";
const ISSUER_KEY = "11111111-2222-4333-8444-555555555555";
const GOOD_TOKEN = "twa_at_good-token-abcdefghijklmnopqrstuvwxyz";
const OTHER_AUD_TOKEN = "twa_at_other-audience-abcdefghijklmnopqrst";
const WRITE_TOKEN = "twa_at_write-token-abcdefghijklmnopqrstuvw";
const SESSION_NO_SCOPE_TOKEN = "twa_at_session-no-scope-abcdefghijklmn";
const MULTI_TOKEN = "twa_at_multi-accounts-abcdefghijklmnopqrs";
const ACCOUNTS = [
  { id: 11, handle: "brand", user_id: "111", default: true, cookie: "auth_token=brandauthtoken1; ct0=brandct0value1", proxy: "http://u:brandpass111@proxy.test:8080" },
  { id: 12, handle: "Support_Team", user_id: "222", default: false, cookie: "auth_token=supportauthtoken2; ct0=supportct0value2", proxy: "http://u:supportpass222@proxy.test:8080", chat_passcode: "8642" },
];
const STORED = { cookie: "auth_token=storedauthtoken123; ct0=storedct0value456", proxy: "http://u:storedpass789@proxy.test:8080" };
const HEADER_COOKIE = "auth_token=headerauthtoken123; ct0=headerct0value456";
const HEADER_PROXY = "http://u:headerpass789@proxy.test:8080";
const SECRET = "s".repeat(40);

interface Seen {
  url: string;
  headers: IncomingHttpHeaders;
  body?: string;
}

const apiSeen: Seen[] = [];
const introSeen: Seen[] = [];
let api: Server;
let issuer: Server;
let apiUrl: string;
let issuerUrl: string;
let introspectionDown = false;

function listen(s: Server): Promise<string> {
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
}

beforeAll(async () => {
  api = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    apiSeen.push({ url: req.url ?? "", headers: req.headers, body });
    const url = new URL(req.url ?? "/", "http://x");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/client/like" && body.includes("407407")) {
      res.statusCode = 407;
      return res.end("{}");
    }
    if (url.pathname === "/client/like" && body.includes("401401")) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: "Unauthorized" }));
    }
    const respond = () => res.end(JSON.stringify({ data: { username: "jack", id: "12" } }));
    if (url.pathname.startsWith("/user/by/username/slow")) {
      setTimeout(respond, 400);
      return;
    }
    respond();
  });
  issuer = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      introSeen.push({ url: req.url ?? "", headers: req.headers, body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/.well-known/oauth-authorization-server") {
        return res.end(JSON.stringify({ issuer: issuerUrl, token_endpoint: `${issuerUrl}/oauth/token` }));
      }
      if (introspectionDown) {
        res.statusCode = 503;
        return res.end("{}");
      }
      if (req.headers.authorization !== `Bearer ${SECRET}`) {
        res.statusCode = 401;
        return res.end("{}");
      }
      const token = new URLSearchParams(body).get("token");
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const base = { active: true, scope: "mcp", client_id: "twc_test", exp, twittrapi: { api_key: ISSUER_KEY, account_id: 7 } };
      if (token === GOOD_TOKEN) return res.end(JSON.stringify({ ...base, aud: RESOURCE }));
      if (token === OTHER_AUD_TOKEN) return res.end(JSON.stringify({ ...base, aud: "https://other.example/mcp" }));
      if (token === WRITE_TOKEN) {
        return res.end(JSON.stringify({ ...base, scope: "mcp x:write", aud: RESOURCE, twittrapi: { ...base.twittrapi, x_session: STORED } }));
      }
      if (token === MULTI_TOKEN) {
        const stored = { cookie: ACCOUNTS[0].cookie, proxy: ACCOUNTS[0].proxy };
        return res.end(JSON.stringify({ ...base, scope: "mcp x:write", aud: RESOURCE, twittrapi: { ...base.twittrapi, x_session: stored, x_sessions: ACCOUNTS } }));
      }
      if (token === SESSION_NO_SCOPE_TOKEN) {
        return res.end(JSON.stringify({ ...base, aud: RESOURCE, twittrapi: { ...base.twittrapi, x_session: STORED } }));
      }
      res.end(JSON.stringify({ active: false }));
    });
  });
  apiUrl = await listen(api);
  issuerUrl = await listen(issuer);
});

afterAll(async () => {
  await new Promise((r) => api.close(r));
  await new Promise((r) => issuer.close(r));
});

async function start(extra: Partial<Parameters<typeof startHttpServer>[0]> = {}) {
  const lines: string[] = [];
  const http = await startHttpServer({
    port: 0,
    host: "127.0.0.1",
    baseUrl: apiUrl,
    oauth: {
      resourceUrl: RESOURCE,
      issuer: issuerUrl,
      introspectionUrl: `${issuerUrl}/introspect`,
      introspectionSecret: SECRET,
      cacheSeconds: 30,
    },
    logger: createLogger({ level: "debug", write: (l) => lines.push(l) }),
    ...extra,
  });
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return { http, base, endpoint: new URL(`${base}/mcp`), lines, close: () => new Promise((r) => http.close(r)) };
}

const rpc = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};

describe("hosted mode: discovery and auth challenges", () => {
  let s: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    s = await start();
  });
  afterAll(async () => s.close());

  it("answers an unauthenticated request with 401 and resource metadata", async () => {
    const res = await fetch(s.endpoint, rpc(INIT));
    expect(res.status).toBe(401);
    const www = res.headers.get("www-authenticate")!;
    expect(www).toContain('resource_metadata="https://mcp.twittrapi.test/.well-known/oauth-protected-resource/mcp"');
    expect(www).toContain('scope="mcp"');
    expect(res.headers.get("access-control-expose-headers")).toContain("WWW-Authenticate");
  });

  it("serves RFC 9728 metadata at the path-suffixed and the root well-known URL", async () => {
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const res = await fetch(s.base + path);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        resource: RESOURCE,
        authorization_servers: [issuerUrl],
        bearer_methods_supported: ["header"],
        scopes_supported: ["mcp", "x:write"],
      });
    }
  });

  it("relays the authorization server metadata for older clients", async () => {
    const res = await fetch(`${s.base}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    expect((await res.json()).issuer).toBe(issuerUrl);
  });

  it("rejects unknown and wrong-audience tokens with invalid_token", async () => {
    for (const token of ["twa_at_unknown-token-xxxxxxxxxxxxxxxx", OTHER_AUD_TOKEN]) {
      const res = await fetch(s.endpoint, rpc(INIT, { authorization: `Bearer ${token}` }));
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    }
  });

  it("answers 503 (not 401) when introspection is down, so clients do not drop their tokens", async () => {
    introspectionDown = true;
    try {
      const res = await fetch(s.endpoint, rpc(INIT, { authorization: "Bearer twa_at_fresh-token-while-down-xxxxxx" }));
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("5");
    } finally {
      introspectionDown = false;
    }
  });

  it("rejects GET (stateless), oversized and malformed bodies; no legacy SSE", async () => {
    expect((await fetch(s.endpoint, { headers: { "x-api-key": "k" } })).status).toBe(405);
    expect((await fetch(`${s.base}/sse`)).status).toBe(404);
    const big = await fetch(s.endpoint, rpc({ jsonrpc: "2.0", id: 1, method: "x", params: { pad: "x".repeat(300_000) } }, { "x-api-key": "k" }));
    expect(big.status).toBe(413);
    expect((await fetch(s.endpoint, rpc("{not json", { "x-api-key": "k" }))).status).toBe(400);
    const pre = await fetch(s.endpoint, { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("Authorization");
  });

  it("health reports OAuth", async () => {
    expect(await (await fetch(`${s.base}/health`)).json()).toMatchObject({ ok: true, oauth: true });
  });
});

describe("hosted mode: tool calls", () => {
  let s: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    s = await start();
  });
  afterAll(async () => s.close());

  it("OAuth token: calls the API with the account's key, never the token; introspection is cached", async () => {
    introSeen.length = 0;
    apiSeen.length = 0;
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(s.endpoint, { requestInit: { headers: { Authorization: `Bearer ${GOOD_TOKEN}` } } }));
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(20);
    const result = await client.callTool({ name: "get_user_by_username", arguments: { username: "jack" } });
    expect(result.isError).toBeFalsy();
    await client.close();
    expect(apiSeen).toHaveLength(1);
    expect(apiSeen[0].headers["x-api-key"]).toBe(ISSUER_KEY);
    expect(JSON.stringify(apiSeen[0].headers)).not.toContain(GOOD_TOKEN);
    // initialize, notifications/initialized, tools/list, tools/call: one introspection, carrying the resource
    const intro = introSeen.filter((r) => r.url === "/introspect");
    expect(intro).toHaveLength(1);
    expect(new URLSearchParams(intro[0].body).get("resource")).toBe(RESOURCE);
    // Logs: no token, no key
    const all = s.lines.join("\n");
    expect(all).not.toContain(GOOD_TOKEN);
    expect(all).not.toContain(ISSUER_KEY);
    const call = s.lines.map((l) => JSON.parse(l)).find((l) => l.tool === "get_user_by_username");
    expect(call).toMatchObject({ msg: "request", auth: "oauth", client_id: "twc_test", account: 7, status: 200, rpc: "tools/call" });
    expect(call.key).toBe(keyId(ISSUER_KEY));
  });

  it("header key: Authorization Bearer <api key> and X-API-KEY", async () => {
    for (const headers of [{ Authorization: "Bearer my-api-key-123" }, { "X-API-KEY": "my-api-key-123" }]) {
      apiSeen.length = 0;
      const client = new Client({ name: "t", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(s.endpoint, { requestInit: { headers } }));
      await client.callTool({ name: "get_user_by_username", arguments: { username: "jack" } });
      await client.close();
      expect(apiSeen[0].headers["x-api-key"]).toBe("my-api-key-123");
    }
    expect(s.lines.join("\n")).not.toContain("my-api-key-123");
  });

  it("answers 400 for an x-rapidapi-host that is not a RapidAPI host", async () => {
    for (const host of ["127.0.0.1:8080", "twttr.p.rapidapi.com/v1"]) {
      const res = await fetch(s.endpoint, rpc(INIT, { "x-rapidapi-key": "rk-123456", "x-rapidapi-host": host }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/x-rapidapi-host/);
    }
  });
});

describe("credentialFromRequest", () => {
  const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

  it("reads x-rapidapi-host next to x-rapidapi-key", () => {
    expect(credentialFromRequest(req({ "x-rapidapi-key": "rk", "x-rapidapi-host": "https://twttr.p.rapidapi.com/" }))).toEqual({
      kind: "api_key",
      config: { mode: "rapidapi", apiKey: "rk", rapidApiHost: "twttr.p.rapidapi.com" },
    });
    expect(credentialFromRequest(req({ "x-rapidapi-key": "rk" }))).toEqual({
      kind: "api_key",
      config: { mode: "rapidapi", apiKey: "rk" },
    });
  });

  it("rejects hosts outside .p.rapidapi.com and ignores the host header in direct mode", () => {
    expect(credentialFromRequest(req({ "x-rapidapi-key": "rk", "x-rapidapi-host": "169.254.169.254" })).kind).toBe("invalid");
    expect(credentialFromRequest(req({ "x-rapidapi-key": "rk", "x-rapidapi-host": "evil.com/x.p.rapidapi.com" })).kind).toBe(
      "invalid",
    );
    const direct = credentialFromRequest(req({ "x-api-key": "k", "x-rapidapi-host": "not a host" }));
    expect(direct.kind).toBe("api_key");
  });
});

describe("hosted mode: limits", () => {
  const call = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "get_user_by_username", arguments: { username: "slow" } } });

  it("limits concurrent requests per key", async () => {
    const s = await start({ maxConcurrencyPerKey: 1 });
    try {
      const h = { "x-api-key": "conc-key" };
      const [a, b] = await Promise.all([fetch(s.endpoint, rpc(call(1), h)), fetch(s.endpoint, rpc(call(2), h))]);
      expect([a.status, b.status].sort()).toEqual([200, 429]);
      // Another key is not affected, and the slot is free again afterwards
      expect((await fetch(s.endpoint, rpc(call(3), { "x-api-key": "other-key" }))).status).toBe(200);
      expect((await fetch(s.endpoint, rpc(call(4), h))).status).toBe(200);
    } finally {
      await s.close();
    }
  });

  it("times out slow requests", async () => {
    const s = await start({ requestTimeoutMs: 100 });
    try {
      const res = await fetch(s.endpoint, rpc(call(1), { "x-api-key": "k" }));
      expect(res.status).toBe(504);
    } finally {
      await s.close();
    }
  });
});

describe("helpers", () => {
  it("redacts keys and tokens", () => {
    expect(redact(`Bearer ${GOOD_TOKEN}`)).toBe("Bearer [REDACTED]");
    expect(redact(`token twa_rt_abcdefghijkl and ${ISSUER_KEY}`)).not.toMatch(/twa_rt_|1111/);
    expect(redact('{"x-api-key":"supersecret"}')).not.toContain("supersecret");
    expect(redact("plain message")).toBe("plain message");
  });

  it("builds metadata URLs and challenges", () => {
    expect(protectedResourceMetadataUrl("https://mcp.twittrapi.com/mcp")).toBe(
      "https://mcp.twittrapi.com/.well-known/oauth-protected-resource/mcp",
    );
    expect(protectedResourceMetadataUrl("https://mcp.twittrapi.com")).toBe("https://mcp.twittrapi.com/.well-known/oauth-protected-resource");
    expect(wwwAuthenticate(undefined)).toBe('Bearer realm="twittrapi"');
    expect(canonicalUrl("HTTPS://MCP.TwittrAPI.com/mcp/")).toBe("https://mcp.twittrapi.com/mcp");
  });

  it("reads OAuth settings from the environment, all or nothing", () => {
    expect(oauthConfigFromEnv({})).toBeUndefined();
    expect(() => oauthConfigFromEnv({ MCP_PUBLIC_URL: RESOURCE })).toThrow(/OAUTH_ISSUER/);
    expect(() => oauthConfigFromEnv({ MCP_PUBLIC_URL: RESOURCE, OAUTH_ISSUER: "https://a", OAUTH_INTROSPECTION_SECRET: "short" })).toThrow(/32/);
    expect(
      oauthConfigFromEnv({ MCP_PUBLIC_URL: RESOURCE + "/", OAUTH_ISSUER: "https://app.example/", OAUTH_INTROSPECTION_SECRET: SECRET }),
    ).toMatchObject({ resourceUrl: RESOURCE, issuer: "https://app.example", introspectionUrl: "https://app.example/api/oauth/introspect" });
  });

  it("concurrency limiter releases once", () => {
    const l = new ConcurrencyLimiter(2);
    const r1 = l.acquire("a")!;
    l.acquire("a");
    expect(l.acquire("a")).toBeNull();
    r1();
    r1();
    expect(l.inFlight("a")).toBe(1);
  });
});

describe("hosted mode: account tools", () => {
  let s: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    s = await start();
  });
  afterAll(async () => s.close());

  async function connect(headers: Record<string, string>) {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(s.endpoint, { requestInit: { headers } }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    return { client, names };
  }

  it("read only without a session", async () => {
    const { client, names } = await connect({ "X-API-KEY": "my-api-key-123" });
    await client.close();
    expect(names).toContain("get_user_by_username");
    expect(names).not.toContain("create_tweet");
  });

  it("X-Twitter-Cookie and X-Twitter-Proxy headers add the account tools for that request only", async () => {
    apiSeen.length = 0;
    const { client, names } = await connect({ "X-API-KEY": "my-api-key-123", "X-Twitter-Cookie": HEADER_COOKIE, "X-Twitter-Proxy": HEADER_PROXY });
    expect(names).toContain("create_tweet");
    const result = await client.callTool({ name: "create_tweet", arguments: { text: "hello" } });
    await client.close();
    expect(result.isError).toBeFalsy();
    const post = apiSeen.find((r) => r.url.startsWith("/client/create"));
    expect(post).toBeDefined();
    expect(JSON.parse(post!.body!)).toMatchObject({ cookie: HEADER_COOKIE, proxy: HEADER_PROXY });
    const logs = s.lines.join("\n");
    expect(logs).not.toContain("headerauthtoken123");
    expect(logs).not.toContain("headerpass789");
    expect(s.lines.map((l) => JSON.parse(l)).some((l) => l.tool === "create_tweet" && l.x_session === "header")).toBe(true);
  });

  it("answers 400 for half a session or a malformed one, without echoing it", async () => {
    const only = await fetch(s.endpoint, rpc(INIT, { "X-API-KEY": "k-123456", "X-Twitter-Cookie": HEADER_COOKIE }));
    expect(only.status).toBe(400);
    expect(await only.text()).toMatch(/X-Twitter-Proxy/);
    const bad = await fetch(s.endpoint, rpc(INIT, { "X-API-KEY": "k-123456", "X-Twitter-Cookie": "foo=secretvalue99", "X-Twitter-Proxy": HEADER_PROXY }));
    expect(bad.status).toBe(400);
    const text = await bad.text();
    expect(text).toMatch(/X-Twitter-Cookie must be/);
    expect(text).not.toContain("secretvalue99");
  });

  it("OAuth grant with x:write uses the session saved in the dashboard", async () => {
    apiSeen.length = 0;
    const { client, names } = await connect({ Authorization: `Bearer ${WRITE_TOKEN}` });
    expect(names).toContain("create_tweet");
    await client.callTool({ name: "create_tweet", arguments: { text: "hello" } });
    await client.close();
    const post = apiSeen.find((r) => r.url.startsWith("/client/create"));
    expect(JSON.parse(post!.body!)).toMatchObject({ cookie: STORED.cookie, proxy: STORED.proxy });
    expect(post!.headers["x-api-key"]).toBe(ISSUER_KEY);
  });

  it("several saved accounts: the default acts unless account names another one", async () => {
    apiSeen.length = 0;
    const { client, names } = await connect({ Authorization: `Bearer ${MULTI_TOKEN}` });
    expect(names).toContain("list_x_accounts");
    expect(names).toContain("send_dm");
    const tools = (await client.listTools()).tools;
    expect(Object.keys(tools.find((t) => t.name === "create_tweet")!.inputSchema.properties ?? {})).toContain("account");
    expect(client.getInstructions()).toMatch(/2 X accounts: @brand \(default\), @Support_Team/);

    const list = await client.callTool({ name: "list_x_accounts", arguments: {} });
    const text = (list.content as { text: string }[])[0].text;
    expect(JSON.parse(text).data).toEqual([
      { account: "@brand", userId: "111", default: true, dms: false },
      { account: "@Support_Team", userId: "222", default: false, dms: true },
    ]);
    for (const secret of ["brandauthtoken1", "supportpass222", "8642"]) expect(text).not.toContain(secret);

    await client.callTool({ name: "create_tweet", arguments: { text: "from the default" } });
    await client.callTool({ name: "create_tweet", arguments: { text: "from support", account: "@support_team" } });
    await client.callTool({ name: "like_tweet", arguments: { tweetId: "20", account: "222" } });
    const posts = apiSeen.filter((r) => r.url.startsWith("/client/")).map((r) => JSON.parse(r.body!));
    expect(posts.map((b) => b.cookie)).toEqual([ACCOUNTS[0].cookie, ACCOUNTS[1].cookie, ACCOUNTS[1].cookie]);
    expect(posts.every((b) => !("account" in b))).toBe(true);

    const unknown = await client.callTool({ name: "create_tweet", arguments: { text: "x", account: "@nobody" } });
    expect(unknown.isError).toBe(true);
    expect((unknown.content as { text: string }[])[0].text).toMatch(/No saved X account matches "@nobody".*@brand, @Support_Team/);

    // The default has no chat passcode: DMs need the account that has one
    const dm = await client.callTool({ name: "send_dm", arguments: { userId: "5", text: "hi" } });
    expect(dm.isError).toBe(true);
    expect((dm.content as { text: string }[])[0].text).toMatch(/@brand has no X Chat passcode/);
    await client.close();
  });

  it("OAuth grant without x:write stays read only even if a session is sent along", async () => {
    const { client, names } = await connect({ Authorization: `Bearer ${SESSION_NO_SCOPE_TOKEN}` });
    await client.close();
    expect(names).not.toContain("create_tweet");
  });
});

describe("hosted mode: usage events", () => {
  const recorded: ToolCallEvent[] = [];
  const sink: EventSink = { record: (e) => void recorded.push(e), flush: async () => {}, close: async () => {} };
  let s: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    s = await start({ events: sink });
  });
  afterAll(async () => s.close());

  async function call(headers: Record<string, string>, name: string, args: Record<string, unknown>) {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(s.endpoint, { requestInit: { headers } }));
    const result = await client.callTool({ name, arguments: args });
    await client.close();
    return result;
  }

  it("records one event per tool call, with the account for OAuth", async () => {
    recorded.length = 0;
    await call({ Authorization: `Bearer ${GOOD_TOKEN}` }, "get_user_by_username", { username: "jack" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      tool: "get_user_by_username",
      kind: "read",
      write: false,
      auth: "oauth",
      account_id: 7,
      client_id: "twc_test",
      key_hash: keyHash(ISSUER_KEY),
      ok: true,
    });
    expect(recorded[0].session).toBeUndefined();
  });

  it("records failed account tools with status and the session source, never the session or key", async () => {
    recorded.length = 0;
    const result = await call(
      { "X-API-KEY": "my-api-key-123", "X-Twitter-Cookie": HEADER_COOKIE, "X-Twitter-Proxy": HEADER_PROXY },
      "like_tweet",
      { tweetId: "401401" },
    );
    expect(result.isError).toBe(true);
    expect(recorded).toHaveLength(1);
    const e = recorded[0];
    expect(e).toMatchObject({ tool: "like_tweet", kind: "account", write: true, auth: "api_key", session: "header", ok: false, status: 401 });
    expect(e.account_id).toBeUndefined();
    expect(e.key_hash).toBe(keyHash("my-api-key-123"));
    expect(e.error).toMatch(/logged out or expired/);
    const json = JSON.stringify(recorded);
    for (const secret of ["headerauthtoken123", "headerpass789", "my-api-key-123"]) expect(json).not.toContain(secret);
  });

  it("records which saved account acted, and a failing proxy as 407", async () => {
    recorded.length = 0;
    await call({ Authorization: `Bearer ${MULTI_TOKEN}` }, "like_tweet", { tweetId: "20", account: "support_team" });
    const failed = await call({ Authorization: `Bearer ${MULTI_TOKEN}` }, "like_tweet", { tweetId: "407407" });
    expect(recorded.map((e) => [e.ok, e.x_session_id, e.status])).toEqual([
      [true, 12, undefined],
      [false, 11, 407],
    ]);
    expect((failed.content as { text: string }[])[0].text).toMatch(/@brand: .*proxy/);
  });

  it("records nothing without a sink", async () => {
    recorded.length = 0;
    const plain = await start();
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(plain.endpoint, { requestInit: { headers: { "X-API-KEY": "my-api-key-123" } } }));
    await client.callTool({ name: "get_user_by_username", arguments: { username: "jack" } });
    await client.close();
    await plain.close();
    expect(recorded).toHaveLength(0);
  });
});
