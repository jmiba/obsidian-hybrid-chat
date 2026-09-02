import type {
  OhsEndpointConfig,
  RetrievalFailure,
  RetrievalResult,
  RetrievedSource,
  VaultSelection,
} from "./domain";
import type { OhsGateway } from "./ohs-client";
import { fuseRankedResults, type RankedVaultResults } from "./rank-fusion";

export interface RetrievalOptions {
  searchLimitPerVault: number;
  maxNotes: number;
  enableReranking: boolean;
  frontmatterFilters: string[];
}

export class FederatedRetriever {
  constructor(private readonly ohs: OhsGateway) {}

  async retrieve(
    query: string,
    endpoints: OhsEndpointConfig[],
    selection: VaultSelection,
    currentVaultName: string,
    options: RetrievalOptions,
    signal?: AbortSignal,
  ): Promise<RetrievalResult> {
    const selectedEndpoints = selectEndpoints(endpoints, selection, currentVaultName);
    if (selectedEndpoints.length === 0) throw new Error("No enabled OHS endpoints match the selected vault scope");

    const failures: RetrievalFailure[] = [];
    const searchSettled = await Promise.allSettled(selectedEndpoints.map(async (endpoint) => ({
      endpoint,
      results: await this.ohs.search(
        endpoint.endpoint,
        query,
        options.searchLimitPerVault,
        options.enableReranking,
        options.frontmatterFilters,
        signal,
      ),
    })));
    const healthySearches: RankedVaultResults[] = [];
    searchSettled.forEach((settled, index) => {
      const endpoint = selectedEndpoints[index];
      if (!endpoint) return;
      if (settled.status === "fulfilled") healthySearches.push(settled.value);
      else failures.push(failure(endpoint, "search", settled.reason));
    });

    const globallySelected = fuseRankedResults(healthySearches, options.maxNotes);
    const byVault = new Map<string, typeof globallySelected>();
    for (const source of globallySelected) {
      const list = byVault.get(source.vaultId) ?? [];
      list.push(source);
      byVault.set(source.vaultId, list);
    }

    const readSettled = await Promise.allSettled([...byVault].map(async ([vaultId, selected]) => {
      const endpoint = selectedEndpoints.find((item) => item.id === vaultId);
      if (!endpoint) throw new Error(`Missing endpoint ${vaultId}`);
      const notes = await this.ohs.read(endpoint.endpoint, selected.map((item) => item.path), signal);
      const notesByPath = new Map(notes.filter((note) => note.found).map((note) => [note.path, note]));
      const sources: RetrievedSource[] = selected.flatMap((candidate) => {
        const note = notesByPath.get(candidate.path);
        if (!note) return [];
        return [{ ...candidate, title: note.title || candidate.title, content: note.content }];
      });
      return { endpoint, sources };
    }));

    const sources: RetrievedSource[] = [];
    readSettled.forEach((settled, index) => {
      const vaultId = [...byVault.keys()][index];
      const endpoint = selectedEndpoints.find((item) => item.id === vaultId);
      if (settled.status === "fulfilled") sources.push(...settled.value.sources);
      else if (endpoint) failures.push(failure(endpoint, "read", settled.reason));
    });
    const globalOrder = new Map(globallySelected.map((source, index) => [source.sourceId, index]));
    sources.sort((a, b) => (globalOrder.get(a.sourceId) ?? 0) - (globalOrder.get(b.sourceId) ?? 0));
    return {
      sources,
      failures,
      allSearchesFailed: healthySearches.length === 0,
    };
  }
}

export function selectEndpoints(
  endpoints: OhsEndpointConfig[],
  selection: VaultSelection,
  currentVaultName: string,
): OhsEndpointConfig[] {
  const enabled = endpoints.filter((endpoint) => endpoint.enabled);
  if (selection.mode === "current") {
    return enabled.filter((endpoint) => endpoint.obsidianVaultName === currentVaultName);
  }
  if (selection.mode === "specific") {
    const selected = new Set(selection.vaultIds);
    return enabled.filter((endpoint) => selected.has(endpoint.id));
  }
  return enabled;
}

function failure(
  endpoint: OhsEndpointConfig,
  stage: "search" | "read",
  reason: unknown,
): RetrievalFailure {
  return {
    vaultId: endpoint.id,
    vaultDisplayName: endpoint.displayName,
    stage,
    message: reason instanceof Error ? reason.message : String(reason),
  };
}
