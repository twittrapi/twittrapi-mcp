import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://api.twittrapi.com";
export const RAPIDAPI_HOST = "twitter-aio.p.rapidapi.com";
export const RAPIDAPI_BASE_URL = `https://${RAPIDAPI_HOST}`;
export const DEFAULT_TIMEOUT_MS = 60_000;

export type AuthMode = "direct" | "rapidapi";

export interface ClientConfig {
  /** "direct" sends X-API-KEY to the TwittrAPI base URL, "rapidapi" goes through RapidAPI. */
  mode: AuthMode;
  /** API key. Undefined means "not configured": every call returns a setup error. */
  apiKey?: string;
  /** Base URL for direct mode. Ignored in RapidAPI mode. */
  baseUrl?: string;
  timeoutMs?: number;
  /** Injected for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
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

/** Reads auth config from environment variables (stdio mode). */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ClientConfig {
  const baseUrl = env.TWITTRAPI_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const direct = env.TWITTRAPI_API_KEY?.trim();
  if (direct) return { mode: "direct", apiKey: direct, baseUrl };
  const rapid = env.RAPIDAPI_KEY?.trim();
  if (rapid) return { mode: "rapidapi", apiKey: rapid };
  return { mode: "direct", apiKey: undefined, baseUrl };
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
    headers["x-rapidapi-host"] = RAPIDAPI_HOST;
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
    return this.config.mode === "rapidapi" ? RAPIDAPI_BASE_URL : this.config.baseUrl || DEFAULT_BASE_URL;
  }

  async get(req: ApiRequest): Promise<ApiResponse> {
    if (!this.config.apiKey) {
      throw new TwittrApiError(
        "No API key configured. Set TWITTRAPI_API_KEY (direct API) or RAPIDAPI_KEY (RapidAPI) in the MCP server's environment, or send an X-API-KEY header in HTTP mode.",
      );
    }
    const url = buildUrl(this.baseUrl, req);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: buildHeaders(this.config),
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
