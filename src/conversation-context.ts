import type { ChatCompletionMessage, ChatMessage, QueryExpansionMode } from "./domain";

export const DEFAULT_CHAT_HISTORY_MESSAGES = 12;
export const DEFAULT_CHAT_HISTORY_CHARACTERS = 12_000;
export const DEFAULT_RETRIEVAL_HISTORY_QUESTIONS = 3;
export const DEFAULT_RETRIEVAL_HISTORY_CHARACTERS = 3_000;
export const DEFAULT_RETRIEVAL_QUERY_VARIANTS = 3;

export interface ChatHistoryOptions {
  maxMessages?: number;
  maxCharacters?: number;
}

export interface RetrievalHistoryOptions {
  maxPreviousQuestions?: number;
  maxPreviousCharacters?: number;
  maxQueryVariants?: number;
  expansionMode?: QueryExpansionMode;
}

const FOLLOW_UP_REFERENCE = /(?:^(?:and|also|then|next|what about|how about|und|auch|dann|danach|was ist mit|wie sieht es mit)\b|\b(?:it|its|they|them|their|he|him|his|she|her|hers|this|that|these|those|former|latter|there|er|sie|ihm|ihn|ihr|ihre|dies|diese|dieser|dieses|das|davon|dazu|darüber|dort)\b)/iu;

const QUERY_STOP_WORDS = new Set([
  "a", "about", "an", "and", "are", "as", "at", "be", "been", "by", "can", "could", "did", "do", "does",
  "for", "from", "had", "has", "have", "he", "her", "him", "his", "how", "i", "in", "is", "it", "its", "me",
  "of", "on", "or", "please", "she", "tell", "that", "the", "their", "them", "they", "this", "to", "was",
  "were", "what", "when", "where", "which", "who", "why", "with", "would",
  "als", "am", "an", "auch", "auf", "aus", "bei", "bitte", "das", "dem", "den", "der", "des", "die", "ein",
  "eine", "einer", "eines", "für", "hat", "ich", "im", "in", "ist", "kann", "könnte", "man", "mit", "nach",
  "oder", "sein", "seine", "sie", "sind", "über", "und", "von", "war", "was", "welche", "welcher", "welches", "wenn",
  "wer", "wie", "wo", "zu",
]);

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

/**
 * Builds a small, deterministic set of OHS queries. The original question is
 * always first. By default, conversation context is added only for a likely
 * follow-up. A compact lexical variant is available as an explicit opt-in
 * because OHS gives every query variant influence during RRF fusion.
 */
export function buildRetrievalQueries(
  currentQuestion: string,
  previousQuestions: string[],
  options: RetrievalHistoryOptions = {},
): string[] {
  const current = normalizeQuestion(currentQuestion);
  if (!current) return [""];

  const expansionMode = options.expansionMode ?? "follow-ups";
  if (expansionMode === "off") return [current];

  const maxVariants = Math.max(1, options.maxQueryVariants ?? DEFAULT_RETRIEVAL_QUERY_VARIANTS);
  const variants: string[] = [];
  const addVariant = (value: string): void => {
    const normalized = normalizeQuestion(value);
    if (!normalized || variants.some((item) => item.toLocaleLowerCase() === normalized.toLocaleLowerCase())) return;
    variants.push(normalized);
  };

  addVariant(current);
  const contextDependent = FOLLOW_UP_REFERENCE.test(current);
  const contextual = contextDependent
    ? buildConversationSearchQuery(current, previousQuestions, options)
    : current;
  if (contextDependent) addVariant(contextual);

  if (expansionMode === "always") {
    const lexicalInput = contextDependent
      ? `${recentQuestions(previousQuestions, options).join(" ")} ${current}`
      : current;
    addVariant(buildLexicalVariant(lexicalInput));
  }
  return variants.slice(0, maxVariants);
}

function recentQuestions(
  previousQuestions: string[],
  options: RetrievalHistoryOptions,
): string[] {
  const maxQuestions = Math.max(0, options.maxPreviousQuestions ?? DEFAULT_RETRIEVAL_HISTORY_QUESTIONS);
  let remaining = Math.max(0, options.maxPreviousCharacters ?? DEFAULT_RETRIEVAL_HISTORY_CHARACTERS);
  const selected: string[] = [];
  for (let index = previousQuestions.length - 1; index >= 0 && selected.length < maxQuestions; index -= 1) {
    const question = normalizeQuestion(previousQuestions[index] ?? "");
    if (!question) continue;
    if (question.length > remaining) break;
    selected.unshift(question);
    remaining -= question.length;
  }
  return selected;
}

function buildLexicalVariant(value: string): string {
  const tokens = value.match(/[\p{L}\p{N}][\p{L}\p{N}_'’.-]*/gu) ?? [];
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const folded = token.toLocaleLowerCase();
    if (QUERY_STOP_WORDS.has(folded) || seen.has(folded)) continue;
    if (token.length < 2 && !/^\d+$/u.test(token)) continue;
    selected.push(token);
    seen.add(folded);
    if (selected.length >= 16) break;
  }
  return selected.length >= 2 ? selected.join(" ") : "";
}

function normalizeQuestion(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
