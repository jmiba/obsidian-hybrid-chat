import { vi, describe, expect, it } from "vitest";

vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, MarkdownView: class {} }));

import { MarkdownView, TFile } from "obsidian";
import type { App } from "obsidian";
import type { RetrievedSource } from "../src/domain";
import { buildObsidianOpenUri, buildSourceOpenUri, isValidVaultRelativePath, openCitation } from "../src/citation-mapper";

describe("citation validation", () => {
  it("accepts safe Markdown paths and encodes cross-vault URIs", () => {
    expect(isValidVaultRelativePath("Folder/My note.md")).toBe(true);
    expect(buildObsidianOpenUri("Research Vault", "Folder/My note.md"))
      .toBe("obsidian://open?vault=Research%20Vault&file=Folder%2FMy%20note.md");
  });

  it("rejects traversal, absolute paths, non-Markdown targets, and missing vault names", () => {
    expect(isValidVaultRelativePath("../secret.md")).toBe(false);
    expect(isValidVaultRelativePath("/absolute.md")).toBe(false);
    expect(isValidVaultRelativePath("note.pdf")).toBe(false);
    expect(buildObsidianOpenUri("", "note.md")).toBeNull();
  });

  it("opens a local citation when OHS and Obsidian use canonically equivalent Unicode paths", async () => {
    const ohsPath = "Mail Archive/Buchungsbesta\u0308tigung/Ticket.pdf.md";
    const obsidianPath = ohsPath.normalize("NFC");
    const file = new TFile();
    const openFile = vi.fn().mockResolvedValue(undefined);
    const getAbstractFileByPath = vi.fn((path: string) => path === obsidianPath ? file : null);
    const app = {
      vault: {
        getName: () => "Mail-Vault",
        getAbstractFileByPath,
      },
      workspace: {
        getLeaf: () => ({ openFile }),
      },
    } as unknown as App;
    const source = {
      path: ohsPath,
      obsidianVaultName: "Mail-Vault",
    } as RetrievedSource;

    await expect(openCitation(app, source)).resolves.toBe(true);
    expect(getAbstractFileByPath).toHaveBeenNthCalledWith(1, ohsPath);
    expect(getAbstractFileByPath).toHaveBeenNthCalledWith(2, obsidianPath);
    expect(openFile).toHaveBeenCalledWith(file);
  });

  it("normalizes cross-vault citation URIs to composed Unicode", () => {
    const ohsPath = "Mail Archive/Buchungsbesta\u0308tigung/Ticket.pdf.md";

    expect(buildObsidianOpenUri("Mail-Vault", ohsPath))
      .toBe(`obsidian://open?vault=Mail-Vault&file=${encodeURIComponent(ohsPath.normalize("NFC"))}`);
  });
});


describe("citation passage navigation", () => {
  const raw = "---\ntitle: Note\n---\n# Topic\nBefore\nMatching passage here\n";
  function setup(mode: "source" | "preview") {
    const file = Object.assign(new TFile(), { path: "note.md" });
    const editor = { getValue: () => raw, setSelection: vi.fn(), scrollIntoView: vi.fn() };
    const view = Object.assign(new MarkdownView({} as never), { file, editor, getMode: () => mode, getViewData: () => raw });
    const leaf = { view, openFile: vi.fn().mockResolvedValue(undefined), setEphemeralState: vi.fn() };
    const app = { vault: { getName: () => "Vault", getAbstractFileByPath: () => file }, workspace: { getLeaf: () => leaf } } as unknown as App;
    const source = { path: "note.md", obsidianVaultName: "Vault", previewAnchors: [{ headingPath: "# Topic", matchText: "Matching passage here", charStart: 0, charEnd: 1 }] } as RetrievedSource;
    return { app, source, editor, leaf };
  }
  it("selects and centers the current matching passage in the editor", async () => {
    const { app, source, editor } = setup("source");
    await expect(openCitation(app, source)).resolves.toBe(true);
    expect(editor.setSelection).toHaveBeenCalledWith({ line: 5, ch: 0 }, { line: 5, ch: 21 });
    expect(editor.scrollIntoView).toHaveBeenCalledWith({ from: { line: 5, ch: 0 }, to: { line: 5, ch: 21 } }, true);
  });
  it("uses line navigation in reading mode without switching modes", async () => {
    const { app, source, editor, leaf } = setup("preview");
    await openCitation(app, source);
    expect(leaf.setEphemeralState).toHaveBeenCalledWith({ line: 5 });
    expect(editor.setSelection).not.toHaveBeenCalled();
  });
  it("still opens the note when every anchor is stale", async () => {
    const { app, source, editor, leaf } = setup("source");
    source.previewAnchors = [{ headingPath: null, matchText: "Missing", charStart: 999, charEnd: 1000 }];
    await expect(openCitation(app, source)).resolves.toBe(true);
    expect(leaf.openFile).toHaveBeenCalledOnce();
    expect(editor.setSelection).not.toHaveBeenCalled();
  });
  it("encodes cross-vault heading jumps without adding arbitrary URI parameters", () => {
    const source = { obsidianVaultName: "Other", path: "Notes/My note.md", previewAnchors: [{ headingPath: "# Root > ## Costs & scope", matchText: "Match", charStart: 0, charEnd: 5 }] } as RetrievedSource;
    expect(buildSourceOpenUri(source)).toBe("obsidian://open?vault=Other&file=Notes%2FMy%20note.md%23Costs%20%26%20scope");
    source.previewAnchors![0]!.headingPath = "# ^block";
    expect(buildSourceOpenUri(source)).toBe("obsidian://open?vault=Other&file=Notes%2FMy%20note.md");
  });
});
