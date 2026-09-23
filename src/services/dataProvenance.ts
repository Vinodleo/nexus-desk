import type { ExperienceVector, MarketBar, TradeProposal } from "../types";

// Where the data behind a decision came from. Generated price bars and the
// seeded starter memory bank are useful scaffolding, but results built on
// them must never be mistaken for evidence from the real market.

export function syntheticBarShare(bars: MarketBar[] | null | undefined): number {
  if (!bars || bars.length === 0) return 1;
  const synthetic = bars.filter((b) => b.isSynthetic).length;
  return Number((synthetic / bars.length).toFixed(3));
}

// Seeded starter experiences carry isSeeded; banks saved by older builds
// predate the flag, so fall back to the seed's id pattern ("exp-1".."exp-420").
// Real trades are recorded as "exp-live-<timestamp>".
export function isSeededExperience(e: Pick<ExperienceVector, "id" | "isSeeded">): boolean {
  return e.isSeeded === true || /^exp-\d+$/.test(e.id);
}

export function seededShare(experiences: Pick<ExperienceVector, "id" | "isSeeded">[]): number {
  if (experiences.length === 0) return 0;
  return Number((experiences.filter(isSeededExperience).length / experiences.length).toFixed(3));
}

/** True when any of the proposal's price history was generated. */
export function isBuiltOnSyntheticPrices(p: Pick<TradeProposal, "dataQuality">): boolean {
  return (p.dataQuality?.syntheticBarShare ?? 0) > 0;
}
