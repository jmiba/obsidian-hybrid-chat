import http from "node:http";
import https from "node:https";
import type { ChatCompletionMessage, ChatProviderProfile } from "./domain";
import { buildOpenAiCompatibleUrl } from "./openai-provider-url";

export type ChatCompletionStatus = "complete" | "length" | "incomplete";

export interface StreamChatResult {
  answer: string;
  status: ChatCompletionStatus;
}

interface StreamChatOptions {
  profile: ChatProviderProfile;
  apiKey: string;
  messages: ChatCompletionMessage[];
  signal?: AbortSignal;
  onToken(token: string): void;
}

export class OpenAiCompatibleChatClient {
  async stream(options: StreamChatOptions): Promise<StreamChatResult> {
    const url = buildOpenAiCompatibleUrl(options.profile.baseUrl, "chat/completions");
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

function streamRequest(
  url: URL,
  body: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  onToken: (token: string) => void,
): Promise<StreamChatResult> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    let answer = "";
    let raw = "";
    let settled = false;
    let sseResponse = false;
    let finishReason: string | null = null;
    const acceptSseLine = (line: string): void => {
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") return;
      const event = parseStreamEvent(data);
      if (event.finishReason) finishReason = event.finishReason;
      if (event.token) {
        answer += event.token;
        onToken(event.token);
      }
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve({ answer, status: completionStatus(sseResponse, finishReason) });
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
      sseResponse = contentType.includes("text/event-stream");
      response.on("data", (chunk: string) => {
        raw += chunk;
        if (sseResponse) {
          const lines = raw.split(/\r?\n/);
          raw = lines.pop() ?? "";
          for (const line of lines) acceptSseLine(line);
        }
      });
      response.on("end", () => {
        if (sseResponse) {
          acceptSseLine(raw.replace(/\r$/, ""));
        } else {
          try {
            const value = JSON.parse(raw) as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }> };
            const content = value.choices?.[0]?.message?.content;
            finishReason = typeof value.choices?.[0]?.finish_reason === "string"
              ? value.choices[0].finish_reason
              : null;
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
      const error = abortError();
      request.destroy(error);
      finish(error);
    };
    signal?.addEventListener("abort", abort, { once: true });
    request.on("error", (error) => finish(error));
    request.end(body);
    if (signal?.aborted) abort();
  });
}

function completionStatus(sseResponse: boolean, finishReason: string | null): ChatCompletionStatus {
  if (finishReason === "length") return "length";
  if (finishReason === null && sseResponse) return "incomplete";
  return "complete";
}

function abortError(): Error {
  return new DOMException("Request canceled", "AbortError");
}

function parseStreamEvent(data: string): { token: string; finishReason: string | null } {
  try {
    const value = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown }; finish_reason?: unknown }> };
    const choice = value.choices?.[0];
    const content = choice?.delta?.content;
    const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
    return { token: typeof content === "string" ? content : "", finishReason };
  } catch {
    return { token: "", finishReason: null };
  }
}
