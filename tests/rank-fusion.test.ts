import { describe, expect, it } from "vitest";
import { fuseRankedResults, namespaceSource } from "../src/rank-fusion";

const endpoint = (id: string) => ({
  id,
  displayName: id.toUpperCase(),
  endpoint: `http://127.0.0.1/${id}/mcp`,
  obsidianVaultName: id,
  requestTimeoutMs: 60_000,
  enabled: true,
  selectedByDefault: true,
});

describe("reciprocal-rank fusion", () => {
  it("uses per-vault rank and preserves diversity", () => {
    const fused = fuseRankedResults([
      { endpoint: endpoint("alpha"), results: [
        { path: "a1.md", title: "A1", snippet: "", rank: 1 },
        { path: "a2.md", title: "A2", snippet: "", rank: 2 },
      ] },
      { endpoint: endpoint("beta"), results: [
        { path: "b1.md", title: "B1", snippet: "", rank: 1 },
      ] },
    ], 2);
    expect(fused.map((item) => item.vaultId)).toEqual(["alpha", "beta"]);
    expect(fused.map((item) => item.rank)).toEqual([1, 1]);
  });
});

describe("source namespacing", () => {
  it("combines stable vault id and normalized vault-relative path", () => {
    expect(namespaceSource("research", "./Notes\\Paper.md")).toBe("research::Notes/Paper.md");
    expect(namespaceSource("research", "/Notes/Paper.md")).toBe("research::Notes/Paper.md");
    expect(namespaceSource("mail", "Notes/Paper.md")).not.toBe(namespaceSource("research", "Notes/Paper.md"));
  });
});
