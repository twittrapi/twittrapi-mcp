import { createHash } from "node:crypto";
import { redact, silentLogger, type Logger } from "./log.js";

/**
 * Usage events of the hosted server: one per tool call, sent in batches to the operator's
 * dashboard (MCP_EVENTS_URL) so it can show who uses the server and which calls fail.
 * Off unless configured. An event never carries tool arguments, results, the X session or the
 * API key itself: the key is reduced to a SHA-256 hash the dashboard matches against its accounts.
 */
export interface ToolCallEvent {
  at: string;
  tool: string;
  /** read: public data; account: acts with the X session */
  kind: "read" | "account";
  /** The tool changes something on X */
  write: boolean;
  auth: "oauth" | "api_key" | "rapidapi";
  /** Dashboard account (OAuth only) */
  account_id?: number;
  /** SHA-256 hex of the API key the call used */
  key_hash: string;
  /** OAuth client (OAuth only) */
  client_id?: string;
  /** Where the X session came from, when there is one */
  session?: "header" | "oauth" | "env";
  ok: boolean;
  /** HTTP status of the failed API call, when there was one */
  status?: number;
  /** Error message as the model saw it, scrubbed of keys and the X session, at most 300 characters */
  error?: string;
  ms: number;
}

/** What a tool run reports about itself. */
export type ToolOutcome = { ok: true } | { ok: false; status?: number; message: string };

export interface EventSink {
  record(event: ToolCallEvent): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export const noEvents: EventSink = {
  record() {},
  async flush() {},
  async close() {},
};

export function keyHash(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

export function eventError(message: string): string {
  return redact(message).replace(/^Error:\s*/, "").slice(0, 300);
}

export interface EventReporterOptions {
  url: string;
  secret: string;
  /** Flush at least this often. Default 5 s. */
  intervalMs?: number;
  /** Events per POST. Default 200. */
  batchSize?: number;
  /** Events kept while the dashboard is unreachable; older ones are dropped. Default 5000. */
  maxQueue?: number;
  timeoutMs?: number;
  logger?: Logger;
  fetch?: typeof fetch;
}

/** Batches events and POSTs them. Never blocks or fails a tool call; a failed batch is dropped. */
export class EventReporter implements EventSink {
  private queue: ToolCallEvent[] = [];
  private readonly timer: NodeJS.Timeout;
  private sending: Promise<void> = Promise.resolve();
  private dropped = 0;
  private lastWarn = 0;

  constructor(private readonly opts: EventReporterOptions) {
    this.timer = setInterval(() => void this.flush(), opts.intervalMs ?? 5_000);
    this.timer.unref();
  }

  record(event: ToolCallEvent): void {
    this.queue.push(event);
    const max = this.opts.maxQueue ?? 5_000;
    if (this.queue.length > max) {
      this.dropped += this.queue.length - max;
      this.queue.splice(0, this.queue.length - max);
    }
    if (this.queue.length >= (this.opts.batchSize ?? 200)) void this.flush();
  }

  flush(): Promise<void> {
    this.sending = this.sending.then(() => this.sendAll());
    return this.sending;
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }

  private async sendAll(): Promise<void> {
    const size = this.opts.batchSize ?? 200;
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, size);
      const failure = await this.post(batch);
      if (failure) {
        this.dropped += batch.length;
        this.warn(failure);
        break;
      }
    }
  }

  /** null when delivered, else the reason */
  private async post(events: ToolCallEvent[]): Promise<string | null> {
    const f = this.opts.fetch ?? fetch;
    try {
      const res = await f(this.opts.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.opts.secret}` },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5_000),
      });
      return res.ok ? null : `status ${res.status}`;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /** At most one warning a minute, with the number of events lost so far. */
  private warn(reason: string): void {
    const now = Date.now();
    if (now - this.lastWarn < 60_000) return;
    this.lastWarn = now;
    (this.opts.logger ?? silentLogger).log("warn", "usage events not delivered", {
      reason: redact(reason).slice(0, 200),
      dropped: this.dropped,
    });
  }
}
