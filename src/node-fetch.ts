import http from "node:http";
import https from "node:https";

/**
 * A minimal fetch over node:http(s) that returns every status. Node's fetch throws "fetch failed" on
 * a 407 answer, which TwittrAPI sends when the user's proxy fails, so the error would read as if the
 * API could not be reached.
 */
export const nodeFetch = (async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
  const url = typeof input === "string" ? input : input.toString();
  const { request } = url.startsWith("https:") ? https : http;
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const body = typeof init.body === "string" ? init.body : "";
  const signal = init.signal;
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    const req = request(
      url,
      { method: init.method ?? "GET", headers: { ...headers, "content-length": String(Buffer.byteLength(body)) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const out = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") out.set(k, v);
            else if (Array.isArray(v)) out.set(k, v.join(", "));
          }
          const status = res.statusCode ?? 502;
          const noBody = status === 204 || status === 304;
          resolve(new Response(noBody ? null : Buffer.concat(chunks), { status, headers: out }));
        });
        res.on("error", reject);
      },
    );
    signal?.addEventListener("abort", () => req.destroy(signal.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" })), {
      once: true,
    });
    req.on("error", reject);
    req.end(body);
  });
}) as typeof fetch;
