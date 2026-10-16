/**
 * Account-action tools: they act on the user's own X account through the TwittrAPI /client
 * endpoints (POST with a JSON body). The X session (cookie and proxy) is never a tool argument: the
 * server adds it to every body from its configuration (TWITTRAPI_X_COOKIE, TWITTRAPI_X_PROXY), and
 * server.ts registers these tools only when both are set. See https://twittrapi.com/docs/x-session.
 */
import { z } from "zod";

export interface ActionDef {
  /** Tool name (snake_case). */
  name: string;
  title: string;
  description: string;
  /** API path, e.g. /client/like. */
  path: string;
  /** Tool arguments (zod schemas), shown to the model. Never cookie or proxy. */
  params: Record<string, z.ZodType>;
  /** Builds the API body fields from validated arguments. Cookie and proxy are added by the server. */
  body: (args: Record<string, unknown>) => Record<string, unknown>;
  /** False only for the actions that read (DM inbox, drafts). */
  write: boolean;
  /** Removes or undoes something (delete, unlike, unfollow, ...). */
  destructive: boolean;
  /** Repeating the call with the same arguments has no further effect. */
  idempotent: boolean;
  /** Needs the X Chat passcode (TWITTRAPI_X_CHAT_PASSCODE); registered only when it is set. */
  needsChatPasscode?: boolean;
}

// ---------------------------------------------------------------------------
// Shared parameters
// ---------------------------------------------------------------------------

const numericId = (what: string) => z.string().regex(/^\d{1,30}$/, `${what} must be a numeric ID (digits only)`);

const tweetId = (what: string) => numericId("tweetId").describe(`Numeric ID of the tweet to ${what}.`);

const userTarget = {
  userId: numericId("userId").optional().describe("Numeric X user ID. Provide this or username."),
  username: z
    .string()
    .trim()
    .min(1)
    .max(16)
    .optional()
    .describe("X handle, e.g. \"jack\" (a leading @ is fine). Used when userId is not set."),
};

/** user_id (preferred) or username for the API; throws when neither is set. */
function userBody(args: Record<string, unknown>): Record<string, unknown> {
  if (typeof args.userId === "string" && args.userId) return { user_id: args.userId };
  const username = typeof args.username === "string" ? args.username.trim().replace(/^@/, "").trim() : "";
  if (username) return { username };
  throw new Error("Provide either userId or username.");
}

const tweetText = z
  .string()
  .min(1)
  .max(25_000)
  .refine((s) => s.trim().length > 0, "text must not be empty")
  .describe("Tweet text. Over 280 characters it is posted as a long post (needs X Premium).");

const quoteUrl = z
  .string()
  .url()
  .regex(/^https:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+/, "quoteUrl must be a tweet URL like https://x.com/user/status/123")
  .optional()
  .describe("URL of a tweet to quote, e.g. https://x.com/jack/status/20.");

const tweetAction = (
  name: string,
  title: string,
  path: string,
  description: string,
  what: string,
  flags: { destructive: boolean },
): ActionDef => ({
  name,
  title,
  description,
  path,
  params: { tweetId: tweetId(what) },
  body: (a) => ({ tweet_id: a.tweetId }),
  write: true,
  destructive: flags.destructive,
  idempotent: true,
});

const userAction = (name: string, title: string, path: string, description: string, destructive: boolean): ActionDef => ({
  name,
  title,
  description,
  path,
  params: { ...userTarget },
  body: userBody,
  write: true,
  destructive,
  idempotent: true,
});

const listMember = (name: string, title: string, path: string, description: string, destructive: boolean): ActionDef => ({
  name,
  title,
  description,
  path,
  params: { listId: numericId("listId").describe("Numeric ID of your list."), ...userTarget },
  body: (a) => ({ list_id: a.listId, ...userBody(a) }),
  write: true,
  destructive,
  idempotent: true,
});

const dmTarget = {
  conversationId: z
    .string()
    .regex(/^[A-Za-z0-9:_-]{1,128}$/, "conversationId has the wrong format")
    .optional()
    .describe("Conversation ID from list_dm_conversations. Provide this or userId."),
  userId: numericId("userId").optional().describe("Numeric ID of the other person, for a one-to-one chat."),
};

// ---------------------------------------------------------------------------
// Action table
// ---------------------------------------------------------------------------

export const ACTIONS: ActionDef[] = [
  // Tweets ------------------------------------------------------------------
  {
    name: "create_tweet",
    title: "Post a tweet",
    description:
      "Post a tweet from the user's X account. Optional: quote another tweet (quoteUrl), add a poll (pollChoices), limit who can reply. Only call this when the user asked to post this exact text.",
    path: "/client/create",
    params: {
      text: tweetText,
      quoteUrl,
      pollChoices: z
        .array(z.string().trim().min(1).max(25))
        .min(2)
        .max(4)
        .optional()
        .describe("2 to 4 poll choices, up to 25 characters each. A poll tweet has at most 280 characters and no quote."),
      pollDurationMinutes: z
        .number()
        .int()
        .min(5)
        .max(10_080)
        .optional()
        .describe("How long the poll runs, 5 to 10080 minutes (7 days). Default 1440 (1 day)."),
      whoCanReply: z
        .enum(["only_follows", "only_verified", "only_mentioned"])
        .optional()
        .describe("Limit replies: accounts the user follows, verified accounts, or accounts mentioned in the tweet. Default: everyone."),
    },
    body: (a) => {
      if (a.pollDurationMinutes !== undefined && !a.pollChoices) {
        throw new Error("pollDurationMinutes needs pollChoices.");
      }
      if (a.pollChoices && a.quoteUrl) throw new Error("A poll tweet cannot quote another tweet.");
      const body: Record<string, unknown> = { text: a.text };
      if (a.quoteUrl) body.quote_url = a.quoteUrl;
      if (a.whoCanReply) body.conversation_control_mode = a.whoCanReply;
      if (a.pollChoices) {
        body.poll = {
          choices: a.pollChoices,
          ...(a.pollDurationMinutes !== undefined ? { duration_minutes: a.pollDurationMinutes } : {}),
        };
      }
      return body;
    },
    write: true,
    destructive: false,
    idempotent: false,
  },
  {
    name: "reply_to_tweet",
    title: "Reply to a tweet",
    description: "Reply to a tweet from the user's X account. Only call this when the user asked to post this reply.",
    path: "/client/reply",
    params: {
      tweetId: tweetId("reply to"),
      text: z
        .string()
        .min(1)
        .max(25_000)
        .refine((s) => s.trim().length > 0, "text must not be empty")
        .describe("Reply text."),
      quoteUrl,
    },
    body: (a) => ({ id: a.tweetId, text: a.text, ...(a.quoteUrl ? { attachment_url: a.quoteUrl } : {}) }),
    write: true,
    destructive: false,
    idempotent: false,
  },
  tweetAction("delete_tweet", "Delete a tweet", "/client/deleteTweet", "Delete one of the user's own tweets. This cannot be undone.", "delete", {
    destructive: true,
  }),
  tweetAction("like_tweet", "Like a tweet", "/client/like", "Like a tweet from the user's X account.", "like", { destructive: false }),
  tweetAction("unlike_tweet", "Unlike a tweet", "/client/unlike", "Remove the user's like from a tweet.", "unlike", { destructive: true }),
  tweetAction("retweet", "Retweet", "/client/retweet", "Retweet a tweet from the user's X account.", "retweet", { destructive: false }),
  tweetAction("unretweet", "Undo a retweet", "/client/unretweet", "Undo the user's retweet of a tweet.", "unretweet (the original tweet's ID)", {
    destructive: true,
  }),
  tweetAction("bookmark_tweet", "Bookmark a tweet", "/client/bookmark", "Add a tweet to the user's bookmarks.", "bookmark", {
    destructive: false,
  }),
  tweetAction("unbookmark_tweet", "Remove a bookmark", "/client/unbookmark", "Remove a tweet from the user's bookmarks.", "remove from the bookmarks", {
    destructive: true,
  }),

  // Users -------------------------------------------------------------------
  userAction("follow_user", "Follow a user", "/client/follow", "Follow an account from the user's X account. Takes userId or username.", false),
  userAction("unfollow_user", "Unfollow a user", "/client/unfollow", "Unfollow an account. Takes userId or username.", true),

  // Direct messages -----------------------------------------------------------
  {
    name: "list_dm_conversations",
    title: "List DM conversations",
    description:
      "The user's direct message inbox: conversations with participants and settings. With an X Chat passcode configured on the server, each conversation also carries its latest messages.",
    path: "/client/dm/inbox",
    params: {
      count: z.number().int().min(1).max(50).optional().describe("Conversations to return, 1 to 50 (default 20)."),
    },
    body: (a) => (a.count !== undefined ? { count: a.count } : {}),
    write: false,
    destructive: false,
    idempotent: true,
  },
  {
    name: "send_dm",
    title: "Send a direct message",
    description:
      "Send an encrypted text direct message from the user's X account, to a conversation or to a user. Text only. Only call this when the user asked to send this message.",
    path: "/client/dm/send",
    params: {
      ...dmTarget,
      text: z
        .string()
        .min(1)
        .max(10_000)
        .refine((s) => s.trim().length > 0, "text must not be empty")
        .describe("Message text, up to 10,000 characters."),
    },
    body: (a) => {
      if (!a.conversationId && !a.userId) throw new Error("Provide either conversationId or userId.");
      return {
        ...(a.conversationId ? { conversation_id: a.conversationId } : { user_id: a.userId }),
        text: a.text,
      };
    },
    write: true,
    destructive: false,
    idempotent: false,
    needsChatPasscode: true,
  },

  // Lists -------------------------------------------------------------------
  {
    name: "create_list",
    title: "Create a list",
    description: "Create an X list owned by the user. Returns the new list with its ID.",
    path: "/client/lists/create",
    params: {
      name: z
        .string()
        .min(1)
        .max(25)
        .refine((s) => s.trim().length > 0, "name must not be empty")
        .describe("List name, up to 25 characters."),
      description: z.string().max(100).optional().describe("List description, up to 100 characters."),
      private: z.boolean().optional().describe("Make the list private (default false: public)."),
    },
    body: (a) => ({
      name: a.name,
      ...(a.description !== undefined ? { description: a.description } : {}),
      ...(a.private !== undefined ? { private: a.private } : {}),
    }),
    write: true,
    destructive: false,
    idempotent: false,
  },
  listMember("add_list_member", "Add a list member", "/client/lists/members/add", "Add an account to one of the user's lists. Takes userId or username.", false),
  listMember(
    "remove_list_member",
    "Remove a list member",
    "/client/lists/members/remove",
    "Remove an account from one of the user's lists. Takes userId or username.",
    true,
  ),

  // Drafts ------------------------------------------------------------------
  {
    name: "create_draft",
    title: "Save a draft",
    description: "Save a tweet as a draft in the user's X account (not posted). The user can post it later from x.com.",
    path: "/client/drafts/create",
    params: {
      text: z
        .string()
        .min(1)
        .max(25_000)
        .refine((s) => s.trim().length > 0, "text must not be empty")
        .describe("Draft text."),
    },
    body: (a) => ({ text: a.text }),
    write: true,
    destructive: false,
    idempotent: false,
  },
  {
    name: "list_drafts",
    title: "List drafts",
    description: "The user's saved tweet drafts, newest first.",
    path: "/client/drafts",
    params: {
      ascending: z.boolean().optional().describe("Oldest first instead (default false)."),
    },
    body: (a) => (a.ascending !== undefined ? { ascending: a.ascending } : {}),
    write: false,
    destructive: false,
    idempotent: true,
  },
];

export function getAction(name: string): ActionDef | undefined {
  return ACTIONS.find((a) => a.name === name);
}
