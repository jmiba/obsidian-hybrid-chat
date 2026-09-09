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
      response.end('data: {"choices":[{"delta":{"content":"final token"},"finish_reason":"stop"}]}');
    });
    const tokens: string[] = [];

    const { answer, status } = await new OpenAiCompatibleChatClient().stream({
      profile: profile(baseUrl),
      apiKey: "",
      messages: [{ role: "user", content: "question" }],
      onToken: (token) => tokens.push(token),
    });

    expect(answer).toBe("final token");
    expect(status).toBe("complete");
    expect(tokens).toEqual(["final token"]);
  });

  it("keeps a quoted query intact in the request body and reassembles a fragmented OpenAI-style stream", async () => {
    const question = 'What does "the \'fast\' car" \\backslash\\ mean? \u201Ccurly\u201D & <tags>';
    interface CapturedRequest { messages: Array<{ role: string; content: string }> }
    let captured: CapturedRequest | undefined;
    const baseUrl = await serve((request, response) => {
      let raw = "";
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => {
        captured = JSON.parse(raw) as CapturedRequest;
        const tokenJson = (content: string) =>
          JSON.stringify({
            id: "chatcmpl-abc", object: "chat.completion.chunk", created: 1,
            model: "gpt-4o-mini", system_fingerprint: "fp_1",
            choices: [{ index: 0, delta: { content }, logprobs: null, finish_reason: null }],
          });
        const events = [
          ": keep-alive",
          "",
          "data: " + tokenJson('He said: "quoted" and '),
          "data: " + tokenJson("it's \\backslash\\ ok"),
          "",
          "data: " + tokenJson("echo: " + question),
          "",
          "data: " + tokenJson("end"),
          "",
          "data: [DONE]",
          "",
        ].join("\n");
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (let offset = 0; offset < events.length; offset += 7) {
          response.write(events.slice(offset, offset + 7));
        }
        response.end();
      });
    });

    const tokens: string[] = [];
    const { answer, status } = await new OpenAiCompatibleChatClient().stream({
      profile: profile(baseUrl),
      apiKey: "sk-test",
      messages: [{ role: "user", content: question }],
      onToken: (token) => tokens.push(token),
    });

    const expected = 'He said: "quoted" and it\'s \\backslash\\ okecho: ' + question + "end";
    expect(captured?.messages.find((message) => message.role === "user")?.content).toBe(question);
    expect(answer).toBe(expected);
    expect(status).toBe("incomplete");
    expect(tokens.join("")).toBe(answer);
  });

  it("reports status length when the provider stops at the token limit", async () => {
    const baseUrl = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"content":"partial "}}]}\n\n');
      response.write('data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"length"}]}\n\n');
      response.write("data: [DONE]\n\n");
      response.end();
    });

    const { answer, status } = await new OpenAiCompatibleChatClient().stream({
      profile: profile(baseUrl),
      apiKey: "",
      messages: [{ role: "user", content: "question" }],
      onToken: () => undefined,
    });

    expect(answer).toBe("partial answer");
    expect(status).toBe("length");
  });

  it("keeps multi-byte characters intact when split across chunk boundaries", async () => {
    const baseUrl = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const payload = "data: " + JSON.stringify({ choices: [{ delta: { content: "h\u00e9llo \u{1F600} \u00fc \u201Cq\u201D" } }] });
      const bytes = Buffer.from(payload + "\n\n", "utf8");
      for (let offset = 0; offset < bytes.length; offset += 3) {
        response.write(bytes.subarray(offset, offset + 3));
      }
      response.end();
    });

    const { answer } = await new OpenAiCompatibleChatClient().stream({
      profile: profile(baseUrl),
      apiKey: "",
      messages: [{ role: "user", content: "question" }],
      onToken: () => undefined,
    });

    expect(answer).toBe("h\u00e9llo \u{1F600} \u00fc \u201Cq\u201D");
  });

  it("parses CRLF-delimited events when the final event has no trailing newline", async () => {
    const baseUrl = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"content":"A \\"quoted\\""}}]}\r\n');
      response.write("\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"B\"}}]}");
      response.end();
    });

    const { answer } = await new OpenAiCompatibleChatClient().stream({
      profile: profile(baseUrl),
      apiKey: "",
      messages: [{ role: "user", content: 'q "with quotes"' }],
      onToken: () => undefined,
    });

    expect(answer).toBe('A "quoted"B');
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
