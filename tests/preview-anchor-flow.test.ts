import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ requestUrl: vi.fn(), Notice: class {}, PluginSettingTab: class {}, SecretComponent: class {} }));
vi.stubGlobal("window", { setTimeout, clearTimeout });
import { OhsMcpClient } from "../src/ohs-client";
import { FederatedRetriever } from "../src/federated-retriever";
import { packContext } from "../src/context-packer";
import { defaultSettings, loadSettings, sanitizeSettingsForPersistence } from "../src/settings";

describe("preview anchors across retrieval and saved chats", () => {
  it("requests anchors and preserves the preferred passage through fusion, reads, packing and persistence", async () => {
    const anchors = [
      { headingPath: "# Other", matchText: "Other text", charStart: 0, charEnd: 10 },
      { headingPath: "# Topic", matchText: "Matching passage", charStart: 10, charEnd: 80 },
    ];
    const client = {
      initialize: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue([
        { name: "search", inputSchema: { properties: { query: {}, anchors: {}, limit: {} } } }, { name: "read" },
      ]),
      callTool: vi.fn().mockImplementation((name: string) => Promise.resolve({ content: [], structuredContent: {
        results: name === "search"
          ? [{ path: "Note.md", title: "Note", snippet: "Matching passage", rank: 1, previewAnchors: anchors, primaryAnchorIndex: 1 }]
          : [{ path: "Note.md", title: "Note", content: "# Topic\nMatching passage", found: true }],
      } })),
    };
    const settings = defaultSettings("Vault");
    const result = await new FederatedRetriever(new OhsMcpClient(() => client)).retrieve(
      "question", settings.ohsEndpoints, { mode: "current", vaultIds: [] }, "Vault",
      { searchLimitPerVault: 8, maxNotes: 1, enableReranking: false, enableRelatedTraversal: false, frontmatterFilters: [] },
    );
    expect(client.callTool).toHaveBeenCalledWith("search", expect.objectContaining({ anchors: true }), expect.any(AbortSignal));
    const packed = packContext(result.sources, { maxContextChars: 1000, maxCharsPerNote: 1000 });
    settings.sessions[0]!.messages.push({ id: "answer", role: "assistant", content: "Answer [S1]", createdAt: "now", sources: packed.sources });
    const restored = loadSettings(sanitizeSettingsForPersistence(settings), "Vault");
    const source = restored.sessions[0]?.messages[0]?.sources?.[0];
    expect(source?.previewAnchors).toEqual([anchors[1], anchors[0]]);
    expect(source?.primaryAnchorIndex).toBe(0);
  });
});
