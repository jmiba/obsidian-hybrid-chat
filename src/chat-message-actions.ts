import type { ChatMessage } from "./domain";

export function messageClipboardText(message: ChatMessage): string {
  return message.content;
}

export function removeMessageById(messages: ChatMessage[], messageId: string): {
  messages: ChatMessage[];
  removed: boolean;
} {
  const filtered = messages.filter((message) => message.id !== messageId);
  return { messages: filtered, removed: filtered.length !== messages.length };
}
