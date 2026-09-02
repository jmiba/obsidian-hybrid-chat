export type ChatWorkPhase = "retrieving" | "generating";

export function chatWorkLabel(phase: ChatWorkPhase): string {
  return phase === "retrieving" ? "Searching sources…" : "Generating answer…";
}

export function shouldShowSources(isWorking: boolean, sourcesRevealed: boolean): boolean {
  return !isWorking || sourcesRevealed;
}
