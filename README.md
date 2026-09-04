# Hybrid Chat

Hybrid Chat is a desktop-only Obsidian 1.13+ plugin that provides federated, provider-neutral RAG chat over existing [Obsidian Hybrid Search (OHS)](https://github.com/flowing-abyss/obsidian-hybrid-search) services.

It does **not** create a vector index, read OHS SQLite databases, or duplicate indexing. Retrieval is read-only: the plugin calls only the OHS MCP `search` and `read` tools. Chat export copies Markdown to the clipboard and does not create or modify vault notes.

## Architecture

1. The sidebar selects the current vault, explicitly selected vaults, or every enabled vault.
2. `OhsMcpClient` queries the configured stateless Streamable HTTP MCP endpoints concurrently through Obsidian's desktop HTTP API, avoiding browser CORS requirements for loopback services.
3. Hybrid Chat sends the original question to OHS. With the default **Follow-ups only** query-expansion mode, referential follow-ups also receive one bounded contextual variant through OHS `queries[]`. The optional **Always** mode adds a compact lexical recall variant. OHS performs per-vault multi-query RRF and then applies its native cross-encoder reranker once; endpoints with an older advertised schema receive only the original query.
4. Explicit YAML directives map to OHS frontmatter filters: `@property(status=todo)` includes an exact value, `@property(status!=done)` excludes one, and `@property(publication_date)` requests a property without filtering.
5. Conversation history is added to retrieval only when the current question appears referential, allowing references such as “she”, “that project”, or “the second one” to retain their subject without pulling self-contained questions toward stale topics. Assistant answers are not sent to OHS. `FederatedRetriever` merges the resulting per-vault ranks without comparing raw cross-vault scores, and a diversity pass gives each healthy vault a chance to contribute.
6. Only the globally selected note paths are sent to OHS `read`. If a selected path is missing or a vault read fails, the retriever moves down the ranked candidates until the requested number of readable notes is filled or candidates are exhausted. Unavailable endpoints remain visible partial failures.
7. `ContextPacker` applies per-note and total character limits and centers long-note excerpts around the matching OHS snippet instead of always taking the beginning. Each source is namespaced as `vault_id::vault/relative/path.md`. Only explicitly requested YAML properties from the currently open vault are appended; current OHS `read` responses do not expose arbitrary cross-vault frontmatter.
8. A fresh local/UTC timestamp and optional custom instructions are added to the protected grounding prompt. No datetime MCP call or model tool selection is required.
9. `OpenAiCompatibleChatClient` sends the current question and a bounded recent transcript to `/v1/chat/completions`, then streams SSE output. A new chat starts with empty conversational memory. Retrieval never depends on model tool-calling.
10. Citations in the current vault open through the Obsidian workspace API. Other-vault citations use validated, percent-encoded `obsidian://open?vault=…&file=…` URIs.

The source is split into the OHS client, federated retriever, rank fusion, context packer, OpenAI-compatible client, citation mapper, settings, and session/UI layers.

## Privacy boundaries

- OHS endpoints may be local or remote. Every selected endpoint receives the current query. Depending on the query-expansion setting, referential follow-ups may also include a bounded excerpt containing up to three earlier user questions, and **Always** may add a deterministic lexical variant. Assistant answers are not included in OHS queries.
- The configured chat provider receives the packed source text and up to 12 recent non-empty chat messages within a 12,000-character transcript budget. The current question is always retained. A loopback provider can keep generation local; a cloud provider sends that data to the provider.
- Remote chat endpoints must use HTTPS. Plain HTTP is accepted only for loopback hosts.
- API keys are stored by Obsidian `SecretStorage` through `SecretComponent`. Plugin data contains only secret identifiers.
- Chat sessions and retrieved source text are stored in this plugin’s `data.json` so sessions survive restarts. If the vault configuration is synchronized, that plugin data may synchronize too.
- Source text is marked as untrusted context in the system prompt, but prompt injection remains a model-level risk.
- This MVP has no note mutation, Redis, embeddings, Graphify, Docling, OCR, direct SQLite access, or OHS reindex/status calls.

## Configuration

In Obsidian settings:

- Register one OHS Streamable HTTP MCP endpoint per vault, including a stable ID, display name, exact Obsidian vault name, and enabled/default-selection state.
- Set a per-endpoint request timeout. The default is 60 seconds for each OHS `search` or `read`; a client timeout stops Hybrid Chat from waiting but cannot cancel synchronous database work already running inside OHS.
- Configure one or more OpenAI-compatible profiles, choose an active profile, enter its model, and select or create an API-key secret.
- Optionally customize language, tone, role, or answer structure. Grounding/citation rules remain enforced separately.
- Keep the local current-date/time injection enabled when relative dates such as “today” or “last week” matter.
- OHS reranking is enabled by default. Disable it when lower latency matters more than precision. The reranker model is configured on each OHS server, not in this plugin.
- Keep query expansion at **Follow-ups only** for the best default precision: ordinary questions are sent unchanged, while referential follow-ups receive bounded conversational context. Use **Off** for strict single-query retrieval or **Always** to opt into the broader lexical variant.
- Use explicit YAML directives in chat prompts: `@property(field=value)` filters by an exact value, `@property(field!=value)` excludes it, and `@property(field)` adds that current-vault value to answer context without filtering.
- Adjust per-vault search, global note-read, and context limits.

The current public OHS contract exposes multi-query `search` and batch `read` over stateless Streamable HTTP. Tool prefixes and support for `queries[]` are discovered from each endpoint's advertised schema.

Streamable HTTP remains the default because multiple clients can share one long-lived OHS indexer and model cache. STDIO is not currently exposed as a Hybrid Chat transport; a future local-only mode would need to own a persistent child process and make its indexing, memory, logging, and cancellation lifecycle explicit.

## Development

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run build
npm run check
```

For manual testing, copy `manifest.json`, `main.js`, and `styles.css` into `<vault>/.obsidian/plugins/hybrid-chat/`, enable the plugin, configure OHS and a chat profile, then use the ribbon icon or **Hybrid Chat: Open chat** command.

## Releases

`main.js` is generated and intentionally not committed. Run `npm run package-release` to execute every quality gate, validate that `package.json`, `manifest.json`, and `versions.json` agree, and create these files under `dist/release/`:

- `main.js`
- `manifest.json`
- `styles.css`
- `checksums.sha256`

Pushing a tag that exactly matches `manifest.json` (for example, `0.1.3`) runs the release workflow against the tagged source, generates build-provenance attestations from `checksums.sha256`, and creates a draft GitHub release containing only the three supported Obsidian assets: `main.js`, `manifest.json`, and `styles.css`. Review its generated notes before publishing.
