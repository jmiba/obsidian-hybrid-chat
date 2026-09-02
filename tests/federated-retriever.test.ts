import { describe, expect, it } from "vitest";
import { FederatedRetriever } from "../src/federated-retriever";
import type { OhsGateway, OhsReadResult } from "../src/ohs-client";
import type { OhsEndpointConfig, SearchResult } from "../src/domain";

class FakeGateway implements OhsGateway {
  readonly reads: Array<{ endpoint: string; paths: string[] }> = [];
  readonly rerankFlags: boolean[] = [];

  search(
    endpoint: string,
    query: string,
    limit: number,
    rerank: boolean,
    frontmatter: string[],
  ): Promise<SearchResult[]> {
    void query;
    void limit;
    void frontmatter;
    this.rerankFlags.push(rerank);
    if (endpoint.includes("offline")) return Promise.reject(new Error("connection refused"));
    return Promise.resolve([
      { path: "one.md", title: "One", snippet: "one", rank: 1 },
      { path: "two.md", title: "Two", snippet: "two", rank: 2 },
    ]);
  }

  read(endpoint: string, paths: string[]): Promise<OhsReadResult[]> {
    this.reads.push({ endpoint, paths });
    return Promise.resolve(paths.map((path) => ({ path, title: path, content: `content:${path}`, found: true })));
  }
}

const endpoints: OhsEndpointConfig[] = [
  { id: "healthy", displayName: "Healthy", endpoint: "http://healthy/mcp", obsidianVaultName: "A", requestTimeoutMs: 60_000, enabled: true, selectedByDefault: true },
  { id: "offline", displayName: "Offline", endpoint: "http://offline/mcp", obsidianVaultName: "B", requestTimeoutMs: 60_000, enabled: true, selectedByDefault: true },
];

describe("endpoint partial failure", () => {
  it("continues with healthy vaults and reads only globally selected notes", async () => {
    const gateway = new FakeGateway();
    const result = await new FederatedRetriever(gateway).retrieve(
      "question",
      endpoints,
      { mode: "all", vaultIds: [] },
      "A",
      { searchLimitPerVault: 8, maxNotes: 1, enableReranking: true, frontmatterFilters: [] },
    );
    expect(result.failures).toEqual([expect.objectContaining({ vaultId: "offline", stage: "search" })]);
    expect(result.allSearchesFailed).toBe(false);
    expect(result.sources.map((source) => source.sourceId)).toEqual(["healthy::one.md"]);
    expect(gateway.reads).toEqual([{ endpoint: "http://healthy/mcp", paths: ["one.md"] }]);
    expect(gateway.rerankFlags).toEqual([true, true]);
  });

  it("marks retrieval unavailable when every selected OHS search fails", async () => {
    const gateway = new FakeGateway();
    const result = await new FederatedRetriever(gateway).retrieve(
      "question",
      [endpoints[1]!],
      { mode: "all", vaultIds: [] },
      "B",
      { searchLimitPerVault: 8, maxNotes: 1, enableReranking: true, frontmatterFilters: [] },
    );
    expect(result.sources).toEqual([]);
    expect(result.allSearchesFailed).toBe(true);
  });

  it("bounds each endpoint and reports that a timed-out server may still be processing", async () => {
    class HangingGateway extends FakeGateway {
      override search(
        endpoint: string,
        query: string,
        limit: number,
        rerank: boolean,
        frontmatter: string[],
        signal?: AbortSignal,
      ): Promise<SearchResult[]> {
        void endpoint;
        void query;
        void limit;
        void rerank;
        void frontmatter;
        return new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("Request canceled", "AbortError")), { once: true });
        });
      }
    }

    const result = await new FederatedRetriever(new HangingGateway()).retrieve(
      "question",
      [{ ...endpoints[0]!, requestTimeoutMs: 5 }],
      { mode: "all", vaultIds: [] },
      "A",
      { searchLimitPerVault: 8, maxNotes: 1, enableReranking: true, frontmatterFilters: [] },
    );
    expect(result.allSearchesFailed).toBe(true);
    expect(result.failures[0]).toMatchObject({
      stage: "search",
      kind: "timeout",
    });
    expect(result.failures[0]?.message).toContain("may still be processing");
  });

  it("propagates user cancellation instead of recording endpoint failures", async () => {
    const controller = new AbortController();
    class CanceledGateway extends FakeGateway {
      override search(): Promise<SearchResult[]> {
        controller.abort();
        return Promise.reject(new DOMException("Request canceled", "AbortError"));
      }
    }

    await expect(new FederatedRetriever(new CanceledGateway()).retrieve(
      "question",
      [endpoints[0]!],
      { mode: "all", vaultIds: [] },
      "A",
      { searchLimitPerVault: 8, maxNotes: 1, enableReranking: true, frontmatterFilters: [] },
      controller.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
  });
});
