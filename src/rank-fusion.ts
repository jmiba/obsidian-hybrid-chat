import type { NamespacedSearchResult, OhsEndpointConfig, SearchResult } from "./domain";

export interface RankedVaultResults {
  endpoint: OhsEndpointConfig;
  results: SearchResult[];
}

export function namespaceSource(vaultId: string, path: string): string {
  return `${vaultId}::${normalizeVaultRelativePath(path)}`;
}

export function normalizeVaultRelativePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
}

export function fuseRankedResults(
  ranked: RankedVaultResults[],
  limit: number,
  rrfK = 60,
): NamespacedSearchResult[] {
  // OHS has already fused the query variants within each vault. This layer
  // normalizes only per-vault rank positions because raw scores from separately
  // configured services are not comparable, then preserves vault diversity.
  const candidates = ranked.flatMap(({ endpoint, results }, vaultOrder) => (
    results.map((result, index) => {
      const rank = Number.isInteger(result.rank) && result.rank > 0 ? result.rank : index + 1;
      return {
        ...result,
        path: normalizeVaultRelativePath(result.path),
        rank,
        vaultId: endpoint.id,
        vaultDisplayName: endpoint.displayName,
        obsidianVaultName: endpoint.obsidianVaultName,
        sourceId: namespaceSource(endpoint.id, result.path),
        rrfScore: 1 / (rrfK + rank),
        vaultOrder,
      };
    })
  ));

  const sorted = candidates.sort((left, right) => (
    right.rrfScore - left.rrfScore
    || left.rank - right.rank
    || left.vaultOrder - right.vaultOrder
    || left.path.localeCompare(right.path)
  ));

  const selected: typeof sorted = [];
  const selectedIds = new Set<string>();
  for (const vault of ranked) {
    const best = sorted.find((item) => item.vaultId === vault.endpoint.id);
    if (best && selected.length < limit) {
      selected.push(best);
      selectedIds.add(best.sourceId);
    }
  }
  for (const candidate of sorted) {
    if (selected.length >= limit) break;
    if (!selectedIds.has(candidate.sourceId)) {
      selected.push(candidate);
      selectedIds.add(candidate.sourceId);
    }
  }
  return selected.map((candidate) => ({
    path: candidate.path,
    title: candidate.title,
    snippet: candidate.snippet,
    rank: candidate.rank,
    score: candidate.score,
    tags: candidate.tags,
    vaultId: candidate.vaultId,
    vaultDisplayName: candidate.vaultDisplayName,
    obsidianVaultName: candidate.obsidianVaultName,
    sourceId: candidate.sourceId,
    rrfScore: candidate.rrfScore,
  }));
}
