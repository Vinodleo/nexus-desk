import type { MarketBar, RegimeType } from "../../src/types";
import { classifyRegime, decorateBarsWithIndicators } from "../../src/services/marketDataService";
import { MIN_SIGNAL_BARS, SIGNAL_INTERVAL_MS, mergeBars, toClosedBars } from "../../src/services/liveMarketStreamService";
import { describeCandleError, fetchCoinCandles } from "../coindcxMarketData";
import { fetchStockCandles } from "../angelOne";
import { isNseSymbol } from "../../src/shared/nse";
import { isUsSymbol } from "../../src/shared/usMarket";
import { fetchUsCandles } from "../alpaca";
import { usdInr } from "../fx";

// Closed 5-minute candles (with the scanner's indicators) and the 1-hour
// trend for each coin the server scans. The same data the app's market
// stream keeps, fetched the same way: the full ~25 hours the first time,
// then the latest few candles merged in after each close. NSE stocks come
// from Angel One: the last few sessions the first time (a session is only
// 75 candles), then today's.

const FULL_CANDLES = 300;
const RECENT_CANDLES = 24;
const FETCH_CONCURRENCY = 6;
const HOUR_MS = 60 * 60 * 1000;
/** The 1-hour trend changes slowly; refetch it this often. */
const MACRO_REFRESH_MS = 15 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** How far back a stock's first fetch reaches: enough for MIN_SIGNAL_BARS over weekends and holidays. */
const STOCK_HISTORY_MS = 7 * DAY_MS;
const STOCK_MACRO_HISTORY_MS = 30 * DAY_MS;
/** A USD/INR move bigger than this refetches the US candles at the new rate. */
const US_RATE_REFETCH = 0.002;

async function forEachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export class ServerMarketData {
  private bars = new Map<string, MarketBar[]>();
  private errors = new Map<string, string>();
  private macro = new Map<string, { regime: RegimeType; at: number }>();

  /** Fetches the latest closed candles for each symbol ("BTC/INR"). Returns the symbols with a new candle. */
  async refresh(symbols: string[], now: number = Date.now()): Promise<string[]> {
    const updated: string[] = [];
    // US stocks come in one request for all of them.
    const us = symbols.filter(isUsSymbol);
    if (us.length > 0) updated.push(...(await this.refreshUs(us, now)));
    await forEachLimited(symbols.filter((s) => !isUsSymbol(s)), FETCH_CONCURRENCY, async (sym) => {
      if (isNseSymbol(sym)) {
        if (await this.refreshStock(sym, now)) updated.push(sym);
        return;
      }
      const coin = sym.split("/")[0];
      const held = this.bars.get(sym);
      const lastHeld = held?.[held.length - 1]?.timestampMs;
      const recentOnly = !!held && held.length >= MIN_SIGNAL_BARS && lastHeld !== undefined && now - lastHeld < (RECENT_CANDLES - 4) * SIGNAL_INTERVAL_MS;
      try {
        const result = await fetchCoinCandles(coin, "5m", recentOnly ? RECENT_CANDLES : FULL_CANDLES);
        if (!result.list) {
          this.errors.set(sym, describeCandleError(result));
          return;
        }
        let fresh = toClosedBars(result.list, SIGNAL_INTERVAL_MS, now);
        if (fresh.length === 0) {
          this.errors.set(sym, "No usable candles in CoinDCX's reply");
          return;
        }
        if (recentOnly) fresh = mergeBars(held!, fresh, FULL_CANDLES);
        this.errors.delete(sym);
        this.bars.set(sym, decorateBarsWithIndicators(fresh));
        if (fresh[fresh.length - 1].timestampMs !== lastHeld) updated.push(sym);
      } catch (err: any) {
        this.errors.set(sym, err?.message || "Couldn't reach CoinDCX");
      }
    });
    return updated;
  }

  /** An NSE stock's candles from Angel One. Returns true if a new candle arrived. */
  private async refreshStock(sym: string, now: number): Promise<boolean> {
    const held = this.bars.get(sym);
    const lastHeld = held?.[held.length - 1]?.timestampMs;
    const recentOnly = !!held && held.length >= MIN_SIGNAL_BARS && lastHeld !== undefined && now - lastHeld < DAY_MS;
    try {
      const raw = await fetchStockCandles(sym, "FIVE_MINUTE", recentOnly ? now - 2 * HOUR_MS : now - STOCK_HISTORY_MS, now);
      let fresh = toClosedBars(raw, SIGNAL_INTERVAL_MS, now);
      if (fresh.length === 0) {
        this.errors.set(sym, "No candles from Angel One");
        return false;
      }
      if (recentOnly) fresh = mergeBars(held!, fresh, FULL_CANDLES);
      this.errors.delete(sym);
      this.bars.set(sym, decorateBarsWithIndicators(fresh.slice(-FULL_CANDLES)));
      return fresh[fresh.length - 1].timestampMs !== lastHeld;
    } catch (err: any) {
      this.errors.set(sym, err?.message || "Couldn't reach Angel One");
      return false;
    }
  }

  /** The USD/INR rate the held US candles were converted at. */
  private usRate: number | null = null;

  /**
   * US stocks' candles from Alpaca, in rupees, in one request: the last few
   * sessions the first time, then the last two hours merged in. A new
   * USD/INR rate refetches them all, so every candle is at the same rate.
   */
  private async refreshUs(symbols: string[], now: number): Promise<string[]> {
    const rate = usdInr();
    if (!rate) {
      for (const sym of symbols) this.errors.set(sym, "No USD/INR rate yet");
      return [];
    }
    if (this.usRate !== null && Math.abs(rate / this.usRate - 1) > US_RATE_REFETCH) {
      for (const sym of [...this.bars.keys()].filter(isUsSymbol)) this.bars.delete(sym);
    }
    this.usRate = rate;
    const recentOnly = symbols.every((sym) => {
      const held = this.bars.get(sym);
      const last = held?.[held.length - 1]?.timestampMs;
      return !!held && held.length >= MIN_SIGNAL_BARS && last !== undefined && now - last < DAY_MS;
    });
    const updated: string[] = [];
    try {
      const rows = await fetchUsCandles(symbols, "5Min", recentOnly ? now - 2 * HOUR_MS : now - STOCK_HISTORY_MS, now);
      for (const sym of symbols) {
        const held = this.bars.get(sym);
        const lastHeld = held?.[held.length - 1]?.timestampMs;
        let fresh = toClosedBars(rows[sym] ?? [], SIGNAL_INTERVAL_MS, now);
        if (fresh.length === 0) {
          if (!held) this.errors.set(sym, "No candles from Alpaca");
          continue;
        }
        if (held) fresh = mergeBars(held, fresh, FULL_CANDLES);
        this.errors.delete(sym);
        this.bars.set(sym, decorateBarsWithIndicators(fresh.slice(-FULL_CANDLES)));
        if (fresh[fresh.length - 1].timestampMs !== lastHeld) updated.push(sym);
      }
    } catch (err: any) {
      for (const sym of symbols) this.errors.set(sym, err?.message || "Couldn't reach Alpaca");
    }
    return updated;
  }

  /** Refreshes the 1-hour trend for symbols whose copy is older than MACRO_REFRESH_MS. */
  async refreshMacro(symbols: string[], now: number = Date.now()): Promise<void> {
    const due = symbols.filter((s) => now - (this.macro.get(s)?.at ?? 0) >= MACRO_REFRESH_MS);
    // US stocks: one request for all of them.
    const usDue = due.filter(isUsSymbol);
    if (usDue.length > 0) {
      try {
        const rows = await fetchUsCandles(usDue, "1Hour", now - STOCK_MACRO_HISTORY_MS, now);
        for (const sym of usDue) {
          const hours = toClosedBars(rows[sym] ?? [], HOUR_MS, now);
          if (hours.length > 0) this.macro.set(sym, { regime: classifyRegime(decorateBarsWithIndicators(hours)), at: now });
        }
      } catch {
        // Keep the last known trends.
      }
    }
    await forEachLimited(due.filter((s) => !isUsSymbol(s)), FETCH_CONCURRENCY, async (sym) => {
      try {
        let hours: MarketBar[];
        if (isNseSymbol(sym)) {
          hours = toClosedBars(await fetchStockCandles(sym, "ONE_HOUR", now - STOCK_MACRO_HISTORY_MS, now), HOUR_MS, now);
        } else {
          const result = await fetchCoinCandles(sym.split("/")[0], "1h", 100);
          hours = result.list ? toClosedBars(result.list, HOUR_MS, now) : [];
        }
        if (hours.length > 0) this.macro.set(sym, { regime: classifyRegime(decorateBarsWithIndicators(hours)), at: now });
      } catch {
        // Keep the last known trend; with none, the check stays neutral.
      }
    });
  }

  getBars(symbol: string): MarketBar[] | null {
    return this.bars.get(symbol) ?? null;
  }

  macroRegimes(): Record<string, RegimeType> {
    return Object.fromEntries([...this.macro.entries()].map(([s, m]) => [s, m.regime]));
  }

  /** Symbols without usable candles and why, for the status endpoint. */
  problems(symbols: string[]): { symbol: string; error: string }[] {
    return symbols.filter((s) => this.errors.has(s)).map((s) => ({ symbol: s, error: this.errors.get(s)! }));
  }

  /** Drops coins no longer scanned. */
  keepOnly(symbols: string[]): void {
    const keep = new Set(symbols);
    for (const s of [...this.bars.keys()]) if (!keep.has(s)) this.bars.delete(s);
    for (const s of [...this.macro.keys()]) if (!keep.has(s)) this.macro.delete(s);
  }
}
