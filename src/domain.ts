export type VaultSelectionMode = "current" | "specific" | "all";
export type QueryExpansionMode = "off" | "follow-ups" | "always";

export const DEFAULT_OHS_REQUEST_TIMEOUT_MS = 60_000;

export interface OhsEndpointConfig {
  id: string;
  displayName: string;
  endpoint: string;
  obsidianVaultName: string;
  requestTimeoutMs: number;
  enabled: boolean;
  selectedByDefault: boolean;
}

export interface ChatProviderProfile {
  id: string;
  displayName: string;
  baseUrl: string;
  model: string;
  apiKeySecretId: string;
  enabled: boolean;
}

export interface VaultSelection {
  mode: VaultSelectionMode;
  vaultIds: string[];
}

export interface SearchResult {
  path: string;
  title: string;
  snippet: string;
  rank: number;
  score?: number | null;
  tags?: string[];
  retrievalKind?: "direct" | "related";
  relatedFromPath?: string;
}

export interface NamespacedSearchResult extends SearchResult {
  vaultId: string;
  vaultDisplayName: string;
  obsidianVaultName: string;
  sourceId: string;
  rrfScore: number;
}

export interface RetrievedSource extends NamespacedSearchResult {
  content: string;
}

export interface RetrievalFailure {
  vaultId: string;
  vaultDisplayName: string;
  stage: "search" | "related" | "read";
  kind: "timeout" | "error";
  message: string;
}

export interface RetrievalResult {
  sources: RetrievedSource[];
  failures: RetrievalFailure[];
  allSearchesFailed: boolean;
}

export interface PackedContext {
  text: string;
  sources: RetrievedSource[];
  truncated: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  sources?: RetrievedSource[];
  failures?: RetrievalFailure[];
  retrievalUnavailable?: boolean;
}

export interface ChatSession {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface HybridChatSettings {
  ohsEndpoints: OhsEndpointConfig[];
  providers: ChatProviderProfile[];
  activeProviderId: string;
  defaultSelection: VaultSelection;
  searchLimitPerVault: number;
  maxNotes: number;
  enableOhsReranking: boolean;
  queryExpansionMode: QueryExpansionMode;
  enableRelatedNoteTraversal: boolean;
  maxContextChars: number;
  maxCharsPerNote: number;
  includeCurrentDateTime: boolean;
  customSystemPrompt: string;
  sessions: ChatSession[];
  activeSessionId: string;
}

export interface ChatCompletionMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
