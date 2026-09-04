import { describe, expect, it, vi } from "vitest";

const { requestUrl } = vi.hoisted(() => ({ requestUrl: vi.fn() }));
vi.mock("obsidian", () => ({
  requestUrl,
}));
vi.stubGlobal("window", { clearTimeout, setTimeout });

import {
  adaptSearchArgumentsForTool,
  buildOhsRelatedArguments,
  buildOhsSearchArguments,
  isTransientOhsError,
  OhsMcpClient,
  withTransientOhsRetries,
} from "../src/ohs-client";

describe("OHS search arguments", () => {
  it("enables native cross-encoder reranking explicitly", () => {
    expect(buildOhsSearchArguments("question", 8, true)).toEqual({
      query: "question",
      mode: "hybrid",
      limit: 8,
      snippet_length: 600,
      rerank: true,
    });
  });

  it("passes exact property filters through the OHS frontmatter contract", () => {
    expect(buildOhsSearchArguments("mail", 8, true, ["status:todo", "-priority:low"]))
      .toMatchObject({ frontmatter: ["status:todo", "-priority:low"] });
  });

  it("uses OHS native multi-query fusion for recall variants", () => {
    expect(buildOhsSearchArguments(["original question", "keyword variant", "contextual variant"], 12, true))
      .toMatchObject({
        query: "original question",
        queries: ["keyword variant", "contextual variant"],
        limit: 12,
        rerank: true,
      });
  });

  it("drops multi-query arguments for an older advertised tool schema", () => {
    const args = buildOhsSearchArguments(["original", "variant"], 8, true);
    const adapted = adaptSearchArgumentsForTool(args, {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
    });
    expect(adapted).not.toHaveProperty("queries");
    expect(adaptSearchArgumentsForTool(args, {
      type: "object",
      properties: { query: { type: "string" }, queries: { type: "array" } },
    })).toHaveProperty("queries", ["variant"]);
  });

  it("builds a vault-local one-hop links and backlinks request", () => {
    const args = buildOhsRelatedArguments("Projects/Anchor.md", ["status:active"]);
    expect(args).toEqual({
      path: "Projects/Anchor.md",
      related: true,
      depth: 1,
      direction: "both",
      link_type: "all",
      snippet_length: 600,
      frontmatter: ["status:active"],
    });
    expect(adaptSearchArgumentsForTool(args, {
      type: "object",
      properties: { path: {}, related: {}, depth: {} },
    })).toEqual({ path: "Projects/Anchor.md", related: true, depth: 1 });
  });
});

describe("OHS capability caching", () => {
  it("reuses discovered tool names and schemas for an endpoint", async () => {
    const client = {
      initialize: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue([{
        name: "vault_search",
        inputSchema: { type: "object", properties: { query: {}, queries: {} } },
      }]),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: '{"results":[]}' }],
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const ohs = new OhsMcpClient(() => client, () => 1_000);

    await ohs.search("http://127.0.0.1:3939/mcp", ["one", "two"], 8, false, []);
    await ohs.search("http://127.0.0.1:3939/mcp", ["three"], 8, false, []);

    expect(client.initialize).toHaveBeenCalledTimes(2);
    expect(client.listTools).toHaveBeenCalledTimes(1);
    expect(client.callTool).toHaveBeenCalledTimes(2);
    expect(client.close).toHaveBeenCalledTimes(2);
  });

  it("refreshes endpoint capabilities after the cache expires", async () => {
    let now = 1_000;
    const client = {
      initialize: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue([{
        name: "search",
        inputSchema: { type: "object", properties: { query: {} } },
      }]),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: '{"results":[]}' }],
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const ohs = new OhsMcpClient(() => client, () => now);

    await ohs.search("http://127.0.0.1:3939/mcp", ["one"], 8, false, []);
    now += 5 * 60_000;
    await ohs.search("http://127.0.0.1:3939/mcp", ["two"], 8, false, []);

    expect(client.listTools).toHaveBeenCalledTimes(2);
  });

  it("invalidates a stale cached tool name after an MCP error", async () => {
    const client = {
      initialize: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn()
        .mockResolvedValueOnce([{
          name: "old_search",
          inputSchema: { type: "object", properties: { query: {} } },
        }])
        .mockResolvedValueOnce([{
          name: "new_search",
          inputSchema: { type: "object", properties: { query: {} } },
        }]),
      callTool: vi.fn()
        .mockRejectedValueOnce(new Error("MCP error -32602: Unknown tool old_search"))
        .mockResolvedValueOnce({ content: [{ type: "text", text: '{"results":[]}' }] }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const response = await new OhsMcpClient(() => client).search(
      "http://127.0.0.1:3939/mcp",
      ["question"],
      8,
      false,
      [],
    );

    expect(response).toEqual([]);
    expect(client.listTools).toHaveBeenCalledTimes(2);
    expect(client.callTool).toHaveBeenNthCalledWith(1, "old_search", expect.anything(), undefined);
    expect(client.callTool).toHaveBeenNthCalledWith(2, "new_search", expect.anything(), undefined);
  });

  it("falls back to normal hybrid search when reranking fails", async () => {
    const client = {
      initialize: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue([{
        name: "search",
        inputSchema: { type: "object", properties: { query: {} } },
      }]),
      callTool: vi.fn()
        .mockRejectedValueOnce(new Error("reranker unavailable"))
        .mockResolvedValueOnce({ content: [{ type: "text", text: '{"results":[]}' }] }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const response = await new OhsMcpClient(() => client).search(
      "http://127.0.0.1:3939/mcp",
      ["question"],
      8,
      true,
      [],
    );

    expect(response).toEqual([]);
    expect(client.callTool).toHaveBeenNthCalledWith(
      2,
      "search",
      expect.objectContaining({ rerank: false }),
      undefined,
    );
  });

  it("refuses to mislabel unsupported path search as related traversal", async () => {
    const client = {
      initialize: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue([{
        name: "search",
        inputSchema: { type: "object", properties: { query: {}, path: {} } },
      }]),
      callTool: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const ohs = new OhsMcpClient(() => client);

    await expect(ohs.related("http://127.0.0.1:3939/mcp", "Anchor.md", []))
      .rejects.toThrow("does not advertise related-note traversal");
    expect(client.callTool).not.toHaveBeenCalled();
  });
});

describe("OHS availability retries", () => {
  it("recognizes Obsidian's loopback connection-refused error", () => {
    expect(isTransientOhsError(new Error("net::ERR_CONNECTION_REFUSED"))).toBe(true);
    expect(isTransientOhsError(new Error("Invalid search arguments"))).toBe(false);
  });

  it("retries transient failures and preserves non-transient failures", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error("net::ERR_CONNECTION_REFUSED"))
      .mockResolvedValue("ready");
    await expect(withTransientOhsRetries(operation, undefined, [0])).resolves.toBe("ready");
    expect(operation).toHaveBeenCalledTimes(2);

    const invalid = vi.fn().mockRejectedValue(new Error("Invalid search arguments"));
    await expect(withTransientOhsRetries(invalid, undefined, [0])).rejects.toThrow("Invalid search arguments");
    expect(invalid).toHaveBeenCalledTimes(1);
  });

  it("does not retry a transient error after its request signal is canceled", async () => {
    const controller = new AbortController();
    const operation = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.reject(new Error("fetch failed"));
    });

    await expect(withTransientOhsRetries(operation, controller.signal, [0, 0]))
      .rejects.toThrow("fetch failed");
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
