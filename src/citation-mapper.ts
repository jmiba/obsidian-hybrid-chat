import { MarkdownView, TFile } from "obsidian";
import type { App } from "obsidian";
import type { RetrievedSource } from "./domain";
import { anchorHeading, parsePreviewAnchors, resolvePreviewAnchor } from "./preview-anchors";
import { normalizeVaultRelativePath } from "./rank-fusion";

export function isValidVaultRelativePath(path: string): boolean {
  const normalized = normalizeVaultRelativePath(path);
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return false;
  if (normalized.includes("\0") || !normalized.toLowerCase().endsWith(".md")) return false;
  return normalized.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function buildObsidianOpenUri(vaultName: string, path: string, heading?: string | null): string | null {
  const cleanVault = vaultName.trim();
  const cleanPath = normalizeVaultRelativePath(path).normalize("NFC");
  if (!cleanVault || !isValidVaultRelativePath(cleanPath)) return null;
  const subpath = heading && !/[#^\r\n\0]/u.test(heading) ? `#${heading.normalize("NFC")}` : "";
  return `obsidian://open?vault=${encodeURIComponent(cleanVault)}&file=${encodeURIComponent(cleanPath + subpath)}`;
}

export async function openCitation(app: App, source: RetrievedSource): Promise<boolean> {
  if (!isValidVaultRelativePath(source.path)) return false;
  if (source.obsidianVaultName === app.vault.getName()) {
    for (const path of citationPathCandidates(source.path)) {
      const file = app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        const leaf = app.workspace.getLeaf(false);
        await leaf.openFile(file);
        if (source.previewAnchors?.length) {
          // The file can have changed since retrieval. Resolve using the live
          // view (including unsaved edits), never the stored OHS read response.
          try {
            const view = leaf.view;
            if (view instanceof MarkdownView && view.file?.path === file.path) {
              const raw = view.getMode() === "source" ? view.editor.getValue() : view.getViewData();
              const passage = resolvePreviewAnchor(raw, source);
              if (passage) {
                const start = positionAt(raw, passage.start);
                const end = positionAt(raw, passage.end);
                if (view.getMode() === "source") {
                  view.editor.setSelection(start, end);
                  view.editor.scrollIntoView({ from: start, to: end }, true);
                } else leaf.setEphemeralState({ line: start.line });
              }
            }
          } catch {
            // Opening the note still succeeded if passage navigation is unavailable.
          }
        }
        return true;
      }
    }
    return false;
  }
  const uri = buildSourceOpenUri(source);
  if (!uri) return false;
  window.open(uri);
  return true;
}

function citationPathCandidates(path: string): string[] {
  const normalized = normalizeVaultRelativePath(path);
  return [...new Set([normalized, normalized.normalize("NFC"), normalized.normalize("NFD")])];
}


/** Cross-vault navigation uses Obsidian's standard heading subpath support. */
export function buildSourceOpenUri(source: RetrievedSource): string | null {
  const heading = parsePreviewAnchors(source).previewAnchors?.map(anchorHeading).find((value) => value !== null);
  return buildObsidianOpenUri(source.obsidianVaultName, source.path, heading);
}

function positionAt(text: string, offset: number): { line: number; ch: number } {
  const preceding = text.slice(0, offset);
  const line = preceding.split("\n").length - 1;
  const newline = preceding.lastIndexOf("\n");
  return { line, ch: offset - newline - 1 };
}
