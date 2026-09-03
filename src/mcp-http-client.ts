import { requestUrl } from "obsidian";

type JsonRecord = Record<string, unknown>;
type JsonRpcId = string | number;

const LATEST_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  LATEST_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

export interface McpTool {
  name: string;
  inputSchema?: unknown;
}

export interface McpToolResult {
  content: unknown;
  isError?: boolean;
  structuredContent?: JsonRecord;
}

interface HttpResult {
  message: JsonRecord | null;
  headers: Record<string, string>;
}

/** Minimal Streamable HTTP client for OHS tool discovery and invocation. */
export class McpHttpClient {
  private nextRequestId = 1;
  private protocolVersion?: string;
  private sessionId?: string;

  constructor(
    private readonly endpoint: URL,
    private readonly clientInfo: { name: string; version: string },
  ) {}

  async initialize(signal?: AbortSignal): Promise<void> {
    const response = await this.request("initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: this.clientInfo,
    }, signal);
    const negotiatedVersion = asString(response.result.protocolVersion);
    if (!SUPPORTED_PROTOCOL_VERSIONS.has(negotiatedVersion)) {
      throw new Error(`OHS negotiated unsupported MCP protocol version: ${negotiatedVersion || "missing"}`);
    }
    this.protocolVersion = negotiatedVersion;
    this.sessionId = getHeader(response.headers, "mcp-session-id") || undefined;
    await this.post({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }, signal);
  }

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    this.assertInitialized();
    const response = await this.request("tools/list", {}, signal);
    return asRecordArray(response.result.tools).flatMap((value) => {
      const name = asString(value.name);
      return name ? [{ name, inputSchema: value.inputSchema }] : [];
    });
  }

  async callTool(name: string, args: JsonRecord, signal?: AbortSignal): Promise<McpToolResult> {
    this.assertInitialized();
    const response = await this.request("tools/call", { name, arguments: args }, signal);
    return {
      content: response.result.content,
      isError: response.result.isError === true,
      structuredContent: asRecord(response.result.structuredContent) ?? undefined,
    };
  }

  async close(signal?: AbortSignal): Promise<void> {
    if (!this.sessionId) return;
    if (signal?.aborted) throw abortError();
    const response = await raceAbort(requestUrl({
      url: this.endpoint.toString(),
      method: "DELETE",
      headers: {
        "mcp-protocol-version": this.protocolVersion ?? LATEST_PROTOCOL_VERSION,
        "mcp-session-id": this.sessionId,
      },
      throw: false,
    }), signal);
    if (response.status < 200 || response.status >= 300) {
      const body = new TextDecoder().decode(response.arrayBuffer);
      throw new Error(httpError(response.status, body, getHeader(response.headers, "content-type")));
    }
    this.sessionId = undefined;
  }

  private async request(
    method: string,
    params: JsonRecord,
    signal?: AbortSignal,
  ): Promise<{ result: JsonRecord; headers: Record<string, string> }> {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const response = await this.post({ jsonrpc: "2.0", id, method, params }, signal);
    if (!response.message) throw new Error(`${method} returned no MCP response`);
    const error = extractMcpError(response.message);
    if (error) throw new Error(error);
    const result = asRecord(response.message.result);
    if (!result) throw new Error(`${method} returned no result`);
    return { result, headers: response.headers };
  }

  private async post(message: JsonRecord, signal?: AbortSignal): Promise<HttpResult> {
    if (signal?.aborted) throw abortError();
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    };
    if (this.protocolVersion) headers["mcp-protocol-version"] = this.protocolVersion;
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    // Obsidian's desktop request API avoids renderer CORS restrictions for
    // loopback OHS endpoints while retaining the standard MCP wire format.
    const pending = requestUrl({
      url: this.endpoint.toString(),
      method: "POST",
      headers,
      body: JSON.stringify(message),
      throw: false,
    });
    const response = await raceAbort(pending, signal);
    const body = new TextDecoder().decode(response.arrayBuffer);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(httpError(response.status, body, getHeader(response.headers, "content-type")));
    }
    if (response.status === 202 || body.trim().length === 0) {
      return { message: null, headers: response.headers };
    }

    const messages = parseMcpMessages(body, getHeader(response.headers, "content-type"));
    const requestId = asJsonRpcId(message.id);
    const responseMessage = requestId === null
      ? messages[0] ?? null
      : messages.find((candidate) => candidate.id === requestId) ?? null;
    if (requestId !== null && !responseMessage) {
      throw new Error(`MCP response did not include request ID ${requestId}`);
    }
    return { message: responseMessage, headers: response.headers };
  }

  private assertInitialized(): void {
    if (!this.protocolVersion) throw new Error("MCP client is not initialized");
  }
}

function parseMcpMessages(body: string, contentType: string): JsonRecord[] {
  if (contentType.toLowerCase().includes("text/event-stream") || /^\s*(?:event|data):/m.test(body)) {
    const messages: JsonRecord[] = [];
    const normalized = body.replace(/\r\n?/g, "\n");
    for (const event of normalized.split("\n\n")) {
      const data = event.split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data || data === "[DONE]") continue;
      const record = asRecord(JSON.parse(data) as unknown);
      if (record) messages.push(record);
    }
    return messages;
  }

  const parsed = JSON.parse(body) as unknown;
  if (Array.isArray(parsed)) return parsed.map(asRecord).filter((value): value is JsonRecord => value !== null);
  const record = asRecord(parsed);
  return record ? [record] : [];
}

function httpError(status: number, body: string, contentType: string): string {
  let detail = body.trim();
  try {
    const error = extractMcpError(parseMcpMessages(body, contentType)[0] ?? null);
    if (error) detail = error;
  } catch {
    // Preserve the original response body when it is not valid MCP JSON.
  }
  return `MCP HTTP ${status}${detail ? `: ${detail}` : ""}`;
}

function extractMcpError(message: JsonRecord | null): string {
  const error = message ? asRecord(message.error) : null;
  if (!error) return "";
  const code = typeof error.code === "number" ? ` ${error.code}` : "";
  return `MCP error${code}: ${asString(error.message) || "Unknown error"}`;
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : null;
}

function asRecordArray(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is JsonRecord => item !== null)
    : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asJsonRpcId(value: unknown): JsonRpcId | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function getHeader(headers: Record<string, string>, requestedName: string): string {
  const match = Object.entries(headers).find(([name]) => name.toLowerCase() === requestedName.toLowerCase());
  return match?.[1] ?? "";
}

function raceAbort<T>(pending: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function abortError(): Error {
  return new DOMException("Request canceled", "AbortError");
}
