# Hybrid Chat

Hybrid Chat is a desktop-only Obsidian 1.13+ plugin that provides federated, provider-neutral RAG chat over existing [Obsidian Hybrid Search (OHS)](https://github.com/flowing-abyss/obsidian-hybrid-search) services.

It does **not** create a vector index, read OHS SQLite databases, or duplicate indexing. Retrieval is read-only: the plugin calls only the OHS MCP `search` and `read` tools. Chat export copies Markdown to the clipboard and does not create or modify vault notes.

## Architecture

1. The sidebar selects the current vault, explicitly selected vaults, or every enabled vault.
2. `OhsMcpClient` queries the configured stateless Streamable HTTP MCP endpoints concurrently through Obsidian's desktop HTTP API, avoiding browser CORS requirements for loopback services.
3. Native OHS cross-encoder reranking is enabled by default for each vault's hybrid candidates. The OHS service owns the reranker model and cache; Hybrid Chat sends only the MCP `rerank` flag.
4. Explicit YAML directives map to OHS frontmatter filters: `@property(status=todo)` includes an exact value, `@property(status!=done)` excludes one, and `@property(publication_date)` requests a property without filtering.
5. `FederatedRetriever` merges the resulting per-vault ranks with reciprocal-rank fusion. Raw OHS scores are never compared across vaults, and a diversity pass gives each healthy vault a chance to contribute.
6. Only the globally selected note paths are sent to OHS `read`; unavailable endpoints become visible partial failures.
7. `ContextPacker` applies per-note and total character limits. Each source is namespaced as `vault_id::vault/relative/path.md`. Only explicitly requested YAML properties from the currently open vault are appended; current OHS `read` responses do not expose arbitrary cross-vault frontmatter.
8. A fresh local/UTC timestamp and optional custom instructions are added to the protected grounding prompt. No datetime MCP call or model tool selection is required.
9. `OpenAiCompatibleChatClient` sends ordinary messages to `/v1/chat/completions` and streams SSE output. Retrieval never depends on model tool-calling.
10. Citations in the current vault open through the Obsidian workspace API. Other-vault citations use validated, percent-encoded `obsidian://open?vault=…&file=…` URIs.

The source is split into the OHS client, federated retriever, rank fusion, context packer, OpenAI-compatible client, citation mapper, settings, and session/UI layers.

## Privacy boundaries

- OHS endpoints may be local or remote. Every selected endpoint receives the user’s query.
- The configured chat provider receives the packed source text and recent chat history. A loopback provider can keep generation local; a cloud provider sends that data to the provider.
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
- Use explicit YAML directives in chat prompts: `@property(field=value)` filters by an exact value, `@property(field!=value)` excludes it, and `@property(field)` adds that current-vault value to answer context without filtering.
- Adjust per-vault search, global note-read, and context limits.

The current public OHS contract exposes `search` and batch `read` over stateless Streamable HTTP. Tool prefixes configured by OHS are discovered automatically.

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

For manual testing, copy `manifest.json`, `main.js`, and `styles.css` into `<vault>/.obsidian/plugins/obsidian-hybrid-chat/`, enable the plugin, configure OHS and a chat profile, then use the ribbon icon or **Hybrid Chat: Open chat** command.

## Releases

`main.js` is generated and intentionally not committed. Run `npm run package-release` to execute every quality gate, validate that `package.json`, `manifest.json`, and `versions.json` agree, and create these files under `dist/release/`:

- `main.js`
- `manifest.json`
- `styles.css`
- `checksums.sha256`

Pushing a tag that exactly matches `manifest.json` (for example, `0.1.0`) runs the release workflow against the tagged source, generates build-provenance attestations for the three Obsidian assets, and creates a draft GitHub release. Review its generated notes before publishing. Obsidian installs the individual `main.js`, `manifest.json`, and `styles.css` attachments; the checksum file is an additional verification aid.
