import {
  ButtonComponent,
  ItemView,
  MarkdownRenderer,
  Modal,
  Notice,
  setIcon,
  TFile,
  type App,
  type WorkspaceLeaf,
} from "obsidian";
import type HybridChatPlugin from "./main";
import type { ChatMessage, ChatSession, RetrievedSource, VaultSelection } from "./domain";
import { buildGroundedSystemPrompt, packContext } from "./context-packer";
import { buildObsidianOpenUri, openCitation } from "./citation-mapper";
import { appendRequestedProperties, parsePropertyDirectives } from "./property-directives";
import { chatWorkLabel, shouldShowSources, type ChatWorkPhase } from "./chat-progress";
import { messageClipboardText, removeMessageById } from "./chat-message-actions";
import { buildRecentChatMessages, buildRetrievalQueries } from "./conversation-context";

export const VIEW_TYPE_HYBRID_CHAT = "obsidian-hybrid-chat-view";

export class HybridChatView extends ItemView {
  private readonly plugin: HybridChatPlugin;
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private sessionSelect!: HTMLSelectElement;
  private scopeEl!: HTMLElement;
  private selection: VaultSelection;
  private controller: AbortController | null = null;
  private workingMessageId: string | null = null;
  private workingPhase: ChatWorkPhase = "retrieving";
  private readonly sourcesRevealed = new Set<string>();

  constructor(leaf: WorkspaceLeaf, plugin: HybridChatPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.selection = {
      mode: plugin.settings.defaultSelection.mode,
      vaultIds: [...plugin.settings.defaultSelection.vaultIds],
    };
  }

  getViewType(): string { return VIEW_TYPE_HYBRID_CHAT; }
  getDisplayText(): string { return "Hybrid Chat"; }
  getIcon(): string { return "messages-square"; }

  async onOpen(): Promise<void> {
    this.renderShell();
    await this.renderMessages();
  }

  onClose(): Promise<void> {
    this.controller?.abort();
    return Promise.resolve();
  }

  private renderShell(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("ohc-view");
    const header = containerEl.createDiv({ cls: "ohc-header" });
    header.createDiv({ cls: "ohc-title", text: "Hybrid Chat" });
    const controls = header.createDiv({ cls: "ohc-controls" });
    this.sessionSelect = controls.createEl("select", { cls: "ohc-session-select", attr: { "aria-label": "Chat session" } });
    this.refreshSessionSelect();
    this.sessionSelect.addEventListener("change", () => {
      this.plugin.settings.activeSessionId = this.sessionSelect.value;
      void this.plugin.saveSettings().then(() => this.renderMessages());
    });
    this.addIconButton(controls, "plus", "New chat", () => void this.newSession());
    this.addIconButton(controls, "clipboard-copy", "Copy chat as Markdown", () => void this.copySession());
    this.addIconButton(controls, "trash", "Delete chat", () => void this.deleteSession());

    this.scopeEl = containerEl.createDiv({ cls: "ohc-scope" });
    this.renderScopeControls();
    this.messagesEl = containerEl.createDiv({ cls: "ohc-messages" });
    const composer = containerEl.createDiv({ cls: "ohc-composer" });
    this.inputEl = composer.createEl("textarea", {
      cls: "ohc-input",
      attr: { placeholder: "Ask your selected vaults…", rows: "3" },
    });
    this.sendButton = composer.createEl("button", { cls: "ohc-send", attr: { "aria-label": "Send" } });
    setIcon(this.sendButton, "send");
    this.sendButton.addEventListener("click", () => void (this.controller ? this.cancel() : this.send()));
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (!this.controller) void this.send();
      }
    });
  }

  private renderScopeControls(): void {
    this.scopeEl.empty();
    const row = this.scopeEl.createDiv({ cls: "ohc-scope-row" });
    row.createSpan({ text: "Vault scope", cls: "ohc-scope-label" });
    const select = row.createEl("select", { attr: { "aria-label": "Vault scope" } });
    select.createEl("option", { value: "current", text: "Current vault" });
    select.createEl("option", { value: "specific", text: "Selected vaults" });
    select.createEl("option", { value: "all", text: "All enabled vaults" });
    select.value = this.selection.mode;
    select.addEventListener("change", () => {
      this.selection.mode = select.value as VaultSelection["mode"];
      if (this.selection.mode === "specific" && this.selection.vaultIds.length === 0) {
        this.selection.vaultIds = this.plugin.settings.ohsEndpoints
          .filter((item) => item.enabled && item.selectedByDefault)
          .map((item) => item.id);
      }
      this.persistVaultSelection();
      this.renderScopeControls();
    });
    if (this.selection.mode === "specific") {
      const choices = this.scopeEl.createDiv({ cls: "ohc-vault-choices" });
      for (const endpoint of this.plugin.settings.ohsEndpoints.filter((item) => item.enabled)) {
        const label = choices.createEl("label", { cls: "ohc-vault-choice" });
        const checkbox = label.createEl("input", { type: "checkbox" });
        checkbox.checked = this.selection.vaultIds.includes(endpoint.id);
        checkbox.addEventListener("change", () => {
          const ids = new Set(this.selection.vaultIds);
          if (checkbox.checked) ids.add(endpoint.id); else ids.delete(endpoint.id);
          this.selection.vaultIds = [...ids];
          this.persistVaultSelection();
        });
        label.createSpan({ text: endpoint.displayName });
      }
    }
  }

  private persistVaultSelection(): void {
    this.plugin.settings.defaultSelection = {
      mode: this.selection.mode,
      vaultIds: [...this.selection.vaultIds],
    };
    void this.plugin.saveSettings();
  }

  private async send(): Promise<void> {
    const question = this.inputEl.value.trim();
    if (!question) return;
    const profile = this.plugin.getActiveProvider();
    if (!profile) {
      new Notice("Configure and enable a chat provider first.");
      return;
    }
    if (!profile.model) {
      new Notice("Configure a model for the active chat provider.");
      return;
    }
    this.controller = new AbortController();
    this.setBusy(true);
    this.inputEl.value = "";
    const session = this.plugin.getActiveSession();
    if (session.name === "New chat") {
      session.name = question.length > 60 ? `${question.slice(0, 57)}…` : question;
      this.refreshSessionSelect();
    }
    const now = new Date().toISOString();
    const userMessage: ChatMessage = {
      id: this.plugin.createId("message"), role: "user", content: question, createdAt: now,
    };
    const assistantMessage: ChatMessage = {
      id: this.plugin.createId("message"), role: "assistant", content: "", createdAt: now,
    };
    this.workingMessageId = assistantMessage.id;
    this.workingPhase = "retrieving";
    session.messages.push(userMessage, assistantMessage);
    session.updatedAt = now;
    await this.plugin.saveSettings();
    await this.renderMessages();
    let assistantContent = this.messagesEl.querySelector(`[data-message-id="${assistantMessage.id}"] .ohc-message-content`);
    try {
      const propertyDirectives = parsePropertyDirectives(question);
      const previousQuestions = session.messages
        .filter((message) => message.role === "user" && message.id !== userMessage.id)
        .map((message) => parseSearchText(message.content));
      const retrievalQueries = buildRetrievalQueries(
        propertyDirectives.searchQuery,
        previousQuestions,
        { expansionMode: this.plugin.settings.queryExpansionMode },
      );
      const retrieval = await this.plugin.retriever.retrieve(
        retrievalQueries,
        this.plugin.settings.ohsEndpoints,
        this.selection,
        this.app.vault.getName(),
        {
          searchLimitPerVault: this.plugin.settings.searchLimitPerVault,
          maxNotes: this.plugin.settings.maxNotes,
          enableReranking: this.plugin.settings.enableOhsReranking,
          frontmatterFilters: propertyDirectives.frontmatterFilters,
        },
        this.controller.signal,
      );
      assistantMessage.failures = retrieval.failures;
      assistantMessage.retrievalUnavailable = retrieval.allSearchesFailed;
      if (retrieval.allSearchesFailed) {
        assistantMessage.content = retrieval.failures.some((failure) => failure.kind === "timeout")
          ? "I could not complete retrieval within the configured OHS timeout. Hybrid Chat stopped waiting, but OHS may still be processing one or more requests."
          : "I could not query the selected vault because every selected OHS endpoint failed.";
        await this.plugin.saveSettings();
        return;
      }
      const sourcesWithProperties = this.addRequestedProperties(
        retrieval.sources,
        propertyDirectives.requestedProperties,
      );
      const packed = packContext(sourcesWithProperties, {
        maxContextChars: this.plugin.settings.maxContextChars,
        maxCharsPerNote: this.plugin.settings.maxCharsPerNote,
      });
      assistantMessage.sources = packed.sources;
      this.workingPhase = "generating";
      this.sourcesRevealed.add(assistantMessage.id);
      await this.renderMessages();
      assistantContent = this.messagesEl.querySelector(`[data-message-id="${assistantMessage.id}"] .ohc-message-content`);
      const history = buildRecentChatMessages(session.messages, assistantMessage.id);
      const apiKey = profile.apiKeySecretId
        ? this.app.secretStorage.getSecret(profile.apiKeySecretId) ?? ""
        : "";
      await this.plugin.chatClient.stream({
        profile,
        apiKey,
        messages: [{
          role: "system",
          content: buildGroundedSystemPrompt(packed, {
            customInstructions: this.plugin.settings.customSystemPrompt,
            includeCurrentDateTime: this.plugin.settings.includeCurrentDateTime,
          }),
        }, ...history],
        signal: this.controller.signal,
        onToken: (token) => {
          assistantMessage.content += token;
          if (assistantContent instanceof HTMLElement) assistantContent.textContent = assistantMessage.content;
        },
      });
      if (!assistantMessage.content) assistantMessage.content = "No response content was returned.";
      await this.plugin.saveSettings();
    } catch (error) {
      const canceled = this.controller.signal.aborted;
      assistantMessage.content = canceled
        ? (assistantMessage.content || "Request canceled.")
        : `Unable to complete the request: ${error instanceof Error ? error.message : String(error)}`;
      await this.plugin.saveSettings();
    } finally {
      this.controller = null;
      this.workingMessageId = null;
      this.sourcesRevealed.delete(assistantMessage.id);
      this.setBusy(false);
      await this.renderMessages();
    }
  }

  private cancel(): void {
    this.controller?.abort();
  }

  private addRequestedProperties(sources: RetrievedSource[], propertyPaths: string[]): RetrievedSource[] {
    if (propertyPaths.length === 0) return sources;
    const currentVaultName = this.app.vault.getName();
    return sources.map((source) => {
      if (source.obsidianVaultName !== currentVaultName) return source;
      const file = this.app.vault.getAbstractFileByPath(source.path);
      if (!(file instanceof TFile)) return source;
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      return {
        ...source,
        content: appendRequestedProperties(source.content, propertyPaths, frontmatter),
      };
    });
  }

  private setBusy(busy: boolean): void {
    this.inputEl.disabled = busy;
    this.sessionSelect.disabled = busy;
    setIcon(this.sendButton, busy ? "square" : "send");
    this.sendButton.setAttr("aria-label", busy ? "Cancel response" : "Send");
    this.sendButton.setAttr("title", busy ? "Cancel response" : "Send");
  }

  private async renderMessages(): Promise<void> {
    if (!this.messagesEl) return;
    this.messagesEl.empty();
    const session = this.plugin.getActiveSession();
    if (session.messages.length === 0) {
      this.messagesEl.createDiv({ cls: "ohc-empty", text: "Ask a question to search the selected OHS-backed vaults." });
      return;
    }
    for (const message of session.messages) await this.renderMessage(message);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private async renderMessage(message: ChatMessage): Promise<void> {
    const wrapper = this.messagesEl.createDiv({ cls: `ohc-message is-${message.role}` });
    wrapper.dataset.messageId = message.id;
    const header = wrapper.createDiv({ cls: "ohc-message-header" });
    header.createDiv({ cls: "ohc-message-role", text: message.role === "user" ? "You" : "Assistant" });
    const actions = header.createDiv({ cls: "ohc-message-actions" });
    const copyButton = this.addIconButton(actions, "copy", "Copy message as Markdown", () => void this.copyMessage(message));
    copyButton.addClass("ohc-message-action");
    const deleteButton = this.addIconButton(actions, "trash-2", "Delete message", () => this.confirmDeleteMessage(message.id));
    deleteButton.addClass("ohc-message-action");
    deleteButton.disabled = this.controller !== null;
    const isWorking = message.role === "assistant" && message.id === this.workingMessageId;
    if (isWorking) this.renderWorkingStatus(wrapper);
    const content = wrapper.createDiv({ cls: "ohc-message-content" });
    const placeholder = message.role === "assistant" && !isWorking ? "…" : "";
    await MarkdownRenderer.render(this.app, message.content || placeholder, content, "", this);
    if (message.role === "assistant") {
      this.renderFailures(wrapper, message);
      if (shouldShowSources(isWorking, this.sourcesRevealed.has(message.id))) {
        this.renderSources(wrapper, message.sources ?? [], message.retrievalUnavailable === true);
      }
    }
  }

  private renderWorkingStatus(wrapper: HTMLElement): void {
    const status = wrapper.createDiv({
      cls: "ohc-working",
      attr: { role: "status", "aria-live": "polite" },
    });
    status.createSpan({ cls: "ohc-spinner", attr: { "aria-hidden": "true" } });
    status.createSpan({ text: chatWorkLabel(this.workingPhase) });
  }

  private renderFailures(wrapper: HTMLElement, message: ChatMessage): void {
    if (!message.failures?.length) return;
    const warning = wrapper.createDiv({ cls: "ohc-partial-failures" });
    warning.createDiv({ text: message.retrievalUnavailable ? "Retrieval failed" : "Partial retrieval failures" });
    for (const failure of message.failures) {
      warning.createDiv({ text: `${failure.vaultDisplayName} (${failure.stage}): ${failure.message}` });
    }
  }

  private renderSources(wrapper: HTMLElement, sources: RetrievedSource[], retrievalUnavailable: boolean): void {
    const details = wrapper.createEl("details", { cls: "ohc-sources" });
    details.open = true;
    details.createEl("summary", { text: `Sources (${sources.length})` });
    if (sources.length === 0) {
      details.createDiv({
        cls: "ohc-no-sources",
        text: retrievalUnavailable ? "Sources unavailable because retrieval failed." : "No readable sources returned.",
      });
      return;
    }
    const list = details.createEl("ol");
    for (const source of sources) {
      const item = list.createEl("li");
      const button = item.createEl("button", { cls: "ohc-source-link" });
      button.createSpan({ cls: "ohc-source-label", text: source.title || source.path });
      button.createSpan({ cls: "ohc-source-path", text: `${source.vaultDisplayName} :: ${source.path}` });
      button.addEventListener("click", () => void openCitation(this.app, source).then((opened) => {
        if (!opened) new Notice("Citation target is invalid or unavailable.");
      }));
    }
  }

  private async newSession(): Promise<void> {
    const now = new Date().toISOString();
    const id = this.plugin.createId("chat");
    this.plugin.settings.sessions.push({ id, name: "New chat", createdAt: now, updatedAt: now, messages: [] });
    this.plugin.settings.activeSessionId = id;
    await this.plugin.saveSettings();
    this.refreshSessionSelect();
    await this.renderMessages();
  }

  private async copyMessage(message: ChatMessage): Promise<void> {
    await navigator.clipboard.writeText(messageClipboardText(message));
    new Notice("Message copied as Markdown.");
  }

  private confirmDeleteMessage(messageId: string): void {
    if (this.controller) {
      new Notice("Wait for the current response to finish before deleting messages.");
      return;
    }
    new ConfirmMessageDeleteModal(this.app, async () => {
      const session = this.plugin.getActiveSession();
      const result = removeMessageById(session.messages, messageId);
      if (!result.removed) return;
      session.messages = result.messages;
      session.updatedAt = new Date().toISOString();
      await this.plugin.saveSettings();
      await this.renderMessages();
    }).open();
  }

  private async deleteSession(): Promise<void> {
    if (this.plugin.settings.sessions.length <= 1) {
      new Notice("At least one chat session is required.");
      return;
    }
    const active = this.plugin.settings.activeSessionId;
    this.plugin.settings.sessions = this.plugin.settings.sessions.filter((session) => session.id !== active);
    this.plugin.settings.activeSessionId = this.plugin.settings.sessions[0]?.id ?? "default";
    await this.plugin.saveSettings();
    this.refreshSessionSelect();
    await this.renderMessages();
  }

  private async copySession(): Promise<void> {
    const session = this.plugin.getActiveSession();
    await navigator.clipboard.writeText(sessionToMarkdown(session));
    new Notice("Chat copied as Markdown. No vault note was created.");
  }

  private refreshSessionSelect(): void {
    if (!this.sessionSelect) return;
    this.sessionSelect.empty();
    for (const session of [...this.plugin.settings.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
      const option = this.sessionSelect.createEl("option", { value: session.id, text: session.name });
      option.selected = session.id === this.plugin.settings.activeSessionId;
    }
  }

  private addIconButton(parent: HTMLElement, icon: string, label: string, handler: () => void): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label, title: label } });
    setIcon(button, icon);
    button.addEventListener("click", handler);
    return button;
  }
}

function parseSearchText(question: string): string {
  try {
    return parsePropertyDirectives(question).searchQuery;
  } catch {
    return question;
  }
}

class ConfirmMessageDeleteModal extends Modal {
  constructor(app: App, private readonly onConfirm: () => Promise<void>) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Delete message?");
    this.contentEl.createEl("p", { text: "This removes only this message from the current chat. This action cannot be undone." });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    new ButtonComponent(actions).setButtonText("Cancel").onClick(() => this.close());
    new ButtonComponent(actions)
      .setButtonText("Delete")
      .setDestructive()
      .setCta()
      .onClick(() => {
        this.close();
        void this.onConfirm();
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function sessionToMarkdown(session: ChatSession): string {
  const lines = [`# ${session.name}`, ""];
  for (const message of session.messages) {
    lines.push(`## ${message.role === "user" ? "You" : "Assistant"}`, "", message.content, "");
    if (message.role === "assistant" && message.sources?.length) {
      lines.push("### Sources", "");
      message.sources.forEach((source, index) => {
        const uri = buildObsidianOpenUri(source.obsidianVaultName, source.path);
        const label = `${source.vaultDisplayName} :: ${source.path}`;
        lines.push(uri ? `${index + 1}. [${label}](${uri})` : `${index + 1}. ${label}`);
      });
      lines.push("");
    }
  }
  return lines.join("\n");
}
