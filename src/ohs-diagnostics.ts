import { McpHttpClient, type McpTool, type McpToolResult } from "./mcp-http-client";
import type { OhsEndpointConfig } from "./domain";

interface DiagnosticClient {
  readonly connectionInfo: { protocolVersion?: string; name?: string; version?: string };
  initialize(signal?: AbortSignal): Promise<void>;
  listTools(signal?: AbortSignal): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult>;
  close(signal?: AbortSignal): Promise<void>;
}

export interface OhsDiagnostics {
  compatible: boolean;
  details: string[];
}

/** Explicit, read-only check. Does not search, read notes, or start a rebuild. */
export async function checkOhsConnection(
  endpoint: Pick<OhsEndpointConfig, "endpoint" | "requestTimeoutMs">,
  version: string,
  createClient: (url: URL) => DiagnosticClient = (url) => new McpHttpClient(url, {
    name: "obsidian-hybrid-chat", version,
  }),
): Promise<OhsDiagnostics> {
  const url = new URL(endpoint.endpoint.trim());
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("OHS endpoint must use HTTP or HTTPS without credentials in the URL");
  }
  const client = createClient(url);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), endpoint.requestTimeoutMs);
  try {
    await client.initialize(controller.signal);
    const tools = await client.listTools(controller.signal);
    const find = (name: string): McpTool | undefined => tools.find((tool) => tool.name === name)
      ?? tools.find((tool) => tool.name.endsWith(`_${name}`));
    const info = client.connectionInfo;
    const details = [
      `Connected to ${info.name || "MCP server"}${info.version ? ` ${info.version}` : ""}. Protocol: ${info.protocolVersion || "unknown"}.`,
    ];
    const missing = ["search", "read"].filter((name) => !find(name));
    let compatible = missing.length === 0;
    details.push(missing.length ? `Missing required tools: ${missing.join(", ")}.` : "Search and read tools are available.");
    const search = find("search");
    if (search) {
      const properties = record(record(search.inputSchema)?.properties);
      const supports = (name: string): boolean => Boolean(properties && Object.prototype.hasOwnProperty.call(properties, name));
      details.push(`Advertised search options: ${["rerank", "frontmatter", "queries", "anchors"].filter(supports).join(", ") || "none"}.`);
      details.push(`Related-note traversal: ${["path", "related", "depth"].every(supports) ? "available" : "not advertised"}.`);
    }
    const status = find("status");
    if (status) {
      try {
        const result = await client.callTool(status.name, {}, controller.signal);
        const text = textContent(result);
        if (result.isError) throw new Error(text || "Status tool failed");
        // OHS may append a human-readable warning after the JSON object.
        const data = result.structuredContent ?? record(JSON.parse(text.slice(0, text.lastIndexOf("}") + 1)) as unknown);
        if (!data) throw new Error("Status returned no diagnostic object");
        const fields = ["version", "total", "indexed", "pending", "failed_chunks", "failed_indexing", "model", "active_model"];
        for (const field of fields) {
          const value = data[field];
          if (typeof value === "string" || typeof value === "number") details.push(`${field.replace(/_/g, " ")}: ${value}.`);
        }
        if (typeof data.model === "string" && typeof data.active_model === "string" && data.model !== data.active_model) {
          compatible = false;
          details.push("Embedding model mismatch. Restore the model recorded in the index, or intentionally rebuild the index in OHS after choosing a new model.");
        }
        if ((typeof data.failed_chunks === "number" && data.failed_chunks > 0)
          || (typeof data.failed_indexing === "number" && data.failed_indexing > 0)) {
          details.push("Indexing failures may reduce search coverage. Inspect the errors in OHS and retry failed indexing there.");
        }
      } catch (error) {
        if (controller.signal.aborted) throw error;
        details.push(`Status unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else details.push("Status tool not advertised; index health could not be checked.");
    details.push("Search and note reads were not executed; retrieval quality and reranker loading were not tested.");
    return { compatible, details };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Connection check timed out after ${endpoint.requestTimeoutMs / 1000} seconds. Verify the endpoint and that OHS is running.`);
    }
    throw error;
  } finally {
    // Use the same deadline for session cleanup, so an unavailable server cannot
    // leave the settings button waiting indefinitely.
    await client.close(controller.signal).catch(() => undefined);
    window.clearTimeout(timer);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function textContent(result: McpToolResult): string {
  return Array.isArray(result.content) ? result.content.flatMap((item: unknown) => {
    const value = record(item);
    return value?.type === "text" && typeof value.text === "string" ? [value.text] : [];
  }).join("\n") : "";
}
