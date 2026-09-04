import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestUrl } = vi.hoisted(() => ({ requestUrl: vi.fn() }));
vi.mock("obsidian", () => ({ requestUrl }));

import { McpHttpClient } from "../src/mcp-http-client";

describe("minimal MCP Streamable HTTP client", () => {
  beforeEach(() => requestUrl.mockReset());

  it("initializes a session, discovers tools, and handles an SSE tool response", async () => {
    requestUrl
      .mockResolvedValueOnce(response({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "OHS", version: "0.15.1" },
        },
      }, 200, { "Mcp-Session-Id": "session-1", "Content-Type": "application/json" }))
      .mockResolvedValueOnce(response("", 202))
      .mockResolvedValueOnce(response({
        jsonrpc: "2.0",
        id: 2,
        result: {
          tools: [{ name: "ohs_search", inputSchema: { type: "object" } }],
        },
      }))
      .mockResolvedValueOnce(response(
        'event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"{\\"results\\":[]}"}]}}\n\n',
        200,
        { "content-type": "text/event-stream" },
      ))
      .mockResolvedValueOnce(response("", 204));

    const client = new McpHttpClient(
      new URL("http://127.0.0.1:3939/mcp"),
      { name: "hybrid-chat", version: "0.1.4" },
    );
    await client.initialize();
    await expect(client.listTools()).resolves.toEqual([
      { name: "ohs_search", inputSchema: { type: "object" } },
    ]);
    await expect(client.callTool("ohs_search", { query: "test" })).resolves.toMatchObject({
      content: [{ type: "text", text: '{"results":[]}' }],
      isError: false,
    });
    await client.close();

    const requests = requestUrl.mock.calls.map(([options]) => options as {
      body: string;
      headers: Record<string, string>;
    });
    expect(requests.map(({ body }) => parseMethod(body))).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
      undefined,
    ]);
    expect(requests[0]?.headers).not.toHaveProperty("mcp-protocol-version");
    for (const request of requests.slice(1)) {
      expect(request.headers).toMatchObject({
        "mcp-protocol-version": "2025-03-26",
        "mcp-session-id": "session-1",
      });
    }
    expect(requests[4]).toMatchObject({
      headers: {
        "mcp-protocol-version": "2025-03-26",
        "mcp-session-id": "session-1",
      },
    });
  });

  it("rejects an unsupported negotiated protocol version", async () => {
    requestUrl.mockResolvedValueOnce(response({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2099-01-01", capabilities: {}, serverInfo: {} },
    }));
    const client = new McpHttpClient(new URL("http://localhost:3939/mcp"), { name: "test", version: "1.0.0" });
    await expect(client.initialize()).rejects.toThrow("unsupported MCP protocol version");
  });

  it("does not contact the endpoint after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new McpHttpClient(new URL("http://localhost:3939/mcp"), { name: "test", version: "1.0.0" });
    await expect(client.initialize(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(requestUrl).not.toHaveBeenCalled();
  });
});

function response(
  body: unknown,
  status = 200,
  headers: Record<string, string> = { "content-type": "application/json" },
): { status: number; headers: Record<string, string>; arrayBuffer: ArrayBuffer } {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    headers,
    arrayBuffer: new TextEncoder().encode(text).buffer,
  };
}

function parseMethod(body: unknown): unknown {
  if (typeof body !== "string") return undefined;
  const parsed: unknown = JSON.parse(body);
  return typeof parsed === "object" && parsed !== null && "method" in parsed
    ? parsed.method
    : undefined;
}
