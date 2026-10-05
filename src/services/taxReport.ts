import type { HistoricalTrade } from "../types";
import { marketOf, type MarketKey } from "../shared/marketLimits";
import { COIN_SALE_TDS } from "../shared/tradeMath";

// A yearly report of closed trades for the owner's CA (Book → Breakdown →
// Tax report): an Indian financial year (1 April to 31 March, India time),
// each market grouped by how India taxes it, as we understand the rules
// (2026). The CA decides; the app only adds up.
// - Coins (crypto, "virtual digital assets"): 30% plus 4% cess on each
//   trade's gain; a loss offsets nothing, not even another coin's gain, and
//   nothing is deducted but the purchase, so the estimate counts gains
//   before fees. CoinDCX withholds 1% TDS of each sale, credited when filing.
// - US stocks: capital gains, losses offsetting gains: short-term (held 24
//   months or less) at the slab rate, long-term at 12.5%. Brokerage comes
//   off. In rupees at the day's rate the app used; the CA may use SBI's.
// - Indian stocks: intraday trades, speculative business income at the slab
//   rate, costs deducted.
// Live trades and paper ones are reported apart: only live trades are taxed.

/** Crypto's rate, and the 4% cess on it. */
export const VDA_TAX_RATE = 0.3;
export const CESS = 0.04;
const IST_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TaxRow {
  market: MarketKey;
  symbol: string;
  /** "breakout", "momentum", "daily", or the trader's name. */
  strategy: string;
  boughtMs?: number;
  soldMs: number;
  daysHeld?: number;
  quantity: number;
  /** What it was bought for and sold for, before fees (₹). */
  buyValue: number;
  saleValue: number;
  fees: number;
  /** What it sold for less what it was bought for, before fees. */
  gain: number;
  /** After fees: what the book counted. */
  net: number;
  /** Coins: 1% of the sale, withheld by CoinDCX. */
  tds?: number;
  /** US: held more than 24 months. */
  longTerm?: boolean;
}

export interface TaxReport {
  /** "2026-27". */
  fy: string;
  live: boolean;
  coins: {
    rows: TaxRow[];
    /** The winners' gains, before fees: what the tax is on. */
    gains: number;
    /** The losers' losses (offsetting nothing). */
    losses: number;
    tds: number;
    /** 30% plus cess on the winners' gains. */
    tax: number;
  };
  us: { rows: TaxRow[]; shortTerm: number; longTerm: number };
  india: { rows: TaxRow[]; net: number };
}

/** The Indian financial year a time falls in: "2026-27" from 1 April 2026 to 31 March 2027 (India time). */
export function financialYearOf(ms: number): string {
  const d = new Date(ms + IST_MS);
  const start = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** The financial years with closed trades of a kind (live or paper), latest first. */
export function taxYears(trades: HistoricalTrade[], live: boolean): string[] {
  const years = new Set(trades.filter((t) => !!t.isLiveOrder === live && t.closedAtMs !== undefined).map((t) => financialYearOf(t.closedAtMs!)));
  return [...years].sort().reverse();
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Held more than 24 months (the date two years on, passed). */
function heldOverTwoYears(boughtMs: number, soldMs: number): boolean {
  const twoYears = new Date(boughtMs + IST_MS);
  twoYears.setUTCFullYear(twoYears.getUTCFullYear() + 2);
  return soldMs + IST_MS > twoYears.getTime();
}

export function taxRow(t: HistoricalTrade): TaxRow {
  const market = marketOf(t.symbol);
  const fees = t.feesPaid ?? 0;
  const gain = t.grossPnl ?? t.realizedPnl + fees;
  // A long buys first; a short sells first and buys back.
  const opened = t.entryPrice * t.quantity;
  const buyValue = t.direction === "SHORT" ? opened - gain : opened;
  const saleValue = t.direction === "SHORT" ? opened : opened + gain;
  const boughtMs = t.openedAtMs;
  const row: TaxRow = {
    market,
    symbol: t.symbol,
    strategy: t.strategy ?? (t.timeframe === "1d" ? "daily" : t.setupName || "—"),
    ...(boughtMs !== undefined ? { boughtMs, daysHeld: Math.max(0, Math.round((t.closedAtMs! - boughtMs) / DAY_MS)) } : {}),
    soldMs: t.closedAtMs!,
    quantity: t.quantity,
    buyValue: round2(buyValue),
    saleValue: round2(saleValue),
    fees: round2(fees),
    gain: round2(gain),
    net: round2(t.realizedPnl),
  };
  if (market === "coins") row.tds = round2(saleValue * COIN_SALE_TDS);
  if (market === "us") row.longTerm = boughtMs !== undefined && heldOverTwoYears(boughtMs, t.closedAtMs!);
  return row;
}

/** One financial year's closed trades of a kind (live or paper), by market. Trades without a close time are left out. */
export function taxReport(trades: HistoricalTrade[], fy: string, live: boolean): TaxReport {
  const rows = trades
    .filter((t) => !!t.isLiveOrder === live && t.closedAtMs !== undefined && financialYearOf(t.closedAtMs) === fy)
    .map(taxRow)
    .sort((a, b) => a.soldMs - b.soldMs);
  const of = (m: MarketKey) => rows.filter((r) => r.market === m);
  const sum = (xs: number[]) => round2(xs.reduce((a, b) => a + b, 0));
  const coins = of("coins");
  const gains = sum(coins.map((r) => Math.max(0, r.gain)));
  const us = of("us");
  const india = of("stocks");
  return {
    fy,
    live,
    coins: {
      rows: coins,
      gains,
      losses: sum(coins.map((r) => Math.min(0, r.gain))),
      tds: sum(coins.map((r) => r.tds ?? 0)),
      tax: round2(gains * VDA_TAX_RATE * (1 + CESS)),
    },
    us: { rows: us, shortTerm: sum(us.filter((r) => !r.longTerm).map((r) => r.net)), longTerm: sum(us.filter((r) => r.longTerm).map((r) => r.net)) },
    india: { rows: india, net: sum(india.map((r) => r.net)) },
  };
}

const MARKET_NAME: Record<MarketKey, string> = { coins: "Coins (crypto)", us: "US stocks", stocks: "Indian stocks (intraday)" };
/** India's date of a time: "2026-10-05". */
const day = (ms: number) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The report as a CSV file for the CA: a row per trade, then each market's totals. */
export function taxReportCsv(r: TaxReport): string {
  const header = [
    "Market", "Symbol", "Strategy", "Bought on", "Sold on", "Days held", "Quantity",
    "Bought for (₹)", "Sold for (₹)", "Fees (₹)", "Gain before fees (₹)", "Net after fees (₹)", "TDS 1% (₹)", "Term",
  ];
  const lines = [header];
  for (const x of [...r.coins.rows, ...r.us.rows, ...r.india.rows]) {
    lines.push([
      MARKET_NAME[x.market], x.symbol, x.strategy, x.boughtMs !== undefined ? day(x.boughtMs) : "", day(x.soldMs), x.daysHeld ?? "",
      String(Number(x.quantity.toPrecision(10))), x.buyValue.toFixed(2), x.saleValue.toFixed(2), x.fees.toFixed(2), x.gain.toFixed(2),
      x.net.toFixed(2), x.tds !== undefined ? x.tds.toFixed(2) : "", x.market === "us" ? (x.longTerm ? "long-term" : "short-term") : "",
    ].map(String));
  }
  lines.push([]);
  lines.push([`Financial year ${r.fy}, ${r.live ? "live trades" : "paper trades (no tax due)"}`]);
  lines.push(["Coins: winners' gains before fees", r.coins.gains.toFixed(2)]);
  lines.push(["Coins: losers' losses (offset nothing)", r.coins.losses.toFixed(2)]);
  lines.push(["Coins: TDS withheld (1% of each sale)", r.coins.tds.toFixed(2)]);
  lines.push(["Coins: tax estimate (30% + 4% cess on the gains)", r.coins.tax.toFixed(2)]);
  lines.push(["US stocks: short-term net after fees", r.us.shortTerm.toFixed(2)]);
  lines.push(["US stocks: long-term net after fees", r.us.longTerm.toFixed(2)]);
  lines.push(["Indian stocks: intraday net after fees", r.india.net.toFixed(2)]);
  lines.push(["US amounts are in rupees at the day's rate the app used; your CA may convert at SBI's rate."]);
  return `${lines.map((l) => l.map(csvCell).join(",")).join("\n")}\n`;
}
