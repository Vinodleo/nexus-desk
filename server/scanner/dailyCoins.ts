import fs from "fs";
import path from "path";
import type { TradeProposal } from "../../src/types";
import type { RiskPolicyConfig } from "../../src/services/riskEngine";
import { FIXED_COINS, latestSlowSetups, sumRecords, type HistoryRecords } from "../../src/services/historyReplay";
import { MIN_EDGE_R, MIN_TRADER_TRADES } from "../../src/services/calibration";
import { roundPrice } from "../../src/services/strategyEngine";
import { ruleFor } from "../../src/services/marketRulesStore";
import { cleanMarketLimits } from "../../src/shared/marketLimits";
import { fitQuantity } from "../../src/shared/marketRules";
import { MAX_COIN_SPREAD, roundTripFeeRate, spreadTooWide } from "../../src/shared/tradeCosts";
import { DEFAULT_TRAIL_PROFILE, TRAIL_PROFILES, type TrailProfileId } from "../../src/shared/trailingStop";
import { getCoinUniverse } from "../coinUniverse";
import { getMarketRules } from "../marketRules";
import { fetchOrderBook } from "../coindcxMarketData";
import { fetchCoinDaily, type HistoryFetch } from "../history/historyCandles";
import { historyRunInfo } from "../history/historyJob";
import { getDeskState, scanningDesks, type DeskState } from "./deskState";
import { runServerAutopilot, serverAutopilotOn, type ServerAutopilotHooks } from "./autopilot";
import { riskPolicyFor, serverDailyPnl, typicalSpread } from "./scannerService";

// Coin trades on daily candles, paper only. Two years of replays found the
// traders losing their costs on 5-minute candles but making money on coins
// held for days on daily ones (+0.12R a trade on a list of coins fixed in
// advance). So once a day, just after the day's candle closes at 00:00 UTC
// (5:30 IST), the server reads each coin's daily candles from Binance, as
// the replay did, and takes the setups the replay would have taken there
// (latestSlowSetups: the same traders, spacing and cost check). They open
// through the server autopilot, within your coin limits (trades at once,
// amount and risk per trade), priced at CoinDCX's ask, with the stop and
// target the same distance away as on Binance's chart. The guardian then
// holds them as the replay did: trailed on the daily ATR, half banked at
// +1R, closed at 30 days exactly.
//
// Only traders whose two-year daily record with your trailing stop averages
// MIN_EDGE_R or more over MIN_TRADER_TRADES or more setups trade; the rest
// stay paused. Each trader trades alone (no panel vote): that's how the
// replay judged them. Gemini doesn't review these (it reads 5-minute
// candles), and a desk in live mode gets none.

const DAY_MS = 24 * 60 * 60 * 1000;
/** Scanned this long after the day's close (Binance publishes it at once; a little margin). */
export const DAILY_SCAN_AFTER_MS = 10 * 60 * 1000;
/** A day not scanned by then (the server was down) is skipped: the entries would be hours late. */
export const DAILY_SCAN_UNTIL_MS = 6 * 60 * 60 * 1000;
/** Daily candles read per coin: the replay's warm-up (210) and view (300), with room. */
const DAILY_CANDLES = 400;
const CHECK_EVERY_MS = 5 * 60 * 1000;
/** Between coins, kind to Binance's limits. */
const PAUSE_MS = 200;

const file = () => path.join(process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data"), "daily_coins.json");

/** What happened to one setup found. */
export interface DailyPick {
  symbol: string;
  trader: string;
  outcome: "opened" | "waiting" | "paused";
  reason?: string;
}

/** One user's daily scan. */
export interface DailyRun {
  at: number;
  /** The UTC day it ran on (its candles closed at that day's start). */
  day: string;
  /** Coins checked, and those whose candles couldn't be read. */
  coins: number;
  failed: string[];
  picks: DailyPick[];
  /** Why nothing was opened for this desk, when that's the case. */
  note?: string;
}

/** A trader's two-year record on daily coin candles with one trailing stop, and whether it trades. */
export interface TraderGate {
  trader: string;
  trades: number;
  avgR: number;
  on: boolean;
}

interface Saved {
  lastDay: string | null;
  runs: Record<string, DailyRun>;
}

let state: Saved = { lastDay: null, runs: {} };
let running = false;
let timer: ReturnType<typeof setInterval> | null = null;

export interface DailyCoinsDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The coins to check: today's most active and the coin check's fixed list, those CoinDCX trades in INR. */
  coins: () => Promise<string[]>;
  /** A coin's daily candles closed by `closedBy`. */
  daily: (symbol: string, closedBy: number) => Promise<HistoryFetch>;
  /** CoinDCX's best bid and ask for a coin, or null. */
  quote: (symbol: string) => Promise<{ bid: number; ask: number } | null>;
  spread: (symbol: string) => number | undefined;
  /** The two-year replay's daily records, or null before it has any. */
  records: () => HistoryRecords | null;
  desks: (now: number) => [string, DeskState][];
  dailyPnl: (uid: string, desk: DeskState, now: number) => number;
  /** Opens what the autopilot accepts and marks every proposal (runServerAutopilot). */
  open: typeof runServerAutopilot;
}

const realDeps: DailyCoinsDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  coins: async () => {
    const [universe, rules] = await Promise.all([getCoinUniverse(), getMarketRules()]);
    const list = [...new Set([...universe.coins.map((c) => c.symbol), ...FIXED_COINS])];
    return rules.size > 0 ? list.filter((s) => rules.has(s.replace("/", ""))) : list;
  },
  daily: (symbol, closedBy) => fetchCoinDaily(symbol, DAILY_CANDLES, closedBy),
  quote: async (symbol) => {
    const result = await fetchOrderBook(symbol.split("/")[0]);
    if (!("book" in result) || result.book.bids.length === 0 || result.book.asks.length === 0) return null;
    return { bid: result.book.bids[0][0], ask: result.book.asks[0][0] };
  },
  spread: typicalSpread,
  records: () => historyRunInfo()?.slow?.["1d"] ?? null,
  desks: scanningDesks,
  dailyPnl: serverDailyPnl,
  open: runServerAutopilot,
};

/** Never a live order, and no Gemini review: see above. */
const PAPER_HOOKS: ServerAutopilotHooks = {
  placeLiveEntry: async () => ({ ok: false, status: 400, error: "Daily coin trades are paper only." }),
  reviewTrade: async () => ({ outcome: "unreviewed", reason: "Daily trades aren't reviewed.", off: true }),
};

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const OUTCOME_ORDER: Record<DailyPick["outcome"], number> = { opened: 0, waiting: 1, paused: 2 };

/** Each trader's two-year daily coin record with `profile`, best first, and whether it trades. */
export function dailyTraderGates(records: HistoryRecords | null, profile: TrailProfileId): TraderGate[] {
  const byPeriod = records?.[profile] ?? {};
  const byTrader = new Map<string, ReturnType<typeof sumRecords>[]>();
  for (const byKey of Object.values(byPeriod)) {
    for (const [key, rec] of Object.entries(byKey)) {
      if (!key.startsWith("crypto:")) continue;
      const trader = key.slice("crypto:".length);
      byTrader.set(trader, [...(byTrader.get(trader) ?? []), rec]);
    }
  }
  return [...byTrader.entries()]
    .map(([trader, recs]) => {
      const sum = sumRecords(recs);
      const avgR = sum.trades > 0 ? sum.totalR / sum.trades : 0;
      return { trader, trades: sum.trades, avgR, on: sum.trades >= MIN_TRADER_TRADES && avgR >= MIN_EDGE_R };
    })
    .sort((a, b) => b.avgR - a.avgR);
}

/** Why a trader is paused, in a few words. */
function pausedReason(gate: TraderGate | undefined): string {
  if (!gate) return "no two-year daily record yet";
  if (gate.trades < MIN_TRADER_TRADES) return `only ${gate.trades} replayed setups (needs ${MIN_TRADER_TRADES})`;
  return `two-year daily record ${gate.avgR >= 0 ? "+" : "−"}${Math.abs(gate.avgR).toFixed(2)}R (needs +${MIN_EDGE_R.toFixed(2)}R)`;
}

/**
 * The proposal for a daily setup found on Binance's candles, in rupees at
 * CoinDCX's ask (the stop, target and ATR the same share of the price away),
 * sized to the coin limits: the risk per trade at the stop, never more than
 * the amount per trade.
 */
export function dailyProposal(
  found: { symbol: string; regime: TradeProposal["regime"]; setup: TradeProposal["setup"] },
  ask: number,
  gate: TraderGate,
  policy: RiskPolicyConfig,
  day: string,
  now: number
): TradeProposal {
  const { symbol, setup } = found;
  const scale = ask / setup.entryPrice;
  const stopLoss = roundPrice(setup.stopLoss * scale, ask);
  const takeProfit = roundPrice(setup.takeProfit * scale, ask);
  const limit = (policy.marketLimits ?? cleanMarketLimits(undefined)).coins;
  const risk = Math.abs(ask - stopLoss);
  const riskInr = limit.riskPerTradeInr ?? policy.equity * policy.maxRiskFraction;
  const fit = fitQuantity(Math.min(risk > 0 ? riskInr / risk : 0, limit.amountPerTradeInr / ask), ask, ruleFor(symbol, ask));
  const units = fit.ok ? fit.quantity : 0;
  const winShare = gate.trades > 0 ? Math.min(1, Math.max(0, 0.5 + gate.avgR / 4)) : 0.5;
  return {
    id: `daily-${day}-${symbol}-${setup.name}`,
    timestamp: new Date(now).toISOString(),
    symbol,
    setup: {
      ...setup,
      symbol,
      timeframe: "1d",
      entryPrice: ask,
      stopLoss,
      takeProfit,
      planAtr: (setup.planAtr ?? setup.features.atr) * scale,
      features: { ...setup.features, atr: setup.features.atr * scale },
    },
    regime: found.regime,
    metaScore: {
      setupId: setup.id,
      confidence: winShare,
      calibratedWinProbability: winShare,
      historicalSampleCount: gate.trades,
      historicalWinRate: winShare,
      confidenceRationale: `Two-year daily record with your trailing stop: ${gate.avgR >= 0 ? "+" : "−"}${Math.abs(gate.avgR).toFixed(2)}R over ${gate.trades} setups.`,
      regimeFit: "acceptable",
    },
    evAssessment: {
      pWin: winShare,
      avgWinDollars: 0,
      pLoss: 1 - winShare,
      avgLossDollars: 0,
      estimatedSpreadCost: 0,
      estimatedBrokerageFee: 0,
      estimatedSlippageCost: 0,
      estimatedLatencyTax: 0,
      totalCost: 0,
      expectedNetValue: Number((gate.avgR * risk * units).toFixed(2)),
      isPositiveEdge: true,
    },
    riskCalc: {
      equity: policy.equity,
      maxRiskPerTradeFraction: policy.maxRiskFraction,
      hardDailyLossLimit: policy.hardDailyLossLimit,
      currentDailyLoss: 0,
      portfolioExposureFraction: 0,
      maxAllowedExposureFraction: policy.maxAllowedExposureFraction,
      openPositionCount: 0,
      maxSimultaneousPositions: limit.maxOpenTrades,
      fractionalKellyFraction: 0,
      recommendedPositionSizeUnits: units,
      recommendedDollarExposure: Number((units * ask).toFixed(2)),
      riskDollars: Number((units * risk).toFixed(2)),
      passedAllChecks: units > 0,
      ...(fit.ok ? {} : { rejectionReason: fit.reason }),
    },
    status: "PENDING_APPROVAL",
    approvalExpiryMs: 0,
    supervisorNotes: "Daily candles: the trader's two-year daily record decides.",
    ensembleAgreement: 1,
    personaVotesCast: 1,
    supportingPersonas: [setup.name],
    exitEdge: { r: gate.avgR, trades: gate.trades },
  };
}

/** The desk's limits for daily trades: your coin limits, each trader judged alone (no panel vote). */
function dailyPolicy(desk: DeskState): RiskPolicyConfig {
  const policy = riskPolicyFor(desk);
  return { ...policy, marketLimits: cleanMarketLimits(desk.riskLimits.marketLimits), autopilotMinConsensus: 0, autopilotMinPersonaVotes: 1 };
}

/** Why a desk gets no daily trades today, or null. */
function deskNote(uid: string, desk: DeskState, policy: RiskPolicyConfig, deps: DailyCoinsDeps, now: number): string | null {
  if (!serverAutopilotOn(desk)) return "Autopilot is off, so no daily trades were opened.";
  if ((desk.tradingMode ?? "PAPER") !== "PAPER") return "Your desk is in live mode; daily trades are paper only for now.";
  if (deps.dailyPnl(uid, desk, now) <= -policy.hardDailyLossLimit) return "Today's loss limit is reached.";
  return null;
}

/**
 * The day's scan, once, between DAILY_SCAN_AFTER_MS and DAILY_SCAN_UNTIL_MS
 * after 00:00 UTC: every coin's daily setups, opened for each scanning desk
 * as the autopilot allows.
 */
export async function runDailyCoins(deps: DailyCoinsDeps = realDeps): Promise<void> {
  const now = deps.now();
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const day = isoDay(dayStart);
  const since = now - dayStart;
  if (running || state.lastDay === day || since < DAILY_SCAN_AFTER_MS || since > DAILY_SCAN_UNTIL_MS) return;
  const desks = deps.desks(now);
  if (desks.length === 0) return;
  running = true;
  // Marked first: a restart mid-scan doesn't open the day's trades twice.
  state.lastDay = day;
  save();
  try {
    const coins = await deps.coins();
    const failed: string[] = [];
    const found: { symbol: string; regime: TradeProposal["regime"]; setups: TradeProposal["setup"][]; spread: number | undefined }[] = [];
    for (const symbol of coins) {
      const fetched = await deps.daily(symbol, dayStart);
      await deps.sleep(PAUSE_MS);
      // Without the day just closed, it would trade on yesterday's candle.
      if ("error" in fetched || fetched.series.t.at(-1) !== dayStart - DAY_MS) {
        failed.push(symbol);
        continue;
      }
      const spread = deps.spread(symbol);
      const at = latestSlowSetups(symbol, fetched.series, "1d", roundTripFeeRate(symbol), Math.min(spread ?? MAX_COIN_SPREAD, MAX_COIN_SPREAD));
      if (at?.regime && at.setups.length > 0) found.push({ symbol, regime: at.regime, setups: at.setups, spread });
    }

    const quotes = new Map<string, { bid: number; ask: number } | null>();
    for (const [uid, desk] of desks) {
      const profile = (desk.trailProfile && desk.trailProfile in TRAIL_PROFILES ? desk.trailProfile : DEFAULT_TRAIL_PROFILE) as TrailProfileId;
      const gates = dailyTraderGates(deps.records(), profile);
      const gateOf = (trader: string) => gates.find((g) => g.trader === trader);
      const policy = dailyPolicy(desk);
      const note = deskNote(uid, desk, policy, deps, now);
      const picks: DailyPick[] = [];
      const candidates: { proposal: TradeProposal; avgR: number }[] = [];
      for (const f of found) {
        for (const setup of f.setups) {
          const gate = gateOf(setup.name);
          if (!gate?.on) {
            picks.push({ symbol: f.symbol, trader: setup.name, outcome: "paused", reason: pausedReason(gate) });
            continue;
          }
          if (spreadTooWide(f.symbol, f.spread ?? 0)) {
            picks.push({ symbol: f.symbol, trader: setup.name, outcome: "waiting", reason: `its spread (${((f.spread ?? 0) * 100).toFixed(2)}%) is wider than ${(MAX_COIN_SPREAD * 100).toFixed(1)}%` });
            continue;
          }
          if (!quotes.has(f.symbol)) quotes.set(f.symbol, await deps.quote(f.symbol));
          const quote = quotes.get(f.symbol);
          if (!quote) {
            picks.push({ symbol: f.symbol, trader: setup.name, outcome: "waiting", reason: "no CoinDCX price" });
            continue;
          }
          candidates.push({ proposal: dailyProposal({ symbol: f.symbol, regime: f.regime, setup }, quote.ask, gate, policy, day, now), avgR: gate.avgR });
        }
      }
      // The best records first: they get the coin slots.
      const proposals = candidates.sort((a, b) => b.avgR - a.avgR).map((c) => c.proposal);
      if (note) {
        for (const p of proposals) picks.push({ symbol: p.symbol, trader: p.setup.name, outcome: "waiting", reason: note });
      } else if (proposals.length > 0) {
        const livePrice = (s: string, direction: "LONG" | "SHORT") => {
          const q = quotes.get(s);
          return q ? (direction === "LONG" ? q.ask : q.bid) : undefined;
        };
        const marked = await deps.open(uid, desk, proposals, policy, { livePrice, barAtr: () => undefined }, now, PAPER_HOOKS);
        for (const p of marked) {
          picks.push(
            p.status === "APPROVED"
              ? { symbol: p.symbol, trader: p.setup.name, outcome: "opened" }
              : { symbol: p.symbol, trader: p.setup.name, outcome: "waiting", reason: p.deferralReason ?? "not opened" }
          );
        }
      }
      // Opened first, then those not opened, then paused traders' (a stable sort keeps the best records first).
      picks.sort((a, b) => OUTCOME_ORDER[a.outcome] - OUTCOME_ORDER[b.outcome]);
      state.runs[uid] = { at: now, day, coins: coins.length, failed, picks, ...(note ? { note } : {}) };
      const opened = picks.filter((p) => p.outcome === "opened").map((p) => p.symbol);
      console.log(`[DailyCoins] ${day}: ${coins.length} coins, ${picks.length} setups, opened ${opened.join(", ") || "none"} for ${uid}.`);
    }
    save();
  } catch (err) {
    console.error("[DailyCoins] Scan failed:", err);
  } finally {
    running = false;
  }
}

/** What the Lab shows a user: the last scan, each trader's daily record and whether it trades, and the next scan. */
export function dailyCoinsView(uid: string, now: number = Date.now()) {
  const desk = getDeskState(uid);
  const profile = (desk?.trailProfile && desk.trailProfile in TRAIL_PROFILES ? desk.trailProfile : DEFAULT_TRAIL_PROFILE) as TrailProfileId;
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const todayDone = state.lastDay === isoDay(dayStart) || now - dayStart > DAILY_SCAN_UNTIL_MS;
  return {
    run: state.runs[uid] ?? null,
    traders: dailyTraderGates(realDeps.records(), profile),
    nextAt: (todayDone ? dayStart + DAY_MS : dayStart) + DAILY_SCAN_AFTER_MS,
  };
}

export function loadDailyCoins(): void {
  try {
    if (!fs.existsSync(file())) return;
    const saved = JSON.parse(fs.readFileSync(file(), "utf8"));
    if (saved && typeof saved === "object") state = { lastDay: typeof saved.lastDay === "string" ? saved.lastDay : null, runs: saved.runs ?? {} };
  } catch (err) {
    console.warn("[DailyCoins] Couldn't read the last scan:", err);
  }
}

function save(): void {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(`${file()}.tmp`, JSON.stringify(state), "utf8");
    fs.renameSync(`${file()}.tmp`, file());
  } catch (err) {
    console.warn("[DailyCoins] Couldn't save the scan:", err);
  }
}

/** Checks every few minutes whether the day's scan is due. */
export function startDailyCoins(): void {
  loadDailyCoins();
  timer = setInterval(() => void runDailyCoins(), CHECK_EVERY_MS);
}

/** Test hooks. */
export function _resetDailyCoins(): void {
  state = { lastDay: null, runs: {} };
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
}
export function _dailyCoinsState(): Saved {
  return state;
}
