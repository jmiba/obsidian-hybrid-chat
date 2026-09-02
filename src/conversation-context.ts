import type { ChatCompletionMessage, ChatMessage } from "./domain";

export const DEFAULT_CHAT_HISTORY_MESSAGES = 12;
export const DEFAULT_CHAT_HISTORY_CHARACTERS = 12_000;
export const DEFAULT_RETRIEVAL_HISTORY_QUESTIONS = 3;
export const DEFAULT_RETRIEVAL_HISTORY_CHARACTERS = 3_000;

export interface ChatHistoryOptions {
  maxMessages?: number;
  maxCharacters?: number;
}

export interface RetrievalHistoryOptions {
  maxPreviousQuestions?: number;
  maxPreviousCharacters?: number;
}

/**
 * Builds a provider-safe recent transcript. The latest message is always kept
 * intact; older messages are included only while both bounds permit it.
 */
export function buildRecentChatMessages(
  messages: ChatMessage[],
  excludedMessageId: string,
  options: ChatHistoryOptions = {},
): ChatCompletionMessage[] {
  const maxMessages = Math.max(1, options.maxMessages ?? DEFAULT_CHAT_HISTORY_MESSAGES);
  const maxCharacters = Math.max(0, options.maxCharacters ?? DEFAULT_CHAT_HISTORY_CHARACTERS);
  const candidates = messages.filter((message) => (
    message.id !== excludedMessageId && message.content.trim().length > 0
  ));
  const latest = candidates.at(-1);
  if (!latest) return [];

  const selected: ChatMessage[] = [latest];
  let remainingCharacters = Math.max(0, maxCharacters - latest.content.length);
  for (let index = candidates.length - 2; index >= 0 && selected.length < maxMessages; index -= 1) {
    const message = candidates[index];
    if (!message) continue;
    if (message.content.length > remainingCharacters) break;
    selected.unshift(message);
    remainingCharacters -= message.content.length;
  }

  return selected.map((message) => ({ role: message.role, content: message.content }));
}

/**
 * Adds a small number of earlier user questions to the OHS search text so
 * pronouns and shorthand in a follow-up retain their conversational subject.
 * Assistant answers are intentionally not sent to retrieval endpoints.
 */
export function buildConversationSearchQuery(
  currentQuestion: string,
  previousQuestions: string[],
  options: RetrievalHistoryOptions = {},
): string {
  const current = normalizeQuestion(currentQuestion);
  const maxPreviousQuestions = Math.max(
    0,
    options.maxPreviousQuestions ?? DEFAULT_RETRIEVAL_HISTORY_QUESTIONS,
  );
  let remainingCharacters = Math.max(
    0,
    options.maxPreviousCharacters ?? DEFAULT_RETRIEVAL_HISTORY_CHARACTERS,
  );
  const selected: string[] = [];

  for (let index = previousQuestions.length - 1;
    index >= 0 && selected.length < maxPreviousQuestions;
    index -= 1) {
    const question = normalizeQuestion(previousQuestions[index] ?? "");
    if (!question) continue;
    if (question.length > remainingCharacters) break;
    selected.unshift(question);
    remainingCharacters -= question.length;
  }

  if (selected.length === 0) return current;
  return [
    `Current question: ${current || "(follow-up using the earlier questions)"}`,
    "Earlier questions in this chat (for resolving follow-up references):",
    ...selected.map((question) => `- ${question}`),
  ].join("\n");
}

function normalizeQuestion(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
