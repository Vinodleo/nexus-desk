import type { CandleSeries } from "./historyReplay";
import {
  BREAKOUT_SETTINGS,
  MOMENTUM_SETTINGS,
  breakoutTrades,
  coinWeekClose,
  momentumTrades,
  type BreakoutSettings,
  type ClassicTrade,
  type MomentumSettings,
} from "./classicStrategies";

// The settings test (the Lab's Tests tab): whether breakout's and momentum's
// records come from the settings they trade on or hold up nearby. A strategy
// worth trusting still makes money a little either side of its settings (a
// plateau); one that only works at its exact settings (a peak) was likely
// fitted to the past. Each strategy is replayed on the same candles, lists
// and costs as its long replay (history/dailyLong.ts, history/stocksLong.ts),
// at a 3 x 3 grid of settings around its own, a looser and a tighter stop
// (breakout), and its own settings at double the costs. It decides nothing.

/** Bumped when the grid or what's measured changes: the replays then run the test again. */
export const SETTINGS_TEST_VERSION = 1;

export type SettingsStrategy = "breakout" | "momentum";

/** One setting's replay: its trades, average result after costs, share won, and the years it made money. */
export interface SettingsCell {
  id: string;
  trades: number;
  avgR: number;
  winPct: number;
  yearsUp: number;
  years: number;
}

/**
 * How a strategy fares around its settings: the grid (rows by cols, row by
 * row; its own settings in the middle), the extra checks (stops, doubled
 * costs), the average over the grid and the verdict.
 */
export interface SettingsResult {
  strategy: SettingsStrategy;
  rows: number[];
  cols: number[];
  grid: SettingsCell[];
  extra: SettingsCell[];
  /** The grid's average result a trade: what a setting nearby made, the traded one included. */
  nearbyAvgR: number;
  /** Nearby settings (the grid less the traded one) that made money. */
  nearbyUp: number;
  verdict: SettingsVerdict;
}

/** "holds": every nearby setting made money, and doubled costs still do; "fragile": most nearby lost, or doubled costs lose; else "mixed". */
export type SettingsVerdict = "holds" | "mixed" | "fragile";

interface Variant<P> {
  id: string;
  settings: P;
  /** Costs times this (2 for the doubled-costs check). */
  costScale: number;
}

/** Breakout's grid: the high it buys above (rows) by the low it sells below (columns), days. */
export const BREAKOUT_ROWS = [40, BREAKOUT_SETTINGS.entryDays, 70];
export const BREAKOUT_COLS = [15, BREAKOUT_SETTINGS.exitDays, 30];
/** Momentum's grid: the days it ranks the rise over (rows) by how many it holds (columns). */
export const MOMENTUM_ROWS = [60, MOMENTUM_SETTINGS.days, 120];
export const MOMENTUM_COLS = [2, MOMENTUM_SETTINGS.hold, 5];

export const COSTS_DOUBLED = "costs-x2";

/** Breakout's settings to replay: the grid row by row, then a tighter and a looser stop, then doubled costs. */
export function breakoutVariants(): Variant<BreakoutSettings>[] {
  const grid = BREAKOUT_ROWS.flatMap((entryDays) =>
    BREAKOUT_COLS.map((exitDays) => ({ id: `${entryDays}/${exitDays}`, settings: { ...BREAKOUT_SETTINGS, entryDays, exitDays }, costScale: 1 }))
  );
  return [
    ...grid,
    { id: "stop-1.5", settings: { ...BREAKOUT_SETTINGS, stopAtr: 1.5 }, costScale: 1 },
    { id: "stop-3", settings: { ...BREAKOUT_SETTINGS, stopAtr: 3 }, costScale: 1 },
    { id: COSTS_DOUBLED, settings: BREAKOUT_SETTINGS, costScale: 2 },
  ];
}

/** Momentum's settings to replay: the grid row by row, then doubled costs. */
export function momentumVariants(): Variant<MomentumSettings>[] {
  const grid = MOMENTUM_ROWS.flatMap((days) =>
    MOMENTUM_COLS.map((hold) => ({ id: `${days}/${hold}`, settings: { days, hold }, costScale: 1 }))
  );
  return [...grid, { id: COSTS_DOUBLED, settings: MOMENTUM_SETTINGS, costScale: 2 }];
}

/** A setting's trades in one figure each. */
export function settingsCell(id: string, trades: ClassicTrade[]): SettingsCell {
  const byYear = new Map<number, number>();
  let total = 0;
  let wins = 0;
  for (const t of trades) {
    total += t.r;
    if (t.r > 0) wins++;
    const year = new Date(t.entryMs).getUTCFullYear();
    byYear.set(year, (byYear.get(year) ?? 0) + t.r);
  }
  const n = trades.length;
  return {
    id,
    trades: n,
    avgR: n > 0 ? total / n : 0,
    winPct: n > 0 ? Math.round((wins / n) * 100) : 0,
    yearsUp: [...byYear.values()].filter((r) => r > 0).length,
    years: byYear.size,
  };
}

/** Breakout at one setting over every coin or stock, as its replay: each one's own costs (scaled), on that year's list. */
export function breakoutVariantCell(
  series: Record<string, CandleSeries>,
  v: Variant<BreakoutSettings>,
  costFor: (symbol: string) => number,
  eligible: (symbol: string, ms: number) => boolean
): SettingsCell {
  const trades = Object.entries(series).flatMap(([symbol, s]) =>
    breakoutTrades(symbol, s, costFor(symbol) * v.costScale, (ms) => eligible(symbol, ms), v.settings)
  );
  return settingsCell(v.id, trades);
}

/** Momentum at one setting across the coins or stocks, as its replay: the market's guard, its week's close. */
export function momentumVariantCell(
  series: Record<string, CandleSeries>,
  v: Variant<MomentumSettings>,
  up: (dayStartMs: number) => boolean | undefined,
  costFor: (symbol: string) => number,
  eligible: (symbol: string, ms: number) => boolean,
  weekClose: (day: number, next: number | undefined) => boolean = coinWeekClose
): SettingsCell {
  const trades = momentumTrades(series, up, (symbol) => costFor(symbol) * v.costScale, eligible, weekClose, v.settings);
  return settingsCell(v.id, trades);
}

/** The cells (in the variants' order) as the strategy's result, with its verdict. */
export function settingsResult(strategy: SettingsStrategy, cells: SettingsCell[]): SettingsResult {
  const rows = strategy === "breakout" ? BREAKOUT_ROWS : MOMENTUM_ROWS;
  const cols = strategy === "breakout" ? BREAKOUT_COLS : MOMENTUM_COLS;
  const size = rows.length * cols.length;
  const grid = cells.slice(0, size);
  const extra = cells.slice(size);
  const centre = Math.floor(size / 2);
  const nearby = grid.filter((_, k) => k !== centre);
  const nearbyUp = nearby.filter((c) => c.trades > 0 && c.avgR > 0).length;
  const doubled = extra.find((c) => c.id === COSTS_DOUBLED);
  const costsHold = !doubled || doubled.avgR > 0;
  const verdict: SettingsVerdict =
    nearbyUp === nearby.length && costsHold ? "holds" : nearbyUp < Math.ceil(nearby.length / 2) || !costsHold ? "fragile" : "mixed";
  return {
    strategy,
    rows,
    cols,
    grid,
    extra,
    nearbyAvgR: grid.length > 0 ? grid.reduce((a, c) => a + c.avgR, 0) / grid.length : 0,
    nearbyUp,
    verdict,
  };
}
