import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { build } from "esbuild";

// Inputs and raw results can contain private vault data. Keep them outside git.
// Usage: node scripts/trial-multi-query.mjs config.json cases.json output-directory
const [configPath, casesPath, outputPath] = process.argv.slice(2);
if (!configPath || !casesPath || !outputPath) {
  throw new Error("Usage: node scripts/trial-multi-query.mjs config.json cases.json output-directory");
}
const output = resolve(outputPath);
await mkdir(output, { recursive: true });
const config = JSON.parse(await readFile(configPath, "utf8"));
const cases = JSON.parse(await readFile(casesPath, "utf8"));
if (!Array.isArray(config.endpoints) || !config.endpoints.length || !Array.isArray(cases) || !cases.length) {
  throw new Error("Provide endpoints and at least one trial question");
}
for (const item of cases) {
  if (!item.id || typeof item.query !== "string" || !item.query.trim() || !Array.isArray(item.reformulations)
    || item.reformulations.length < 1 || item.reformulations.length > 3
    || item.reformulations.some((query) => typeof query !== "string" || !query.trim())) {
    throw new Error("Each case needs an id, query, and 1–3 nonempty reformulations");
  }
}
await build({ entryPoints: ["src/rank-fusion.ts"], outfile: join(output, "rank-fusion.mjs"), format: "esm", bundle: true, platform: "node" });
// Import the locally built repository module in this Node-only CLI.
// eslint-disable-next-line no-unsanitized/method -- Imports only the module just built from repository source.
const { fuseRankedResults } = await import(pathToFileURL(join(output, "rank-fusion.mjs")).href);
function post(url, options) {
  return new Promise((resolveResponse, reject) => {
    const request = (new URL(url).protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: options.method, headers: options.headers, signal: options.signal,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolveResponse({
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode, headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.end(options.body);
  });
}
let requestId = 0;
async function rpc(endpoint, method, params, notification = false) {
  const response = await post(endpoint.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": endpoint.protocol || "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", ...(!notification ? { id: ++requestId } : {}), method, ...(params ? { params } : {}) }),
    signal: AbortSignal.timeout(endpoint.requestTimeoutMs || 60000),
  });
  const body = response.body;
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}: ${body.slice(0, 300)}`);
  if (notification) return;
  const messages = response.headers["content-type"]?.includes("text/event-stream")
    ? body.split(/\r?\n\r?\n/).flatMap((event) => {
      const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      return data ? [JSON.parse(data)] : [];
    }) : [JSON.parse(body)];
  const message = messages.find((value) => "result" in value || "error" in value);
  if (!message || message.error) throw new Error(message?.error?.message || "Missing MCP response");
  return message.result;
}
function payload(result) {
  const text = result.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") || "";
  if (result.isError) throw new Error(text || "Tool failed");
  return result.structuredContent || JSON.parse(text.slice(0, text.lastIndexOf("}") + 1));
}
const report = { startedAt: new Date().toISOString(), config, cases, servers: [], runs: [] };
for (const endpoint of config.endpoints) {
  process.stdout.write(`Connecting to ${endpoint.id}\n`);
  const url = new URL(endpoint.endpoint);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) {
    throw new Error("This trial runner accepts loopback endpoints without URL credentials only");
  }
  const initialized = await rpc(endpoint, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "hybrid-chat-retrieval-trial", version: "1" } });
  endpoint.protocol = initialized.protocolVersion;
  await rpc(endpoint, "notifications/initialized", undefined, true);
  const { tools } = await rpc(endpoint, "tools/list", {});
  const find = (name) => tools.find((tool) => tool.name === name) || tools.find((tool) => tool.name.endsWith(`_${name}`));
  const search = find("search");
  if (!search?.inputSchema?.properties?.queries || !search.inputSchema.properties.rerank) {
    throw new Error(`${endpoint.id} does not advertise multi-query and rerank support`);
  }
  endpoint.searchTool = search.name;
  const status = find("status");
  process.stdout.write(`Discovered tools on ${endpoint.id}; reading status\n`);
  report.servers.push({ id: endpoint.id, info: initialized.serverInfo, status: status ? payload(await rpc(endpoint, "tools/call", { name: status.name, arguments: {} })) : null });
}
await writeFile(join(output, "results.json"), JSON.stringify(report, null, 2));
// Warm both paths before recording timings. No notes or index configuration are changed.
for (const variant of ["single", "multi"]) {
  process.stdout.write(`Warming ${variant} search\n`);
  await Promise.all(config.endpoints.map(async (endpoint) => {
    const result = await search(endpoint, cases[0], variant);
    process.stdout.write(`Warm ${variant} ${endpoint.id}: ${Math.round(result.elapsedMs)} ms\n`);
  }));
}
async function search(endpoint, item, variant) {
  const start = performance.now();
  const result = payload(await rpc(endpoint, "tools/call", {
    name: endpoint.searchTool,
    arguments: { query: item.query, ...(variant === "multi" ? { queries: item.reformulations } : {}), mode: "hybrid", limit: config.limit || 24, rerank: config.rerank !== false, snippet_length: 600 },
  }));
  if (!Array.isArray(result.results)) throw new Error("Search returned no result array");
  return { endpoint, results: result.results, elapsedMs: performance.now() - start };
}
for (let repetition = 0; repetition < (config.repetitions || 2); repetition++) {
  for (const [caseIndex, item] of cases.entries()) {
    const variants = (caseIndex + repetition) % 2 ? ["multi", "single"] : ["single", "multi"];
    for (const variant of variants) {
      const start = performance.now();
      const settled = await Promise.allSettled(config.endpoints.map((endpoint) => search(endpoint, item, variant)));
      const healthy = settled.filter((value) => value.status === "fulfilled").map((value) => value.value);
      const errors = settled.flatMap((value, index) => value.status === "rejected" ? [{ vaultId: config.endpoints[index].id, message: String(value.reason) }] : []);
      const selected = fuseRankedResults(healthy, config.maxNotes || 10);
      report.runs.push({ caseId: item.id, repetition, variant, elapsedMs: performance.now() - start, errors, vaults: healthy, selected });
      await writeFile(join(output, "results.json"), JSON.stringify(report, null, 2));
      process.stdout.write(`${item.id} ${variant} round ${repetition + 1}: ${selected.length} candidates, ${Math.round(report.runs.at(-1).elapsedMs)} ms, ${errors.length} errors\n`);
    }
  }
}
report.finishedAt = new Date().toISOString();
await writeFile(join(output, "results.json"), JSON.stringify(report, null, 2));
// Pool candidates without variant labels for relevance assessment.
const pools = cases.map((item) => {
  const notes = new Map();
  for (const run of report.runs.filter((run) => run.caseId === item.id)) {
    for (const note of run.selected) if (!notes.has(note.sourceId)) notes.set(note.sourceId, note);
  }
  return { id: item.id, question: item.query, candidates: [...notes.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId)).map(({ sourceId, title, snippet }) => ({ sourceId, title, snippet, relevance: null })) };
});
await writeFile(join(output, "judgments.json"), JSON.stringify(pools, null, 2));
