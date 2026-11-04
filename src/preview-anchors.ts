import type { PreviewAnchor } from "./domain";

/** Normalize both live MCP results and persisted session metadata. */
export function parsePreviewAnchors(value: { previewAnchors?: unknown; primaryAnchorIndex?: unknown }): {
  previewAnchors?: PreviewAnchor[];
  primaryAnchorIndex?: number;
} {
  if (!Array.isArray(value.previewAnchors)) return {};
  const raw = value.previewAnchors.slice(0, 8);
  const preferred = typeof value.primaryAnchorIndex === "number" && Number.isInteger(value.primaryAnchorIndex)
    ? value.primaryAnchorIndex : 0;
  const ordered = raw.map((anchor: unknown, index: number) => ({ anchor, index }))
    .sort((a, b) => Number(b.index === preferred) - Number(a.index === preferred));
  const anchors = ordered.flatMap(({ anchor }) => {
    if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) return [];
    const item = anchor as Record<string, unknown>;
    const headingPath = typeof item.headingPath === "string" ? item.headingPath.slice(0, 2000) : null;
    const matchText = typeof item.matchText === "string" ? item.matchText.slice(0, 500) : "";
    const start = item.charStart;
    const end = item.charEnd;
    const validOffsets = typeof start === "number" && Number.isSafeInteger(start) && start >= 0
      && typeof end === "number" && Number.isSafeInteger(end) && end > start;
    if (!headingPath?.trim() && !matchText.trim()) return [];
    return [{ headingPath, matchText, charStart: validOffsets ? start : null, charEnd: validOffsets ? end : null }];
  });
  return anchors.length ? { previewAnchors: anchors, primaryAnchorIndex: 0 } : {};
}

export function anchorHeading(anchor: PreviewAnchor): string | null {
  const heading = headingParts(anchor.headingPath).at(-1);
  // These characters have special subpath semantics in Obsidian links.
  return heading && !/[#^\r\n\0]/u.test(heading) ? heading : null;
}

export interface PassageLocation { start: number; end: number }
interface Heading extends PassageLocation { level: number; chain: string[] }

/** Resolve against current raw Markdown; never trust an old offset by itself. */
export function resolvePreviewAnchor(raw: string, source: {
  previewAnchors?: PreviewAnchor[]; primaryAnchorIndex?: number;
}): PassageLocation | null {
  const anchors = parsePreviewAnchors(source).previewAnchors ?? [];
  if (!anchors.length) return null;
  const bodyStart = raw.match(/^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/u)?.[0].length ?? 0;
  const headings = markdownHeadings(raw, bodyStart);
  for (const anchor of anchors) {
    const parts = headingParts(anchor.headingPath).map(normalize);
    const exact = headings.filter((heading) => heading.chain.join("\0") === parts.join("\0"));
    const terminal = headings.filter((heading) => heading.chain.at(-1) === parts.at(-1));
    const heading = exact.length === 1 ? exact[0] : terminal.length === 1 ? terminal[0] : undefined;
    const match = anchor.matchText.trim();
    if (match) {
      if (anchor.charStart !== null && anchor.charEnd !== null) {
        const start = bodyStart + anchor.charStart;
        const end = bodyStart + anchor.charEnd;
        if (end <= raw.length && (!heading || (start >= heading.start && start < heading.end))) {
          const found = findText(raw, match, start, end);
          if (found.length === 1) return found[0]!;
        }
      }
      if (heading) {
        const found = findText(raw, match, heading.start, heading.end);
        if (found.length === 1) return found[0]!;
      }
      const found = findText(raw, match, bodyStart, raw.length);
      if (found.length === 1) return found[0]!;
    }
    if (heading) return { start: heading.start, end: heading.start };
  }
  return null;
}

function headingParts(path: string | null): string[] {
  return (path ?? "").split(/\s+>\s+/u).map((part) => part.trim().replace(/^#{1,6}\s+/u, "").replace(/\s+#+$/u, "")).filter(Boolean);
}

function normalize(value: string): string {
  return value.replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/gu, "$2")
    .replace(/\[\[([^\]]+)\]\]/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<[^>]*>/gu, "")
    .replace(/[*_`~]/gu, "")
    .replace(/^\s*(?:>\s*)*(?:#{1,6}\s+|[-+*]\s+|\d+[.)]\s+)?(?:\[[ xX]\]\s*)?/u, "")
    .replace(/\s+/gu, " ").trim().normalize("NFC").toLocaleLowerCase();
}

function findText(raw: string, match: string, start: number, end: number): PassageLocation[] {
  const text = raw.slice(start, end);
  const exact = text.indexOf(match);
  if (exact >= 0) {
    if (text.indexOf(match, exact + 1) >= 0) return [];
    return [{ start: start + exact, end: start + exact + match.length }];
  }
  const needle = normalize(match);
  if (!needle) return [];
  const found: PassageLocation[] = [];
  let offset = start;
  for (const line of text.split("\n")) {
    // OHS matchText is a rendered, single-line excerpt. When markup changes its
    // character width, selecting the matching Markdown line is more reliable.
    if (normalize(line).includes(needle)) found.push({ start: offset, end: offset + line.replace(/\r$/u, "").length });
    offset += line.length + 1;
  }
  return found;
}

function markdownHeadings(raw: string, start: number): Heading[] {
  const lines = raw.slice(start).split("\n");
  const headings: Heading[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let offset = start;
  let fence: { char: string; length: number } | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    if (marker) {
      if (!fence) fence = { char: marker[0]!, length: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/u.test(line)) fence = null;
    } else if (!fence) {
      const atx = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u);
      const setext = line.trim() && lines[index + 1]?.match(/^ {0,3}(=+|-+)\s*$/u);
      const level = atx ? atx[1]!.length : setext ? (setext[1]![0] === "=" ? 1 : 2) : 0;
      if (level) {
        while (stack.length && stack.at(-1)!.level >= level) stack.pop();
        stack.push({ level, title: normalize(atx?.[2] ?? line) });
        headings.push({ start: offset, end: raw.length, level, chain: stack.map((item) => item.title) });
      }
    }
    offset += line.length + 1;
  }
  const pending: Heading[] = [];
  for (const heading of headings) {
    while (pending.length && pending.at(-1)!.level >= heading.level) pending.pop()!.end = heading.start;
    pending.push(heading);
  }
  return headings;
}
