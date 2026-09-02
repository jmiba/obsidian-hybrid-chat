import http from "node:http";
import https from "node:https";
import type { ChatCompletionMessage, ChatProviderProfile } from "./domain";

export interface StreamChatOptions {
  profile: ChatProviderProfile;
  apiKey: string;
  messages: ChatCompletionMessage[];
  signal?: AbortSignal;
  onToken(token: string): void;
}

export class OpenAiCompatibleChatClient {
  async stream(options: StreamChatOptions): Promise<string> {
    const url = buildChatCompletionsUrl(options.profile.baseUrl);
    const body = JSON.stringify({
      model: options.profile.model,
      messages: options.messages,
      stream: true,
      temperature: 0.2,
    });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream, application/json",
      "content-length": String(Buffer.byteLength(body)),
    };
    if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
    return streamRequest(url, body, headers, options.signal, (token) => options.onToken(token));
  }
}

export function buildChatCompletionsUrl(baseUrl: string): URL {
  const url = new URL(baseUrl.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Chat provider URL must use http or https");
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol === "http:" && !local) {
    throw new Error("Remote chat providers must use HTTPS; HTTP is allowed only on loopback");
  }
  if (url.username || url.password) throw new Error("Credentials are not allowed in provider URLs");
  const cleanPath = url.pathname.replace(/\/+$/, "");
  if (cleanPath.endsWith("/chat/completions")) return url;
  url.pathname = `${cleanPath || ""}${cleanPath.endsWith("/v1") ? "" : "/v1"}/chat/completions`;
  return url;
}

function streamRequest(
  url: URL,
  body: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  onToken: (token: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    let answer = "";
    let raw = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(answer);
    };
    const request = transport.request(url, { method: "POST", headers }, (response) => {
      response.setEncoding("utf8");
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        let errorBody = "";
        response.on("data", (chunk: string) => { errorBody = (errorBody + chunk).slice(0, 65536); });
        response.on("end", () => finish(new Error(`Chat provider returned HTTP ${response.statusCode}: ${errorBody}`)));
        return;
      }
      const contentType = String(response.headers["content-type"] ?? "");
      response.on("data", (chunk: string) => {
        raw += chunk;
        if (contentType.includes("text/event-stream")) {
          const lines = raw.split(/\r?\n/);
          raw = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            const token = parseStreamToken(data);
            if (token) {
              answer += token;
              onToken(token);
            }
          }
        }
      });
      response.on("end", () => {
        if (!contentType.includes("text/event-stream")) {
          try {
            const value = JSON.parse(raw) as { choices?: Array<{ message?: { content?: unknown } }> };
            const content = value.choices?.[0]?.message?.content;
            if (typeof content === "string") {
              answer = content;
              onToken(content);
            }
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
            return;
          }
        }
        finish();
      });
      response.on("error", (error) => finish(error));
    });
    const abort = () => {
      request.destroy(new Error("Request canceled"));
      finish(new Error("Request canceled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    request.on("error", (error) => finish(error));
    request.end(body);
    if (signal?.aborted) abort();
  });
}

function parseStreamToken(data: string): string {
  try {
    const value = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown } }> };
    const content = value.choices?.[0]?.delta?.content;
    return typeof content === "string" ? content : "";
  } catch {
    return "";
  }
}
