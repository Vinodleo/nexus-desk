import type { StrategySetup } from "../types";
import { fitQuantity } from "../shared/marketRules";
import { ruleFor } from "./marketRulesStore";

// A proposal is priced at the close of the candle it came from; by the time
// it's approved the market has moved. The entry is taken at the live price,
// keeping the signal's stop and target (they mark the levels the setup is
// about), and the size shrinks if the stop is now further away. If price has
// already reached either level, or too little reward is left for the risk,
// the trade is skipped rather than chased.

/** Least reward-to-risk still worth entering at the live price. */
export const MIN_REWARD_TO_RISK_AT_ENTRY = 1.0;

export type EntryPricing =
  | { ok: true; entryPrice: number; units: number; rewardToRisk: number }
  | { ok: false; reason: string };

export function priceEntry(
  setup: Pick<StrategySetup, "symbol" | "direction" | "entryPrice" | "stopLoss" | "takeProfit">,
  livePrice: number | undefined,
  units: number,
  riskBudget: number
): EntryPricing {
  const entry = livePrice && livePrice > 0 ? livePrice : setup.entryPrice;
  const isLong = setup.direction === "LONG";
  const risk = isLong ? entry - setup.stopLoss : setup.stopLoss - entry;
  const reward = isLong ? setup.takeProfit - entry : entry - setup.takeProfit;

  if (risk <= 0) return { ok: false, reason: `Price (${entry}) is already past the stop (${setup.stopLoss}).` };
  if (reward <= 0) return { ok: false, reason: `Price (${entry}) has already reached the target (${setup.takeProfit}).` };

  const rewardToRisk = reward / risk;
  if (rewardToRisk < MIN_REWARD_TO_RISK_AT_ENTRY) {
    const movedPct = (Math.abs(entry - setup.entryPrice) / setup.entryPrice) * 100;
    return {
      ok: false,
      reason: `Price moved ${movedPct.toFixed(2)}% since the signal; only ${rewardToRisk.toFixed(2)}R of reward is left.`,
    };
  }

  // Never more than the scanner sized, and no more risk than budgeted.
  const byRisk = riskBudget > 0 ? riskBudget / risk : units;
  const fit = fitQuantity(Math.min(units, byRisk), entry, ruleFor(setup.symbol, entry));
  if (!fit.ok) return { ok: false, reason: fit.reason };
  return { ok: true, entryPrice: entry, units: fit.quantity, rewardToRisk };
}
