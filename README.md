# twittrapi-mcp – Twitter/X MCP server for Claude, Cursor and other AI agents

[![npm](https://img.shields.io/npm/v/twittrapi-mcp.svg)](https://www.npmjs.com/package/twittrapi-mcp)

An [MCP](https://modelcontextprotocol.io) server for [TwittrAPI](https://twittrapi.com), a read-only
Twitter/X data API. It lets Claude, Cursor and other MCP clients look up profiles, tweets,
followers, search results, lists, communities and trends.

> **Get an API key:** [twittrapi.com/start](https://twittrapi.com/start?utm_source=github&utm_medium=readme&utm_campaign=twittrapi-mcp) · [Pricing](https://twittrapi.com/pricing?utm_source=github&utm_medium=readme&utm_campaign=twittrapi-mcp) · [Docs](https://twittrapi.com/docs?utm_source=github&utm_medium=readme&utm_campaign=twittrapi-mcp) · also available on [RapidAPI](https://rapidapi.com/viperscores-viperscores-default/api/twitter-aio)

Not affiliated with X Corp.

## What you need

- Node.js 20 or newer
- A TwittrAPI key, or a RapidAPI key subscribed to the Twitter AIO API

Every tool call is one billed API call on your account.

## Install

### Claude Code

```sh
claude mcp add twittrapi --env TWITTRAPI_API_KEY=your-key -- npx -y twittrapi-mcp
```

### Claude Desktop

Open Settings > Developer > Edit Config and add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "twittrapi": {
      "command": "npx",
      "args": ["-y", "twittrapi-mcp"],
      "env": {
        "TWITTRAPI_API_KEY": "your-key"
      }
    }
  }
}
```

Restart Claude Desktop afterwards.

### Cursor

Add this to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "twittrapi": {
      "command": "npx",
      "args": ["-y", "twittrapi-mcp"],
      "env": {
        "TWITTRAPI_API_KEY": "your-key"
      }
    }
  }
}
```

### Other clients

Any client that can start a stdio server works. The command is `npx -y twittrapi-mcp`.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `TWITTRAPI_API_KEY` | one of the two keys | Your TwittrAPI key. Sent as the `X-API-KEY` header. |
| `RAPIDAPI_KEY` | one of the two keys | RapidAPI key. Used only when `TWITTRAPI_API_KEY` is not set. |
| `TWITTRAPI_BASE_URL` | no | API base URL for the direct API. Default `https://api.twittrapi.com`. |

If neither key is set, the server still starts and lists its tools, but every call returns an
error explaining how to set a key.

## Using RapidAPI instead

If you bought access through RapidAPI, set `RAPIDAPI_KEY` instead of `TWITTRAPI_API_KEY`:

```json
"env": { "RAPIDAPI_KEY": "your-rapidapi-key" }
```

Requests then go to `https://twitter-aio.p.rapidapi.com` with the `x-rapidapi-key` and
`x-rapidapi-host` headers. The tools and their output are the same.

## Tools

All tools are read-only.

| Tool | What it does |
| --- | --- |
| `get_user_by_username` | Profile by handle, including the numeric user ID |
| `get_user_by_id` | Profile by numeric user ID |
| `username_to_id` | Resolve a handle to its user ID |
| `users_by_ids` | Profiles for up to 100 user IDs at once |
| `get_user_tweets` | A user's tweets |
| `get_user_tweets_and_replies` | A user's tweets and replies |
| `get_user_media` | A user's tweets with photos or videos |
| `get_followers` | A user's followers |
| `get_following` | Accounts a user follows |
| `get_verified_followers` | A user's verified followers |
| `search_tweets` | Search with X operators; Top, Latest, People, Photos or Videos |
| `get_tweet` | A tweet and its reply thread |
| `get_tweet_retweets` | Users who retweeted a tweet |
| `get_tweet_favorites` | Users who liked a tweet |
| `get_tweet_quotes` | Tweets quoting a tweet |
| `get_list_details` | List name, owner and counts |
| `get_list_tweets` | Tweets from a list's members |
| `get_list_members` | Members of a list |
| `get_community` | Community details |
| `get_community_tweets` | Tweets in a community |
| `search_communities` | Find communities by keyword |
| `get_trends` | Trending topics for a location (WOEID) |
| `get_trend_locations` | Locations that have trends, with their WOEIDs |

The user timeline tools (`get_user_tweets`, `get_followers` and so on) accept either `userId` or
`username`.

### Output size and pagination

Responses are X's raw GraphQL JSON and can be several hundred KB. Every tool takes an optional
`max_chars` argument (default 50,000, range 1,000 to 1,000,000). Longer output is cut and ends
with a `[TRUNCATED ...]` marker.

Paginated tools print the cursor above the JSON, so truncation never removes it:

```
next_cursor: DAABCgABGZ...
Pass next_cursor as `cursor` to get the next page.

{"data":{...}}
```

On the last page the header reads `next_cursor: none (last page, no more results)`. That happens
when the response has no next cursor (empty likes or likers timelines included), when X returns
the cursor you just sent, or when a page holds only cursors and no results.

### Errors

API errors come back as tool errors with a short explanation, for example:

- 402: the account has no balance left
- 429: rate limit hit, wait before retrying
- 404: the user or tweet does not exist, is private or is suspended
- 5xx: temporary upstream problem

## HTTP mode (remote hosting)

```sh
npx -y twittrapi-mcp --http --port 3333 --host 0.0.0.0
```

This serves a stateless [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http)
endpoint at `/mcp` and a health check at `/health`. The default host is `127.0.0.1`.

In HTTP mode the server does not use a key from its own environment. Each request must carry the
caller's key in one of these headers:

- `X-API-KEY: <key>` or `Authorization: Bearer <key>` for the direct API
- `x-rapidapi-key: <key>` for RapidAPI

`TWITTRAPI_BASE_URL` is still read from the environment. Put the server behind HTTPS if it is
reachable from the internet.

Example client config for a hosted instance (Claude Code):

```sh
claude mcp add --transport http twittrapi https://your-host.example.com/mcp --header "X-API-KEY: your-key"
```

## Development

```sh
npm install
npm run build
npm test
```

`npm test` builds first, then runs unit tests and a protocol test that starts the server over
stdio and HTTP against a local mock API.

To add or change a tool, edit `src/endpoints.ts`. Each entry has a name, description, API path and
zod parameter schemas. An entry can also set a `simplify` function to return a smaller shape than
the raw GraphQL JSON; none do yet.

Try the server interactively with the MCP Inspector:

```sh
npx @modelcontextprotocol/inspector -e TWITTRAPI_API_KEY=your-key node dist/index.js
```

## Support

Questions, bugs or a higher rate limit: email support@twittrapi.com or open an issue in this repository. Service status: [twittrapi.com/status](https://twittrapi.com/status). News and changes: the TwittrAPI Telegram channel (link on the website).

## License

MIT
