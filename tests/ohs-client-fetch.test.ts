import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestUrl } = vi.hoisted(() => ({ requestUrl: vi.fn() }));
vi.mock("obsidian", () => ({ requestUrl }));

import {
  buildOhsSearchArguments,
  isTransientOhsError,
  obsidianMcpFetch,
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

describe("Obsidian MCP HTTP adapter", () => {
  beforeEach(() => requestUrl.mockReset());

  it("routes MCP POSTs through requestUrl and reconstructs a web Response", async () => {
    requestUrl.mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/json" },
      arrayBuffer: new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"result":{}}').buffer,
    });
    const response = await obsidianMcpFetch("http://127.0.0.1:3939/mcp", {
      method: "POST",
      headers: { accept: "application/json, text/event-stream" },
      body: '{"jsonrpc":"2.0"}',
    });

    expect(requestUrl).toHaveBeenCalledWith(expect.objectContaining({
      url: "http://127.0.0.1:3939/mcp",
      method: "POST",
      body: '{"jsonrpc":"2.0"}',
      throw: false,
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("rejects an already canceled request before contacting OHS", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(obsidianMcpFetch("http://127.0.0.1:3939/mcp", { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(requestUrl).not.toHaveBeenCalled();
  });
});
