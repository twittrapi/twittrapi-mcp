import { createHash } from "node:crypto";

/**
 * Structured JSON logs for HTTP mode, one object per line on stdout. Never pass a key or token
 * in: use keyId() for a stable, non-reversible identifier, and redact() on free text (error
 * messages can echo headers).
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
}

/** Short, stable id for a key or token: "k_" + 12 hex chars of SHA-256. Safe to log. */
export function keyId(secret: string): string {
  return `k_${createHash("sha256").update(secret).digest("hex").slice(0, 12)}`;
}

const SECRET_PATTERNS: RegExp[] = [
  // OAuth tokens, codes and client secrets issued by the dashboard
  /\btw(?:a_(?:at|rt|ac)|cs)_[A-Za-z0-9_-]{8,}/g,
  // Authorization header values
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // API keys (UUIDs) and other long hex/base64-ish secrets
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\b(x-api-key|x-rapidapi-key|api_key|apikey|token|secret)(["'\s:=]+)[^\s"',}]{6,}/gi,
];

/** Removes anything that looks like a key or token from free text. */
export function redact(text: string): string {
  let out = text;
  out = out.replace(SECRET_PATTERNS[0], "[REDACTED]");
  out = out.replace(SECRET_PATTERNS[1], (_m, scheme: string) => `${scheme} [REDACTED]`);
  out = out.replace(SECRET_PATTERNS[2], "[REDACTED]");
  out = out.replace(SECRET_PATTERNS[3], (_m, name: string, sep: string) => `${name}${sep}[REDACTED]`);
  return out;
}

function sanitize(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (value instanceof Error) return redact(value.message);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitize(v);
    return out;
  }
  return value;
}

export function createLogger(
  opts: { level?: LogLevel; write?: (line: string) => void } = {},
): Logger {
  const min = LEVELS[opts.level ?? "info"];
  const write = opts.write ?? ((line: string) => process.stdout.write(line + "\n"));
  return {
    log(level, msg, fields = {}) {
      if (LEVELS[level] < min) return;
      write(JSON.stringify({ ts: new Date().toISOString(), level, msg: redact(msg), ...(sanitize(fields) as object) }));
    },
  };
}

export function parseLogLevel(value: string | undefined): LogLevel {
  const v = value?.trim().toLowerCase();
  return v === "debug" || v === "warn" || v === "error" ? v : "info";
}

export const silentLogger: Logger = { log() {} };
