import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("plugin metadata", () => {
  it("uses a user-visible name without the platform name while preserving the stable ID", () => {
    const parsed: unknown = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
    expect(parsed).toMatchObject({
      id: "obsidian-hybrid-chat",
      name: "Hybrid Chat",
    });
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
