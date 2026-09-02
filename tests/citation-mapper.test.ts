import { vi, describe, expect, it } from "vitest";

vi.mock("obsidian", () => ({ App: class {}, TFile: class {} }));

import { TFile } from "obsidian";
import type { App } from "obsidian";
import type { RetrievedSource } from "../src/domain";
import { buildObsidianOpenUri, isValidVaultRelativePath, openCitation } from "../src/citation-mapper";

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
