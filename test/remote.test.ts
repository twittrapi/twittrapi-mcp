import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConcurrencyLimiter, credentialFromRequest, startHttpServer } from "../src/http.js";
import { createLogger, keyId, redact } from "../src/log.js";
import { canonicalUrl, oauthConfigFromEnv, protectedResourceMetadataUrl, wwwAuthenticate } from "../src/oauth.js";

const RESOURCE = "https://mcp.twittrapi.test/mcp";
const ISSUER_KEY = "11111111-2222-4333-8444-555555555555";
const GOOD_TOKEN = "twa_at_good-token-abcdefghijklmnopqrstuvwxyz";
const OTHER_AUD_TOKEN = "twa_at_other-audience-abcdefghijklmnopqrst";
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
  api = createServer((req, res) => {
    apiSeen.push({ url: req.url ?? "", headers: req.headers });
    const url = new URL(req.url ?? "/", "http://x");
    res.setHeader("content-type", "application/json");
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
        scopes_supported: ["mcp"],
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
