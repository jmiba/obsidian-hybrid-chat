export interface ParsedPropertyDirectives {
  searchQuery: string;
  frontmatterFilters: string[];
  requestedProperties: string[];
}

const DIRECTIVE = /@property\s*\(([^)]*)\)/giu;
const PROPERTY_PATH = /^[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*$/u;

/** Parse explicit metadata requests without guessing property names from prose. */
export function parsePropertyDirectives(input: string): ParsedPropertyDirectives {
  const frontmatterFilters: string[] = [];
  const requestedProperties: string[] = [];
  const seenProperties = new Set<string>();

  const searchQuery = input.replace(DIRECTIVE, (_directive, rawExpression: string) => {
    const expression = rawExpression.trim();
    const operatorMatch = expression.match(/^(.+?)\s*(!=|=)\s*(.+)$/u);
    const propertyPath = (operatorMatch?.[1] ?? expression).trim();
    if (!PROPERTY_PATH.test(propertyPath)) {
      throw new Error(`Invalid @property name: ${propertyPath || "(empty)"}`);
    }

    if (!seenProperties.has(propertyPath)) {
      requestedProperties.push(propertyPath);
      seenProperties.add(propertyPath);
    }

    if (operatorMatch) {
      const value = unquote(operatorMatch[3]?.trim() ?? "");
      if (!value) throw new Error(`Missing value for @property(${propertyPath})`);
      const excluded = operatorMatch[2] === "!=";
      frontmatterFilters.push(`${excluded ? "-" : ""}${propertyPath}:${value}`);
    }
    return " ";
  }).replace(/\s+/gu, " ").trim();

  return { searchQuery, frontmatterFilters, requestedProperties };
}

export function appendRequestedProperties(
  content: string,
  propertyPaths: string[],
  frontmatter: Record<string, unknown> | null | undefined,
): string {
  if (propertyPaths.length === 0) return content;
  const lines = propertyPaths.map((propertyPath) => {
    const value = resolveProperty(frontmatter, propertyPath);
    return `- ${propertyPath}: ${formatPropertyValue(value)}`;
  });
  return `${content}\n\nRequested YAML properties:\n${lines.join("\n")}`.trim();
}

export function resolveProperty(
  frontmatter: Record<string, unknown> | null | undefined,
  propertyPath: string,
): unknown {
  if (!frontmatter) return undefined;
  if (Object.prototype.hasOwnProperty.call(frontmatter, propertyPath)) return frontmatter[propertyPath];
  return resolveSegments(frontmatter, propertyPath.split("."));
}

function resolveSegments(value: unknown, segments: string[]): unknown {
  if (segments.length === 0) return value;
  if (Array.isArray(value)) {
    const resolved = value
      .map((item) => resolveSegments(item, segments))
      .filter((item) => item !== undefined);
    return resolved.length > 0 ? resolved : undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const [head, ...tail] = segments;
  if (!head || !Object.prototype.hasOwnProperty.call(value, head)) return undefined;
  return resolveSegments((value as Record<string, unknown>)[head], tail);
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1).trim();
  }
  return value;
}

function formatPropertyValue(value: unknown): string {
  if (value === undefined) return "(not set)";
  if (value === null) return "null";
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const text = serialized ?? "(unserializable value)";
  return text.length > 1_000 ? `${text.slice(0, 997)}...` : text;
}
