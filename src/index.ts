#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TwittrApiClient, configFromEnv, parseResponseFormat } from "./client.js";
import { startHttpServer } from "./http.js";
import { createLogger, parseLogLevel } from "./log.js";
import { oauthConfigFromEnv } from "./oauth.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

const HELP = `twittrapi-mcp ${VERSION} - MCP server for the TwittrAPI Twitter/X data API

Usage:
  twittrapi-mcp                      Run over stdio (for Claude Desktop, Claude Code, Cursor)
  twittrapi-mcp --http [--port 3333] [--host 127.0.0.1]
                                     Run a Streamable HTTP server at /mcp. Callers send their
                                     own key (X-API-KEY, Authorization: Bearer, x-rapidapi-key)
                                     or, with OAuth configured, a TwittrAPI OAuth access token.

Environment (stdio mode):
  TWITTRAPI_API_KEY     Your TwittrAPI key (direct API)
  RAPIDAPI_KEY          Your RapidAPI key, used if TWITTRAPI_API_KEY is not set
  TWITTRAPI_BASE_URL    Override the API base URL (default https://api.twittrapi.com)
  TWITTRAPI_RESPONSE_FORMAT
                        simple (default): compact JSON, far fewer tokens.
                        raw: X's full GraphQL JSON. Tools also take a format argument.
                        Read in both stdio and HTTP mode.
  PORT, HOST            Defaults for --port and --host in HTTP mode

Environment (HTTP mode, hosted deployments; see README "Hosted MCP server"):
  MCP_PUBLIC_URL        Public URL of /mcp, e.g. https://mcp.twittrapi.com/mcp (OAuth audience)
  OAUTH_ISSUER          Authorization server (TwittrAPI dashboard), e.g. https://app.twittrapi.com
  OAUTH_INTROSPECTION_URL
                        Internal introspection URL (default OAUTH_ISSUER/api/oauth/introspect)
  OAUTH_INTROSPECTION_SECRET
                        Shared secret with the dashboard (32+ characters)
  OAUTH_METADATA_URL    Internal URL of the AS metadata, relayed for older clients (optional)
  OAUTH_CACHE_SECONDS   Cache for valid tokens, default 30 (max 300)
  MAX_CONCURRENCY_PER_KEY  Concurrent requests per key and instance, default 8 (0 = off)
  MAX_BODY_BYTES        Request body limit, default 262144
  REQUEST_TIMEOUT_MS    Time limit per request, default 90000
  ALLOWED_ORIGINS       Comma-separated Origin allowlist (browser clients); empty = any
  TRUST_PROXY           1 to log the client IP from X-Forwarded-For
  LOG_LEVEL             debug, info (default), warn, error. JSON lines on stdout.
`;

interface Args {
  http: boolean;
  port: number;
  host: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    http: false,
    port: Number(process.env.PORT) || 3333,
    host: process.env.HOST || "127.0.0.1",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.split("=", 2);
    const next = () => inline ?? argv[++i];
    switch (flag) {
      case "--http":
        args.http = true;
        break;
      case "--port": {
        const n = Number(next());
        if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`Invalid --port value`);
        args.port = n;
        break;
      }
      case "--host":
        args.host = next() ?? args.host;
        break;
      case "--help":
      case "-h":
        process.stdout.write(HELP);
        process.exit(0);
      case "--version":
      case "-v":
        process.stdout.write(`${VERSION}\n`);
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${a}. Try --help.`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.http) {
    const env = process.env;
    const num = (name: string, fallback: number) => {
      const raw = env[name]?.trim();
      if (!raw) return fallback;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid ${name} value`);
      return n;
    };
    const oauth = oauthConfigFromEnv(env);
    const server = await startHttpServer({
      port: args.port,
      host: args.host,
      baseUrl: env.TWITTRAPI_BASE_URL?.trim() || undefined,
      format: parseResponseFormat(env.TWITTRAPI_RESPONSE_FORMAT),
      oauth,
      maxBodyBytes: num("MAX_BODY_BYTES", 256 * 1024),
      requestTimeoutMs: num("REQUEST_TIMEOUT_MS", 90_000),
      maxConcurrencyPerKey: num("MAX_CONCURRENCY_PER_KEY", 8),
      allowedOrigins: env.ALLOWED_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean),
      trustProxy: env.TRUST_PROXY === "1" || env.TRUST_PROXY === "true",
      logger: createLogger({ level: parseLogLevel(env.LOG_LEVEL) }),
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : args.port;
    console.error(
      `twittrapi-mcp ${VERSION} listening on http://${args.host}:${port}/mcp` +
        (oauth ? ` (OAuth: resource ${oauth.resourceUrl}, issuer ${oauth.issuer})` : " (API key headers only)"),
    );
    const shutdown = () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 10_000).unref();
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    return;
  }
  const config = configFromEnv();
  if (!config.apiKey) {
    console.error(
      "twittrapi-mcp: no TWITTRAPI_API_KEY or RAPIDAPI_KEY set. Tools will be listed but calls will fail until a key is configured.",
    );
  }
  const server = createServer(new TwittrApiClient(config));
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(`twittrapi-mcp: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
