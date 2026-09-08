import { vi, describe, expect, it } from "vitest";

vi.mock("obsidian", () => ({
  Notice: class {},
  PluginSettingTab: class {},
  SecretComponent: class {},
  Setting: class {},
}));

import {
  defaultSettings,
  HybridChatSettingTab,
  loadSettings,
  sanitizeSettingsForPersistence,
} from "../src/settings";

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
    expect(persisted.enableRelatedNoteTraversal).toBe(false);
    expect(persisted.ohsEndpoints[0]?.requestTimeoutMs).toBe(60_000);
  });

  it("drops legacy query-expansion settings", () => {
    expect(loadSettings({ queryExpansionMode: "always" }, "Vault"))
      .not.toHaveProperty("queryExpansionMode");
  });

  it("keeps related-note traversal opt-in", () => {
    expect(loadSettings({}, "Vault").enableRelatedNoteTraversal).toBe(false);
    expect(loadSettings({ enableRelatedNoteTraversal: true }, "Vault").enableRelatedNoteTraversal).toBe(true);
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

  it("treats blank persisted numeric values as missing instead of minimum values", () => {
    const loaded = loadSettings({
      searchLimitPerVault: "",
      maxNotes: " ",
      maxContextChars: "",
      maxCharsPerNote: "",
    }, "Vault");
    expect(loaded).toMatchObject({
      searchLimitPerVault: 8,
      maxNotes: 6,
      maxContextChars: 24_000,
      maxCharsPerNote: 6_000,
    });
  });

  it("does not persist blank numeric edits and reflects clamped values", () => {
    const { tab, plugin } = settingTab();
    const control = renderTextSetting(tab, "Retrieval", "Total context characters");

    control.change("");
    expect(plugin.settings.maxContextChars).toBe(24_000);
    expect(plugin.saveSettings).not.toHaveBeenCalled();

    control.change("400000");
    expect(plugin.settings.maxContextChars).toBe(200_000);
    expect(control.value()).toBe("200000");
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps a blank endpoint timeout unchanged and reflects its upper bound", () => {
    const { tab, plugin } = settingTab();
    const control = renderTextSetting(tab, "Vault: Vault", "Request timeout (seconds)");

    control.change("");
    expect(plugin.settings.ohsEndpoints[0]?.requestTimeoutMs).toBe(60_000);
    expect(plugin.saveSettings).not.toHaveBeenCalled();

    control.change("900");
    expect(plugin.settings.ohsEndpoints[0]?.requestTimeoutMs).toBe(600_000);
    expect(control.value()).toBe("600");
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps required provider and endpoint fields when an edit is emptied", () => {
    const { tab, plugin } = settingTab();
    const providerUrl = renderTextSetting(tab, "Provider: Local OpenAI-compatible", "Base URL");
    const endpointId = renderTextSetting(tab, "Vault: Vault", "Stable vault ID");
    const endpointUrl = renderTextSetting(tab, "Vault: Vault", "MCP endpoint");

    providerUrl.change("");
    endpointId.change("!!!");
    endpointUrl.change(" ");
    expect(plugin.settings.providers[0]?.baseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(plugin.settings.ohsEndpoints[0]).toMatchObject({
      id: "vault",
      endpoint: "http://127.0.0.1:3939/mcp",
    });
    expect(plugin.saveSettings).not.toHaveBeenCalled();

    providerUrl.blur();
    endpointId.blur();
    endpointUrl.blur();
    expect(providerUrl.value()).toBe("http://127.0.0.1:1234/v1");
    expect(endpointId.value()).toBe("vault");
    expect(endpointUrl.value()).toBe("http://127.0.0.1:3939/mcp");
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

function settingTab() {
  const plugin = {
    settings: defaultSettings("Vault"),
    saveSettings: vi.fn().mockResolvedValue(undefined),
  };
  return {
    plugin,
    tab: new HybridChatSettingTab({} as never, plugin as never),
  };
}

function renderTextSetting(tab: HybridChatSettingTab, heading: string, name: string) {
  type Definition = { name?: string; render?: (setting: unknown) => void };
  type Group = { heading?: string; items?: Definition[] };
  const groups = tab.getSettingDefinitions() as unknown as Group[];
  const definition = groups.find((item) => item.heading === heading)?.items?.find((item) => item.name === name);
  if (!definition?.render) throw new Error(`Missing setting ${heading} / ${name}`);

  let currentValue = "";
  let changeHandler: ((value: string) => void) | undefined;
  let blurHandler: (() => void) | undefined;
  const text = {
    inputEl: {
      addEventListener(event: string, handler: () => void) {
        if (event === "blur") blurHandler = handler;
      },
    },
    setValue(value: string) {
      currentValue = value;
      return text;
    },
    onChange(handler: (value: string) => void) {
      changeHandler = handler;
      return text;
    },
  };
  const setting = {
    setName() { return setting; },
    setDesc() { return setting; },
    addText(configure: (component: typeof text) => void) {
      configure(text);
      return setting;
    },
  };
  definition.render(setting);
  return {
    change(value: string) {
      currentValue = value;
      if (!changeHandler) throw new Error("Missing change handler");
      changeHandler(value);
    },
    blur() { blurHandler?.(); },
    value: () => currentValue,
  };
}
