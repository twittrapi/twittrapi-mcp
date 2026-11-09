import type { ToolOutcome } from "./events.js";
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
  X_SESSION_NAMES,
  scrubSession,
} from "./client.js";
import { ACTIONS, type ActionDef } from "./actions.js";
import { ENDPOINTS, type EndpointDef } from "./endpoints.js";
import { DEFAULT_MAX_CHARS, MAX_MAX_CHARS, MIN_MAX_CHARS, formatResult } from "./output.js";
import { SERVER_ICONS } from "./icons.js";
import { VERSION } from "./version.js";

/** Server instructions for the given default response format. */
export function serverInstructions(format: ResponseFormat = DEFAULT_FORMAT, withActions = false, accounts: XSession[] = []): string {
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
Account tools (create_tweet, like_tweet, follow_user, send_dm, ...) act on the user's own X account. Call a tool that posts, deletes or changes something only when the user asked for that exact action, and confirm the text before posting. They do not take a cookie or proxy: the server adds the user's X session itself.${accountsLine(accounts)}`
      : ""
  }`;
}

/** Name of a saved account for the model: @handle, else the X user ID. */
export function accountLabel(a: XSession): string {
  return a.handle ? `@${a.handle}` : a.userId ? `user ID ${a.userId}` : a.id ? `account ${a.id}` : "the saved account";
}

function accountsLine(accounts: XSession[]): string {
  if (accounts.length < 2) return "";
  const shown = accounts.slice(0, 20).map((a) => `${accountLabel(a)}${a.isDefault ? " (default)" : ""}`);
  const more = accounts.length > 20 ? `, and ${accounts.length - 20} more (list_x_accounts lists all)` : "";
  return `
The user saved ${accounts.length} X accounts: ${shown.join(", ")}${more}. Account tools use the default unless you pass account (a @handle or user ID). When the user names an account ("post from @name"), pass it; when it is unclear which account they mean, ask.`;
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
  onOutcome?: (o: ToolOutcome) => void,
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
    onOutcome?.({ ok: true });
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const message =
      err instanceof TwittrApiError || err instanceof Error ? err.message : `Unexpected error: ${String(err)}`;
    onOutcome?.({ ok: false, status: err instanceof TwittrApiError ? err.status : undefined, message });
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

/** Input shape of an account tool: its own params plus max_chars and (unless raw only) format. Never cookie or proxy. */
const accountSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .optional()
  .describe("Which saved X account acts: its @handle or numeric user ID. Leave it out for the default account.");

export function actionInputShape(
  def: ActionDef,
  defaultFormat: ResponseFormat = DEFAULT_FORMAT,
  multiAccount = false,
): Record<string, z.ZodType> {
  const account: Record<string, z.ZodType> = multiAccount ? { account: accountSchema } : {};
  if (def.rawOnly) return { ...def.params, ...account, max_chars: maxCharsSchema };
  return { ...def.params, ...account, max_chars: maxCharsSchema, format: formatSchema(defaultFormat) };
}

/**
 * The saved account an `account` argument names (@handle, handle or user ID, any case); the default
 * when it is empty. undefined when nothing matches.
 */
export function pickAccount(accounts: XSession[], wanted: unknown): XSession | undefined {
  const w = typeof wanted === "string" ? wanted.trim().replace(/^@/, "").toLowerCase() : "";
  if (!w) return accounts.find((a) => a.isDefault) ?? accounts[0];
  return accounts.find((a) => a.handle?.toLowerCase() === w) ?? accounts.find((a) => a.userId === w || (a.id !== undefined && String(a.id) === w));
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
  sessions: XSession | XSession[],
  args: Record<string, unknown>,
  onOutcome?: (o: ToolOutcome) => void,
): Promise<CallToolResult> {
  const accounts = Array.isArray(sessions) ? sessions : [sessions];
  const { account: wanted, ...rest } = args;
  const session = pickAccount(accounts, accounts.length > 1 ? wanted : undefined);
  if (!session) {
    const names = accounts.slice(0, 30).map(accountLabel).join(", ");
    const message = `No saved X account matches "${String(wanted).slice(0, 40)}". Saved accounts: ${names}.`;
    onOutcome?.({ ok: false, message });
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
  const used = session.id ? { xSessionId: session.id } : {};
  if (def.needsChatPasscode && !session.chatPasscode) {
    const message = `${accountLabel(session)} has no X Chat passcode saved, so it cannot send or manage DMs. Use another account or save the passcode in the TwittrAPI dashboard.`;
    onOutcome?.({ ok: false, message, ...used });
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
  try {
    const { max_chars, format, ...toolArgs } = rest;
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
    onOutcome?.({ ok: true, ...used });
    return { content: [{ type: "text", text: scrubSession(text, session) }] };
  } catch (err) {
    let message =
      err instanceof TwittrApiError || err instanceof Error ? err.message : `Unexpected error: ${String(err)}`;
    const status = err instanceof TwittrApiError ? err.status : undefined;
    if (status === 401 || status === 403 || status === 407) {
      const names = X_SESSION_NAMES[session.source ?? "env"];
      const renew =
        session.source === "oauth"
          ? "save a fresh cookie from x.com in the TwittrAPI dashboard under Connected apps"
          : "copy a fresh cookie from x.com";
      message +=
        status === 407
          ? ` The proxy (${names.proxy}) could not be reached.`
          : ` If the API key is valid, the X session (${names.cookie}) may be logged out or expired: the user needs to ${renew}.`;
    }
    if (accounts.length > 1) message = `${accountLabel(session)}: ${message}`;
    message = scrubSession(message, session);
    onOutcome?.({ ok: false, status, message, ...used });
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

/** Account tools to register for a session: DM sending and accepting or declining requests only with a chat passcode. */
export function actionsFor(session: XSession | XSession[] | undefined, actions: ActionDef[] = ACTIONS): ActionDef[] {
  const accounts = Array.isArray(session) ? session : session ? [session] : [];
  if (accounts.length === 0) return [];
  const anyPasscode = accounts.some((a) => Boolean(a.chatPasscode));
  return actions.filter((a) => !a.needsChatPasscode || anyPasscode);
}

/** Called after every tool call with what happened (hosted mode reports it as a usage event). */
export type ToolCallHook = (call: { tool: string; kind: "read" | "account"; write: boolean; ms: number } & ToolOutcome) => void;

export function createServer(
  client: TwittrApiClient,
  endpoints: EndpointDef[] = ENDPOINTS,
  onToolCall?: ToolCallHook,
): McpServer {
  const observe = (tool: string, kind: "read" | "account", write: boolean) => {
    if (!onToolCall) return undefined;
    const started = Date.now();
    return (o: ToolOutcome) => {
      try {
        onToolCall({ tool, kind, write, ms: Date.now() - started, ...o });
      } catch {
        // Reporting never affects the tool result
      }
    };
  };
  const session = client.config.xSession;
  const accounts = client.config.xAccounts && client.config.xAccounts.length > 1 ? client.config.xAccounts : session ? [session] : [];
  const multi = accounts.length > 1;
  const actions = actionsFor(accounts);
  const defaultFormat = client.config.format ?? DEFAULT_FORMAT;
  const server = new McpServer(
    { name: "twittrapi-mcp", title: "TwittrAPI", version: VERSION, websiteUrl: "https://twittrapi.com", icons: SERVER_ICONS },
    { instructions: serverInstructions(defaultFormat, actions.length > 0, accounts) },
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
      async (args: Record<string, unknown>) => runEndpoint(client, def, args, observe(def.name, "read", false)),
    );
  }
  // Account tools exist only when the server has an X session (TWITTRAPI_X_COOKIE + TWITTRAPI_X_PROXY).
  for (const def of actions) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: actionInputShape(def, defaultFormat, multi),
        annotations: {
          title: def.title,
          readOnlyHint: !def.write,
          destructiveHint: def.destructive,
          idempotentHint: def.idempotent,
          openWorldHint: true,
        },
      },
      async (args: Record<string, unknown>) => runAction(client, def, accounts, args, observe(def.name, "account", def.write)),
    );
  }
  if (multi) {
    server.registerTool(
      "list_x_accounts",
      {
        title: "List saved X accounts",
        description:
          "List the X accounts the user saved for account tools: @handle, user ID, which one is the default and whether DMs work. Free, no API call.",
        inputSchema: {},
        annotations: { title: "List saved X accounts", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                data: accounts.map((a) => ({
                  account: a.handle ? `@${a.handle}` : (a.userId ?? null),
                  userId: a.userId ?? null,
                  default: Boolean(a.isDefault),
                  dms: Boolean(a.chatPasscode),
                })),
              },
              null,
              2,
            ),
          },
        ],
      }),
    );
  }
  return server;
}
