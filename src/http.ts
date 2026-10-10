import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { DEFAULT_BASE_URL, TwittrApiClient, type ClientConfig } from "./client.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

export interface HttpOptions {
  port: number;
  host: string;
  /** Base URL for direct mode, from the server operator's env (never from the request). */
  baseUrl?: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  const s = Array.isArray(v) ? v[0] : v;
  return s?.trim() || undefined;
}

/**
 * Reads the caller's key from the request. In HTTP mode the server never uses a key from its own
 * environment, so one deployment can serve many users and nobody spends the operator's balance.
 */
export function configFromRequest(req: IncomingMessage, baseUrl?: string): ClientConfig | undefined {
  const direct = header(req, "x-api-key");
  if (direct) return { mode: "direct", apiKey: direct, baseUrl: baseUrl || DEFAULT_BASE_URL };
  const auth = header(req, "authorization");
  const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) return { mode: "direct", apiKey: bearer, baseUrl: baseUrl || DEFAULT_BASE_URL };
  const rapid = header(req, "x-rapidapi-key");
  if (rapid) return { mode: "rapidapi", apiKey: rapid };
  return undefined;
}

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Stateless Streamable HTTP endpoint at /mcp. Each POST gets its own McpServer bound to the key in
 * that request's headers.
 */
export function startHttpServer(opts: HttpOptions): Promise<Server> {
  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health" || url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true, name: "twittrapi-mcp", version: VERSION });
      return;
    }
    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { error: "Not found. The MCP endpoint is /mcp." });
      return;
    }
    if (req.method !== "POST") {
      // Stateless mode: no server-initiated streams or sessions.
      res.setHeader("Allow", "POST");
      sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
      return;
    }
    const config = configFromRequest(req, opts.baseUrl);
    if (!config) {
      sendJson(res, 401, {
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Missing API key. Send X-API-KEY (or Authorization: Bearer <key>), or x-rapidapi-key for RapidAPI.",
        },
        id: null,
      });
      return;
    }
    const client = new TwittrApiClient({ ...config, fetch: opts.fetch });
    const server = createServer(client);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("twittrapi-mcp: error handling request:", err);
      if (!res.headersSent) {
        sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });
  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, opts.host, () => resolve(httpServer));
  });
}
