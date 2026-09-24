// CoinDCX's per-market order rules (minimum quantity, quantity step, minimum
// order value), and fitting a position size to them. Shared by the browser
// (sizing proposals) and the server (checking live orders).

export interface MarketRule {
  /** CoinDCX market code, e.g. "BTCINR". */
  market: string;
  /** App symbol, e.g. "BTC/INR". */
  symbol: string;
  minQuantity: number;
  maxQuantity: number;
  /** Quantities must be a whole multiple of this. */
  quantityStep: number;
  /** Smallest order value CoinDCX accepts, in the quote currency. */
  minNotional: number;
  quantityPrecision: number;
  pricePrecision: number;
  /** True when the numbers were estimated because CoinDCX's list wasn't available. */
  estimated?: boolean;
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Parses CoinDCX's /exchange/v1/markets_details response into rules for
 * active INR markets. Unknown or malformed entries are skipped.
 */
export function parseMarketsDetails(raw: unknown): MarketRule[] {
  if (!Array.isArray(raw)) return [];
  const out: MarketRule[] = [];
  for (const m of raw as Record<string, unknown>[]) {
    if (!m || typeof m !== "object") continue;
    const quote = String(m.base_currency_short_name ?? "").toUpperCase();
    const coin = String(m.target_currency_short_name ?? "").toUpperCase();
    const market = String(m.coindcx_name ?? m.symbol ?? "").toUpperCase();
    if (quote !== "INR" || !coin || !market) continue;
    if (m.status !== undefined && String(m.status).toLowerCase() !== "active") continue;

    const quantityPrecision = num(m.target_currency_precision) ?? 4;
    const pricePrecision = num(m.base_currency_precision) ?? 2;
    const precisionStep = Number((10 ** -quantityPrecision).toFixed(quantityPrecision));
    const step = num(m.step);
    out.push({
      market,
      symbol: `${coin}/INR`,
      minQuantity: num(m.min_quantity) ?? precisionStep,
      maxQuantity: num(m.max_quantity) ?? Number.MAX_SAFE_INTEGER,
      quantityStep: step && step > 0 ? step : precisionStep,
      minNotional: num(m.min_notional) ?? 0,
      quantityPrecision,
      pricePrecision,
    });
  }
  return out;
}

/**
 * A cautious stand-in when CoinDCX's list isn't available: allows fractional
 * quantities (as CoinDCX does) with a step worth about ₹1 or less, and
 * CoinDCX's usual ₹100 minimum order.
 */
export function estimatedRule(symbol: string, price: number): MarketRule {
  const quantityPrecision = price >= 100000 ? 5 : price >= 1000 ? 3 : price >= 10 ? 2 : price >= 1 ? 1 : 0;
  const step = Number((10 ** -quantityPrecision).toFixed(quantityPrecision));
  return {
    market: symbol.replace("/", ""),
    symbol,
    minQuantity: step,
    maxQuantity: Number.MAX_SAFE_INTEGER,
    quantityStep: step,
    minNotional: 100,
    quantityPrecision,
    pricePrecision: 2,
    estimated: true,
  };
}

/** Rounds down to the rule's quantity step, without floating-point dust. */
export function floorToStep(quantity: number, rule: Pick<MarketRule, "quantityStep" | "quantityPrecision">): number {
  if (!(quantity > 0) || !(rule.quantityStep > 0)) return 0;
  const steps = Math.floor(quantity / rule.quantityStep + 1e-9);
  const decimals = Math.max(rule.quantityPrecision, stepDecimals(rule.quantityStep));
  return Number((steps * rule.quantityStep).toFixed(decimals));
}

function stepDecimals(step: number): number {
  const s = String(step);
  if (s.includes("e-")) return Number(s.split("e-")[1]);
  return s.includes(".") ? s.split(".")[1].length : 0;
}

export type FitResult =
  | { ok: true; quantity: number; notional: number }
  | { ok: false; quantity: number; reason: string };

/** Fits a desired quantity to the market's step, maximum and minimums. */
export function fitQuantity(desired: number, price: number, rule: MarketRule): FitResult {
  const capped = Math.min(desired, rule.maxQuantity);
  const quantity = floorToStep(capped, rule);
  const notional = quantity * price;
  if (quantity <= 0 || quantity < rule.minQuantity) {
    return {
      ok: false,
      quantity,
      reason: `Size ${quantity} is below ${rule.symbol}'s minimum of ${rule.minQuantity}.`,
    };
  }
  if (notional < rule.minNotional) {
    return {
      ok: false,
      quantity,
      reason: `Order value ₹${notional.toFixed(2)} is below ${rule.symbol}'s minimum of ₹${rule.minNotional}.`,
    };
  }
  return { ok: true, quantity, notional };
}
