import { beforeEach, describe, expect, it, vi } from "vitest";

const { notices } = vi.hoisted(() => ({ notices: [] as string[] }));
vi.mock("obsidian", () => ({
  ButtonComponent: class {},
  ItemView: class {},
  MarkdownRenderer: { render: vi.fn() },
  Modal: class {},
  Notice: class { constructor(message: string) { notices.push(message); } },
  PluginSettingTab: class {},
  SecretComponent: class {},
  setIcon: vi.fn(),
  TFile: class {},
}));

import { HybridChatView } from "../src/chat-view";
import { defaultSettings } from "../src/settings";

describe("chat session actions", () => {
  beforeEach(() => notices.splice(0));

  it("does not delete the active session while a response is in flight", async () => {
    const settings = defaultSettings("Vault");
    settings.sessions.push({
      id: "second",
      name: "Second",
      createdAt: "2026-09-08T00:00:00.000Z",
      updatedAt: "2026-09-08T00:00:00.000Z",
      messages: [],
    });
    const plugin = { settings, saveSettings: vi.fn().mockResolvedValue(undefined) };
    const view = Object.create(HybridChatView.prototype) as unknown as {
      controller: AbortController;
      plugin: typeof plugin;
      deleteSession(): Promise<void>;
    };
    view.controller = new AbortController();
    view.plugin = plugin;

    await view.deleteSession();

    expect(settings.sessions.map((session) => session.id)).toEqual(["default", "second"]);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(notices).toEqual(["Wait for the current response to finish before deleting chats."]);
  });
});
