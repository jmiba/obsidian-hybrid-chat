import { vi, describe, expect, it } from "vitest";

vi.mock("obsidian", () => ({
  Notice: class {},
  PluginSettingTab: class {},
  SecretComponent: class {},
  Setting: class {},
}));

import { defaultSettings, sanitizeSettingsForPersistence } from "../src/settings";

describe("settings sanitization", () => {
  it("persists secret identifiers but drops unexpected plaintext credential fields", () => {
    const settings = defaultSettings("Vault") as ReturnType<typeof defaultSettings> & {
      apiKey?: string;
      providers: Array<ReturnType<typeof defaultSettings>["providers"][number] & { apiKey?: string; password?: string }>;
    };
    settings.apiKey = "top-level-secret";
    settings.providers[0]!.apiKeySecretId = "secret-provider-key";
    settings.providers[0]!.apiKey = "plaintext-secret";
    settings.providers[0]!.password = "plaintext-password";
    settings.includeCurrentDateTime = true;
    settings.customSystemPrompt = "Answer in German.";
    settings.enableOhsReranking = true;

    const persisted = sanitizeSettingsForPersistence(settings);
    expect(persisted.providers[0]?.apiKeySecretId).toBe("secret-provider-key");
    expect(JSON.stringify(persisted)).not.toContain("plaintext-secret");
    expect(JSON.stringify(persisted)).not.toContain("plaintext-password");
    expect(JSON.stringify(persisted)).not.toContain("top-level-secret");
    expect(persisted.includeCurrentDateTime).toBe(true);
    expect(persisted.customSystemPrompt).toBe("Answer in German.");
    expect(persisted.enableOhsReranking).toBe(true);
  });

  it("creates a persistence snapshot without detaching live streaming references", () => {
    const settings = defaultSettings("Vault");
    const session = settings.sessions[0]!;
    const message = {
      id: "message-1",
      role: "assistant" as const,
      content: "",
      createdAt: new Date().toISOString(),
    };
    session.messages.push(message);
    const persisted = sanitizeSettingsForPersistence(settings);

    message.content = "streamed answer";
    expect(settings.sessions[0]?.messages[0]?.content).toBe("streamed answer");
    expect(persisted.sessions[0]?.messages[0]?.content).toBe("");
  });
});
