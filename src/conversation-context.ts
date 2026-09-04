import type { ChatCompletionMessage, ChatMessage } from "./domain";

export const DEFAULT_CHAT_HISTORY_MESSAGES = 12;
export const DEFAULT_CHAT_HISTORY_CHARACTERS = 12_000;

export interface ChatHistoryOptions {
  maxMessages?: number;
  maxCharacters?: number;
}

const RELATED_NOTE_INTENT = /\b(?:backlinks?|cit(?:e[sd]?|ing|ations?)|connect(?:ed|ion|ions|s)?|depend(?:s|ed|ency|encies)?|influenc(?:e[sd]?|ing)|link(?:s|ed)?|multi[- ]hop|references?|relate[ds]?|relationships?|abhängig(?:keit|keiten)?|beziehung(?:en)?|mehrstufig|referenz(?:en|iert)?|verknüpf(?:t|ung|ungen)?|verweist|zusammenhang|zitate?|zitiert)\b/iu;

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

/** Restrict graph expansion to questions that explicitly ask about relationships. */
export function shouldTraverseRelatedNotes(question: string): boolean {
  return RELATED_NOTE_INTENT.test(normalizeQuestion(question));
}

function normalizeQuestion(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
