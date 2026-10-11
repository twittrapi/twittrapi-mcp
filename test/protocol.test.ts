import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENDPOINTS } from "../src/endpoints.js";
import { startHttpServer } from "../src/http.js";

interface Seen {
  url: string;
  headers: IncomingHttpHeaders;
}

const seen: Seen[] = [];
let mock: Server;
let mockUrl: string;

const userBody = {
  data: { user: { result: { rest_id: "12", legacy: { screen_name: "jack", name: "jack" } } } },
};
const timelineBody = {
  data: {
    timeline: {
      instructions: [{ entries: [{ content: { cursorType: "Bottom", value: "NEXT_PAGE" } }] }],
    },
  },
};

function simpleFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/simple/${name}.json`, import.meta.url), "utf8"));
}
const simpleUserBody = simpleFixture("user-by-username-username");
const simpleTimelineBody = simpleFixture("user-userid-tweets") as { nextCursor: string };

beforeAll(async () => {
  mock = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    const url = new URL(req.url ?? "/", "http://mock");
    const isSimple = url.searchParams.get("format") === "simple";
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/user/by/username/jack") return res.end(JSON.stringify(isSimple ? simpleUserBody : userBody));
    if (url.pathname === "/user/12/tweets") return res.end(JSON.stringify(isSimple ? simpleTimelineBody : timelineBody));
    if (url.pathname === "/tweet/402") {
      res.statusCode = 402;
      return res.end(JSON.stringify({ error: "Insufficient balance" }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "NOT_FOUND" }));
  });
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
  mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => mock.close(r));
});

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0].text;
}

describe("stdio server (dist/index.js)", () => {
  let client: Client;

  beforeAll(async () => {
    const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: { PATH: process.env.PATH ?? "", TWITTRAPI_API_KEY: "stdio-key", TWITTRAPI_BASE_URL: mockUrl },
      stderr: "pipe",
    });
    client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();
  });

  it("lists all tools with schemas and read-only annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(ENDPOINTS.map((e) => e.name).sort());
    const search = tools.find((t) => t.name === "search_tweets")!;
    expect(search.inputSchema.required).toEqual(["searchItem"]);
    expect(Object.keys(search.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["searchItem", "category", "count", "cursor", "max_chars", "format"]),
    );
    expect(search.annotations?.readOnlyHint).toBe(true);
  });

  it("calls a tool against the mock API with the key header, in the simple format by default", async () => {
    seen.length = 0;
    const result = await client.callTool({ name: "get_user_by_username", arguments: { username: "jack" } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toEqual(simpleUserBody);
    expect(seen[0].url).toBe("/user/by/username/jack?format=simple");
    expect(seen[0].headers["x-api-key"]).toBe("stdio-key");
  });

  it("returns raw JSON when a tool is called with format: raw", async () => {
    const result = await client.callTool({ name: "get_user_by_username", arguments: { username: "jack", format: "raw" } });
    expect(JSON.parse(text(result))).toEqual(userBody);
    expect(seen.at(-1)!.url).toBe("/user/by/username/jack");
  });

  it("passes the next cursor through on paginated tools", async () => {
    const result = await client.callTool({ name: "get_user_tweets", arguments: { userId: "12", count: 5 } });
    expect(text(result).split("\n")[0]).toBe(`next_cursor: ${simpleTimelineBody.nextCursor}`);
    expect(seen.at(-1)!.url).toBe("/user/12/tweets?count=5&format=simple");
  });

  it("passes the raw next cursor through with format: raw", async () => {
    const result = await client.callTool({ name: "get_user_tweets", arguments: { userId: "12", count: 5, format: "raw" } });
    expect(text(result).split("\n")[0]).toBe("next_cursor: NEXT_PAGE");
    expect(seen.at(-1)!.url).toBe("/user/12/tweets?count=5");
  });

  it("rejects an unknown format argument", async () => {
    const before = seen.length;
    const result = await client.callTool({ name: "get_user_by_id", arguments: { userId: "12", format: "xml" } });
    expect(result.isError).toBe(true);
    expect(seen.length).toBe(before);
  });

  it("returns a readable tool error for 402", async () => {
    const result = await client.callTool({ name: "get_tweet", arguments: { tweetId: "402" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/No balance left/);
  });

  it("rejects invalid arguments before calling the API", async () => {
    const before = seen.length;
    const result = await client.callTool({ name: "get_tweet", arguments: { tweetId: "not-a-number" } });
    expect(result.isError).toBe(true);
    expect(seen.length).toBe(before);
  });
});

describe("stdio server with TWITTRAPI_RESPONSE_FORMAT=raw", () => {
  it("returns raw JSON by default and still allows format: simple", async () => {
    const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [entry],
        env: {
          PATH: process.env.PATH ?? "",
          TWITTRAPI_API_KEY: "stdio-key",
          TWITTRAPI_BASE_URL: mockUrl,
          TWITTRAPI_RESPONSE_FORMAT: "raw",
        },
        stderr: "pipe",
      }),
    );
    try {
      const raw = await client.callTool({ name: "get_user_by_username", arguments: { username: "jack" } });
      expect(JSON.parse(text(raw))).toEqual(userBody);
      expect(seen.at(-1)!.url).toBe("/user/by/username/jack");
      const simple = await client.callTool({ name: "get_user_by_username", arguments: { username: "jack", format: "simple" } });
      expect(JSON.parse(text(simple))).toEqual(simpleUserBody);
      expect(seen.at(-1)!.url).toBe("/user/by/username/jack?format=simple");
    } finally {
      await client.close();
    }
  });
});

describe("Streamable HTTP mode", () => {
  let http: Server;
  let endpoint: URL;

  beforeAll(async () => {
    http = await startHttpServer({ port: 0, host: "127.0.0.1", baseUrl: mockUrl });
    endpoint = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);
  });

  afterAll(async () => {
    await new Promise((r) => http.close(r));
  });

  it("uses the API key from the request header", async () => {
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { "X-API-KEY": "header-key" } } }),
    );
    const { tools } = await client.listTools();
    expect(tools.length).toBe(ENDPOINTS.length);
    seen.length = 0;
    const result = await client.callTool({ name: "get_user_by_username", arguments: { username: "jack" } });
    expect(JSON.parse(text(result))).toEqual(simpleUserBody);
    expect(seen[0].url).toBe("/user/by/username/jack?format=simple");
    expect(seen[0].headers["x-api-key"]).toBe("header-key");
    await client.close();
  });

  it("rejects requests without a key", async () => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("serves a health check", async () => {
    const res = await fetch(new URL("/health", endpoint));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});
