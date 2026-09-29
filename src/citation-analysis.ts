import type { ChatMessage, RetrievedSource } from "./domain";

export interface CitedSource {
  source: RetrievedSource;
  /** Display number assigned in the order the source was first cited. */
  number: number;
  /** 1-based position of the source in the retrieved source list. */
  retrievalNumber: number;
}

export interface UncitedSource {
  source: RetrievedSource;
  /** 1-based position of the source in the retrieved source list. */
  retrievalNumber: number;
}

export interface CitationAnalysis {
  /** Answer text with source labels rewritten to natural 1..n citation numbers. */
  content: string;
  /** Sources the answer actually cites, ordered by first citation. */
  cited: CitedSource[];
  /** Sources that were retrieved but never cited, in retrieval order. */
  uncited: UncitedSource[];
  /** Count of citation markers that did not match any retrieved source. */
  unknownMarkers: number;
}

// Some providers insert invisible format characters inside citation brackets.
// They are tolerated only within markers, not stripped from the answer globally.
const CITATION_MARKER = /\[[\s\u200B\u2060\uFEFF]*(?:[Ss]?\d+[\s\u200B\u2060\uFEFF]*,[\s\u200B\u2060\uFEFF]*)*[Ss]?\d+[\s\u200B\u2060\uFEFF]*\]|【[\s\u200B\u2060\uFEFF]*[Ss]?\d+(?:†L\d+-L\d+)?[\s\u200B\u2060\uFEFF]*】|［[\s\u200B\u2060\uFEFF]*[Ss]?\d+[\s\u200B\u2060\uFEFF]*］|〖[\s\u200B\u2060\uFEFF]*[Ss]?\d+[\s\u200B\u2060\uFEFF]*〗|〔[\s\u200B\u2060\uFEFF]*[Ss]?\d+[\s\u200B\u2060\uFEFF]*〕/gu;
const LABEL_NUMBER = /\d+/gu;
const UNVERIFIED_CITATION = "[unverified citation]";

/**
 * Resolves source markers such as `[S1]`, `[1]`, and `【1】` against the
 * retrieved sources. Cited sources are renumbered 1..n in the order they are
 * first cited so the displayed markers read in a natural order, mirroring the
 * citation check used by the ai-service-chatbot project.
 */
export function analyzeCitations(content: string, sources: RetrievedSource[]): CitationAnalysis {
  const numberBySourceIndex = new Map<number, number>();
  let nextNumber = 1;
  let unknownMarkers = 0;

  // Narrow no-break spaces between ordinary words prevent answers from wrapping
  // in Obsidian's narrow sidebar. Keep the persisted model output untouched.
  const rewritten = content.replace(/\u202F/gu, " ").replace(CITATION_MARKER, (marker) => {
    const markerWithoutLineLocator = marker.split("†", 1)[0] ?? marker;
    const indices = (markerWithoutLineLocator.match(LABEL_NUMBER) ?? []).map((label) => Number(label) - 1);
    if (indices.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= sources.length)) {
      unknownMarkers += 1;
      return UNVERIFIED_CITATION;
    }
    const numbers = indices.map((index) => {
      const known = numberBySourceIndex.get(index);
      if (known !== undefined) return known;
      numberBySourceIndex.set(index, nextNumber);
      nextNumber += 1;
      return nextNumber - 1;
    });
    return `[${numbers.join(", ")}]`;
  });

  const cited: CitedSource[] = [];
  for (const [sourceIndex, number] of numberBySourceIndex) {
    const source = sources[sourceIndex];
    if (!source) continue;
    cited.push({ source, number, retrievalNumber: sourceIndex + 1 });
  }
  cited.sort((left, right) => left.number - right.number);

  const citedIndexes = new Set<number>(numberBySourceIndex.keys());
  const uncited: UncitedSource[] = [];
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    if (!source || citedIndexes.has(index)) continue;
    uncited.push({ source, retrievalNumber: index + 1 });
  }

  return { content: rewritten, cited, uncited, unknownMarkers };
}

/**
 * Returns the answer text to show for a message: assistant answers that carry
 * sources are rendered with renumbered citation markers, everything else is
 * returned untouched.
 */
export function displayMessageContent(message: Pick<ChatMessage, "role" | "content" | "sources">): string {
  if (message.role !== "assistant") return message.content;
  if (!message.sources?.length) return message.content.replace(/\u202F/gu, " ");
  return analyzeCitations(message.content, message.sources).content;
}
