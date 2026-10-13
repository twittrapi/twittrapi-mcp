import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { DEFAULT_BASE_URL, TwittrApiClient, type ClientConfig, type ResponseFormat } from "./client.js";
import { keyId, silentLogger, type Logger } from "./log.js";
import {
  OAUTH_ACCESS_TOKEN_PREFIX,
  TokenIntrospector,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  wwwAuthenticate,
  type OAuthConfig,
} from "./oauth.js";
import { createServer } from "./server.js";
import { ICON_FILES } from "./icons.js";
import { VERSION } from "./version.js";

export interface HttpOptions {
  port: number;
  host: string;
  /** Base URL for direct mode, from the server operator's env (never from the request). */
  baseUrl?: string;
  /** Default response format for tool results, from the operator's env. Callers can override it per tool call. */
  format?: ResponseFormat;
  /** OAuth (hosted mode): the dashboard is the authorization server. Off when undefined. */
  oauth?: OAuthConfig;
  /** Largest accepted request body. Default 256 KB. */
  maxBodyBytes?: number;
  /** Time limit for one request, tool calls included. Default 90 s. */
  requestTimeoutMs?: number;
  /** Concurrent requests per API key (per instance). Default 8. 0 disables the limit. */
  maxConcurrencyPerKey?: number;
  /** When set, requests with an Origin header must match one of these (DNS rebinding protection). */
  allowedOrigins?: string[];
  /** Read the client IP from X-Forwarded-For (behind a reverse proxy such as Coolify's Traefik). */
  trustProxy?: boolean;
  logger?: Logger;
  /** Injected for tests. */
  fetch?: typeof fetch;
}

export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;
export const DEFAULT_MAX_CONCURRENCY_PER_KEY = 8;

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  const s = Array.isArray(v) ? v[0] : v;
  return s?.trim() || undefined;
}

/** What the request authenticates with, before any network check. */
export type Credential =
  | { kind: "api_key"; config: ClientConfig }
  | { kind: "oauth"; token: string }
  | { kind: "none" };

/**
 * Reads the caller's credential from the request. In HTTP mode the server never uses a key from
 * its own environment, so one deployment can serve many users and nobody spends the operator's
 * balance. A Bearer value with the OAuth access token prefix is an OAuth token; any other Bearer
 * value is a TwittrAPI API key (for clients that only let users set Authorization).
 */
export function credentialFromRequest(req: IncomingMessage, baseUrl?: string): Credential {
  const direct = header(req, "x-api-key");
  if (direct) return { kind: "api_key", config: { mode: "direct", apiKey: direct, baseUrl: baseUrl || DEFAULT_BASE_URL } };
  const auth = header(req, "authorization");
  const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer?.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) return { kind: "oauth", token: bearer };
  if (bearer) return { kind: "api_key", config: { mode: "direct", apiKey: bearer, baseUrl: baseUrl || DEFAULT_BASE_URL } };
  const rapid = header(req, "x-rapidapi-key");
  if (rapid) return { kind: "api_key", config: { mode: "rapidapi", apiKey: rapid } };
  return { kind: "none" };
}

/** Kept for compatibility: the API-key part of credentialFromRequest. */
export function configFromRequest(req: IncomingMessage, baseUrl?: string): ClientConfig | undefined {
  const c = credentialFromRequest(req, baseUrl);
  return c.kind === "api_key" ? c.config : undefined;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, X-API-KEY, x-rapidapi-key, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version, Retry-After",
  "Access-Control-Max-Age": "600",
};

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function rpcError(code: number, message: string, id: unknown = null) {
  return { jsonrpc: "2.0", error: { code, message }, id: id ?? null };
}

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new BodyTooLarge());
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new BodyTooLarge());
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Per-key in-flight counter (per instance; each instance of a scaled deployment has its own). */
export class ConcurrencyLimiter {
  private readonly active = new Map<string, number>();
  constructor(readonly max: number) {}
  acquire(key: string): (() => void) | null {
    if (this.max <= 0) return () => {};
    const n = this.active.get(key) ?? 0;
    if (n >= this.max) return null;
    this.active.set(key, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.active.get(key) ?? 1) - 1;
      if (left <= 0) this.active.delete(key);
      else this.active.set(key, left);
    };
  }
  inFlight(key: string): number {
    return this.active.get(key) ?? 0;
  }
}

function summarize(body: unknown): { rpc?: string; tool?: string; id?: unknown } {
  const first = Array.isArray(body) ? body[0] : body;
  if (!first || typeof first !== "object") return {};
  const m = first as { method?: unknown; params?: { name?: unknown }; id?: unknown };
  return {
    rpc: typeof m.method === "string" ? m.method.slice(0, 64) : undefined,
    tool: m.method === "tools/call" && typeof m.params?.name === "string" ? m.params.name.slice(0, 64) : undefined,
    id: m.id,
  };
}

/**
 * Stateless Streamable HTTP endpoint at /mcp. Each POST gets its own McpServer bound to the
 * caller's key (header) or to the key behind an OAuth access token, so any instance can answer
 * any request (horizontal scaling without sticky sessions).
 */
export function startHttpServer(opts: HttpOptions): Promise<Server> {
  const log = opts.logger ?? silentLogger;
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const limiter = new ConcurrencyLimiter(opts.maxConcurrencyPerKey ?? DEFAULT_MAX_CONCURRENCY_PER_KEY);
  const introspector = opts.oauth ? new TokenIntrospector({ ...opts.oauth, fetch: opts.oauth.fetch ?? opts.fetch }) : undefined;
  const prmPath = opts.oauth ? new URL(protectedResourceMetadataUrl(opts.oauth.resourceUrl)).pathname : undefined;
  let asMetadataCache: { until: number; body: unknown } | undefined;

  const unauthorized = (res: ServerResponse, message: string, error?: { code: string; description: string }) =>
    sendJson(res, 401, rpcError(-32001, message), {
      ...CORS_HEADERS,
      ...(opts.oauth || error ? { "WWW-Authenticate": wwwAuthenticate(opts.oauth, error) } : {}),
    });

  async function handle(req: IncomingMessage, res: ServerResponse, ctx: Record<string, unknown>): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    ctx.path = path;

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }
    const icon = req.method === "GET" || req.method === "HEAD" ? ICON_FILES[path] : undefined;
    if (icon) {
      res.writeHead(200, { "Content-Type": icon.type, "Content-Length": icon.body.length, "Cache-Control": "public, max-age=86400" });
      res.end(req.method === "HEAD" ? undefined : icon.body);
      return;
    }
    if (path === "/health" || path === "/healthz") {
      sendJson(res, 200, { ok: true, name: "twittrapi-mcp", version: VERSION, oauth: Boolean(opts.oauth) });
      return;
    }
    if (opts.oauth && (path === "/.well-known/oauth-protected-resource" || path === prmPath)) {
      sendJson(res, 200, protectedResourceMetadata(opts.oauth), { ...CORS_HEADERS, "Cache-Control": "public, max-age=300" });
      return;
    }
    // Clients that follow the 2025-03-26 spec look for the AS metadata on the MCP host itself
    if (opts.oauth && path === "/.well-known/oauth-authorization-server") {
      const now = Date.now();
      if (!asMetadataCache || asMetadataCache.until < now) {
        try {
          const r = await (opts.fetch ?? fetch)(opts.oauth.metadataUrl ?? `${opts.oauth.issuer}/.well-known/oauth-authorization-server`, {
            signal: AbortSignal.timeout(5_000),
          });
          if (!r.ok) throw new Error(`status ${r.status}`);
          asMetadataCache = { until: now + 300_000, body: await r.json() };
        } catch (err) {
          log.log("warn", "authorization server metadata unavailable", { err });
          sendJson(res, 502, { error: "authorization server metadata unavailable" }, CORS_HEADERS);
          return;
        }
      }
      sendJson(res, 200, asMetadataCache.body, { ...CORS_HEADERS, "Cache-Control": "public, max-age=300" });
      return;
    }
    if (path === "/sse" || path === "/messages") {
      sendJson(res, 404, { error: "The legacy SSE transport is not offered. Use Streamable HTTP at /mcp." }, CORS_HEADERS);
      return;
    }
    if (path !== "/mcp") {
      sendJson(res, 404, { error: "Not found. The MCP endpoint is /mcp." });
      return;
    }
    const origin = header(req, "origin");
    if (origin && opts.allowedOrigins?.length && !opts.allowedOrigins.includes(origin)) {
      sendJson(res, 403, rpcError(-32000, "Origin not allowed."));
      return;
    }
    if (req.method !== "POST") {
      // Stateless mode: no server-initiated streams or sessions.
      sendJson(res, 405, rpcError(-32000, "Method not allowed. Send JSON-RPC as POST."), { ...CORS_HEADERS, Allow: "POST, OPTIONS" });
      return;
    }

    // Credentials first: an unauthenticated client gets the 401 + resource metadata it needs to start OAuth
    const cred = credentialFromRequest(req, opts.baseUrl);
    let config: ClientConfig;
    if (cred.kind === "none") {
      ctx.auth = "none";
      unauthorized(
        res,
        opts.oauth
          ? "Authentication required. Connect with OAuth, or send your TwittrAPI key as Authorization: Bearer <key> or X-API-KEY."
          : "Missing API key. Send X-API-KEY (or Authorization: Bearer <key>), or x-rapidapi-key for RapidAPI.",
      );
      return;
    }
    if (cred.kind === "oauth") {
      ctx.auth = "oauth";
      if (!introspector) {
        unauthorized(res, "OAuth tokens are not accepted by this server.", { code: "invalid_token", description: "OAuth is not enabled" });
        return;
      }
      const check = await introspector.check(cred.token);
      if (!check.ok && check.reason === "unavailable") {
        log.log("error", "token introspection unavailable", {});
        sendJson(res, 503, rpcError(-32002, "Authorization service temporarily unavailable. Retry shortly."), {
          ...CORS_HEADERS,
          "Retry-After": "5",
        });
        return;
      }
      if (!check.ok) {
        unauthorized(res, "The access token is invalid, expired or revoked.", {
          code: "invalid_token",
          description: "The access token is invalid, expired or revoked",
        });
        return;
      }
      ctx.client_id = check.clientId;
      ctx.account = check.accountId;
      config = { mode: "direct", apiKey: check.apiKey, baseUrl: opts.baseUrl || DEFAULT_BASE_URL };
    } else {
      ctx.auth = cred.config.mode === "rapidapi" ? "rapidapi" : "api_key";
      config = cred.config;
    }
    const kid = keyId(config.apiKey!);
    ctx.key = kid;

    let parsed: unknown;
    try {
      const raw = await readBody(req, maxBody);
      parsed = JSON.parse(raw);
    } catch (err) {
      if (err instanceof BodyTooLarge) {
        sendJson(res, 413, rpcError(-32600, `Request body larger than ${maxBody} bytes.`), CORS_HEADERS);
      } else {
        sendJson(res, 400, rpcError(-32700, "Parse error: the body must be JSON-RPC."), CORS_HEADERS);
      }
      return;
    }
    const summary = summarize(parsed);
    if (summary.rpc) ctx.rpc = summary.rpc;
    if (summary.tool) ctx.tool = summary.tool;

    const release = limiter.acquire(kid);
    if (!release) {
      sendJson(res, 429, rpcError(-32000, `Too many concurrent requests for this key (max ${limiter.max}). Retry shortly.`, summary.id), {
        ...CORS_HEADERS,
        "Retry-After": "1",
      });
      return;
    }
    const client = new TwittrApiClient({ ...config, format: opts.format, fetch: opts.fetch });
    const server = createServer(client);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      release();
      void transport.close();
      void server.close();
    });
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
  }

  const httpServer = createHttpServer((req, res) => {
    const started = Date.now();
    const ctx: Record<string, unknown> = {
      req_id: header(req, "x-request-id")?.slice(0, 64) || randomUUID(),
      method: req.method,
    };
    const xff = opts.trustProxy ? header(req, "x-forwarded-for") : undefined;
    ctx.ip = xff ? xff.split(",")[0].trim() : req.socket.remoteAddress;
    const timer = setTimeout(() => {
      ctx.timed_out = true;
      if (!res.headersSent) {
        sendJson(res, 504, rpcError(-32603, `Request timed out after ${Math.round(timeoutMs / 1000)} s.`), CORS_HEADERS);
      } else {
        res.destroy();
      }
    }, timeoutMs);
    res.on("close", () => {
      clearTimeout(timer);
      const status = res.statusCode;
      const level = status >= 500 ? "error" : status === 429 || status === 413 ? "warn" : "info";
      log.log(level, "request", { ...ctx, status, ms: Date.now() - started });
    });
    handle(req, res, ctx).catch((err) => {
      log.log("error", "request failed", { ...ctx, err });
      if (!res.headersSent) sendJson(res, 500, rpcError(-32603, "Internal server error"));
    });
  });
  // Slow-client protection; keep-alive above typical proxy idle timeouts
  httpServer.headersTimeout = 30_000;
  httpServer.requestTimeout = timeoutMs + 10_000;
  httpServer.keepAliveTimeout = 65_000;
  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, opts.host, () => resolve(httpServer));
  });
}
