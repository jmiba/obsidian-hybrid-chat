import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/domain";
import {
  buildConversationSearchQuery,
  buildRecentChatMessages,
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

describe("conversation-aware retrieval", () => {
  it("keeps first-turn searches unchanged", () => {
    expect(buildConversationSearchQuery("Ada publications", [])).toBe("Ada publications");
  });

  it("adds recent user questions to resolve a follow-up", () => {
    expect(buildConversationSearchQuery(
      "What did she publish next?",
      ["Who is Ada?", "What project did Ada lead?"],
    )).toBe([
      "Current question: What did she publish next?",
      "Earlier questions in this chat (for resolving follow-up references):",
      "- Who is Ada?",
      "- What project did Ada lead?",
    ].join("\n"));
  });

  it("does not expose assistant answers to retrieval", () => {
    const query = buildConversationSearchQuery("What happened next?", ["Tell me about Project X"]);
    expect(query).toContain("Tell me about Project X");
    expect(query).not.toContain("assistant");
  });

  it("uses only the bounded number of most recent questions", () => {
    const query = buildConversationSearchQuery("Follow up", ["one", "two", "three"], {
      maxPreviousQuestions: 2,
      maxPreviousCharacters: 100,
    });
    expect(query).not.toContain("- one");
    expect(query).toContain("- two");
    expect(query).toContain("- three");
  });
});
