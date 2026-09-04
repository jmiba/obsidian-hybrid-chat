import { describe, expect, it, vi } from "vitest";

const { requestUrl } = vi.hoisted(() => ({ requestUrl: vi.fn() }));
vi.mock("obsidian", () => ({
  requestUrl,
}));
vi.stubGlobal("window", { clearTimeout, setTimeout });

import {
  adaptSearchArgumentsForTool,
  buildOhsSearchArguments,
  isTransientOhsError,
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
