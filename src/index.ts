#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TwittrApiClient, configFromEnv, parseResponseFormat } from "./client.js";
import { startHttpServer } from "./http.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

const HELP = `twittrapi-mcp ${VERSION} - MCP server for the TwittrAPI Twitter/X data API

Usage:
  twittrapi-mcp                      Run over stdio (for Claude Desktop, Claude Code, Cursor)
  twittrapi-mcp --http [--port 3333] [--host 127.0.0.1]
                                     Run a Streamable HTTP server at /mcp. Callers send their
                                     own key in the X-API-KEY (or x-rapidapi-key) header.

Environment (stdio mode):
  TWITTRAPI_API_KEY     Your TwittrAPI key (direct API)
  RAPIDAPI_KEY          Your RapidAPI key, used if TWITTRAPI_API_KEY is not set
  TWITTRAPI_BASE_URL    Override the API base URL (default https://api.twittrapi.com)
  TWITTRAPI_RESPONSE_FORMAT
                        simple (default): compact JSON, far fewer tokens.
                        raw: X's full GraphQL JSON. Tools also take a format argument.
                        Read in both stdio and HTTP mode.
  PORT, HOST            Defaults for --port and --host in HTTP mode
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
    const server = await startHttpServer({
      port: args.port,
      host: args.host,
      baseUrl: process.env.TWITTRAPI_BASE_URL?.trim() || undefined,
      format: parseResponseFormat(process.env.TWITTRAPI_RESPONSE_FORMAT),
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : args.port;
    console.error(`twittrapi-mcp ${VERSION} listening on http://${args.host}:${port}/mcp`);
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
