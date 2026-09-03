import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("plugin metadata", () => {
  it("uses a community-compatible plugin ID and user-visible name", () => {
    const manifest = parseRecord(new URL("../manifest.json", import.meta.url));
    expect(manifest).toMatchObject({
      id: "hybrid-chat",
      name: "Hybrid Chat",
    });
    expect(manifest.id).toMatch(/^[a-z-]+$/);
    expect(manifest.id).not.toContain("obsidian");
    expect(manifest.id).not.toMatch(/plugin$/);
  });

  it("keeps package, manifest, and Obsidian compatibility versions aligned", () => {
    const manifest = parseRecord(new URL("../manifest.json", import.meta.url));
    const packageJson = parseRecord(new URL("../package.json", import.meta.url));
    const versions = parseRecord(new URL("../versions.json", import.meta.url));
    expect(packageJson.version).toBe(manifest.version);
    expect(versions[String(manifest.version)]).toBe(manifest.minAppVersion);
  });
});

function parseRecord(url: URL): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${url.pathname} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}
