import { TFile } from "obsidian";
import type { App } from "obsidian";
import type { RetrievedSource } from "./domain";
import { normalizeVaultRelativePath } from "./rank-fusion";

export function isValidVaultRelativePath(path: string): boolean {
  const normalized = normalizeVaultRelativePath(path);
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return false;
  if (normalized.includes("\0") || !normalized.toLowerCase().endsWith(".md")) return false;
  return normalized.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function buildObsidianOpenUri(vaultName: string, path: string): string | null {
  const cleanVault = vaultName.trim();
  const cleanPath = normalizeVaultRelativePath(path).normalize("NFC");
  if (!cleanVault || !isValidVaultRelativePath(cleanPath)) return null;
  return `obsidian://open?vault=${encodeURIComponent(cleanVault)}&file=${encodeURIComponent(cleanPath)}`;
}

export async function openCitation(app: App, source: RetrievedSource): Promise<boolean> {
  if (!isValidVaultRelativePath(source.path)) return false;
  if (source.obsidianVaultName === app.vault.getName()) {
    for (const path of citationPathCandidates(source.path)) {
      const file = app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        await app.workspace.getLeaf(false).openFile(file);
        return true;
      }
    }
    return false;
  }
  const uri = buildObsidianOpenUri(source.obsidianVaultName, source.path);
  if (!uri) return false;
  window.open(uri);
  return true;
}

function citationPathCandidates(path: string): string[] {
  const normalized = normalizeVaultRelativePath(path);
  return [...new Set([normalized, normalized.normalize("NFC"), normalized.normalize("NFD")])];
}
