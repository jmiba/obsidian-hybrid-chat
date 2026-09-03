import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { requestUrl } from "obsidian";
import type { SearchResult } from "./domain";

type JsonRecord = Record<string, unknown>;

export const OHS_RETRY_DELAYS_MS = [500, 1_500, 3_500, 6_000] as const;

export interface OhsReadResult {
  path: string;
  title: string;
  content: string;
  found: boolean;
}

export interface OhsGateway {
  search(
    endpoint: string,
    query: string,
    limit: number,
    rerank: boolean,
    frontmatter: string[],
    signal?: AbortSignal,
  ): Promise<SearchResult[]>;
  read(endpoint: string, paths: string[], signal?: AbortSignal): Promise<OhsReadResult[]>;
}

export class OhsMcpClient implements OhsGateway {
  async search(
    endpoint: string,
    query: string,
    limit: number,
    rerank: boolean,
    frontmatter: string[],
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    let payload: unknown;
    if (rerank) {
      try {
        // Do not repeat a failed reranked request: if model loading destabilizes
        // the service, retrying the same request can keep it in a crash loop.
        payload = await this.callToolOnce(
          endpoint,
          "search",
          buildOhsSearchArguments(query, limit, true, frontmatter),
          signal,
        );
      } catch (error) {
        if (isAbortError(error, signal)) throw error;
        // OHS itself normally degrades to hybrid ordering when its reranker cannot
        // load. This client-side fallback also covers older servers, restarts, and
        // a process that disappears while loading the model.
        payload = await withTransientOhsRetries(
          () => this.callToolOnce(
            endpoint,
            "search",
            buildOhsSearchArguments(query, limit, false, frontmatter),
            signal,
          ),
          signal,
        );
      }
    } else {
      payload = await withTransientOhsRetries(
        () => this.callToolOnce(
          endpoint,
          "search",
          buildOhsSearchArguments(query, limit, false, frontmatter),
          signal,
        ),
        signal,
      );
    }
    const results = asRecordArray(asRecord(payload)?.results);
    return results.flatMap((value, index) => {
      const path = asString(value.path);
      if (!path) return [];
      return [{
        path,
        title: asString(value.title) || path.replace(/\.md$/i, "").split("/").pop() || path,
        snippet: asString(value.snippet),
        rank: asPositiveInteger(value.rank) ?? index + 1,
        score: asNumber(value.score),
        tags: asStringArray(value.tags),
      }];
    });
  }

  async read(endpoint: string, paths: string[], signal?: AbortSignal): Promise<OhsReadResult[]> {
    if (paths.length === 0) return [];
    const payload = await withTransientOhsRetries(
      () => this.callToolOnce(endpoint, "read", {
        paths,
        related: false,
      }, signal),
      signal,
    );
    return asRecordArray(asRecord(payload)?.results).map((value, index) => ({
      path: asString(value.path) || paths[index] || "",
      title: asString(value.title),
      content: asString(value.content),
      found: value.found !== false && Boolean(asString(value.content)),
    }));
  }

  private async callToolOnce(
    endpoint: string,
    requestedName: "search" | "read",
    args: JsonRecord,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = validateMcpEndpoint(endpoint);
    const client = new Client({ name: "obsidian-hybrid-chat", version: "0.1.2" });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: signal ? { signal } : undefined,
      // Obsidian's desktop request API is intentionally used here instead of
      // renderer fetch so loopback OHS servers do not require browser CORS
      // headers. OHS Streamable HTTP is stateless request/response JSON.
      fetch: obsidianMcpFetch,
    });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const tool = listed.tools.find(({ name }) => name === requestedName)
        ?? listed.tools.find(({ name }) => name.endsWith(`_${requestedName}`));
      if (!tool) throw new Error(`OHS endpoint does not expose ${requestedName}`);
      const result = await client.callTool({ name: tool.name, arguments: args });
      if (result.isError) throw new Error(extractText(result.content) || `${requestedName} failed`);
      const text = extractText(result.content);
      if (!text) throw new Error(`${requestedName} returned no text payload`);
      return JSON.parse(text) as unknown;
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

export function buildOhsSearchArguments(
  query: string,
  limit: number,
  rerank: boolean,
  frontmatter: string[] = [],
): JsonRecord {
  return {
    query,
    mode: "hybrid",
    limit,
    snippet_length: 600,
    rerank,
    ...(frontmatter.length > 0 ? { frontmatter } : {}),
  };
}

export function isTransientOhsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:err_)?connection_refused|econnrefused|failed to fetch|fetch failed|networkerror|load failed|econnreset|socket hang up|temporarily unavailable|\b50[234]\b/i.test(message);
}

export async function withTransientOhsRetries<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
  delays: readonly number[] = OHS_RETRY_DELAYS_MS,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (isAbortError(error, signal) || !isTransientOhsError(error) || attempt >= delays.length) throw error;
      await waitForRetry(delays[attempt] ?? 0, signal);
    }
  }
}

export const obsidianMcpFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
  const signal = init?.signal;
  if (signal?.aborted) throw abortError();
  const body = await requestBody(init?.body);
  const pending = requestUrl({
    url: String(input),
    method: init?.method ?? "GET",
    headers: headersRecord(init?.headers),
    body,
    throw: false,
  });
  const result = await raceAbort(pending, signal);
  return new Response(result.arrayBuffer, {
    status: result.status,
    headers: result.headers,
  });
};

export function validateMcpEndpoint(value: string): URL {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OHS endpoint must use http or https");
  }
  if (url.username || url.password) throw new Error("Credentials are not allowed in OHS endpoint URLs");
  return url;
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: "text"; text: string } => (
      typeof item === "object" && item !== null
      && (item as JsonRecord).type === "text"
      && typeof (item as JsonRecord).text === "string"
    ))
    .map((item) => item.text)
    .join("\n");
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

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function headersRecord(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => { result[key] = value; });
  return result;
}

async function requestBody(body: BodyInit | null | undefined): Promise<string | ArrayBuffer | undefined> {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return body;
  if (ArrayBuffer.isView(body)) {
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  }
  if (body instanceof Blob) return body.arrayBuffer();
  throw new Error("Unsupported MCP request body type");
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

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      window.clearTimeout(timeout);
      reject(abortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function abortError(): Error {
  return new DOMException("Request canceled", "AbortError");
}
