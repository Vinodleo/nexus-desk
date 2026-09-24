import { parseMarketsDetails, type MarketRule } from "../src/shared/marketRules";
import { fetchWithTimeout } from "./http";

// CoinDCX's order rules per market (minimum quantity, step, minimum order
// value), fetched from its public markets_details endpoint and cached. The
// list changes rarely, so it's refreshed every 6 hours; if a refresh fails
// the last good copy stays in use.

const MARKETS_DETAILS_URL = "https://api.coindcx.com/exchange/v1/markets_details";
const TTL_MS = 6 * 60 * 60 * 1000;

let cache: { at: number; rules: Map<string, MarketRule> } | null = null;
let inFlight: Promise<Map<string, MarketRule>> | null = null;

async function fetchRules(): Promise<Map<string, MarketRule>> {
  const res = await fetchWithTimeout(MARKETS_DETAILS_URL);
  if (!res.ok) throw new Error(`CoinDCX markets_details returned ${res.status}`);
  const rules = parseMarketsDetails(await res.json());
  if (rules.length === 0) throw new Error("CoinDCX markets_details had no active INR markets");
  return new Map(rules.map((r) => [r.market, r]));
}

/** All active INR market rules, keyed by CoinDCX market code (e.g. "BTCINR"). Empty if never fetched. */
export async function getMarketRules(): Promise<Map<string, MarketRule>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rules;
  if (!inFlight) {
    inFlight = fetchRules()
      .then((rules) => {
        cache = { at: Date.now(), rules };
        return rules;
      })
      .catch((err) => {
        console.warn(`[MarketRules] ${err?.message || err}; ${cache ? "keeping the last good copy" : "no rules yet"}`);
        return cache?.rules ?? new Map<string, MarketRule>();
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

export async function getMarketRule(market: string): Promise<MarketRule | undefined> {
  return (await getMarketRules()).get(market.toUpperCase());
}

/** Test hook. */
export function _resetMarketRulesCache() {
  cache = null;
  inFlight = null;
}
