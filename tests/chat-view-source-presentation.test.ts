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
import { analyzeCitations, type CitationAnalysis } from "../src/citation-analysis";
import type { RetrievedSource } from "../src/domain";

function makeSource(index: number): RetrievedSource {
  return {
    path: `notes/source-${index}.md`,
    title: `Source ${index}`,
    snippet: "",
    rank: index,
    vaultId: "vault-1",
    vaultDisplayName: "Test Vault",
    obsidianVaultName: "Test Vault",
    sourceId: `source-${index}`,
    content: "Body text.",
  };
}

type FakeNode = {
  tag: string;
  cls: string;
  text?: string;
  children: FakeNode[];
};

function createFakeNode(tag: string, props?: { cls?: string; text?: string }): FakeNode {
  const node: FakeNode = { tag, cls: props?.cls ?? "", text: props?.text, children: [] };
  const createChild = (childTag: string, childProps?: { cls?: string; text?: string }): FakeNode => {
    const child = createFakeNode(childTag, childProps);
    node.children.push(child);
    return child;
  };
  (node as Record<string, unknown>).createEl = (childTag: string, childProps?: { cls?: string; text?: string }) => createChild(childTag, childProps);
  (node as Record<string, unknown>).createDiv = (childProps?: { cls?: string; text?: string }) => createChild("div", childProps);
  (node as Record<string, unknown>).createSpan = (childProps?: { cls?: string; text?: string }) => createChild("span", childProps);
  (node as Record<string, unknown>).addClass = (cls: string) => { node.cls = node.cls ? `${node.cls} ${cls}` : cls; };
  (node as Record<string, unknown>).setAttr = () => node;
  (node as Record<string, unknown>).addEventListener = () => {};
  return node;
}

function descendants(root: FakeNode): FakeNode[] {
  const all: FakeNode[] = [];
  const visit = (node: FakeNode) => {
    all.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return all;
}

function summaryTexts(wrapper: FakeNode): string[] {
  return descendants(wrapper).filter((node) => node.tag === "summary").map((node) => node.text ?? "");
}

function divText(wrapper: FakeNode, cls: string): string | undefined {
  return descendants(wrapper)
    .find((node) => node.tag === "div" && node.cls.split(/\s+/).includes(cls))?.text;
}

function makeView() {
  return Object.create(HybridChatView.prototype) as unknown as {
    renderSources(wrapper: FakeNode, analysis: CitationAnalysis | null, retrievalUnavailable: boolean, isWorking: boolean): void;
  };
}

describe("source presentation for assistant messages", () => {
  const sources = [makeSource(1), makeSource(2), makeSource(3)];

  beforeEach(() => notices.splice(0));

  it("lists retrieved sources neutrally while the answer is still streaming", () => {
    const wrapper = createFakeNode("div");
    makeView().renderSources(wrapper, analyzeCitations("", sources), false, true);

    expect(summaryTexts(wrapper)).toEqual(["Sources (3)"]);
    expect(divText(wrapper, "ohc-no-citations")).toBeUndefined();
    expect(divText(wrapper, "ohc-citation-warning")).toBeUndefined();
  });

  it("keeps the no-citation note for finished answers without citations", () => {
    const wrapper = createFakeNode("div");
    makeView().renderSources(wrapper, analyzeCitations("Answer without citations.", sources), false, false);

    expect(summaryTexts(wrapper)).toEqual(["Other retrieved sources (3)"]);
    expect(divText(wrapper, "ohc-no-citations")).toBe("This answer did not cite a retrieved source.");
  });

  it("still shows cited sources for finished answers", () => {
    const wrapper = createFakeNode("div");
    makeView().renderSources(wrapper, analyzeCitations("A claim [S1].", sources), false, false);

    expect(summaryTexts(wrapper)).toEqual(["Cited sources (1)", "Other retrieved sources (2)"]);
    expect(divText(wrapper, "ohc-no-citations")).toBeUndefined();
  });
});
