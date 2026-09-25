import { useCallback, useMemo, useState } from "react";
import { DEFAULT_RISK_POLICY, type RiskPolicyConfig } from "../services/riskEngine";
import { cleanMarketLimits, type MarketLimits } from "../shared/marketLimits";

// The trade-size limits you can change in Settings, kept in this browser.
// Everything else comes from DEFAULT_RISK_POLICY.

const STORAGE_KEY = "nexus_risk_limits_v1";

export interface RiskLimits {
  /** Largest single position, in rupees. */
  maxOrderValueInr: number;
  /** Most of your equity that can be in open trades at once (0.1 = 10%). */
  maxAllowedExposureFraction: number;
  /** Amount per trade and trades at once, for coins and for stocks: these are what Settings sets now. */
  marketLimits: MarketLimits;
}

export const ORDER_VALUE_CHOICES = [2000, 5000, 10000, 25000, 50000];
export const EXPOSURE_CHOICES = [0.1, 0.25, 0.5, 0.75, 1];

function load(): RiskLimits {
  const defaults: RiskLimits = {
    maxOrderValueInr: DEFAULT_RISK_POLICY.maxOrderValueInr,
    maxAllowedExposureFraction: DEFAULT_RISK_POLICY.maxAllowedExposureFraction,
    marketLimits: cleanMarketLimits(null),
  };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    return {
      maxOrderValueInr: ORDER_VALUE_CHOICES.includes(saved?.maxOrderValueInr) ? saved.maxOrderValueInr : defaults.maxOrderValueInr,
      maxAllowedExposureFraction: EXPOSURE_CHOICES.includes(saved?.maxAllowedExposureFraction)
        ? saved.maxAllowedExposureFraction
        : defaults.maxAllowedExposureFraction,
      marketLimits: cleanMarketLimits(saved?.marketLimits),
    };
  } catch {
    return defaults;
  }
}

/**
 * The risk policy with your saved limits and current equity applied, plus a
 * setter for the limits.
 */
export function useRiskPolicy(equity: number) {
  const [limits, setLimitsState] = useState<RiskLimits>(load);

  const setLimits = useCallback((next: Partial<RiskLimits>) => {
    setLimitsState((prev) => {
      const merged = { ...prev, ...next };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      } catch {}
      return merged;
    });
  }, []);

  const policy = useMemo<RiskPolicyConfig>(
    () => ({
      ...DEFAULT_RISK_POLICY,
      ...limits,
      // The per-market limits decide; this total is for display.
      maxSimultaneousPositions:
        limits.marketLimits.coins.maxOpenTrades + limits.marketLimits.stocks.maxOpenTrades + limits.marketLimits.us.maxOpenTrades,
      equity: equity > 0 ? equity : DEFAULT_RISK_POLICY.equity,
    }),
    [limits, equity]
  );
  return { policy, limits, setLimits };
}
