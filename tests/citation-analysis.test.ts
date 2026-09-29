import { describe, expect, it } from "vitest";
import type { ChatMessage, RetrievedSource } from "../src/domain";
import { analyzeCitations, displayMessageContent } from "../src/citation-analysis";

function makeSource(index: number): RetrievedSource {
  return {
    path: `notes/source-${index}.md`,
    title: `Source ${index}`,
    snippet: "",
    rank: index,
    vaultId: "vault-1",
    vaultDisplayName: "Test Vault",
    obsidianVaultName: "Test Vault",
    sourceId: `source-${index}`,
    content: "Body text.",
  };
}

describe("citation analysis", () => {
  it("renumbers cited sources in the order they are first cited", () => {
    const sources = [makeSource(1), makeSource(2), makeSource(3)];
    const analysis = analyzeCitations("First claim [S3] and second claim [S1].", sources);

    expect(analysis.content).toBe("First claim [1] and second claim [2].");
    expect(analysis.cited.map((item) => [item.source.sourceId, item.number, item.retrievalNumber])).toEqual([
      ["source-3", 1, 3],
      ["source-1", 2, 1],
    ]);
    expect(analysis.uncited.map((item) => [item.source.sourceId, item.retrievalNumber])).toEqual([["source-2", 2]]);
    expect(analysis.unknownMarkers).toBe(0);
  });

  it("keeps a single number for a source cited multiple times", () => {
    const sources = [makeSource(1), makeSource(2)];
    const analysis = analyzeCitations("Again [S2] and again [S2].", sources);

    expect(analysis.content).toBe("Again [1] and again [1].");
    expect(analysis.cited).toHaveLength(1);
    expect(analysis.uncited.map((item) => item.source.sourceId)).toEqual(["source-1"]);
  });

  it("renumbers every label inside a multi-source marker", () => {
    const sources = [makeSource(1), makeSource(2), makeSource(3)];
    const analysis = analyzeCitations("Both together [S2, S3], one alone [S1].", sources);

    expect(analysis.content).toBe("Both together [1, 2], one alone [3].");
    expect(analysis.cited.map((item) => item.number)).toEqual([1, 2, 3]);
    expect(analysis.uncited).toEqual([]);
  });

  it("leaves the answer untouched when no source marker is cited", () => {
    const sources = [makeSource(1)];
    const content = "No citations here, just a [note] that is not a source marker.";
    const analysis = analyzeCitations(content, sources);

    expect(analysis.content).toBe(content);
    expect(analysis.cited).toEqual([]);
    expect(analysis.uncited.map((item) => item.retrievalNumber)).toEqual([1]);
  });

  it("flags markers that reference an unknown source", () => {
    const sources = [makeSource(1)];
    const analysis = analyzeCitations("A real [S1] and a fabricated [S9].", sources);

    expect(analysis.content).toBe("A real [1] and a fabricated [unverified citation].");
    expect(analysis.unknownMarkers).toBe(1);
    expect(analysis.cited.map((item) => item.source.sourceId)).toEqual(["source-1"]);
  });

  it("treats a marker as unverified when any of its labels is unknown", () => {
    const sources = [makeSource(1), makeSource(2)];
    const analysis = analyzeCitations("Mixed marker [S1, S9].", sources);

    expect(analysis.content).toBe("Mixed marker [unverified citation].");
    expect(analysis.unknownMarkers).toBe(1);
    expect(analysis.cited).toEqual([]);
    expect(analysis.uncited.map((item) => item.retrievalNumber)).toEqual([1, 2]);
  });

  it("accepts lowercase source labels", () => {
    const sources = [makeSource(1)];
    const analysis = analyzeCitations("Lowercase [s1] works.", sources);

    expect(analysis.content).toBe("Lowercase [1] works.");
    expect(analysis.cited.map((item) => item.number)).toEqual([1]);
  });

  it("accepts markers padded with whitespace by the model", () => {
    const sources = [makeSource(1), makeSource(2)];
    const analysis = analyzeCitations("Follow up to confirm receipt and ask about possible support [ S2 ].", sources);

    expect(analysis.content).toBe("Follow up to confirm receipt and ask about possible support [1].");
    expect(analysis.cited.map((item) => [item.source.sourceId, item.number])).toEqual([["source-2", 1]]);
    expect(analysis.uncited.map((item) => item.retrievalNumber)).toEqual([1]);
    expect(analysis.unknownMarkers).toBe(0);
  });

  it("recognizes numeric and decorative markers used by the chatbot API", () => {
    const sources = [makeSource(1), makeSource(2), makeSource(3)];
    const analysis = analyzeCitations("First [3], second 【1】, repeated ［3］, and more 〖2〗〔1〕.", sources);

    expect(analysis.content).toBe("First [1], second [2], repeated [1], and more [3][2].");
    expect(analysis.cited.map((item) => [item.retrievalNumber, item.number])).toEqual([[3, 1], [1, 2], [2, 3]]);
    expect(analysis.uncited).toEqual([]);
  });

  it("recognizes the corner-bracket S marker in the saved Mail-Vault answer", () => {
    const sources = Array.from({ length: 8 }, (_, index) => makeSource(index + 1));
    const analysis = analyzeCitations("A separate organization may be necessary 【S3】.", sources);

    expect(analysis.content).toBe("A separate organization may be necessary [1].");
    expect(analysis.cited.map((item) => [item.retrievalNumber, item.number])).toEqual([[3, 1]]);
    expect(analysis.uncited.map((item) => item.retrievalNumber)).toEqual([1, 2, 4, 5, 6, 7, 8]);
  });

  it("renders the saved Mail-Vault marker and allows ordinary word wrapping", () => {
    const sources = Array.from({ length: 9 }, (_, index) => makeSource(index + 1));
    const analysis = analyzeCitations("Frau\u202fPappusch\u202fantwortete\u202f[\u200bS1\u200b].", sources);

    expect(analysis.content).toBe("Frau Pappusch antwortete [1].");
    expect(analysis.cited.map((item) => item.retrievalNumber)).toEqual([1]);
    expect(analysis.uncited).toHaveLength(8);
  });

  it("omits model-supplied line locators from decorative markers", () => {
    const analysis = analyzeCitations("Claim 【2†L5-L8】.", [makeSource(1), makeSource(2)]);

    expect(analysis.content).toBe("Claim [1].");
    expect(analysis.cited.map((item) => item.retrievalNumber)).toEqual([2]);
  });

  it("accepts whitespace-padded multi-label markers", () => {
    const sources = [makeSource(1), makeSource(2), makeSource(3)];
    const analysis = analyzeCitations("Together [ S2 , S3 ] and alone [ S1 ].", sources);

    expect(analysis.content).toBe("Together [1, 2] and alone [3].");
    expect(analysis.cited.map((item) => item.number)).toEqual([1, 2, 3]);
  });

  describe("displayMessageContent", () => {
    it("rewrites assistant answers that carry sources", () => {
      const message: ChatMessage = {
        id: "one",
        role: "assistant",
        content: "Answer [S1].",
        createdAt: "2026-09-29T00:00:00.000Z",
        sources: [makeSource(1)],
      };

      expect(displayMessageContent(message)).toBe("Answer [1].");
    });

    it("leaves user messages and source-less answers untouched", () => {
      const user: ChatMessage = { id: "two", role: "user", content: "Question [S1].", createdAt: "2026-09-29T00:00:01.000Z" };
      const plain: ChatMessage = { id: "three", role: "assistant", content: "Plain answer.", createdAt: "2026-09-29T00:00:02.000Z" };

      expect(displayMessageContent(user)).toBe("Question [S1].");
      expect(displayMessageContent(plain)).toBe("Plain answer.");
    });

    it("normalizes narrow no-break spaces in source-less assistant output", () => {
      expect(displayMessageContent({ role: "assistant", content: "Two\u202fwords." })).toBe("Two words.");
    });
  });
});
