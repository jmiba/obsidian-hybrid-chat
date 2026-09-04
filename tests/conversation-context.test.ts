import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/domain";
import {
  buildRecentChatMessages,
  shouldTraverseRelatedNotes,
} from "../src/conversation-context";

const message = (id: string, role: ChatMessage["role"], content: string): ChatMessage => ({
  id,
  role,
  content,
  createdAt: "2026-09-02T10:00:00.000Z",
});

describe("provider conversation history", () => {
  it("keeps prior turns and the current question while excluding the working reply", () => {
    const history = buildRecentChatMessages([
      message("u1", "user", "Who is Ada?"),
      message("a1", "assistant", "Ada leads the project. [S1]"),
      message("u2", "user", "What did she publish?"),
      message("a2", "assistant", ""),
    ], "a2");

    expect(history).toEqual([
      { role: "user", content: "Who is Ada?" },
      { role: "assistant", content: "Ada leads the project. [S1]" },
      { role: "user", content: "What did she publish?" },
    ]);
  });

  it("bounds older history without truncating the current question", () => {
    const history = buildRecentChatMessages([
      message("u1", "user", "old question"),
      message("a1", "assistant", "old answer"),
      message("u2", "user", "current question is deliberately longer than the budget"),
      message("a2", "assistant", ""),
    ], "a2", { maxMessages: 12, maxCharacters: 10 });

    expect(history).toEqual([{
      role: "user",
      content: "current question is deliberately longer than the budget",
    }]);
  });
});

describe("related-note intent", () => {
  it("limits related-note traversal to explicit relationship intent", () => {
    expect(shouldTraverseRelatedNotes("How does Project A relate to Project B?")).toBe(true);
    expect(shouldTraverseRelatedNotes("Welche Notizen stehen damit im Zusammenhang?")).toBe(true);
    expect(shouldTraverseRelatedNotes("Summarize Project A")).toBe(false);
    expect(shouldTraverseRelatedNotes("What was published in 2024?")).toBe(false);
  });
});
