import { describe, expect, it } from "vitest";
import { EventReporter, eventError, keyHash, type ToolCallEvent } from "../src/events.js";

const ev = (n: number): ToolCallEvent => ({
  at: "2026-11-09T12:00:00.000Z",
  tool: `t${n}`,
  kind: "read",
  write: false,
  auth: "api_key",
  key_hash: keyHash("k"),
  ok: true,
  ms: 5,
});

function fakeFetch(statuses: number[]) {
  const posts: { url: string; auth: string | null; events: ToolCallEvent[] }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    posts.push({ url, auth: headers.get("authorization"), events: JSON.parse(String(init.body)).events });
    return new Response("{}", { status: statuses.shift() ?? 200 });
  }) as unknown as typeof fetch;
  return { f, posts };
}

describe("EventReporter", () => {
  it("batches events and sends them with the secret", async () => {
    const { f, posts } = fakeFetch([]);
    const r = new EventReporter({ url: "http://dash/api/mcp/events", secret: "s3cret", batchSize: 2, intervalMs: 60_000, fetch: f });
    r.record(ev(1));
    r.record(ev(2));
    r.record(ev(3));
    await r.close();
    expect(posts.map((p) => p.events.length)).toEqual([2, 1]);
    expect(posts[0].auth).toBe("Bearer s3cret");
    expect(posts[0].url).toBe("http://dash/api/mcp/events");
  });

  it("drops a batch the dashboard refuses and keeps going", async () => {
    const lines: string[] = [];
    const { f, posts } = fakeFetch([500, 200]);
    const logger = { log: (_l: string, msg: string, fields?: Record<string, unknown>) => void lines.push(`${msg} ${JSON.stringify(fields)}`) };
    const r = new EventReporter({ url: "http://dash/e", secret: "s", intervalMs: 60_000, fetch: f, logger });
    r.record(ev(1));
    await r.flush();
    r.record(ev(2));
    await r.close();
    expect(posts).toHaveLength(2);
    expect(posts[1].events.map((e) => e.tool)).toEqual(["t2"]);
    expect(lines[0]).toMatch(/not delivered.*"dropped":1/);
  });

  it("keeps at most maxQueue events", async () => {
    const { f, posts } = fakeFetch([]);
    const r = new EventReporter({ url: "http://dash/e", secret: "s", intervalMs: 60_000, batchSize: 100, maxQueue: 3, fetch: f });
    for (let i = 1; i <= 5; i++) r.record(ev(i));
    await r.close();
    expect(posts[0].events.map((e) => e.tool)).toEqual(["t3", "t4", "t5"]);
  });

  it("error text is redacted and capped", () => {
    const e = eventError(`Error: bad key 11111111-2222-4333-8444-555555555555 ${"x".repeat(400)}`);
    expect(e).not.toContain("11111111-2222");
    expect(e.length).toBeLessThanOrEqual(300);
    expect(e.startsWith("Error:")).toBe(false);
  });
});
