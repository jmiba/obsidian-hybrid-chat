import { vi, describe, expect, it } from "vitest";

vi.mock("obsidian", () => ({
  Notice: class {},
  PluginSettingTab: class {},
  SecretComponent: class {},
  Setting: class {},
}));

import { defaultSettings, loadSettings, sanitizeSettingsForPersistence } from "../src/settings";

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
    expect(persisted.queryExpansionMode).toBe("follow-ups");
    expect(persisted.ohsEndpoints[0]?.requestTimeoutMs).toBe(60_000);
  });

  it("migrates query expansion safely and preserves valid choices", () => {
    expect(loadSettings({}, "Vault").queryExpansionMode).toBe("follow-ups");
    expect(loadSettings({ queryExpansionMode: "always" }, "Vault").queryExpansionMode).toBe("always");
    expect(loadSettings({ queryExpansionMode: "invalid" }, "Vault").queryExpansionMode).toBe("follow-ups");
  });

  it("migrates endpoints without a timeout to the bounded default", () => {
    const loaded = loadSettings({
      ohsEndpoints: [{
        id: "vault",
        displayName: "Vault",
        endpoint: "http://127.0.0.1:3939/mcp",
        obsidianVaultName: "Vault",
        enabled: true,
        selectedByDefault: true,
      }],
    }, "Vault");
    expect(loaded.ohsEndpoints[0]?.requestTimeoutMs).toBe(60_000);
  });

  it("round-trips the last vault scope and selected endpoint IDs", () => {
    const settings = defaultSettings("Vault");
    settings.defaultSelection = { mode: "specific", vaultIds: ["research", "mail"] };

    const persisted = sanitizeSettingsForPersistence(settings);
    settings.defaultSelection.vaultIds.push("later-change");

    expect(persisted.defaultSelection).toEqual({
      mode: "specific",
      vaultIds: ["research", "mail"],
    });
    expect(loadSettings(persisted, "Vault").defaultSelection).toEqual(persisted.defaultSelection);
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
