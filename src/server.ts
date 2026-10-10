import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { TwittrApiClient, TwittrApiError, type ApiRequest, type QueryValue } from "./client.js";
import { ENDPOINTS, type EndpointDef } from "./endpoints.js";
import { DEFAULT_MAX_CHARS, MAX_MAX_CHARS, MIN_MAX_CHARS, formatResult } from "./output.js";
import { VERSION } from "./version.js";

export const SERVER_INSTRUCTIONS = `Tools for reading public X (Twitter) data through TwittrAPI.
Responses are X's raw GraphQL JSON and can be large; they are cut at max_chars (default ${DEFAULT_MAX_CHARS}).
Most user tools accept userId or username; resolve a handle once with username_to_id and reuse the ID.
Paginated tools print next_cursor at the top of the result; pass it back as cursor for the next page.
A 402 error means the account has no balance: stop and tell the user. Every call is billed.`;

const maxCharsSchema = z
  .number()
  .int()
  .min(MIN_MAX_CHARS)
  .max(MAX_MAX_CHARS)
  .optional()
  .describe(
    `Maximum characters of JSON to return (default ${DEFAULT_MAX_CHARS}). Longer output is cut with a [TRUNCATED] marker. Lower it to save context, raise it if you need the full response.`,
  );

/** Builds the zod input shape for a tool: its endpoint params plus max_chars. */
export function inputShape(def: EndpointDef): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, p] of Object.entries(def.params)) shape[name] = p.schema;
  shape.max_chars = maxCharsSchema;
  return shape;
}

/** Turns validated tool arguments into a request (path filled in, query collected). */
export function buildRequest(def: EndpointDef, rawArgs: Record<string, unknown>): ApiRequest {
  const args = def.prepare ? def.prepare({ ...rawArgs }) : { ...rawArgs };
  let path = def.path;
  const query: Record<string, QueryValue> = {};
  for (const [name, p] of Object.entries(def.params)) {
    const value = args[name];
    const apiName = p.apiName ?? name;
    if (p.in === "path") {
      if (value === undefined || value === null || value === "") {
        throw new TwittrApiError(`Missing required argument: ${name}`);
      }
      const str = String(p.serialize ? p.serialize(value) : value);
      path = path.replace(`{${apiName}}`, encodeURIComponent(str));
    } else if (value !== undefined && value !== null) {
      query[apiName] = p.serialize ? p.serialize(value) : (value as QueryValue);
    }
  }
  return { path, query };
}

export async function runEndpoint(
  client: TwittrApiClient,
  def: EndpointDef,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    const { max_chars, ...apiArgs } = args;
    const req = buildRequest(def, apiArgs);
    const res = await client.get(req);
    const data = def.simplify ? def.simplify(res.data, apiArgs) : res.data;
    const text = formatResult(data, {
      maxChars: typeof max_chars === "number" ? max_chars : DEFAULT_MAX_CHARS,
      paginated: def.paginated,
      // Cursors come from the raw response so a simplifier cannot drop them by accident.
      cursorSource: res.data,
      // A next cursor equal to the one just used means X has nothing more.
      requestCursor: typeof apiArgs.cursor === "string" ? apiArgs.cursor : undefined,
    });
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const message =
      err instanceof TwittrApiError || err instanceof Error ? err.message : `Unexpected error: ${String(err)}`;
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

export function createServer(client: TwittrApiClient, endpoints: EndpointDef[] = ENDPOINTS): McpServer {
  const server = new McpServer(
    { name: "twittrapi-mcp", version: VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  for (const def of endpoints) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: inputShape(def),
        annotations: {
          title: def.title,
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (args: Record<string, unknown>) => runEndpoint(client, def, args),
    );
  }
  return server;
}
