import {
  Notice,
  PluginSettingTab,
  SecretComponent,
  type App,
  type Setting,
  type SettingDefinition,
  type SettingDefinitionItem,
} from "obsidian";
import type HybridChatPlugin from "./main";
import { DEFAULT_OHS_REQUEST_TIMEOUT_MS } from "./domain";
import type {
  ChatMessage,
  ChatProviderProfile,
  ChatSession,
  HybridChatSettings,
  OhsEndpointConfig,
  QueryExpansionMode,
  RetrievalFailure,
  RetrievedSource,
} from "./domain";

export function defaultSettings(currentVaultName: string): HybridChatSettings {
  const now = new Date().toISOString();
  return {
    ohsEndpoints: [{
      id: stableId(currentVaultName || "current-vault"),
      displayName: currentVaultName || "Current vault",
      endpoint: "http://127.0.0.1:3939/mcp",
      obsidianVaultName: currentVaultName,
      requestTimeoutMs: DEFAULT_OHS_REQUEST_TIMEOUT_MS,
      enabled: true,
      selectedByDefault: true,
    }],
    providers: [{
      id: "local-openai-compatible",
      displayName: "Local OpenAI-compatible",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "",
      apiKeySecretId: "",
      enabled: true,
    }],
    activeProviderId: "local-openai-compatible",
    defaultSelection: { mode: "current", vaultIds: [] },
    searchLimitPerVault: 8,
    maxNotes: 6,
    enableOhsReranking: true,
    queryExpansionMode: "follow-ups",
    enableRelatedNoteTraversal: false,
    maxContextChars: 24000,
    maxCharsPerNote: 6000,
    includeCurrentDateTime: true,
    customSystemPrompt: "",
    sessions: [{ id: "default", name: "New chat", createdAt: now, updatedAt: now, messages: [] }],
    activeSessionId: "default",
  };
}

export function loadSettings(raw: unknown, currentVaultName: string): HybridChatSettings {
  const fallback = defaultSettings(currentVaultName);
  const value = asRecord(raw);
  if (!value) return fallback;
  const endpoints = Array.isArray(value.ohsEndpoints)
    ? value.ohsEndpoints.flatMap(parseEndpoint)
    : fallback.ohsEndpoints;
  const providers = Array.isArray(value.providers)
    ? value.providers.flatMap(parseProvider)
    : fallback.providers;
  const sessions = Array.isArray(value.sessions)
    ? value.sessions.flatMap(parseSession)
    : fallback.sessions;
  const selectionRecord = asRecord(value.defaultSelection);
  const selectionMode = selectionRecord?.mode;
  const mode = selectionMode === "current" || selectionMode === "specific" || selectionMode === "all"
    ? selectionMode
    : fallback.defaultSelection.mode;
  const settings: HybridChatSettings = {
    ohsEndpoints: endpoints.length ? endpoints : fallback.ohsEndpoints,
    providers: providers.length ? providers : fallback.providers,
    activeProviderId: asString(value.activeProviderId) || providers[0]?.id || fallback.activeProviderId,
    defaultSelection: {
      mode,
      vaultIds: asStringArray(selectionRecord?.vaultIds),
    },
    searchLimitPerVault: boundedInteger(value.searchLimitPerVault, 1, 50, fallback.searchLimitPerVault),
    maxNotes: boundedInteger(value.maxNotes, 1, 20, fallback.maxNotes),
    enableOhsReranking: value.enableOhsReranking !== false,
    queryExpansionMode: parseQueryExpansionMode(value.queryExpansionMode, fallback.queryExpansionMode),
    enableRelatedNoteTraversal: value.enableRelatedNoteTraversal === true,
    maxContextChars: boundedInteger(value.maxContextChars, 1000, 200000, fallback.maxContextChars),
    maxCharsPerNote: boundedInteger(value.maxCharsPerNote, 500, 50000, fallback.maxCharsPerNote),
    includeCurrentDateTime: value.includeCurrentDateTime !== false,
    customSystemPrompt: asString(value.customSystemPrompt),
    sessions: sessions.length ? sessions : fallback.sessions,
    activeSessionId: asString(value.activeSessionId) || sessions[0]?.id || fallback.activeSessionId,
  };
  return sanitizeSettingsForPersistence(settings);
}

export function sanitizeSettingsForPersistence(settings: HybridChatSettings): HybridChatSettings {
  return {
    ohsEndpoints: settings.ohsEndpoints.map((endpoint) => ({
      id: endpoint.id,
      displayName: endpoint.displayName,
      endpoint: endpoint.endpoint,
      obsidianVaultName: endpoint.obsidianVaultName,
      requestTimeoutMs: endpoint.requestTimeoutMs,
      enabled: Boolean(endpoint.enabled),
      selectedByDefault: Boolean(endpoint.selectedByDefault),
    })),
    providers: settings.providers.map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKeySecretId: provider.apiKeySecretId,
      enabled: Boolean(provider.enabled),
    })),
    activeProviderId: settings.activeProviderId,
    defaultSelection: {
      mode: settings.defaultSelection.mode,
      vaultIds: [...settings.defaultSelection.vaultIds],
    },
    searchLimitPerVault: settings.searchLimitPerVault,
    maxNotes: settings.maxNotes,
    enableOhsReranking: Boolean(settings.enableOhsReranking),
    queryExpansionMode: parseQueryExpansionMode(settings.queryExpansionMode, "follow-ups"),
    enableRelatedNoteTraversal: Boolean(settings.enableRelatedNoteTraversal),
    maxContextChars: settings.maxContextChars,
    maxCharsPerNote: settings.maxCharsPerNote,
    includeCurrentDateTime: Boolean(settings.includeCurrentDateTime),
    customSystemPrompt: settings.customSystemPrompt,
    sessions: settings.sessions.map(sanitizeSession),
    activeSessionId: settings.activeSessionId,
  };
}

export class HybridChatSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: HybridChatPlugin) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      this.definition(
        "Retrieval and privacy",
        "Retrieval uses only the configured OHS MCP endpoints. API keys are selected from Obsidian SecretStorage and are never written to plugin data.",
        () => undefined,
      ),
      {
        type: "group",
        heading: "Chat provider",
        items: [this.activeProviderDefinition(), this.addProviderDefinition()],
      },
      ...this.plugin.settings.providers.map((provider) => ({
        type: "group" as const,
        heading: `Provider: ${provider.displayName || provider.id}`,
        items: this.providerDefinitions(provider),
      })),
      {
        type: "group",
        heading: "OHS vault registry",
        items: [this.addEndpointDefinition()],
      },
      ...this.plugin.settings.ohsEndpoints.map((endpoint) => ({
        type: "group" as const,
        heading: `Vault: ${endpoint.displayName || endpoint.id}`,
        items: this.endpointDefinitions(endpoint),
      })),
      {
        type: "group",
        heading: "Prompt and context",
        items: this.promptDefinitions(),
      },
      {
        type: "group",
        heading: "Retrieval",
        items: this.retrievalDefinitions(),
      },
    ];
  }

  private activeProviderDefinition(): SettingDefinition {
    return this.definition("Active profile", undefined, (setting) => {
      setting.addDropdown((dropdown) => {
        for (const profile of this.plugin.settings.providers.filter((item) => item.enabled)) {
          dropdown.addOption(profile.id, profile.displayName);
        }
        dropdown.setValue(this.plugin.settings.activeProviderId).onChange((value) => {
          this.plugin.settings.activeProviderId = value;
          this.persist();
        });
      });
    });
  }

  private addProviderDefinition(): SettingDefinition {
    return this.definition("Add provider profile", undefined, (setting) => {
      setting.addButton((button) => button.setButtonText("Add provider profile").onClick(() => {
        const id = uniqueId("provider");
        this.plugin.settings.providers.push({
          id,
          displayName: "New provider",
          baseUrl: "http://127.0.0.1:1234/v1",
          model: "",
          apiKeySecretId: "",
          enabled: true,
        });
        this.persist();
        this.update();
      }));
    });
  }

  private providerDefinitions(provider: ChatProviderProfile): SettingDefinition[] {
    return [
      this.definition("Display name", undefined, (setting) => setting.addText((text) => text
        .setValue(provider.displayName)
        .onChange((value) => { provider.displayName = value.trim(); this.persist(); }))),
      this.definition("Base URL", "HTTPS for remote providers; loopback HTTP is allowed.", (setting) => setting.addText((text) => text
        .setValue(provider.baseUrl)
        .onChange((value) => { provider.baseUrl = value.trim(); this.persist(); }))),
      this.definition("Model", undefined, (setting) => setting.addText((text) => text
        .setValue(provider.model)
        .onChange((value) => { provider.model = value.trim(); this.persist(); }))),
      this.definition("API key", "Select or create an Obsidian secret. Only its identifier is persisted.", (setting) => setting
        .addComponent((componentContainer) => new SecretComponent(this.app, componentContainer)
          .setValue(provider.apiKeySecretId)
          .onChange((value) => { provider.apiKeySecretId = value; this.persist(); }))),
      this.definition("Enabled", undefined, (setting) => setting.addToggle((toggle) => toggle
        .setValue(provider.enabled)
        .onChange((value) => { provider.enabled = value; this.persist(); }))),
      this.definition("Remove provider", undefined, (setting) => setting.addExtraButton((button) => button
        .setIcon("trash")
        .setTooltip("Remove provider")
        .onClick(() => {
          if (this.plugin.settings.providers.length <= 1) {
            new Notice("At least one provider profile is required.");
            return;
          }
          this.plugin.settings.providers = this.plugin.settings.providers.filter((item) => item.id !== provider.id);
          if (this.plugin.settings.activeProviderId === provider.id) {
            this.plugin.settings.activeProviderId = this.plugin.settings.providers[0]?.id ?? "";
          }
          this.persist();
          this.update();
        }))),
    ];
  }

  private addEndpointDefinition(): SettingDefinition {
    return this.definition("Add OHS endpoint", undefined, (setting) => {
      setting.addButton((button) => button.setButtonText("Add OHS endpoint").onClick(() => {
        const id = uniqueId("vault");
        this.plugin.settings.ohsEndpoints.push({
          id,
          displayName: "New vault",
          endpoint: "http://127.0.0.1:3939/mcp",
          obsidianVaultName: "",
          requestTimeoutMs: DEFAULT_OHS_REQUEST_TIMEOUT_MS,
          enabled: true,
          selectedByDefault: false,
        });
        this.persist();
        this.update();
      }));
    });
  }

  private endpointDefinitions(endpoint: OhsEndpointConfig): SettingDefinition[] {
    return [
      this.definition("Stable vault ID", "Used to namespace every source; avoid changing after use.", (setting) => setting.addText((text) => text
        .setValue(endpoint.id)
        .onChange((value) => { endpoint.id = stableId(value); this.persist(); }))),
      this.definition("Display name", undefined, (setting) => setting.addText((text) => text
        .setValue(endpoint.displayName)
        .onChange((value) => { endpoint.displayName = value.trim(); this.persist(); }))),
      this.definition("MCP endpoint", undefined, (setting) => setting.addText((text) => text
        .setValue(endpoint.endpoint)
        .onChange((value) => { endpoint.endpoint = value.trim(); this.persist(); }))),
      this.definition("Obsidian vault name", "Exact vault name used for current-vault matching and Obsidian:// links.", (setting) => setting.addText((text) => text
        .setValue(endpoint.obsidianVaultName)
        .onChange((value) => { endpoint.obsidianVaultName = value.trim(); this.persist(); }))),
      this.definition(
        "Request timeout (seconds)",
        "Maximum time Hybrid Chat waits for each OHS search or read. Timing out does not cancel database work already running inside OHS.",
        (setting) => setting.addText((text) => text
          .setValue(String(Math.round(endpoint.requestTimeoutMs / 1000)))
          .onChange((value) => {
            const currentSeconds = Math.round(endpoint.requestTimeoutMs / 1000);
            endpoint.requestTimeoutMs = boundedInteger(Number(value), 5, 600, currentSeconds) * 1000;
            this.persist();
          })),
      ),
      this.definition("Enabled", undefined, (setting) => setting.addToggle((toggle) => toggle
        .setValue(endpoint.enabled)
        .onChange((value) => { endpoint.enabled = value; this.persist(); }))),
      this.definition("Selected by default", undefined, (setting) => setting.addToggle((toggle) => toggle
        .setValue(endpoint.selectedByDefault)
        .onChange((value) => { endpoint.selectedByDefault = value; this.persist(); }))),
      this.definition("Remove endpoint", undefined, (setting) => setting.addExtraButton((button) => button
        .setIcon("trash")
        .setTooltip("Remove endpoint")
        .onClick(() => {
          this.plugin.settings.ohsEndpoints = this.plugin.settings.ohsEndpoints.filter((item) => item !== endpoint);
          this.persist();
          this.update();
        }))),
    ];
  }

  private promptDefinitions(): SettingDefinition[] {
    return [
      this.definition(
        "Include current date and time",
        "Inject local date/time, IANA time zone, and UTC on every request. This is computed locally and does not call another MCP server.",
        (setting) => setting.addToggle((toggle) => toggle
          .setValue(this.plugin.settings.includeCurrentDateTime)
          .onChange((value) => { this.plugin.settings.includeCurrentDateTime = value; this.persist(); })),
      ),
      this.definition(
        "Custom system instructions",
        "Optional instructions for language, tone, structure, or role. Protected grounding and citation rules are always appended.",
        (setting) => setting.addTextArea((text) => text
          .setPlaceholder("For example: Answer in German and start with a concise summary.")
          .setValue(this.plugin.settings.customSystemPrompt)
          .onChange((value) => { this.plugin.settings.customSystemPrompt = value; this.persist(); })),
      ),
    ];
  }

  private retrievalDefinitions(): SettingDefinition[] {
    return [
      this.definition(
        "Query expansion",
        "Follow-ups only adds bounded chat context when a question appears referential. Always also sends a heuristic lexical variant, which can improve recall but reduce precision. Off sends only the original question.",
        (setting) => setting.addDropdown((dropdown) => dropdown
          .addOption("off", "Off")
          .addOption("follow-ups", "Follow-ups only")
          .addOption("always", "Always")
          .setValue(this.plugin.settings.queryExpansionMode)
          .onChange((value) => {
            this.plugin.settings.queryExpansionMode = parseQueryExpansionMode(value, "follow-ups");
            this.persist();
          })),
      ),
      this.definition(
        "Enable OHS cross-encoder reranking",
        "Rerank each vault's hybrid candidates inside OHS before cross-vault fusion. The OHS service controls and caches its reranker model; this plugin sends only rerank: true.",
        (setting) => setting.addToggle((toggle) => toggle
          .setValue(this.plugin.settings.enableOhsReranking)
          .onChange((value) => { this.plugin.settings.enableOhsReranking = value; this.persist(); })),
      ),
      this.definition(
        "Enable one-hop related notes",
        "For relationship-oriented questions only, expand the best direct result from each vault through one hop of explicit links and backlinks. Disabled by default.",
        (setting) => setting.addToggle((toggle) => toggle
          .setValue(this.plugin.settings.enableRelatedNoteTraversal)
          .onChange((value) => { this.plugin.settings.enableRelatedNoteTraversal = value; this.persist(); })),
      ),
      this.numberDefinition("Results per vault", "Candidates requested from each healthy OHS endpoint.", "searchLimitPerVault", 1, 50),
      this.numberDefinition("Notes read", "Global post-fusion notes fetched with OHS read.", "maxNotes", 1, 20),
      this.numberDefinition("Total context characters", "Maximum source text sent to the chat provider.", "maxContextChars", 1000, 200000),
      this.numberDefinition("Characters per note", "Maximum context from any single source.", "maxCharsPerNote", 500, 50000),
    ];
  }

  private numberDefinition(
    name: string,
    description: string,
    key: "searchLimitPerVault" | "maxNotes" | "maxContextChars" | "maxCharsPerNote",
    min: number,
    max: number,
  ): SettingDefinition {
    return this.definition(name, description, (setting) => setting.addText((text) => text
      .setValue(String(this.plugin.settings[key]))
      .onChange((value) => {
        this.plugin.settings[key] = boundedInteger(Number(value), min, max, this.plugin.settings[key]);
        this.persist();
      })));
  }

  private persist(): void {
    void this.plugin.saveSettings();
  }

  private definition(
    name: string,
    description: string | undefined,
    configure: (setting: Setting) => unknown,
  ): SettingDefinition {
    return {
      name,
      desc: description,
      render: (setting) => {
        setting.setName(name);
        if (description) setting.setDesc(description);
        configure(setting);
      },
    };
  }
}

function sanitizeSession(session: ChatSession): ChatSession {
  return {
    id: session.id,
    name: session.name,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: session.messages.map(sanitizeMessage),
  };
}

function sanitizeMessage(message: ChatMessage): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    sources: message.sources?.map(sanitizeSource),
    failures: message.failures?.map((item) => ({
      vaultId: item.vaultId,
      vaultDisplayName: item.vaultDisplayName,
      stage: item.stage,
      kind: item.kind,
      message: item.message,
    })),
    retrievalUnavailable: message.retrievalUnavailable === true,
  };
}

function sanitizeSource(source: RetrievedSource): RetrievedSource {
  return {
    path: source.path,
    title: source.title,
    snippet: source.snippet,
    rank: source.rank,
    score: source.score,
    tags: source.tags ? [...source.tags] : undefined,
    retrievalKind: source.retrievalKind,
    relatedFromPath: source.relatedFromPath,
    vaultId: source.vaultId,
    vaultDisplayName: source.vaultDisplayName,
    obsidianVaultName: source.obsidianVaultName,
    sourceId: source.sourceId,
    rrfScore: source.rrfScore,
    content: source.content,
  };
}

function parseEndpoint(value: unknown): OhsEndpointConfig[] {
  const item = asRecord(value);
  if (!item) return [];
  const id = stableId(asString(item.id));
  const endpoint = asString(item.endpoint).trim();
  if (!id || !endpoint) return [];
  return [{
    id,
    displayName: asString(item.displayName).trim() || id,
    endpoint,
    obsidianVaultName: asString(item.obsidianVaultName).trim(),
    requestTimeoutMs: boundedInteger(
      item.requestTimeoutMs,
      5_000,
      600_000,
      DEFAULT_OHS_REQUEST_TIMEOUT_MS,
    ),
    enabled: item.enabled !== false,
    selectedByDefault: item.selectedByDefault === true,
  }];
}

function parseProvider(value: unknown): ChatProviderProfile[] {
  const item = asRecord(value);
  if (!item) return [];
  const id = stableId(asString(item.id));
  const baseUrl = asString(item.baseUrl).trim();
  if (!id || !baseUrl) return [];
  return [{
    id,
    displayName: asString(item.displayName).trim() || id,
    baseUrl,
    model: asString(item.model).trim(),
    apiKeySecretId: asString(item.apiKeySecretId).trim(),
    enabled: item.enabled !== false,
  }];
}

function parseSession(value: unknown): ChatSession[] {
  const item = asRecord(value);
  if (!item) return [];
  const id = stableId(asString(item.id));
  if (!id) return [];
  const now = new Date().toISOString();
  const messages = Array.isArray(item.messages) ? item.messages.flatMap(parseMessage) : [];
  return [{
    id,
    name: asString(item.name).trim() || "Chat",
    createdAt: asString(item.createdAt) || now,
    updatedAt: asString(item.updatedAt) || now,
    messages,
  }];
}

function parseMessage(value: unknown): ChatMessage[] {
  const item = asRecord(value);
  if (!item || (item.role !== "user" && item.role !== "assistant")) return [];
  const sources = Array.isArray(item.sources) ? item.sources.flatMap(parseSource) : undefined;
  const failures: RetrievalFailure[] | undefined = Array.isArray(item.failures) ? item.failures.flatMap((failure) => {
    const record = asRecord(failure);
    const stage: RetrievalFailure["stage"] | null = record?.stage === "search"
      || record?.stage === "related"
      || record?.stage === "read"
      ? record.stage
      : null;
    if (!record || !stage) return [];
    return [{
      vaultId: asString(record.vaultId),
      vaultDisplayName: asString(record.vaultDisplayName),
      stage,
      kind: record.kind === "timeout" ? "timeout" : "error",
      message: asString(record.message),
    }];
  }) : undefined;
  return [{
    id: asString(item.id) || uniqueId("message"),
    role: item.role,
    content: asString(item.content),
    createdAt: asString(item.createdAt) || new Date().toISOString(),
    sources,
    failures,
    retrievalUnavailable: item.retrievalUnavailable === true,
  }];
}

function parseSource(value: unknown): RetrievedSource[] {
  const item = asRecord(value);
  if (!item) return [];
  const path = asString(item.path);
  const vaultId = asString(item.vaultId);
  if (!path || !vaultId) return [];
  return [{
    path,
    title: asString(item.title),
    snippet: asString(item.snippet),
    rank: boundedInteger(item.rank, 1, Number.MAX_SAFE_INTEGER, 1),
    score: typeof item.score === "number" && Number.isFinite(item.score) ? item.score : null,
    tags: asStringArray(item.tags),
    retrievalKind: item.retrievalKind === "related" ? "related" : "direct",
    relatedFromPath: asString(item.relatedFromPath) || undefined,
    vaultId,
    vaultDisplayName: asString(item.vaultDisplayName),
    obsidianVaultName: asString(item.obsidianVaultName),
    sourceId: asString(item.sourceId),
    rrfScore: typeof item.rrfScore === "number" && Number.isFinite(item.rrfScore) ? item.rrfScore : 0,
    content: asString(item.content),
  }];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
}

function parseQueryExpansionMode(value: unknown, fallback: QueryExpansionMode): QueryExpansionMode {
  return value === "off" || value === "follow-ups" || value === "always" ? value : fallback;
}

function stableId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
