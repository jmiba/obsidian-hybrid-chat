import { describe, expect, it } from "vitest";
import { messageClipboardText, removeMessageById } from "../src/chat-message-actions";
import type { ChatMessage } from "../src/domain";

const messages: ChatMessage[] = [
  { id: "one", role: "user", content: "**Question**", createdAt: "2026-08-31T00:00:00.000Z" },
  { id: "two", role: "assistant", content: "Answer", createdAt: "2026-08-31T00:00:01.000Z" },
];

describe("individual message actions", () => {
  it("copies the original Markdown content", () => {
    expect(messageClipboardText(messages[0]!)).toBe("**Question**");
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
