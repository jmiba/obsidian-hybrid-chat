import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestUrl } = vi.hoisted(() => ({ requestUrl: vi.fn() }));
vi.mock("obsidian", () => ({ requestUrl }));

import type { ChatProviderProfile } from "../src/domain";
import { OpenAiCompatibleModelClient } from "../src/openai-model-client";
import { buildOpenAiCompatibleUrl } from "../src/openai-provider-url";

const profile: ChatProviderProfile = {
  id: "provider",
  displayName: "Provider",
  baseUrl: "https://example.com/v1",
  model: "",
  apiKeySecretId: "provider-key",
  enabled: true,
};

describe("OpenAI-compatible model discovery", () => {
  beforeEach(() => requestUrl.mockReset());

  it("builds matching model and chat endpoints from supported base URL forms", () => {
    expect(buildOpenAiCompatibleUrl("http://localhost:1234", "models").toString())
      .toBe("http://localhost:1234/v1/models");
    expect(buildOpenAiCompatibleUrl("http://localhost:1234/v1/", "models").toString())
      .toBe("http://localhost:1234/v1/models");
    expect(buildOpenAiCompatibleUrl("http://localhost:1234/v1/chat/completions", "models").toString())
      .toBe("http://localhost:1234/v1/models");
    expect(buildOpenAiCompatibleUrl("http://localhost:1234/v1/models", "chat/completions").toString())
      .toBe("http://localhost:1234/v1/chat/completions");
  });

  it("loads, deduplicates, and sorts model IDs using the configured API key", async () => {
    requestUrl.mockResolvedValueOnce(response({
      object: "list",
      data: [
        { id: "z-model", type: "llm" },
        { id: "embedding-model", type: "embedding" },
        { id: "a-model" },
        { id: "z-model" },
        { owned_by: "unknown" },
      ],
    }));

    await expect(new OpenAiCompatibleModelClient().list(profile, "secret-value"))
      .resolves.toEqual(["a-model", "z-model"]);
    expect(requestUrl).toHaveBeenCalledWith({
      url: "https://example.com/v1/models",
      method: "GET",
      headers: { accept: "application/json", authorization: "Bearer secret-value" },
      throw: false,
    });
  });

  it("rejects HTTP errors and incompatible response shapes", async () => {
    requestUrl.mockResolvedValueOnce(response({ error: "unauthorized" }, 401));
    await expect(new OpenAiCompatibleModelClient().list(profile, ""))
      .rejects.toThrow("Model discovery returned HTTP 401");

    requestUrl.mockResolvedValueOnce(response({ models: [{ id: "model" }] }));
    await expect(new OpenAiCompatibleModelClient().list(profile, ""))
      .rejects.toThrow("does not contain a data array");
  });
});

function response(body: unknown, status = 200): { status: number; text: string } {
  return { status, text: typeof body === "string" ? body : JSON.stringify(body) };
}
