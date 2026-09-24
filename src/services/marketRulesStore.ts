import { apiFetch } from "./apiClient";
import { estimatedRule, type MarketRule } from "../shared/marketRules";
import { getSymbolConfig } from "./marketDataService";

// CoinDCX's order rules, loaded once from the server at startup. Until they
// arrive (or if CoinDCX can't be reached) sizing uses a cautious estimate.

const rules = new Map<string, MarketRule>();

export async function loadMarketRules(): Promise<number> {
  try {
    const res = await apiFetch("/api/coindcx/markets");
    if (!res.ok) return 0;
    const list = (await res.json()) as MarketRule[];
    if (!Array.isArray(list)) return 0;
    rules.clear();
    for (const r of list) rules.set(r.symbol, r);
    return rules.size;
  } catch {
    return 0;
  }
}

/** Order rules for a symbol: CoinDCX's own when loaded, otherwise an estimate. */
export function ruleFor(symbol: string, price: number): MarketRule {
  const real = rules.get(symbol);
  if (real) return real;
  if (getSymbolConfig(symbol).assetClass === "equity") {
    return {
      market: symbol,
      symbol,
      minQuantity: 1,
      maxQuantity: Number.MAX_SAFE_INTEGER,
      quantityStep: 1,
      minNotional: 0,
      quantityPrecision: 0,
      pricePrecision: 2,
    };
  }
  return estimatedRule(symbol, price);
}

/** Symbols CoinDCX currently lists as active INR markets (empty until loaded). */
export function listedInrSymbols(): string[] {
  return [...rules.keys()];
}

/** Test hook. */
export function _setMarketRules(list: MarketRule[]) {
  rules.clear();
  for (const r of list) rules.set(r.symbol, r);
}
