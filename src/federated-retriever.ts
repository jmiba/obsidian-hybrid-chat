import type {
  OhsEndpointConfig,
  RetrievalFailure,
  RetrievalResult,
  RetrievedSource,
  SearchResult,
  VaultSelection,
} from "./domain";
import type { OhsGateway } from "./ohs-client";
import { fuseRankedResults, normalizeVaultRelativePath, type RankedVaultResults } from "./rank-fusion";

export interface RetrievalOptions {
  searchLimitPerVault: number;
  maxNotes: number;
  enableReranking: boolean;
  enableRelatedTraversal: boolean;
  frontmatterFilters: string[];
}

const RELATED_RESULTS_PER_ANCHOR = 2;

export class OhsRequestTimeoutError extends Error {
  readonly name = "OhsRequestTimeoutError";

  constructor(
    readonly stage: RetrievalFailure["stage"],
    readonly timeoutMs: number,
  ) {
    super(
      `OHS ${stage} timed out after ${formatTimeout(timeoutMs)}. `
      + "Hybrid Chat stopped waiting, but OHS may still be processing the request.",
    );
  }
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
      results: await withEndpointTimeout(endpoint, "search", signal, (requestSignal) => (
        this.ohs.search(
          endpoint.endpoint,
          query,
          options.searchLimitPerVault,
          options.enableReranking,
          options.frontmatterFilters,
          requestSignal,
        )
      )),
    })));
    if (signal?.aborted) throw abortError();
    const healthySearches: RankedVaultResults[] = [];
    searchSettled.forEach((settled, index) => {
      const endpoint = selectedEndpoints[index];
      if (!endpoint) return;
      if (settled.status === "fulfilled") {
        healthySearches.push({
          endpoint: settled.value.endpoint,
          results: settled.value.results.map((result) => ({ ...result, retrievalKind: "direct" })),
        });
      } else failures.push(failure(endpoint, "search", settled.reason));
    });

    const searchesWithRelated = options.enableRelatedTraversal
      ? await this.expandRelated(healthySearches, options.frontmatterFilters, failures, signal)
      : healthySearches;
    const candidateCount = searchesWithRelated.reduce((total, item) => total + item.results.length, 0);
    const globallyRanked = fuseRankedResults(searchesWithRelated, candidateCount);
    const globalOrder = new Map(globallyRanked.map((source, index) => [source.sourceId, index]));
    const sourcesById = new Map<string, RetrievedSource>();
    const failedReadVaults = new Set<string>();
    let candidateIndex = 0;

    // Read only as many candidates as needed, then move down the global ranking
    // when a path disappeared or an endpoint's read failed.
    while (sourcesById.size < options.maxNotes && candidateIndex < globallyRanked.length) {
      const needed = options.maxNotes - sourcesById.size;
      const batchByVault = new Map<string, typeof globallyRanked>();
      let batched = 0;
      while (batched < needed && candidateIndex < globallyRanked.length) {
        const candidate = globallyRanked[candidateIndex];
        candidateIndex += 1;
        if (!candidate || failedReadVaults.has(candidate.vaultId)) continue;
        const batch = batchByVault.get(candidate.vaultId) ?? [];
        batch.push(candidate);
        batchByVault.set(candidate.vaultId, batch);
        batched += 1;
      }
      if (batchByVault.size === 0) break;

      const batches = [...batchByVault];
      const readSettled = await Promise.allSettled(batches.map(async ([vaultId, selected]) => {
        const endpoint = selectedEndpoints.find((item) => item.id === vaultId);
        if (!endpoint) throw new Error(`Missing endpoint ${vaultId}`);
        const notes = await withEndpointTimeout(endpoint, "read", signal, (requestSignal) => (
          this.ohs.read(endpoint.endpoint, selected.map((item) => item.path), requestSignal)
        ));
        const notesByPath = new Map(notes
          .filter((note) => note.found)
          .map((note) => [normalizeVaultRelativePath(note.path), note]));
        const sources = selected.flatMap((candidate) => {
          const note = notesByPath.get(candidate.path);
          if (!note) return [];
          return [{ ...candidate, title: note.title || candidate.title, content: note.content }];
        });
        return { endpoint, sources };
      }));
      if (signal?.aborted) throw abortError();

      readSettled.forEach((settled, index) => {
        const [vaultId] = batches[index] ?? [];
        const endpoint = selectedEndpoints.find((item) => item.id === vaultId);
        if (settled.status === "fulfilled") {
          for (const source of settled.value.sources) sourcesById.set(source.sourceId, source);
        } else if (endpoint && !failedReadVaults.has(endpoint.id)) {
          failedReadVaults.add(endpoint.id);
          failures.push(failure(endpoint, "read", settled.reason));
        }
      });
    }

    const sources = [...sourcesById.values()]
      .sort((a, b) => (globalOrder.get(a.sourceId) ?? 0) - (globalOrder.get(b.sourceId) ?? 0))
      .slice(0, options.maxNotes);
    return {
      sources,
      failures,
      allSearchesFailed: healthySearches.length === 0,
    };
  }

  private async expandRelated(
    searches: RankedVaultResults[],
    frontmatterFilters: string[],
    failures: RetrievalFailure[],
    signal?: AbortSignal,
  ): Promise<RankedVaultResults[]> {
    const anchors = searches.flatMap((search) => {
      const anchor = search.results[0];
      return anchor ? [{ endpoint: search.endpoint, anchor }] : [];
    });
    if (anchors.length === 0) return searches;

    const relatedSettled = await Promise.allSettled(anchors.map(async ({ endpoint, anchor }) => ({
      endpoint,
      anchor,
      results: await withEndpointTimeout(endpoint, "related", signal, (requestSignal) => (
        this.ohs.related(endpoint.endpoint, anchor.path, frontmatterFilters, requestSignal)
      )),
    })));
    if (signal?.aborted) throw abortError();

    const relatedByVault = new Map<string, { anchorPath: string; results: SearchResult[] }>();
    relatedSettled.forEach((settled, index) => {
      const fallback = anchors[index];
      if (settled.status === "fulfilled") {
        relatedByVault.set(settled.value.endpoint.id, {
          anchorPath: settled.value.anchor.path,
          results: settled.value.results,
        });
      } else if (fallback) {
        failures.push(failure(fallback.endpoint, "related", settled.reason));
      }
    });

    return searches.map((search) => {
      const related = relatedByVault.get(search.endpoint.id);
      if (!related) return search;
      return {
        endpoint: search.endpoint,
        results: mergeRelatedCandidates(search.results, related.results, related.anchorPath),
      };
    });
  }
}

function mergeRelatedCandidates(
  direct: SearchResult[],
  related: SearchResult[],
  anchorPath: string,
): SearchResult[] {
  const normalizedAnchor = normalizeVaultRelativePath(anchorPath);
  const relatedCandidates = related
    .filter((candidate) => normalizeVaultRelativePath(candidate.path) !== normalizedAnchor)
    .slice(0, RELATED_RESULTS_PER_ANCHOR)
    .map((candidate) => ({
      ...candidate,
      retrievalKind: "related" as const,
      relatedFromPath: normalizedAnchor,
    }));
  const interleaved: SearchResult[] = [];
  const seen = new Set<string>();
  const add = (candidate: SearchResult | undefined): void => {
    if (!candidate) return;
    const path = normalizeVaultRelativePath(candidate.path);
    if (seen.has(path)) return;
    seen.add(path);
    interleaved.push({ ...candidate, path, rank: interleaved.length + 1 });
  };

  add(direct[0]);
  for (let index = 0; index < Math.max(direct.length - 1, relatedCandidates.length); index += 1) {
    add(relatedCandidates[index]);
    add(direct[index + 1]);
  }
  return interleaved;
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
  stage: RetrievalFailure["stage"],
  reason: unknown,
): RetrievalFailure {
  return {
    vaultId: endpoint.id,
    vaultDisplayName: endpoint.displayName,
    stage,
    kind: reason instanceof OhsRequestTimeoutError ? "timeout" : "error",
    message: reason instanceof Error ? reason.message : String(reason),
  };
}

function withEndpointTimeout<T>(
  endpoint: OhsEndpointConfig,
  stage: RetrievalFailure["stage"],
  outerSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (outerSignal?.aborted) return Promise.reject(abortError());
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      outerSignal?.removeEventListener("abort", cancel);
      callback();
    };
    const cancel = (): void => {
      controller.abort();
      finish(() => reject(abortError()));
    };
    const timeout = window.setTimeout(() => {
      controller.abort();
      finish(() => reject(new OhsRequestTimeoutError(stage, endpoint.requestTimeoutMs)));
    }, endpoint.requestTimeoutMs);
    outerSignal?.addEventListener("abort", cancel, { once: true });
    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
      );
  });
}

function formatTimeout(timeoutMs: number): string {
  const seconds = timeoutMs / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} seconds`;
}

function abortError(): Error {
  return new DOMException("Request canceled", "AbortError");
}
