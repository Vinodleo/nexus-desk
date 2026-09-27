import { outcomeScore } from "./calibration";
import { conditionBuckets } from "./conditionStats";
import { oneShadowAtATime, type ShadowSignal } from "./shadowTracker";
import { marketOf } from "../shared/marketLimits";

// The scoring table: what setups like this one have scored, on the
// calibration's win scale (the target 1, the stop 0, in between by how far
// it got), given the conditions they appeared in. It starts from the average
// of every followed setup, and each condition adds or takes away: which
// trader in which market, then the rows of "When setups win" (market mood,
// Bitcoin's last hour, time of day, volume, trend strength, RSI). A
// condition's effect is pulled toward none unless many setups back it (it
// counts as if PRIOR_SETUPS more setups had shown no effect), so a thin row
// can't swing a score.
//
// The confidence score leans on it for what similar setups did. It replaces
// judging a setup by the 15 past setups with the closest indicator readings,
// which knew nothing of the trader or the market and swung with those 15.

/** Each condition's effect counts as if this many more setups had shown none. */
export const PRIOR_SETUPS = 20;
/** Passes over the conditions: each is fitted with the others' effects taken out. */
const ROUNDS = 8;

export interface ConditionModel {
  /** Average score of every setup learned from. */
  base: number;
  samples: number;
  /** Condition group → row → how much it adds to the score. */
  effects: Record<string, Record<string, number>>;
  /** Setups learned from for each trader in each market. */
  traderSetups: Record<string, number>;
}

const traderKey = (s: Pick<ShadowSignal, "setupName" | "symbol">) => `${s.setupName}|${marketOf(s.symbol)}`;
const keysOf = (s: ShadowSignal): Record<string, string> => ({ trader: traderKey(s), ...conditionBuckets(s) });

/** The table from followed intraday setups that have finished, each price move once. */
export function trainConditionModel(shadows: ShadowSignal[]): ConditionModel {
  const rows = oneShadowAtATime(shadows.filter((s) => s.horizon === "intraday")).flatMap((s) => {
    const y = outcomeScore(s);
    return y === null ? [] : [{ keys: keysOf(s), y }];
  });
  const base = rows.length > 0 ? rows.reduce((a, r) => a + r.y, 0) / rows.length : 0.5;
  const effects: Record<string, Record<string, number>> = {};
  const effect = (g: string, row: string) => effects[g]?.[row] ?? 0;
  const groups = [...new Set(rows.flatMap((r) => Object.keys(r.keys)))];
  for (let round = 0; round < ROUNDS; round++) {
    for (const g of groups) {
      const sums = new Map<string, { sum: number; n: number }>();
      for (const r of rows) {
        const row = r.keys[g];
        if (row === undefined) continue;
        let others = 0;
        for (const [g2, row2] of Object.entries(r.keys)) if (g2 !== g) others += effect(g2, row2);
        const acc = sums.get(row) ?? { sum: 0, n: 0 };
        acc.sum += r.y - base - others;
        acc.n++;
        sums.set(row, acc);
      }
      effects[g] = Object.fromEntries([...sums].map(([row, { sum, n }]) => [row, sum / (n + PRIOR_SETUPS)]));
    }
  }
  const traderSetups: Record<string, number> = {};
  for (const r of rows) traderSetups[r.keys.trader] = (traderSetups[r.keys.trader] ?? 0) + 1;
  return { base, samples: rows.length, effects, traderSetups };
}

/** A setup's score from the table, and how many setups of its trader in its market stand behind it. */
export function scoreWithConditions(model: ConditionModel, s: ShadowSignal): { score: number; samples: number } {
  const keys = keysOf(s);
  let score = model.base;
  for (const [g, row] of Object.entries(keys)) score += model.effects[g]?.[row] ?? 0;
  return { score: Math.min(1, Math.max(0, score)), samples: model.traderSetups[keys.trader] ?? 0 };
}
