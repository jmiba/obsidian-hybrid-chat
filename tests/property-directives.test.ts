import { describe, expect, it } from "vitest";
import {
  appendRequestedProperties,
  parsePropertyDirectives,
  resolveProperty,
} from "../src/property-directives";

describe("property directives", () => {
  it("extracts include, exclude, and read-only property references", () => {
    expect(parsePropertyDirectives(
      "Find ships @property(status=active) @property(priority!=low) and show @property(project.owner)",
    )).toEqual({
      searchQuery: "Find ships and show",
      frontmatterFilters: ["status:active", "-priority:low"],
      requestedProperties: ["status", "priority", "project.owner"],
    });
  });

  it("supports quoted exact values containing spaces", () => {
    expect(parsePropertyDirectives('@property(topic="Steam ships")')).toEqual({
      searchQuery: "",
      frontmatterFilters: ["topic:Steam ships"],
      requestedProperties: ["topic"],
    });
  });

  it("rejects malformed property names", () => {
    expect(() => parsePropertyDirectives("@property(status key=todo)"))
      .toThrow("Invalid @property name");
  });
});

describe("requested property context", () => {
  const frontmatter = {
    status: "active",
    project: { owner: "Ada" },
    participants: [{ name: "Ada" }, { name: "Grace" }],
  };

  it("resolves nested objects and arrays", () => {
    expect(resolveProperty(frontmatter, "project.owner")).toBe("Ada");
    expect(resolveProperty(frontmatter, "participants.name")).toEqual(["Ada", "Grace"]);
  });

  it("adds only explicitly requested properties to source context", () => {
    expect(appendRequestedProperties("Body", ["status", "project.owner", "secret"], frontmatter))
      .toBe("Body\n\nRequested YAML properties:\n- status: active\n- project.owner: Ada\n- secret: (not set)");
  });
});
