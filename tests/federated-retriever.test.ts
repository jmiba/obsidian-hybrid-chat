import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("window", { clearTimeout, setTimeout });
import { FederatedRetriever } from "../src/federated-retriever";
import type { OhsGateway, OhsReadResult } from "../src/ohs-client";
import type { OhsEndpointConfig, SearchResult } from "../src/domain";

class FakeGateway implements OhsGateway {
  readonly reads: Array<{ endpoint: string; paths: string[] }> = [];
  readonly rerankFlags: boolean[] = [];

  search(
    endpoint: string,
    queries: string[],
    limit: number,
    rerank: boolean,
    frontmatter: string[],
  ): Promise<SearchResult[]> {
    void queries;
    void limit;
    void frontmatter;
    this.rerankFlags.push(rerank);
    if (endpoint.includes("offline")) return Promise.reject(new Error("connection refused"));
    return Promise.resolve([
      { path: "one.md", title: "One", snippet: "one", rank: 1 },
      { path: "two.md", title: "Two", snippet: "two", rank: 2 },
    ]);
  }

  related(endpoint: string, path: string, frontmatter: string[]): Promise<SearchResult[]> {
    void endpoint;
    void path;
    void frontmatter;
    return Promise.resolve([]);
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
      ["question"],
      endpoints,
      { mode: "all", vaultIds: [] },
      "A",
      { searchLimitPerVault: 8, maxNotes: 1, enableReranking: true, enableRelatedTraversal: false, frontmatterFilters: [] },
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
      ["question"],
      [endpoints[1]!],
      { mode: "all", vaultIds: [] },
      "B",
      { searchLimitPerVault: 8, maxNotes: 1, enableReranking: true, enableRelatedTraversal: false, frontmatterFilters: [] },
    );
    expect(result.sources).toEqual([]);
    expect(result.allSearchesFailed).toBe(true);
  });

  it("bounds each endpoint and reports that a timed-out server may still be processing", async () => {
    class HangingGateway extends FakeGateway {
      override search(
        endpoint: string,
        queries: string[],
        limit: number,
        rerank: boolean,
        frontmatter: string[],
        signal?: AbortSignal,
      ): Promise<SearchResult[]> {
        void endpoint;
        void queries;
        void limit;
        void rerank;
        void frontmatter;
        return new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("Request canceled", "AbortError")), { once: true });
        });
      }
    }

    const result = await new FederatedRetriever(new HangingGateway()).retrieve(
      ["question"],
      [{ ...endpoints[0]!, requestTimeoutMs: 5 }],
      { mode: "all", vaultIds: [] },
      "A",
      { searchLimitPerVault: 8, maxNotes: 1, enableReranking: true, enableRelatedTraversal: false, frontmatterFilters: [] },
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
      ["question"],
      [endpoints[0]!],
      { mode: "all", vaultIds: [] },
      "A",
      { searchLimitPerVault: 8, maxNotes: 1, enableReranking: true, enableRelatedTraversal: false, frontmatterFilters: [] },
      controller.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
  });

  it("backfills a missing top-ranked note without reading lower candidates eagerly", async () => {
    class MissingTopGateway extends FakeGateway {
      override read(endpoint: string, paths: string[]): Promise<OhsReadResult[]> {
        this.reads.push({ endpoint, paths });
        return Promise.resolve(paths.map((path) => ({
          path,
          title: path,
          content: path === "one.md" ? "" : `content:${path}`,
          found: path !== "one.md",
        })));
      }
    }

    const gateway = new MissingTopGateway();
    const result = await new FederatedRetriever(gateway).retrieve(
      ["question", "keyword variant"],
      [endpoints[0]!],
      { mode: "all", vaultIds: [] },
      "A",
      { searchLimitPerVault: 8, maxNotes: 1, enableReranking: true, enableRelatedTraversal: false, frontmatterFilters: [] },
    );
    expect(result.sources.map((source) => source.sourceId)).toEqual(["healthy::two.md"]);
    expect(gateway.reads).toEqual([
      { endpoint: "http://healthy/mcp", paths: ["one.md"] },
      { endpoint: "http://healthy/mcp", paths: ["two.md"] },
    ]);
  });

  it("expands one anchor per vault and promotes only bounded linked candidates", async () => {
    class RelatedGateway extends FakeGateway {
      readonly relatedCalls: Array<{ endpoint: string; path: string; frontmatter: string[] }> = [];

      override related(endpoint: string, path: string, frontmatter: string[]): Promise<SearchResult[]> {
        this.relatedCalls.push({ endpoint, path, frontmatter });
        return Promise.resolve([
          { path: "one.md", title: "One", snippet: "anchor", rank: 1 },
          { path: "linked-a.md", title: "Linked A", snippet: "linked", rank: 2 },
          { path: "linked-b.md", title: "Linked B", snippet: "linked", rank: 3 },
          { path: "linked-c.md", title: "Linked C", snippet: "linked", rank: 4 },
        ]);
      }
    }

    const gateway = new RelatedGateway();
    const result = await new FederatedRetriever(gateway).retrieve(
      ["How is One connected to the project?"],
      [endpoints[0]!],
      { mode: "all", vaultIds: [] },
      "A",
      {
        searchLimitPerVault: 8,
        maxNotes: 3,
        enableReranking: true,
        enableRelatedTraversal: true,
        frontmatterFilters: ["status:active"],
      },
    );

    expect(gateway.relatedCalls).toEqual([{
      endpoint: "http://healthy/mcp",
      path: "one.md",
      frontmatter: ["status:active"],
    }]);
    expect(result.sources.map((source) => [source.sourceId, source.retrievalKind])).toEqual([
      ["healthy::one.md", "direct"],
      ["healthy::linked-a.md", "related"],
      ["healthy::two.md", "direct"],
    ]);
  });

  it("keeps related traversal on each anchor's originating vault endpoint", async () => {
    class MultiVaultRelatedGateway extends FakeGateway {
      readonly relatedCalls: Array<{ endpoint: string; path: string }> = [];

      override related(endpoint: string, path: string): Promise<SearchResult[]> {
        this.relatedCalls.push({ endpoint, path });
        const suffix = endpoint.includes("second") ? "second" : "first";
        return Promise.resolve([{
          path: `${suffix}-linked.md`,
          title: `${suffix} linked`,
          snippet: "linked",
          rank: 1,
        }]);
      }
    }

    const gateway = new MultiVaultRelatedGateway();
    const secondEndpoint: OhsEndpointConfig = {
      ...endpoints[0]!,
      id: "second",
      displayName: "Second",
      endpoint: "http://second/mcp",
      obsidianVaultName: "B",
    };
    const result = await new FederatedRetriever(gateway).retrieve(
      ["What links these projects?"],
      [endpoints[0]!, secondEndpoint],
      { mode: "all", vaultIds: [] },
      "A",
      {
        searchLimitPerVault: 8,
        maxNotes: 4,
        enableReranking: false,
        enableRelatedTraversal: true,
        frontmatterFilters: [],
      },
    );

    expect(gateway.relatedCalls).toEqual([
      { endpoint: "http://healthy/mcp", path: "one.md" },
      { endpoint: "http://second/mcp", path: "one.md" },
    ]);
    expect(result.sources.filter((source) => source.retrievalKind === "related").map((source) => source.sourceId))
      .toEqual(["healthy::first-linked.md", "second::second-linked.md"]);
  });

  it("keeps direct results when optional related traversal fails", async () => {
    class FailedRelatedGateway extends FakeGateway {
      override related(): Promise<SearchResult[]> {
        return Promise.reject(new Error("related traversal unavailable"));
      }
    }

    const result = await new FederatedRetriever(new FailedRelatedGateway()).retrieve(
      ["What is linked to One?"],
      [endpoints[0]!],
      { mode: "all", vaultIds: [] },
      "A",
      {
        searchLimitPerVault: 8,
        maxNotes: 1,
        enableReranking: false,
        enableRelatedTraversal: true,
        frontmatterFilters: [],
      },
    );

    expect(result.sources.map((source) => source.sourceId)).toEqual(["healthy::one.md"]);
    expect(result.failures).toEqual([expect.objectContaining({ stage: "related", vaultId: "healthy" })]);
    expect(result.allSearchesFailed).toBe(false);
  });
});
