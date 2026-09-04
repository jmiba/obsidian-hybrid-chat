import { describe, expect, it } from "vitest";
import { chatWorkLabel, shouldExpandSources, shouldShowSources } from "../src/chat-progress";

describe("chat progress presentation", () => {
  it("uses distinct retrieval and generation labels", () => {
    expect(chatWorkLabel("retrieving")).toBe("Searching sources…");
    expect(chatWorkLabel("generating")).toBe("Generating answer…");
  });

  it("hides sources during retrieval and reveals them at streaming or completion", () => {
    expect(shouldShowSources(true, false)).toBe(false);
    expect(shouldShowSources(true, true)).toBe(true);
    expect(shouldShowSources(false, false)).toBe(true);
  });

  it("collapses populated sources and expands empty or unavailable states", () => {
    expect(shouldExpandSources(6, false)).toBe(false);
    expect(shouldExpandSources(0, false)).toBe(true);
    expect(shouldExpandSources(0, true)).toBe(true);
    expect(shouldExpandSources(1, true)).toBe(true);
  });
});
