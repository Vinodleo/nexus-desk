import fs from "fs";
import path from "path";
import type { MeasuredTrade, TradeHistory } from "../../src/services/exitExpectancy";
import { isNseSymbol } from "../../src/shared/nse";
import { isUsSymbol } from "../../src/shared/usMarket";

// Each trader's finished trades, per trail profile, kept on the volume, so
// "Traders with your exits" covers the last 30 days (exitExpectancy's
// RECORD_DAYS) rather than the day of candles the server holds, and carries
// on after a restart. Saved when the records are re-measured (hourly).

const file = () => path.join(process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data"), "trader_records.json");

const kept = new Map<string, MeasuredTrade[]>();

/**
 * The coin costs the kept trades were measured under. Coin trades kept under
 * other costs are dropped when read, so no trader is judged on them (2:
 * CoinDCX's real fee, 0.59% a side, in place of 0.05%, Oct 2026).
 */
export const COIN_COSTS_VERSION = 2;
const COSTS_KEY = "_coinCosts";
const isCoin = (symbol: string) => !isUsSymbol(symbol) && !isNseSymbol(symbol);

const isTrade = (t: any): t is MeasuredTrade =>
  !!t &&
  typeof t.symbol === "string" &&
  typeof t.trader === "string" &&
  Number.isFinite(t.entryMs) &&
  Number.isFinite(t.exitMs) &&
  Number.isFinite(t.r);

/** The server's store for the traders' records. */
export const traderHistory: TradeHistory = {
  load: (profile) => kept.get(profile) ?? [],
  save: (profile, trades) => {
    kept.set(profile, trades);
    saveTraderRecords();
  },
};

export function loadTraderRecords(): void {
  try {
    if (!fs.existsSync(file())) return;
    const saved = JSON.parse(fs.readFileSync(file(), "utf8"));
    const sameCosts = saved?.[COSTS_KEY] === COIN_COSTS_VERSION;
    for (const [profile, trades] of Object.entries(saved ?? {})) {
      if (Array.isArray(trades)) kept.set(profile, trades.filter(isTrade).filter((t) => sameCosts || !isCoin(t.symbol)));
    }
  } catch (err) {
    console.warn("[TraderRecords] Couldn't read saved trades:", err);
  }
}

export function saveTraderRecords(): void {
  try {
    const f = file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(`${f}.tmp`, JSON.stringify({ ...Object.fromEntries(kept), [COSTS_KEY]: COIN_COSTS_VERSION }), "utf8");
    fs.renameSync(`${f}.tmp`, f);
  } catch (err) {
    console.warn("[TraderRecords] Couldn't save trades:", err);
  }
}

/** Test hook. */
export function _resetTraderRecords(): void {
  kept.clear();
}
