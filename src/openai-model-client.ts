import { requestUrl } from "obsidian";
import type { ChatProviderProfile } from "./domain";
import { buildOpenAiCompatibleUrl } from "./openai-provider-url";

export class OpenAiCompatibleModelClient {
  async list(profile: ChatProviderProfile, apiKey: string): Promise<string[]> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const response = await requestUrl({
      url: buildOpenAiCompatibleUrl(profile.baseUrl, "models").toString(),
      method: "GET",
      headers,
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Model discovery returned HTTP ${response.status}: ${response.text.slice(0, 1000)}`);
    }

    let value: unknown;
    try {
      value = JSON.parse(response.text) as unknown;
    } catch {
      throw new Error("Model discovery returned invalid JSON");
    }
    const record = asRecord(value);
    if (!record || !Array.isArray(record.data)) {
      throw new Error("Model discovery response does not contain a data array");
    }
    return [...new Set(record.data.flatMap((item) => {
      const model = asRecord(item);
      const id = model?.id;
      const type = typeof model?.type === "string" ? model.type.toLowerCase() : "";
      if (type === "embedding" || type === "embeddings") return [];
      return typeof id === "string" && id.trim() ? [id.trim()] : [];
    }))].sort((left, right) => left.localeCompare(right));
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}
