import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://api.twittrapi.com";
export const RAPIDAPI_HOST = "twitter-aio.p.rapidapi.com";
export const RAPIDAPI_BASE_URL = `https://${RAPIDAPI_HOST}`;
export const DEFAULT_TIMEOUT_MS = 60_000;

export type AuthMode = "direct" | "rapidapi";

/**
 * Response format requested from the API. "simple" (the default) asks for format=simple: compact,
 * flat JSON with a fixed schema (https://twittrapi.com/docs/simple-format), roughly 60 % fewer tokens.
 * "raw" returns X's full GraphQL JSON.
 */
export type ResponseFormat = "simple" | "raw";
export const RESPONSE_FORMATS: readonly ResponseFormat[] = ["simple", "raw"];
export const DEFAULT_FORMAT: ResponseFormat = "simple";

/**
 * Parses a format setting (TWITTRAPI_RESPONSE_FORMAT). Empty means the default; anything other than
 * simple or raw (case-insensitive) is an error, so a typo does not silently change the output.
 */
export function parseResponseFormat(value: string | undefined, name = "TWITTRAPI_RESPONSE_FORMAT"): ResponseFormat | undefined {
  const v = value?.trim().toLowerCase();
  if (!v) return undefined;
  if (!RESPONSE_FORMATS.includes(v as ResponseFormat)) {
    throw new Error(`Invalid ${name} value "${value}". Use "simple" (default) or "raw".`);
  }
  return v as ResponseFormat;
}

/**
 * Parses a RapidAPI host setting (RAPIDAPI_HOST). Each TwittrAPI listing on RapidAPI has its own host
 * with the same paths. Accepts "https://" and a trailing slash and returns the bare host. Empty means
 * the default (RAPIDAPI_HOST); a value with a path or spaces is an error.
 */
export function parseRapidApiHost(value: string | undefined, name = "RAPIDAPI_HOST"): string | undefined {
  if (!value?.trim()) return undefined;
  const host = value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  if (!host || /[\s/?#@]/.test(host)) {
    throw new Error(`Invalid ${name} value "${value}". Use a host like ${RAPIDAPI_HOST}, without a path.`);
  }
  return host;
}

export interface ClientConfig {
  /** "direct" sends X-API-KEY to the TwittrAPI base URL, "rapidapi" goes through RapidAPI. */
  mode: AuthMode;
  /** API key. Undefined means "not configured": every call returns a setup error. */
  apiKey?: string;
  /** Base URL for direct mode. Ignored in RapidAPI mode. */
  baseUrl?: string;
  /** RapidAPI host (normalized), used for x-rapidapi-host and the URL. Undefined means RAPIDAPI_HOST. */
  rapidApiHost?: string;
  timeoutMs?: number;
  /** Default response format for tool results. Undefined means DEFAULT_FORMAT ("simple"). */
  format?: ResponseFormat;
  /** Injected for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /**
   * The user's own X session for the account-action (write) tools, from TWITTRAPI_X_COOKIE and
   * TWITTRAPI_X_PROXY. Never shown to the model and never logged. Undefined: no write tools.
   */
  xSession?: XSession;
}

/** Cookie and proxy of the user's own X account, sent in the body of the /client endpoints. */
export interface XSession {
  /** Cookie header of a logged-in x.com session: auth_token=...; ct0=...; twid=u%3D... */
  cookie: string;
  /** The user's proxy, http://user:pass@host:port. */
  proxy: string;
  /** X Chat passcode (TWITTRAPI_X_CHAT_PASSCODE), needed to read and send direct messages. */
  chatPasscode?: string;
}

/**
 * Reads the X session from TWITTRAPI_X_COOKIE and TWITTRAPI_X_PROXY. Returns undefined when either is
 * missing. Throws (without echoing the values) when the cookie lacks auth_token or ct0, or the proxy
 * is not an http(s) URL with a host.
 */
export function xSessionFromEnv(env: NodeJS.ProcessEnv = process.env): XSession | undefined {
  const cookie = env.TWITTRAPI_X_COOKIE?.trim();
  const proxy = env.TWITTRAPI_X_PROXY?.trim();
  if (!cookie || !proxy) return undefined;
  if (!/(?:^|;\s*)auth_token=[^;\s]+/.test(cookie) || !/(?:^|;\s*)ct0=[^;\s]+/.test(cookie)) {
    throw new Error("TWITTRAPI_X_COOKIE must be the cookie of a logged-in x.com session and contain auth_token and ct0.");
  }
  let url: URL | undefined;
  try {
    url = new URL(proxy);
  } catch {
    url = undefined;
  }
  if (!url || !/^https?:$/.test(url.protocol) || !url.hostname) {
    throw new Error("TWITTRAPI_X_PROXY must be a proxy URL like http://user:pass@host:port.");
  }
  const chatPasscode = env.TWITTRAPI_X_CHAT_PASSCODE?.trim();
  return { cookie, proxy, ...(chatPasscode ? { chatPasscode } : {}) };
}

/**
 * Removes the X session (cookie, its token values, proxy, proxy credentials, chat passcode) from text,
 * so an API error that echoes the request can never put it into a tool result.
 */
export function scrubSession(text: string, session: XSession | undefined): string {
  if (!session) return text;
  const secrets = new Set<string>([session.cookie, session.proxy]);
  for (const part of session.cookie.split(";")) {
    const value = part.slice(part.indexOf("=") + 1).trim();
    if (part.includes("=") && value.length >= 6) secrets.add(value);
  }
  try {
    const url = new URL(session.proxy);
    if (url.password) {
      secrets.add(url.password);
      secrets.add(decodeURIComponent(url.password));
    }
    if (url.username.length >= 3) {
      secrets.add(url.username);
      secrets.add(decodeURIComponent(url.username));
    }
  } catch {
    // validated at startup
  }
  if (session.chatPasscode && session.chatPasscode.length >= 4) secrets.add(session.chatPasscode);
  let out = text;
  for (const s of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.split(s).join("[REDACTED]");
  }
  return out;
}

export type QueryValue = string | number | boolean | undefined;

export interface ApiRequest {
  /** Path with placeholders already filled in, e.g. /user/by/username/jack */
  path: string;
  query?: Record<string, QueryValue>;
}

export interface ApiResponse {
  status: number;
  /** Parsed JSON when the body is JSON, otherwise the raw text. */
  data: unknown;
  rawText: string;
}

/** An error that is safe and useful to show to the model as a tool result. */
export class TwittrApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "TwittrApiError";
  }
}

/**
 * Reads auth config, the response format and the optional X session from environment variables
 * (stdio mode). Throws on an invalid TWITTRAPI_RESPONSE_FORMAT, an invalid RAPIDAPI_HOST in RapidAPI
 * mode, or an invalid TWITTRAPI_X_COOKIE / TWITTRAPI_X_PROXY.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ClientConfig {
  const baseUrl = env.TWITTRAPI_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const format = parseResponseFormat(env.TWITTRAPI_RESPONSE_FORMAT);
  const xSession = xSessionFromEnv(env);
  const extra = { ...(format ? { format } : {}), ...(xSession ? { xSession } : {}) };
  const direct = env.TWITTRAPI_API_KEY?.trim();
  if (direct) return { mode: "direct", apiKey: direct, baseUrl, ...extra };
  const rapid = env.RAPIDAPI_KEY?.trim();
  if (rapid) {
    const rapidApiHost = parseRapidApiHost(env.RAPIDAPI_HOST);
    return { mode: "rapidapi", apiKey: rapid, ...(rapidApiHost ? { rapidApiHost } : {}), ...extra };
  }
  return { mode: "direct", apiKey: undefined, baseUrl, ...extra };
}

/** Joins the base URL, a path and query parameters. Undefined/empty values are dropped. */
export function buildUrl(baseUrl: string, req: ApiRequest): string {
  const base = baseUrl.replace(/\/+$/, "");
  const path = req.path.startsWith("/") ? req.path : `/${req.path}`;
  const url = new URL(base + path);
  for (const [key, value] of Object.entries(req.query ?? {})) {
    if (value === undefined || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export function buildHeaders(config: ClientConfig): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": `twittrapi-mcp/${VERSION}`,
  };
  if (!config.apiKey) return headers;
  if (config.mode === "rapidapi") {
    headers["x-rapidapi-key"] = config.apiKey;
    headers["x-rapidapi-host"] = config.rapidApiHost || RAPIDAPI_HOST;
  } else {
    headers["X-API-KEY"] = config.apiKey;
  }
  return headers;
}

function extractErrorText(data: unknown, rawText: string): string | undefined {
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of ["error", "message", "detail"]) {
      const v = obj[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  const trimmed = rawText.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}...` : trimmed;
}

/** Turns an HTTP error status into a message the model can act on. */
export function mapHttpError(
  status: number,
  data: unknown,
  rawText: string,
  mode: AuthMode,
  retryAfter?: string | null,
): TwittrApiError {
  const detail = extractErrorText(data, rawText);
  const suffix = detail ? ` API said: ${detail}` : "";
  const keyVar = mode === "rapidapi" ? "RAPIDAPI_KEY" : "TWITTRAPI_API_KEY";
  let message: string;
  switch (true) {
    case status === 401:
      message = `Authentication failed (401). Check that ${keyVar} is set to a valid key.`;
      break;
    case status === 402:
      message =
        "No balance left on this TwittrAPI account (402). The account owner needs to top up before more calls can be made. Do not retry.";
      break;
    case status === 403:
      message = `Access denied (403). The key may lack access, or X refused the request.`;
      if (mode === "rapidapi") message += " If you subscribed to another TwittrAPI listing on RapidAPI, set RAPIDAPI_HOST to its host.";
      break;
    case status === 404:
      message = "Not found (404). The user, tweet, list or community may not exist, be private, or be suspended.";
      break;
    case status === 422:
      message = "Invalid input (422). Check the IDs and parameters you passed.";
      break;
    case status === 429:
      message = `Rate limit hit (429). Wait before retrying${retryAfter ? ` (Retry-After: ${retryAfter}s)` : ""}.`;
      break;
    case status >= 400 && status < 500:
      message = `Request rejected (${status}).`;
      break;
    case status >= 500:
      message = `TwittrAPI upstream error (${status}). This is usually temporary; retrying once later may work.`;
      break;
    default:
      message = `Unexpected HTTP status ${status}.`;
  }
  return new TwittrApiError(message + suffix, status, detail);
}

export class TwittrApiClient {
  readonly config: ClientConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ClientConfig) {
    this.config = config;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
  }

  get baseUrl(): string {
    if (this.config.mode === "rapidapi") return `https://${this.config.rapidApiHost || RAPIDAPI_HOST}`;
    return this.config.baseUrl || DEFAULT_BASE_URL;
  }

  async get(req: ApiRequest): Promise<ApiResponse> {
    return this.request("GET", req);
  }

  /** POST with a JSON body (the account-action endpoints). */
  async post(req: ApiRequest, body: Record<string, unknown>): Promise<ApiResponse> {
    return this.request("POST", req, body);
  }

  private async request(method: "GET" | "POST", req: ApiRequest, body?: Record<string, unknown>): Promise<ApiResponse> {
    if (!this.config.apiKey) {
      throw new TwittrApiError(
        "No API key configured. Set TWITTRAPI_API_KEY (direct API) or RAPIDAPI_KEY (RapidAPI) in the MCP server's environment, or send an X-API-KEY header in HTTP mode.",
      );
    }
    const url = buildUrl(this.baseUrl, req);
    let res: Response;
    try {
      const headers = buildHeaders(this.config);
      if (body !== undefined) headers["Content-Type"] = "application/json";
      res = await this.fetchImpl(url, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      const e = err as Error;
      if (e?.name === "TimeoutError" || e?.name === "AbortError") {
        throw new TwittrApiError("The request to TwittrAPI timed out. Retrying once may work.");
      }
      throw new TwittrApiError(`Could not reach TwittrAPI: ${e?.message ?? String(err)}`);
    }
    const rawText = await res.text();
    let data: unknown = rawText;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {
      // keep raw text
    }
    if (!res.ok) {
      throw mapHttpError(res.status, data, rawText, this.config.mode, res.headers.get("retry-after"));
    }
    return { status: res.status, data, rawText };
  }
}
