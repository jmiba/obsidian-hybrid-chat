import { describe, expect, it } from "vitest";
import { parsePreviewAnchors, resolvePreviewAnchor } from "../src/preview-anchors";
import type { PreviewAnchor } from "../src/domain";

function source(anchor: Partial<PreviewAnchor>) {
  return { previewAnchors: [{ headingPath: null, matchText: "", charStart: null, charEnd: null, ...anchor }] };
}

describe("passage navigation anchors", () => {
  it("accounts for frontmatter, CRLF and UTF-16 positions when disambiguating repeated text", () => {
    const body = '# Title\r\nRepeated text\r\n😀 paragraph\r\nRepeated text\r\n';
    const raw = '---\r\ntitle: Anything\r\n---\r\n' + body;
    const start = body.lastIndexOf("Repeated text");
    expect(resolvePreviewAnchor(raw, source({ matchText: "Repeated text", charStart: start, charEnd: body.length })))
      .toEqual({ start: raw.lastIndexOf("Repeated text"), end: raw.lastIndexOf("Repeated text") + 13 });
  });
  it("relocates a stale offset within the correct heading chain", () => {
    const raw = '# One\n## Details\nShared passage\n# Two\nInserted new paragraph\n## Details\nShared passage\n';
    const result = resolvePreviewAnchor(raw, source({ headingPath: "# Two > ## Details", matchText: "Shared passage", charStart: 0, charEnd: 10 }));
    expect(result?.start).toBe(raw.lastIndexOf("Shared passage"));
  });
  it("matches rendered text against Markdown formatting", () => {
    const raw = '# Heading\n**Important** [matching text](https://example.com) in a paragraph.\n';
    expect(resolvePreviewAnchor(raw, source({ matchText: "Important matching text in a paragraph." }))?.start)
      .toBe(raw.indexOf("**Important**"));
  });
  it("uses the heading when text is gone and ignores headings in fenced code", () => {
    const raw = '```md\n## Target\n```\n# Title\n## Target\nNew text\n';
    expect(resolvePreviewAnchor(raw, source({ headingPath: "# Title > ## Target", matchText: "Deleted text", charStart: 999, charEnd: 1000 })))
      .toEqual({ start: raw.lastIndexOf("## Target"), end: raw.lastIndexOf("## Target") });
  });
  it("supports setext headings", () => {
    const raw = 'Heading\n=======\nReplacement text\n';
    expect(resolvePreviewAnchor(raw, source({ headingPath: "Heading", matchText: "Deleted" }))?.start).toBe(0);
  });
  it("does not guess between duplicate text or use an unverified offset", () => {
    expect(resolvePreviewAnchor('Same\nSame\n', source({ matchText: "Same" }))).toBeNull();
    expect(resolvePreviewAnchor('Current text', source({ matchText: "Stale", charStart: 1, charEnd: 7 }))).toBeNull();
  });
  it("preserves the preferred valid anchor while discarding malformed metadata", () => {
    const parsed = parsePreviewAnchors({ primaryAnchorIndex: 2, previewAnchors: [null,
      { headingPath: "Other", matchText: "other", charStart: -1, charEnd: 10 },
      { headingPath: "Preferred", matchText: "correct", charStart: 4, charEnd: 12, unexpected: "discard" },
    ] });
    expect(parsed.primaryAnchorIndex).toBe(0);
    expect(parsed.previewAnchors?.[0]).toEqual({ headingPath: "Preferred", matchText: "correct", charStart: 4, charEnd: 12 });
    expect(parsed.previewAnchors?.[1]?.charStart).toBeNull();
    expect(resolvePreviewAnchor('other\ncorrect', parsed)?.start).toBe(6);
  });
});
