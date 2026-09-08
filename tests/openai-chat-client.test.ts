import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { OpenAiCompatibleChatClient } from "../src/openai-chat-client";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

describe("OpenAI-compatible streaming", () => {
  it("flushes a final SSE data line when the response ends without a newline", async () => {
    const baseUrl = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"final token"}}]}');
    });
    const tokens: string[] = [];

    const answer = await new OpenAiCompatibleChatClient().stream({
      profile: profile(baseUrl),
      apiKey: "",
      messages: [{ role: "user", content: "question" }],
      onToken: (token) => tokens.push(token),
    });

    expect(answer).toBe("final token");
    expect(tokens).toEqual(["final token"]);
  });

  it("rejects cancellation with an AbortError", async () => {
    let requestReceived: (() => void) | undefined;
    const received = new Promise<void>((resolve) => { requestReceived = resolve; });
    const baseUrl = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      requestReceived?.();
    });
    const controller = new AbortController();
    const streaming = new OpenAiCompatibleChatClient().stream({
      profile: profile(baseUrl),
      apiKey: "",
      messages: [{ role: "user", content: "question" }],
      signal: controller.signal,
      onToken: () => undefined,
    });

    await received;
    controller.abort();

    await expect(streaming).rejects.toMatchObject({ name: "AbortError" });
  });
});

function profile(baseUrl: string) {
  return {
    id: "test",
    displayName: "Test",
    baseUrl,
    model: "test-model",
    apiKeySecretId: "",
    enabled: true,
  };
}

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return `http://127.0.0.1:${address.port}/v1`;
}
