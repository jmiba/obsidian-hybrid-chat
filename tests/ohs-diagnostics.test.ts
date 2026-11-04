import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));
import { checkOhsConnection } from "../src/ohs-diagnostics";
import type { McpTool } from "../src/mcp-http-client";

const endpoint = { endpoint: "http://localhost:3939/mcp", requestTimeoutMs: 5000 };
function fixture(tools: McpTool[] = [
  { name: "vault_search", inputSchema: { properties: { rerank: {}, frontmatter: {}, path: {}, related: {}, depth: {} } } },
  { name: "vault_read" }, { name: "vault_status" },
]) {
  return {
    connectionInfo: { name: "OHS", version: "0.17.2", protocolVersion: "2025-11-25" },
    initialize: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue(tools),
    callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: JSON.stringify({
      total: 100, indexed: 95, failed_chunks: 0, model: "e5", active_model: "e5",
    }) }] }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("explicit OHS diagnostics", () => {
  it("discovers prefixed tools and reports health without searching or reading notes", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const client = fixture();
    const result = await checkOhsConnection(endpoint, "test", () => client);
    expect(result.compatible).toBe(true);
    expect(result.details.join("\n")).toContain("OHS 0.17.2");
    expect(result.details.join("\n")).toContain("indexed: 95");
    expect(result.details.join("\n")).toContain("rerank, frontmatter");
    expect(client.callTool).toHaveBeenCalledExactlyOnceWith("vault_status", {}, expect.any(AbortSignal));
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("flags model mismatches and indexing errors, including status JSON with an appended warning", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const client = fixture();
    client.callTool.mockResolvedValue({ content: [{ type: "text", text:
      '{"model":"old","active_model":"new","failed_chunks":2}\n⚠️ 2 chunks have no embeddings',
    }] });
    const result = await checkOhsConnection(endpoint, "test", () => client);
    expect(result.compatible).toBe(false);
    expect(result.details.join("\n")).toContain("Embedding model mismatch");
    expect(result.details.join("\n")).toContain("Indexing failures");
  });

  it("reports missing retrieval tools and supports servers without status", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const client = fixture([{ name: "search" }]);
    const result = await checkOhsConnection(endpoint, "test", () => client);
    expect(result.compatible).toBe(false);
    expect(result.details.join("\n")).toContain("Missing required tools: read");
    expect(result.details.join("\n")).toContain("index health could not be checked");
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("keeps a status failure distinct from MCP connectivity", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const client = fixture();
    client.callTool.mockRejectedValue(new Error("Status disabled"));
    const result = await checkOhsConnection(endpoint, "test", () => client);
    expect(result.compatible).toBe(true);
    expect(result.details.join("\n")).toContain("Status unavailable: Status disabled");
  });

  it("bounds the check and closes the client on timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const client = fixture();
    client.initialize.mockImplementation((signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    }));
    const pending = checkOhsConnection(endpoint, "test", () => client);
    const assertion = expect(pending).rejects.toThrow("timed out after 5 seconds");
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("rejects invalid endpoint URLs before making requests", async () => {
    const factory = vi.fn();
    await expect(checkOhsConnection({ ...endpoint, endpoint: "https://user:secret@host/mcp" }, "test", factory))
      .rejects.toThrow("without credentials");
    expect(factory).not.toHaveBeenCalled();
  });
});
