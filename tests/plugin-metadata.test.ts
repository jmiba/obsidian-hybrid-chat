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
});
