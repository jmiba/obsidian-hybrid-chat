import { Notice, Plugin } from "obsidian";
import { VIEW_TYPE_HYBRID_CHAT, HybridChatView } from "./chat-view";
import { FederatedRetriever } from "./federated-retriever";
import type { ChatProviderProfile, ChatSession, HybridChatSettings } from "./domain";
import { OhsMcpClient } from "./ohs-client";
import { OpenAiCompatibleChatClient } from "./openai-chat-client";
import { HybridChatSettingTab, loadSettings, sanitizeSettingsForPersistence } from "./settings";

export default class HybridChatPlugin extends Plugin {
  settings!: HybridChatSettings;
  readonly retriever = new FederatedRetriever(new OhsMcpClient());
  readonly chatClient = new OpenAiCompatibleChatClient();

  async onload(): Promise<void> {
    this.settings = loadSettings(await this.loadData(), this.app.vault.getName());
    this.registerView(VIEW_TYPE_HYBRID_CHAT, (leaf) => new HybridChatView(leaf, this));
    this.addRibbonIcon("messages-square", "Open Hybrid Chat", () => void this.activateView());
    this.addCommand({
      id: "open-hybrid-chat",
      name: "Open chat",
      callback: () => void this.activateView(),
    });
    this.addSettingTab(new HybridChatSettingTab(this.app, this));
  }

  async saveSettings(): Promise<void> {
    // Persist a sanitized snapshot without replacing the live object graph.
    // The chat view intentionally keeps references to the active session and
    // streaming message while asynchronous retrieval and generation run.
    await this.saveData(sanitizeSettingsForPersistence(this.settings));
  }

  getActiveProvider(): ChatProviderProfile | null {
    return this.settings.providers.find((profile) => profile.id === this.settings.activeProviderId && profile.enabled) ?? null;
  }

  getActiveSession(): ChatSession {
    const existing = this.settings.sessions.find((session) => session.id === this.settings.activeSessionId);
    if (existing) return existing;
    const fallback = this.settings.sessions[0];
    if (fallback) {
      this.settings.activeSessionId = fallback.id;
      return fallback;
    }
    const now = new Date().toISOString();
    const created = { id: "default", name: "New chat", createdAt: now, updatedAt: now, messages: [] };
    this.settings.sessions.push(created);
    this.settings.activeSessionId = created.id;
    return created;
  }

  createId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  private async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_HYBRID_CHAT)[0];
    const leaf = existing ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      new Notice("Unable to open a right sidebar leaf.");
      return;
    }
    if (!existing) await leaf.setViewState({ type: VIEW_TYPE_HYBRID_CHAT, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }
}
