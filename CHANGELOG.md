# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
