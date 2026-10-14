/**
 * The single source of truth for which tools exist and which TwittrAPI endpoint each one calls.
 * Add, remove or change tools here; server.ts registers whatever is in ENDPOINTS.
 *
 * Every endpoint is a GET. By default the server asks the API for the simple format
 * (format=simple, compact JSON); the `format` tool argument or TWITTRAPI_RESPONSE_FORMAT=raw gives
 * X's raw GraphQL JSON instead. A tool can also set a `simplify` function (see Simplifier) to reshape
 * the parsed JSON further; cursor extraction runs on the API response before simplify.
 */
import { z } from "zod";
import type { QueryValue } from "./client.js";

export type Simplifier = (data: unknown, args: Record<string, unknown>) => unknown;

export interface ParamDef {
  /** "path" fills {name} in the path, "query" becomes ?name=value. */
  in: "path" | "query";
  schema: z.ZodType;
  /** API parameter name if it differs from the tool argument name. */
  apiName?: string;
  /** Converts the argument to the string sent to the API (default: String(value)). */
  serialize?: (value: unknown) => QueryValue;
}

export interface EndpointDef {
  /** Tool name (snake_case). */
  name: string;
  title: string;
  description: string;
  /** API path with {placeholders} for path params. */
  path: string;
  params: Record<string, ParamDef>;
  /** True when the response is a page of results with cursors. */
  paginated: boolean;
  /** Optional hook to adjust arguments before the request (e.g. defaults that depend on each other). */
  prepare?: (args: Record<string, unknown>) => Record<string, unknown>;
  /** Optional response simplifier. Not set for any tool yet. */
  simplify?: Simplifier;
}

// ---------------------------------------------------------------------------
// Shared parameter definitions
// ---------------------------------------------------------------------------

const numericId = (what: string) =>
  z
    .string()
    .regex(/^\d{1,30}$/, `${what} must be a numeric ID (digits only)`);

const usernameSchema = z
  .string()
  .trim()
  .min(1)
  .max(16)
  .describe("X handle without the URL, e.g. \"elonmusk\" (a leading @ is fine).");

const count = (what: string): ParamDef => ({
  in: "query",
  schema: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(`How many ${what} to request per page (default 20). X may return slightly more or fewer.`),
});

const cursor: ParamDef = {
  in: "query",
  schema: z
    .string()
    .optional()
    .describe("Pagination cursor. Leave empty for the first page; pass the next_cursor from a previous result to get the next page."),
};

const rankingMode: ParamDef = {
  in: "query",
  schema: z
    .enum(["Relevance", "Recency", "Likes"])
    .optional()
    .describe("Sort order. Default Relevance."),
};

/** userId path param that can be replaced by a username (the API resolves it when userId is -1). */
const userTarget: Record<string, ParamDef> = {
  userId: {
    in: "path",
    schema: numericId("userId")
      .optional()
      .describe("Numeric X user ID (rest_id). Provide this or username. Using the ID is faster."),
  },
  username: {
    in: "query",
    schema: usernameSchema.optional().describe("X handle, used when you do not have the user ID. Provide this or userId."),
  },
};

function requireUserTarget(args: Record<string, unknown>): Record<string, unknown> {
  if (args.userId) {
    const { username: _ignored, ...rest } = args;
    return rest;
  }
  const username = typeof args.username === "string" ? args.username.trim().replace(/^@/, "").trim() : "";
  if (username) {
    return { ...args, userId: "-1", username };
  }
  throw new Error("Provide either userId or username.");
}

function stripAt(args: Record<string, unknown>): Record<string, unknown> {
  return typeof args.username === "string" ? { ...args, username: args.username.trim().replace(/^@/, "") } : args;
}

function userTimeline(
  name: string,
  title: string,
  pathSuffix: string,
  description: string,
  what: string,
): EndpointDef {
  return {
    name,
    title,
    description,
    path: `/user/{userId}/${pathSuffix}`,
    params: { ...userTarget, count: count(what), cursor },
    paginated: true,
    prepare: requireUserTarget,
  };
}

// ---------------------------------------------------------------------------
// Endpoint table
// ---------------------------------------------------------------------------

export const ENDPOINTS: EndpointDef[] = [
  // Users -------------------------------------------------------------------
  {
    name: "get_user_by_username",
    title: "Get user by username",
    description:
      "Get an X (Twitter) user's profile by handle: name, bio, follower/following counts, verification, created date, and the numeric user ID (rest_id) needed by other tools.",
    path: "/user/by/username/{username}",
    params: { username: { in: "path", schema: usernameSchema } },
    paginated: false,
    prepare: stripAt,
  },
  {
    name: "get_user_by_id",
    title: "Get user by ID",
    description: "Get an X user's profile by numeric user ID (rest_id). Same data as get_user_by_username.",
    path: "/user/{userId}",
    params: { userId: { in: "path", schema: numericId("userId").describe("Numeric X user ID (rest_id).") } },
    paginated: false,
  },
  {
    name: "username_to_id",
    title: "Username to user ID",
    description:
      "Resolve an X handle to its numeric user ID. Cheaper and smaller than get_user_by_username when you only need the ID.",
    path: "/username/to/id/{username}",
    params: { username: { in: "path", schema: usernameSchema } },
    paginated: false,
    prepare: stripAt,
  },
  {
    name: "users_by_ids",
    title: "Get users by IDs",
    description: "Get profiles for up to 500 X users in one call, by numeric user ID.",
    path: "/user/users/by/ids",
    params: {
      ids: {
        in: "query",
        schema: z
          .array(numericId("Each id"))
          .min(1)
          .max(500)
          .describe("Numeric X user IDs, 1 to 500."),
        serialize: (v) => (v as string[]).join(","),
      },
    },
    paginated: false,
  },
  userTimeline(
    "get_user_tweets",
    "Get user tweets",
    "tweets",
    "Get a user's recent tweets (their profile timeline, without replies), newest first, including retweets and pinned tweet. Paginated.",
    "tweets",
  ),
  userTimeline(
    "get_user_tweets_and_replies",
    "Get user tweets and replies",
    "tweetsAndReplies",
    "Get a user's tweets including their replies to others, newest first. Paginated.",
    "tweets",
  ),
  userTimeline(
    "get_user_media",
    "Get user media",
    "media",
    "Get a user's tweets that contain photos or videos. Paginated.",
    "tweets",
  ),
  userTimeline(
    "get_followers",
    "Get followers",
    "followers",
    "Get accounts that follow a user, newest followers first. Paginated.",
    "users",
  ),
  userTimeline(
    "get_following",
    "Get following",
    "followings",
    "Get accounts a user follows. Paginated.",
    "users",
  ),
  userTimeline(
    "get_verified_followers",
    "Get verified followers",
    "verifiedFollowers",
    "Get a user's followers that have a verified (blue check) badge. Paginated.",
    "users",
  ),

  // Search ------------------------------------------------------------------
  {
    name: "search_tweets",
    title: "Search tweets",
    description:
      "Search X like the search box. Supports X search operators in the query, e.g. from:user, to:user, \"exact phrase\", lang:en, since:2025-01-01, until:2025-02-01, min_faves:100, filter:media, -filter:replies. category Latest gives newest first; People returns accounts instead of tweets. Paginated.",
    path: "/search",
    params: {
      searchItem: {
        in: "query",
        schema: z.string().min(1).max(512).describe("Search query, max 512 characters. May contain X search operators."),
      },
      category: {
        in: "query",
        schema: z
          .enum(["Top", "Latest", "People", "Photos", "Videos"])
          .optional()
          .describe("Result tab: Top (default), Latest, People, Photos or Videos."),
      },
      count: count("results"),
      cursor,
    },
    paginated: true,
  },

  // Tweets ------------------------------------------------------------------
  {
    name: "get_tweet",
    title: "Get tweet",
    description:
      "Get a tweet by ID with full text, author, media, engagement counts and the reply thread (conversation). Use cursor to load more replies.",
    path: "/tweet/{tweetId}",
    params: {
      tweetId: { in: "path", schema: numericId("tweetId").describe("Numeric tweet ID, the number at the end of a tweet URL.") },
      rankingMode,
      cursor,
    },
    paginated: true,
  },
  {
    name: "get_tweet_retweets",
    title: "Get tweet retweeters",
    description: "Get the users who retweeted a tweet. Paginated.",
    path: "/tweet/{tweetId}/retweets",
    params: {
      tweetId: { in: "path", schema: numericId("tweetId").describe("Numeric tweet ID.") },
      count: count("users"),
      cursor,
    },
    paginated: true,
  },
  {
    name: "get_tweet_favorites",
    title: "Get tweet likers",
    description:
      "Get the users who liked a tweet. X only exposes likers to the tweet's author for many tweets, so results can be empty. Paginated.",
    path: "/tweet/{tweetId}/favorites",
    params: {
      tweetId: { in: "path", schema: numericId("tweetId").describe("Numeric tweet ID.") },
      count: count("users"),
      cursor,
    },
    paginated: true,
  },
  {
    name: "get_tweet_quotes",
    title: "Get tweet quotes",
    description: "Get tweets that quote a given tweet. Paginated.",
    path: "/tweet/{tweetId}/quotes",
    params: {
      tweetId: { in: "path", schema: numericId("tweetId").describe("Numeric tweet ID.") },
      count: count("tweets"),
      cursor,
    },
    paginated: true,
  },

  // Lists -------------------------------------------------------------------
  {
    name: "get_list_details",
    title: "Get list details",
    description: "Get an X list's name, description, owner, and member/follower counts.",
    path: "/lists/details",
    params: { listId: { in: "query", schema: numericId("listId").describe("Numeric list ID, from the list URL.") } },
    paginated: false,
  },
  {
    name: "get_list_tweets",
    title: "Get list tweets",
    description: "Get the tweet timeline of an X list (tweets from its members), newest first. Paginated.",
    path: "/lists/tweets",
    params: {
      listId: { in: "query", schema: numericId("listId").describe("Numeric list ID.") },
      count: count("tweets"),
      cursor,
    },
    paginated: true,
  },
  {
    name: "get_list_members",
    title: "Get list members",
    description: "Get the accounts that are members of an X list. Paginated.",
    path: "/lists/members",
    params: {
      listId: { in: "query", schema: numericId("listId").describe("Numeric list ID.") },
      count: count("users"),
      cursor,
    },
    paginated: true,
  },

  // Communities -------------------------------------------------------------
  {
    name: "get_community",
    title: "Get community",
    description: "Get an X Community's name, description, rules, member count and admins.",
    path: "/communities/{communityId}",
    params: { communityId: { in: "path", schema: numericId("communityId").describe("Numeric community ID.") } },
    paginated: false,
  },
  {
    name: "get_community_tweets",
    title: "Get community tweets",
    description: "Get tweets posted in an X Community. Paginated.",
    path: "/communities/{communityId}/tweets",
    params: {
      communityId: { in: "path", schema: numericId("communityId").describe("Numeric community ID.") },
      count: count("tweets"),
      cursor,
    },
    paginated: true,
  },
  {
    name: "search_communities",
    title: "Search communities",
    description: "Search X Communities by keyword. Returns community IDs for get_community and get_community_tweets. Paginated.",
    path: "/communities/search/{searchTerm}",
    params: {
      searchTerm: { in: "path", schema: z.string().min(1).max(200).describe("Keyword to search for.") },
      count: count("communities"),
      cursor,
    },
    paginated: true,
  },

  // Trends ------------------------------------------------------------------
  {
    name: "get_trends",
    title: "Get trends",
    description:
      "Get trending topics for a location by WOEID (1 = worldwide, 23424977 = United States, 23424975 = United Kingdom). Use get_trend_locations to look up other WOEIDs.",
    path: "/trends/{locationId}",
    params: {
      locationId: {
        in: "path",
        schema: z
          .string()
          .regex(/^\d{1,12}$/, "locationId must be a numeric WOEID")
          .describe("Yahoo WOEID of the location, e.g. \"1\" for worldwide."),
      },
    },
    paginated: false,
  },
  {
    name: "get_trend_locations",
    title: "Get trend locations",
    description: "List the locations (countries and cities) that have trends, with their WOEIDs for get_trends.",
    path: "/misc/locations",
    params: {},
    paginated: false,
  },
];

export function getEndpoint(name: string): EndpointDef | undefined {
  return ENDPOINTS.find((e) => e.name === name);
}
