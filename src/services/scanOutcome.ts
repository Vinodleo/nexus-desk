// Why the scanner didn't turn a coin's latest candle into a proposal.

export type SkipReason =
  | "no_data"
  | "no_setup"
  | "against_trend"
  | "vetoed"
  | "low_confidence"
  | "negative_ev"
  | "already_open"
  | "below_min_size"
  | "thin_market"
  | "wide_spread"
  | "no_shorting"
  | "weaker_setup"
  | "outvoted"
  | "market_down"
  | "thin_trading"
  | "no_exit_edge"
  | "risk_limits";

export const SKIP_REASON_LABEL: Record<SkipReason, string> = {
  no_data: "Not enough real price data",
  no_setup: "No trader's rules matched",
  against_trend: "Against the 1-hour trend",
  vetoed: "Too volatile or news blackout",
  low_confidence: "Chance of a win too low",
  negative_ev: "Not worth it after fees",
  already_open: "Already holding this coin",
  below_min_size: "Size below exchange minimum",
  thin_market: "Too little on the order book",
  wide_spread: "Fees and spread too big for the stop",
  no_shorting: "Short setup: CoinDCX spot can't short",
  weaker_setup: "A better setup on the same coin was chosen",
  outvoted: "Outvoted by traders on the other side",
  market_down: "Bitcoin is falling: no coin longs",
  thin_trading: "Trades too rarely: stops fill badly",
  no_exit_edge: "This trader loses money with your exits lately",
  risk_limits: "Blocked by a risk limit",
};

export type RiskRejectionCode =
  | "kill_switch"
  | "quarantine"
  | "spread"
  | "stale_data"
  | "daily_loss"
  | "max_positions"
  | "liquidity"
  | "turnover"
  | "negative_ev"
  | "existing_position"
  | "exposure"
  | "size";

export function skipReasonForRisk(code: RiskRejectionCode | undefined): SkipReason {
  if (code === "negative_ev") return "negative_ev";
  if (code === "size") return "below_min_size";
  if (code === "existing_position") return "already_open";
  if (code === "liquidity") return "thin_market";
  if (code === "spread") return "wide_spread";
  return "risk_limits";
}

/** The outcome of scanning one coin's latest candle. */
export type SymbolScanOutcome = { symbol: string } & ({ proposed: true } | { proposed: false; reason: SkipReason });

export type SkipCounts = Partial<Record<SkipReason, number>>;

export function addSkipCounts(into: SkipCounts, outcomes: SymbolScanOutcome[]): SkipCounts {
  const next = { ...into };
  for (const o of outcomes) if (!o.proposed) next[o.reason] = (next[o.reason] ?? 0) + 1;
  return next;
}
