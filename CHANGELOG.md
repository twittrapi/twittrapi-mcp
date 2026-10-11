# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-10-11

### Breaking

- Tool results now use the API's simple format by default (`format=simple`, see
  https://twittrapi.com/docs/simple-format): compact camelCase JSON such as
  `{"data": [...], "nextCursor": ..., "hasNextPage": ...}` instead of X's raw GraphQL JSON, about
  60 % fewer tokens. Prompts or clients that read raw fields (`legacy.full_text`, `rest_id`,
  `core.screen_name`, ...) from tool output need `format: "raw"` or `TWITTRAPI_RESPONSE_FORMAT=raw`.

### Added

- `format` argument (`"simple"` or `"raw"`) on every tool, to choose the format per call.
- `TWITTRAPI_RESPONSE_FORMAT` environment variable (`simple` by default, or `raw`) for the server's
  default, in stdio and HTTP mode. An invalid value stops the server with an error. Listed in
  `server.json`.
- The cursor header reads `nextCursor` / `hasNextPage` from simple-format pages.
- Tests against simple-format fixtures copied from the API's normalize testdata
  (`test/fixtures/simple`), including the stdio server in both formats and HTTP mode.
- Tests against trimmed real API responses (`test/fixtures/live`): every paginated shape,
  followers (Bottom before Top), tweet detail, the search wrapper, slice `next_cursor`
  (communities, jobs) and empty likes/favorites timelines.

### Fixed

- The cursor header reports the last page (`next_cursor: none (last page, no more results)`) when
  X returns the cursor that was just sent, or a page with cursors but no results, instead of
  offering a cursor that loops.
- A Bottom cursor entry always wins over a plain `next_cursor` field, and `cursor-bottom-` entries
  whose value sits under `content.itemContent` are recognised.
- The Top cursor is no longer printed as `previous_cursor`; it is not a next-page cursor.
- `username` on user timelines is trimmed before validation, and a bare `@` is rejected instead of
  being sent as an empty handle.

## [0.1.0] - 2026-10-10

### Added

- First release.
- 23 read-only tools covering users, timelines, followers, search, tweets,
  lists, communities and trends. The tool table lives in `src/endpoints.ts`.
- Direct API auth (`TWITTRAPI_API_KEY`) and RapidAPI auth (`RAPIDAPI_KEY`).
- `max_chars` argument on every tool (default 50,000) with a clear
  truncation marker.
- Pagination cursors printed above each paginated result.
- Readable tool errors for 401, 402, 404, 422, 429 and 5xx responses.
- stdio transport (default) and stateless Streamable HTTP mode
  (`--http --port 3333`) that takes the API key from request headers.
- `server.json` for the official MCP Registry.
