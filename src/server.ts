import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  DEFAULT_FORMAT,
  RESPONSE_FORMATS,
  TwittrApiClient,
  TwittrApiError,
  type ApiRequest,
  type QueryValue,
  type ResponseFormat,
  type XSession,
  scrubSession,
} from "./client.js";
import { ACTIONS, type ActionDef } from "./actions.js";
import { ENDPOINTS, type EndpointDef } from "./endpoints.js";
import { DEFAULT_MAX_CHARS, MAX_MAX_CHARS, MIN_MAX_CHARS, formatResult } from "./output.js";
import { SERVER_ICONS } from "./icons.js";
import { VERSION } from "./version.js";

/** Server instructions for the given default response format. */
export function serverInstructions(format: ResponseFormat = DEFAULT_FORMAT, withActions = false): string {
  const formatLine =
    format === "simple"
      ? `Responses use the compact simple format by default: {"data": ...} with flat camelCase tweets and users (id, text, createdAt, author, counts, media, ...). Pass format "raw" to a tool only if you need fields it leaves out (cards, polls, edit history, community notes).`
      : `Responses are X's raw GraphQL JSON by default and can be large. Pass format "simple" to a tool for compact, flat JSON with far fewer tokens.`;
  return `Tools for reading public X (Twitter) data through TwittrAPI.
${formatLine}
Output is cut at max_chars (default ${DEFAULT_MAX_CHARS}).
Most user tools accept userId or username; resolve a handle once with username_to_id and reuse the ID.
Paginated tools print next_cursor at the top of the result; pass it back as cursor for the next page.
Tools without a format argument always return raw JSON.
A 402 error means the account has no balance: stop and tell the user. Every call is billed.${
    withActions
      ? `
Account tools (create_tweet, like_tweet, follow_user, send_dm, ...) act on the user's own X account. Call a tool that posts, deletes or changes something only when the user asked for that exact action, and confirm the text before posting. They do not take a cookie or proxy: the server adds the user's X session itself.`
      : ""
  }`;
}

export const SERVER_INSTRUCTIONS = serverInstructions(DEFAULT_FORMAT);

const maxCharsSchema = z
  .number()
  .int()
  .min(MIN_MAX_CHARS)
  .max(MAX_MAX_CHARS)
  .optional()
  .describe(
    `Maximum characters of JSON to return (default ${DEFAULT_MAX_CHARS}). Longer output is cut with a [TRUNCATED] marker. Lower it to save context, raise it if you need the full response.`,
  );

function formatSchema(defaultFormat: ResponseFormat) {
  return z
    .enum(RESPONSE_FORMATS as [ResponseFormat, ...ResponseFormat[]])
    .optional()
    .describe(
      `Response format (default ${defaultFormat}). simple: compact JSON with flat camelCase tweets and users, about 60% fewer tokens. raw: X's full GraphQL JSON, only needed for fields simple leaves out (cards, polls, edit history, community notes).`,
    );
}

/** Builds the zod input shape for a tool: its endpoint params plus max_chars and (unless raw only) format. */
export function inputShape(def: EndpointDef, defaultFormat: ResponseFormat = DEFAULT_FORMAT): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, p] of Object.entries(def.params)) shape[name] = p.schema;
  shape.max_chars = maxCharsSchema;
  if (!def.rawOnly) shape.format = formatSchema(defaultFormat);
  return shape;
}

/** The format to request: raw-only tools are always raw, otherwise the argument or the server default. */
function pickFormat(client: TwittrApiClient, rawOnly: boolean | undefined, format: unknown): ResponseFormat {
  if (rawOnly) return "raw";
  return format === "raw" || format === "simple" ? format : (client.config.format ?? DEFAULT_FORMAT);
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
    const { max_chars, format, ...apiArgs } = args;
    const fmt = pickFormat(client, def.rawOnly, format);
    const req = buildRequest(def, apiArgs);
    if (fmt === "simple") req.query = { ...req.query, format: "simple" };
    const res = await client.get(req);
    const data = def.simplify ? def.simplify(res.data, apiArgs) : res.data;
    const text = formatResult(data, {
      maxChars: typeof max_chars === "number" ? max_chars : DEFAULT_MAX_CHARS,
      paginated: def.paginated,
      // Cursors come from the API response (raw timeline or simple envelope), so a simplifier
      // cannot drop them by accident.
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

/** Input shape of an account tool: its own params plus max_chars and (unless raw only) format. Never cookie or proxy. */
export function actionInputShape(def: ActionDef, defaultFormat: ResponseFormat = DEFAULT_FORMAT): Record<string, z.ZodType> {
  if (def.rawOnly) return { ...def.params, max_chars: maxCharsSchema };
  return { ...def.params, max_chars: maxCharsSchema, format: formatSchema(defaultFormat) };
}

/**
 * The /client endpoints answer {status_code, response: "<X body as a string>"} in the raw format.
 * Parses the inner string so the model gets JSON instead of an escaped string.
 */
function unwrapClientResponse(data: unknown): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const o = data as Record<string, unknown>;
  if (typeof o.response !== "string" || !("status_code" in o)) return data;
  try {
    return { ...o, response: JSON.parse(o.response) };
  } catch {
    return data;
  }
}

/** Runs an account tool: the X session from the server config goes into the body, never into output. */
export async function runAction(
  client: TwittrApiClient,
  def: ActionDef,
  session: XSession,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    const { max_chars, format, ...toolArgs } = args;
    const fmt = pickFormat(client, def.rawOnly, format);
    const body: Record<string, unknown> = { ...def.body(toolArgs), cookie: session.cookie, proxy: session.proxy };
    if (def.path.startsWith("/client/dm/") && session.chatPasscode) body.passcode = session.chatPasscode;
    const req: ApiRequest = { path: def.path, query: fmt === "simple" ? { format: "simple" } : {} };
    const res = await client.post(req, body);
    const text = formatResult(fmt === "raw" ? unwrapClientResponse(res.data) : res.data, {
      maxChars: typeof max_chars === "number" ? max_chars : DEFAULT_MAX_CHARS,
      paginated: def.paginated ?? false,
      requestCursor: typeof toolArgs.cursor === "string" ? toolArgs.cursor : undefined,
    });
    return { content: [{ type: "text", text: scrubSession(text, session) }] };
  } catch (err) {
    let message =
      err instanceof TwittrApiError || err instanceof Error ? err.message : `Unexpected error: ${String(err)}`;
    const status = err instanceof TwittrApiError ? err.status : undefined;
    if (status === 401 || status === 403 || status === 407) {
      message +=
        status === 407
          ? " The proxy in TWITTRAPI_X_PROXY could not be reached."
          : " If the API key is valid, the X session in TWITTRAPI_X_COOKIE may be logged out or expired: the user needs to copy a fresh cookie from x.com.";
    }
    return { content: [{ type: "text", text: `Error: ${scrubSession(message, session)}` }], isError: true };
  }
}

/** Account tools to register for a session: DM sending only with a chat passcode. */
export function actionsFor(session: XSession | undefined, actions: ActionDef[] = ACTIONS): ActionDef[] {
  if (!session) return [];
  return actions.filter((a) => !a.needsChatPasscode || Boolean(session.chatPasscode));
}

export function createServer(client: TwittrApiClient, endpoints: EndpointDef[] = ENDPOINTS): McpServer {
  const session = client.config.xSession;
  const actions = actionsFor(session);
  const defaultFormat = client.config.format ?? DEFAULT_FORMAT;
  const server = new McpServer(
    { name: "twittrapi-mcp", title: "TwittrAPI", version: VERSION, websiteUrl: "https://twittrapi.com", icons: SERVER_ICONS },
    { instructions: serverInstructions(defaultFormat, actions.length > 0) },
  );
  for (const def of endpoints) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: inputShape(def, client.config.format ?? DEFAULT_FORMAT),
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
  // Account tools exist only when the server has an X session (TWITTRAPI_X_COOKIE + TWITTRAPI_X_PROXY).
  for (const def of actions) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: actionInputShape(def, defaultFormat),
        annotations: {
          title: def.title,
          readOnlyHint: !def.write,
          destructiveHint: def.destructive,
          idempotentHint: def.idempotent,
          openWorldHint: true,
        },
      },
      async (args: Record<string, unknown>) => runAction(client, def, session!, args),
    );
  }
  return server;
}
