import { describe, expect, it, vi } from "vitest";
const { check } = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock("../src/ohs-diagnostics", () => ({ checkOhsConnection: check }));
vi.mock("obsidian", () => ({
  Notice: class {}, SecretComponent: class {},
  PluginSettingTab: class { update = vi.fn(); },
}));
import { defaultSettings, HybridChatSettingTab } from "../src/settings";

function setup() {
  const plugin = { settings: defaultSettings("Vault"), manifest: { version: "0.1.9" }, saveSettings: vi.fn() };
  const tab = new HybridChatSettingTab({} as never, plugin as never);
  const details: string[] = [];
  let click: (() => void) | undefined;
  function render() {
    const groups = tab.getSettingDefinitions() as Array<{
      heading?: string; items?: Array<{ name?: string; render?: (setting: unknown) => void }>;
    }>;
    const definition = groups.find((group) => group.heading === "Vault: Vault")?.items
      ?.find((item) => item.name === "Connection and diagnostics");
    const button = {
      setButtonText: () => button,
      setDisabled: () => button,
      onClick: (handler: () => void) => { click = handler; return button; },
    };
    definition?.render?.({
      setName: vi.fn(), setDesc: vi.fn(),
      descEl: { createDiv: ({ text }: { text: string }) => details.push(text) },
      addButton: (configure: (value: typeof button) => void) => configure(button),
    });
  }
  render();
  return { plugin, render, details, click: () => click?.() };
}

describe("connection check settings", () => {
  it("shows actionable results without persisting them", async () => {
    check.mockResolvedValue({ compatible: false, details: ["Embedding model mismatch"] });
    const ui = setup();
    ui.click();
    await vi.waitFor(() => expect(check).toHaveBeenCalled());
    await Promise.resolve();
    ui.render();
    expect(ui.details).toContain("Connection needs attention.");
    expect(ui.details).toContain("Embedding model mismatch");
    expect(ui.plugin.saveSettings).not.toHaveBeenCalled();
  });

  it("discards a result if the endpoint changes while checking", async () => {
    let finish!: (value: { compatible: boolean; details: string[] }) => void;
    check.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const ui = setup();
    ui.click();
    ui.plugin.settings.ohsEndpoints[0]!.endpoint = "http://localhost:4040/mcp";
    finish({ compatible: true, details: ["Old server result"] });
    await Promise.resolve();
    await Promise.resolve();
    ui.render();
    expect(ui.details).not.toContain("Old server result");
  });
});
