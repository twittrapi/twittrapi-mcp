import { createHash } from "node:crypto";

/**
 * Resource-server side of OAuth for the hosted MCP server. The TwittrAPI dashboard is the
 * authorization server; it issues opaque access tokens (prefix twa_at_) and this server checks
 * them through the dashboard's internal introspection endpoint (shared secret), with a short
 * cache. A valid token resolves to the customer's API key, which only ever goes to the
 * gateway, never back to the MCP client.
 */

export const OAUTH_ACCESS_TOKEN_PREFIX = "twa_at_";
export const OAUTH_SCOPE = "mcp";

export interface OAuthConfig {
  /** Canonical URL of this MCP endpoint, e.g. https://mcp.twittrapi.com/mcp (the token audience). */
  resourceUrl: string;
  /** Authorization server issuer, e.g. https://app.twittrapi.com */
  issuer: string;
  /** Internal introspection URL, e.g. http://dashboard:3000/api/oauth/introspect */
  introspectionUrl: string;
  introspectionSecret: string;
  /** Where to fetch the AS metadata relayed at /.well-known/oauth-authorization-server (default issuer + well-known). */
  metadataUrl?: string;
  /** Upper bound for caching a positive introspection result (seconds). Default 30. */
  cacheSeconds?: number;
  fetch?: typeof fetch;
}

/** Canonical form for comparison: lowercase scheme/host, no trailing slash, no fragment. */
export function canonicalUrl(value: string): string | null {
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.hash || u.username || u.password) return null;
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
}

/** RFC 9728 well-known URL for a resource: path-suffixed when the resource has a path. */
export function protectedResourceMetadataUrl(resourceUrl: string): string {
  const u = new URL(resourceUrl);
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "");
  return `${u.origin}/.well-known/oauth-protected-resource${path}`;
}

export function protectedResourceMetadata(cfg: Pick<OAuthConfig, "resourceUrl" | "issuer">) {
  return {
    resource: cfg.resourceUrl,
    authorization_servers: [cfg.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: [OAUTH_SCOPE],
    resource_name: "TwittrAPI",
    resource_documentation: "https://twittrapi.com/docs/integrations",
  };
}

/** WWW-Authenticate value for 401s (RFC 6750 + RFC 9728 resource_metadata). */
export function wwwAuthenticate(cfg: Pick<OAuthConfig, "resourceUrl"> | undefined, error?: { code: string; description: string }): string {
  const parts = ['Bearer realm="twittrapi"'];
  if (error) {
    parts.push(`error="${error.code}"`, `error_description="${error.description.replace(/"/g, "'")}"`);
  }
  if (cfg) {
    parts.push(`resource_metadata="${protectedResourceMetadataUrl(cfg.resourceUrl)}"`, `scope="${OAUTH_SCOPE}"`);
  }
  return parts.join(", ");
}

export type TokenCheck =
  | { ok: true; apiKey: string; clientId: string; accountId: number; exp: number }
  | { ok: false; reason: "invalid" | "unavailable" };

interface CacheEntry {
  until: number;
  result: TokenCheck;
}

const NEGATIVE_CACHE_MS = 5_000;
const MAX_CACHE_ENTRIES = 10_000;

/** Checks access tokens against the dashboard, with a small in-memory cache per instance. */
export class TokenIntrospector {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<TokenCheck>>();
  private readonly fetchImpl: typeof fetch;
  readonly resource: string;

  constructor(readonly cfg: OAuthConfig) {
    this.fetchImpl = cfg.fetch ?? globalThis.fetch;
    const r = canonicalUrl(cfg.resourceUrl);
    if (!r) throw new Error(`Invalid MCP_PUBLIC_URL: ${cfg.resourceUrl}`);
    this.resource = r;
  }

  async check(token: string, now = Date.now()): Promise<TokenCheck> {
    const id = createHash("sha256").update(token).digest("hex");
    const hit = this.cache.get(id);
    if (hit && hit.until > now) return hit.result;
    if (hit) this.cache.delete(id);
    const pending = this.inflight.get(id);
    if (pending) return pending;
    const p = this.lookup(token, now)
      .then((result) => {
        if (result.ok) {
          const ttl = Math.min((this.cfg.cacheSeconds ?? 30) * 1000, result.exp * 1000 - now);
          if (ttl > 0) this.remember(id, { until: now + ttl, result });
        } else if (result.reason === "invalid") {
          this.remember(id, { until: now + NEGATIVE_CACHE_MS, result });
        }
        return result;
      })
      .finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  /** Drops a token from the cache (after the gateway rejected its key, for example). */
  forget(token: string): void {
    this.cache.delete(createHash("sha256").update(token).digest("hex"));
  }

  private remember(id: string, entry: CacheEntry): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(id, entry);
  }

  private async lookup(token: string, now: number): Promise<TokenCheck> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.cfg.introspectionUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.cfg.introspectionSecret}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({ token, resource: this.resource }).toString(),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    if (!res.ok) return { ok: false, reason: "unavailable" };
    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    if (body.active !== true) return { ok: false, reason: "invalid" };
    const extra = body.twittrapi as Record<string, unknown> | undefined;
    const exp = typeof body.exp === "number" ? body.exp : 0;
    const scopes = typeof body.scope === "string" ? body.scope.split(" ") : [];
    // Audience binding (RFC 8707): only tokens issued for this MCP server
    if (typeof body.aud !== "string" || canonicalUrl(body.aud) !== this.resource) return { ok: false, reason: "invalid" };
    if (!scopes.includes(OAUTH_SCOPE)) return { ok: false, reason: "invalid" };
    if (exp * 1000 <= now) return { ok: false, reason: "invalid" };
    if (!extra || typeof extra.api_key !== "string" || !extra.api_key) return { ok: false, reason: "invalid" };
    return {
      ok: true,
      apiKey: extra.api_key,
      clientId: typeof body.client_id === "string" ? body.client_id : "",
      accountId: typeof extra.account_id === "number" ? extra.account_id : 0,
      exp,
    };
  }
}

/** Reads the OAuth settings from the environment; undefined when OAuth is not configured. */
export function oauthConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OAuthConfig | undefined {
  const resourceUrl = env.MCP_PUBLIC_URL?.trim();
  const issuer = env.OAUTH_ISSUER?.trim().replace(/\/+$/, "");
  const secret = env.OAUTH_INTROSPECTION_SECRET?.trim();
  if (!resourceUrl && !issuer && !secret) return undefined;
  const missing = [
    !resourceUrl && "MCP_PUBLIC_URL",
    !issuer && "OAUTH_ISSUER",
    !secret && "OAUTH_INTROSPECTION_SECRET",
  ].filter(Boolean);
  if (missing.length) throw new Error(`OAuth needs ${missing.join(", ")} as well (or unset all three to run without OAuth).`);
  if (secret!.length < 32) throw new Error("OAUTH_INTROSPECTION_SECRET must be at least 32 characters.");
  const canonical = canonicalUrl(resourceUrl!);
  if (!canonical) throw new Error(`Invalid MCP_PUBLIC_URL: ${resourceUrl}`);
  const cacheSeconds = Number(env.OAUTH_CACHE_SECONDS);
  return {
    resourceUrl: canonical,
    issuer: issuer!,
    introspectionUrl: env.OAUTH_INTROSPECTION_URL?.trim() || `${issuer}/api/oauth/introspect`,
    introspectionSecret: secret!,
    metadataUrl: env.OAUTH_METADATA_URL?.trim() || undefined,
    cacheSeconds: Number.isFinite(cacheSeconds) && cacheSeconds >= 0 ? Math.min(cacheSeconds, 300) : 30,
  };
}
