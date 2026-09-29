import { describe, expect, it } from "vitest";
import { messageClipboardText, removeMessageById } from "../src/chat-message-actions";
import type { ChatMessage, RetrievedSource } from "../src/domain";

const messages: ChatMessage[] = [
  { id: "one", role: "user", content: "**Question**", createdAt: "2026-08-31T00:00:00.000Z" },
  { id: "two", role: "assistant", content: "Answer", createdAt: "2026-08-31T00:00:01.000Z" },
];

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

describe("individual message actions", () => {
  it("copies the original Markdown content", () => {
    expect(messageClipboardText(messages[0]!)).toBe("**Question**");
  });

  it("copies an assistant answer with renumbered citation markers", () => {
    const message: ChatMessage = {
      id: "three",
      role: "assistant",
      content: "A claim [S2] and another [S1].",
      createdAt: "2026-08-31T00:00:02.000Z",
      sources: [makeSource(1), makeSource(2)],
    };

    expect(messageClipboardText(message)).toBe("A claim [1] and another [2].");
  });

  it("deletes only the selected message", () => {
    expect(removeMessageById(messages, "one")).toEqual({
      messages: [messages[1]],
      removed: true,
    });
    expect(messages).toHaveLength(2);
  });

  it("leaves the list unchanged when the message no longer exists", () => {
    expect(removeMessageById(messages, "missing")).toEqual({ messages, removed: false });
  });
});
