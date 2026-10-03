import type { HistoricalTrade, Position } from "../types";
import { marketOf } from "../shared/marketLimits";
import { isUsSymbol } from "../shared/usMarket";

// The Lab's scorecard: each slower strategy's real paper trades so far, set
// against what its replay expects. A few weeks of trades can't prove an
// edge (breakout wins a quarter to a third of the time, so ten trades are
// mostly luck), but they show early whether paper trading behaves like the
// replay: wins and losses the size it expects, exits as it makes them, and
// stops that hold rather than gap past.

export type PaperStrategy = "coinBreakout" | "usBreakout" | "dailyCoins";

export const PAPER_STRATEGIES: { id: PaperStrategy; name: string }[] = [
  { id: "coinBreakout", name: "Coin breakout 55/20" },
  { id: "usBreakout", name: "US breakout 55/20" },
  { id: "dailyCoins", name: "Daily coin traders" },
];

/** Fewer closed trades than this, and the comparison isn't made. */
export const SCORECARD_MIN_TRADES = 10;
/** Under this many, luck still decides most of a strategy's average. */
export const SCORECARD_FAIR_TRADES = 30;
/** A stop exit filled this far past its stop (share of price) gapped through it. */
const GAP_PAST_STOP = 0.0025;

/** Which of the slower strategies a trade or position belongs to, or null for the 5-minute traders' and the rest. */
export function strategyOf(t: Pick<HistoricalTrade, "symbol" | "strategy" | "timeframe">): PaperStrategy | null {
  if (t.strategy === "breakout") return isUsSymbol(t.symbol) ? "usBreakout" : marketOf(t.symbol) === "coins" ? "coinBreakout" : null;
  if (t.timeframe === "1d" && marketOf(t.symbol) === "coins") return "dailyCoins";
  return null;
}

/** A replay's record: its trades, wins, the R they won and lost, and the average. */
export interface ReplayRecord {
  trades: number;
  avgR: number;
  wins: number;
  winR: number;
  lossR: number;
}

/** Several records as one (the daily traders that trade), or null without any trades. */
export function combineRecords(records: ReplayRecord[]): ReplayRecord | null {
  const trades = records.reduce((n, r) => n + r.trades, 0);
  if (trades === 0) return null;
  return {
    trades,
    avgR: records.reduce((n, r) => n + r.avgR * r.trades, 0) / trades,
    wins: records.reduce((n, r) => n + r.wins, 0),
    winR: records.reduce((n, r) => n + r.winR, 0),
    lossR: records.reduce((n, r) => n + r.lossR, 0),
  };
}

export type ExitKind = "stop" | "sale" | "target" | "time" | "you";

export interface PaperScore {
  strategy: PaperStrategy;
  closed: number;
  open: number;
  /** In R (the trade's result over what it risked at the first stop, after fees); null with no closed trades. */
  avgR: number | null;
  winPct: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  pnl: number;
  exits: Partial<Record<ExitKind, number>>;
  /** Stop exits that filled well past the stop (a gap, or a fast fall between price checks). */
  gapped: number;
  /** Paper against the replay: too few trades to say, within luck's reach of it, or clearly behind or ahead. */
  verdict: "early" | "inLine" | "behind" | "ahead";
  /** How far luck alone could put the paper average from the replay's (about two standard errors), once there are enough trades. */
  band: number | null;
}

const EXIT_KIND: Record<HistoricalTrade["exitReason"], ExitKind> = {
  STOP_LOSS: "stop",
  TRAILING_STOP: "sale",
  TAKE_PROFIT: "target",
  EXPIRY_TIME: "time",
  MANUAL: "you",
};

/** A strategy's paper trades so far, against its replay's record (null before it has one). */
export function paperScore(
  strategy: PaperStrategy,
  trades: HistoricalTrade[],
  positions: Pick<Position, "symbol" | "strategy" | "timeframe">[],
  replay: Pick<ReplayRecord, "avgR"> | null
): PaperScore {
  const mine = trades.filter((t) => strategyOf(t) === strategy && (t.riskAtOpen ?? 0) > 0);
  const rs = mine.map((t) => t.realizedPnl / t.riskAtOpen!);
  const n = rs.length;
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r <= 0);
  const mean = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const avgR = mean(rs);
  const exits: PaperScore["exits"] = {};
  let gapped = 0;
  for (const t of mine) {
    const kind = EXIT_KIND[t.exitReason];
    exits[kind] = (exits[kind] ?? 0) + 1;
    const fill = t.fillAtExit ?? t.exitPrice;
    if (t.exitReason === "STOP_LOSS" && t.stopAtExit && (t.direction === "LONG" ? fill < t.stopAtExit * (1 - GAP_PAST_STOP) : fill > t.stopAtExit * (1 + GAP_PAST_STOP))) gapped++;
  }
  let verdict: PaperScore["verdict"] = "early";
  let band: number | null = null;
  if (n >= SCORECARD_MIN_TRADES && avgR !== null && replay) {
    const sd = Math.sqrt(rs.reduce((a, r) => a + (r - avgR) ** 2, 0) / (n - 1));
    band = (2 * sd) / Math.sqrt(n);
    const gap = avgR - replay.avgR;
    verdict = gap < -band ? "behind" : gap > band ? "ahead" : "inLine";
  }
  return {
    strategy,
    closed: n,
    open: positions.filter((p) => strategyOf(p) === strategy).length,
    avgR,
    winPct: n > 0 ? Math.round((wins.length / n) * 100) : null,
    avgWinR: mean(wins),
    avgLossR: mean(losses),
    pnl: mine.reduce((a, t) => a + t.realizedPnl, 0),
    exits,
    gapped,
    verdict,
    band,
  };
}
