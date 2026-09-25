import fs from "fs";
import path from "path";
import type { Position } from "../../src/types";
import { scanAllMarkets, type FullScanReport } from "../../src/services/marketScannerService";
import { DEFAULT_RISK_POLICY } from "../../src/services/riskEngine";
import { SIGNAL_INTERVAL_MS, nextCandleFetchAt } from "../../src/services/liveMarketStreamService";
import { mergeShadows, resolveShadows, type ShadowSignal } from "../../src/services/shadowTracker";
import { buildCalibrator } from "../../src/services/calibration";
import { experiencesFromShadows } from "../../src/services/experienceMemory";
import { toOrderBook } from "../../src/services/orderBookService";
import { setMarketRules } from "../../src/services/marketRulesStore";
import type { SymbolScanOutcome } from "../../src/services/scanOutcome";
import { getCoinUniverse } from "../coinUniverse";
import { currentEventWindow } from "../eventCalendar";
import { getMarketRules } from "../marketRules";
import { fetchOrderBook, recentBook } from "../coindcxMarketData";
import { entryPriceFrom } from "../../src/shared/quotes";
import { angelConfigured, fetchStockDepth } from "../angelOne";
import { freshQuote } from "../quoteStore";
import { alpacaConfigured, checkAlpacaAccount } from "../alpaca";
import { refreshUsdInr } from "../fx";
import { usQuoteBook } from "../usPrices";
import { isUsOpen, isUsSymbol, US_SYMBOLS } from "../../src/shared/usMarket";
import { marketOf } from "../../src/shared/marketLimits";
import { cleanMarketLimits } from "../../src/shared/marketLimits";
import { NSE_SYMBOLS, isNseOpen, isNseSymbol } from "../../src/shared/nse";
import { closedTradesFor, daemonPositions, type DaemonPosition } from "../guardian";
import { broadcastToUser, currentPrices } from "../realtime";
import { dailyPnlToday, deskFirstSeenAt, istDay, scanningDesks, getDeskState, type DeskState } from "./deskState";
import { lastServerOpenAt, runServerAutopilot, serverQuarantines } from "./autopilot";
import { getExpectancyTable, marketTrendFrom } from "../../src/services/exitExpectancy";
import { tradingActivity } from "../../src/services/tradingActivity";

/** Bitcoin: its trend decides whether coin longs are taken, so its candles are always kept. */
const MARKET_SYMBOL = "BTC/INR";
import { ServerMarketData } from "./marketData";

// The scanner, run on the server after every 5-minute candle close, so coins
// are scanned whether or not the app is open. It scans each user the way the
// app would (their limits, equity, open positions, quarantines and promoted
// Lab settings, synced from the app), follows every setup it finds (shadow
// tracking) and keeps the results for the app to pick up: live over the
// WebSocket when it's open, and on its next visit when it isn't. With Angel
// One set up, Nifty 50 stocks are scanned too while NSE is open.

/** One scan's results, as the app receives them. */
export interface ServerScanReport {
  at: number;
  outcomes: SymbolScanOutcome[];
  newProposals: FullScanReport["newProposals"];
}

interface UserScanState {
  reports: ServerScanReport[];
  shadows: ShadowSignal[];
  lastScanAt: number;
}

const MAX_REPORTS = 300;
/** A coin whose just-closed candle wasn't published yet gets one more look this long after. */
const LATE_CANDLE_RETRY_MS = 20_000;
/** The app treats the server as scanning if its last scan is newer than this. */
export const SERVER_SCAN_FRESH_MS = 12 * 60 * 1000;

const DATA_DIR = process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data");
const SHADOW_FILE = path.join(DATA_DIR, "scanner_shadows.json");

const market = new ServerMarketData();
const users = new Map<string, UserScanState>();
let universe: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function userState(uid: string): UserScanState {
  let s = users.get(uid);
  if (!s) {
    s = { reports: [], shadows: [], lastScanAt: 0 };
    users.set(uid, s);
  }
  return s;
}

export function loadScannerState(): void {
  try {
    if (!fs.existsSync(SHADOW_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(SHADOW_FILE, "utf8")) as Record<string, ShadowSignal[]>;
    for (const [uid, shadows] of Object.entries(saved ?? {})) if (Array.isArray(shadows)) userState(uid).shadows = shadows;
  } catch (err) {
    console.warn("[ServerScanner] Couldn't read saved setups:", err);
  }
}

/** Writes tracked setups to disk (also called on shutdown). */
export function saveScannerState(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const out = Object.fromEntries([...users.entries()].map(([uid, s]) => [uid, s.shadows]));
    fs.writeFileSync(`${SHADOW_FILE}.tmp`, JSON.stringify(out), "utf8");
    fs.renameSync(`${SHADOW_FILE}.tmp`, SHADOW_FILE);
  } catch (err) {
    console.warn("[ServerScanner] Couldn't save setups:", err);
  }
}

/** A guardian position in the shape the scanner's risk checks read. */
function asPosition(p: DaemonPosition): Position {
  return {
    id: p.id,
    symbol: p.symbol,
    direction: p.direction,
    setupName: p.setupName ?? "",
    entryPrice: p.entryPrice,
    currentPrice: p.currentPrice || p.entryPrice,
    quantity: p.quantity,
    bankedQuantity: p.bankedQuantity,
    bankedPrice: p.bankedPrice,
    stopLoss: p.stopLoss,
    takeProfit: p.takeProfit,
    unrealizedPnl: 0,
    unrealizedPnlPercent: 0,
    openTime: p.openTime,
    expectedHoldingTimeMinutes: p.expectedHoldingTimeMinutes ?? 30,
    metaConfidence: 0.5,
  };
}

/** A book read during the scan prices an entry for this long after. */
const ENTRY_BOOK_MAX_AGE_MS = 60_000;

/** Each coin's bid-ask spread (share of price), averaged over the books read; the trader replay charges it. */
const observedSpreads = new Map<string, number>();

export function recordSpread(symbol: string, spread: number): void {
  if (!(spread >= 0) || !Number.isFinite(spread)) return;
  const held = observedSpreads.get(symbol);
  observedSpreads.set(symbol, held === undefined ? spread : held * 0.7 + spread * 0.3);
}

/** A market's typical spread; for one never read, the middle of the others' in the same market (coins, Indian or US stocks). */
export function typicalSpread(symbol: string): number | undefined {
  const own = observedSpreads.get(symbol);
  if (own !== undefined) return own;
  const market = marketOf(symbol);
  const all = [...observedSpreads.entries()].filter(([s]) => marketOf(s) === market).map(([, v]) => v).sort((a, b) => a - b);
  return all.length > 0 ? all[Math.floor(all.length / 2)] : undefined;
}

async function getOrderBook(symbol: string, notional: number) {
  if (isUsSymbol(symbol)) {
    // Alpaca's free feed has no depth: the best bid and ask (IEX) with their sizes.
    const book = usQuoteBook(symbol);
    if (!book) return null;
    const orderBook = toOrderBook(book, notional, "alpaca");
    if (orderBook.spreadPct !== undefined) recordSpread(symbol, orderBook.spreadPct);
    return orderBook;
  }
  if (isNseSymbol(symbol)) {
    const book = await fetchStockDepth(symbol).catch(() => null);
    if (!book) return null;
    const orderBook = toOrderBook(book, notional, "angelone");
    if (orderBook.spreadPct !== undefined) recordSpread(symbol, orderBook.spreadPct);
    return orderBook;
  }
  const result = await fetchOrderBook(symbol.split("/")[0]);
  if (!("book" in result)) return null;
  const orderBook = toOrderBook(result.book, notional);
  if (orderBook.spreadPct !== undefined) recordSpread(symbol, orderBook.spreadPct);
  return orderBook;
}

/** Stocks the scanner covers: the Nifty 50 when Angel One is set up. */
export function stockUniverse(): string[] {
  return angelConfigured() ? NSE_SYMBOLS : [];
}

/** US stocks the scanner covers: when Alpaca is set up (paper, prices in rupees). */
export function usUniverse(): string[] {
  return alpacaConfigured() ? US_SYMBOLS : [];
}

/** Everything with candles to measure traders on: coins, and stocks, Indian and US (whose candles are kept overnight). */
function measuredSymbols(): string[] {
  return [...universe, ...stockUniverse(), ...usUniverse()];
}

/** Whether a symbol's market is open for fresh candles now (coins always are). */
function marketOpenFor(symbol: string, now: number): boolean {
  return isUsSymbol(symbol) ? isUsOpen(now) : isNseSymbol(symbol) ? isNseOpen(now) : true;
}

/** The coins, plus the Indian stocks while NSE is open and the US stocks while the US market is. */
function scanList(now: number): string[] {
  return [...universe, ...(isNseOpen(now) ? stockUniverse() : []), ...(isUsOpen(now) ? usUniverse() : [])];
}

/**
 * Today's realised P&L for the daily loss limit: what the app last sent,
 * plus trades the guardian closed after that (the app counts those once it
 * hears of them and sends a new total, but it may be closed).
 */
export function serverDailyPnl(uid: string, desk: DeskState, now: number = Date.now()): number {
  const today = istDay(now);
  const since = desk.pnlDay === today ? desk.updatedAt : 0;
  const later = closedTradesFor(uid)
    .filter((t) => {
      const at = Date.parse(t.closedAt);
      return at > since && istDay(at) === today;
    })
    .reduce((sum, t) => sum + t.realizedPnl, 0);
  return Number((dailyPnlToday(desk, now) + later).toFixed(2));
}

/** Scans `symbols` for one user and records the results. */
export async function scanForUser(uid: string, desk: DeskState, symbols: string[], now: number = Date.now()): Promise<ServerScanReport> {
  const state = userState(uid);
  const barsMap = Object.fromEntries(symbols.flatMap((s) => {
    const bars = market.getBars(s);
    return bars ? [[s, bars]] : [];
  }));
  const riskPolicy = {
    ...DEFAULT_RISK_POLICY,
    ...desk.riskLimits,
    ...(desk.riskLimits.marketLimits ? { marketLimits: cleanMarketLimits(desk.riskLimits.marketLimits) } : {}),
    equity: desk.equity > 0 ? desk.equity : DEFAULT_RISK_POLICY.equity,
  };
  const report = await scanAllMarkets({
    symbols,
    cryptoSymbols: universe,
    equitySymbols: [...stockUniverse(), ...usUniverse()],
    now,
    // Each trader's last day with your exits; remeasured hourly.
    exitExpectancy: getExpectancyTable(measuredSymbols(), (s) => market.getBars(s), desk.trailProfile, now, typicalSpread),
    marketTrend: marketTrendFrom(market.getBars(MARKET_SYMBOL), market.macroRegimes()[MARKET_SYMBOL]),
    barsMap,
    activePositions: [...daemonPositions.values()].filter((p) => p.userId === uid).map(asPosition),
    dailyRealizedPnl: serverDailyPnl(uid, desk, now),
    failureState: desk.failureState,
    riskPolicy,
    // The trade memory: this user's finished tracked setups (real results).
    experiences: experiencesFromShadows(state.shadows),
    quarantines: serverQuarantines(uid, desk, now),
    getOrderBook,
    calibrators: { heuristic: buildCalibrator(state.shadows, "heuristic") },
    promotedModel: desk.promotedModel,
    macroRegimes: market.macroRegimes(),
    eventWindow: await currentEventWindow(now),
    // The Lab's TensorFlow model lives in the browser.
    useLabModel: false,
  });
  // Self-Approve: opens what autopilot accepts and marks each proposal.
  const newProposals = await runServerAutopilot(uid, desk, report.newProposals, riskPolicy, {
    // A coin opens at the ask (or bid, for a short) from the order book the
    // scan just read, a stock at its latest quote (Angel One, or Alpaca for
    // US stocks); otherwise at the latest trade or candle close.
    livePrice: (s, direction) => {
      const coin = marketOf(s) === "coins";
      const book = coin ? recentBook(s.split("/")[0], ENTRY_BOOK_MAX_AGE_MS) : null;
      if (book && book.bids.length > 0 && book.asks.length > 0) {
        return entryPriceFrom(direction, { bid: book.bids[0][0], ask: book.asks[0][0], at: book.fetchedAt });
      }
      const quote = coin ? undefined : freshQuote(s, now);
      if (quote) return entryPriceFrom(direction, quote);
      return currentPrices[s] ?? market.getBars(s)?.at(-1)?.close;
    },
    barAtr: (s) => market.getBars(s)?.at(-1)?.atr,
  }, now);
  const record: ServerScanReport = { at: now, outcomes: report.outcomes, newProposals };
  state.reports = [...state.reports, record].slice(-MAX_REPORTS);
  state.shadows = mergeShadows(state.shadows, report.shadows);
  state.lastScanAt = now;
  broadcastToUser(uid, { type: "SCAN_REPORT", data: record });
  return record;
}

/** Stocks without candles are loaded outside market hours at most this often. */
const STOCK_BACKFILL_GAP_MS = 60 * 60 * 1000;
let lastStockBackfillAt = 0;

/** Brings candles, trend and exchange rules up to date for the scanned coins. */
async function refreshMarket(now: number): Promise<void> {
  universe = (await getCoinUniverse()).coins.map((c) => c.symbol);
  const rules = await getMarketRules();
  setMarketRules([...rules.values()]);
  // Coins with setups still being followed keep their candles too.
  const followed = [...users.values()].flatMap((u) => u.shadows.filter((s) => s.status === "open").map((s) => s.symbol));
  // US prices are converted to rupees: keep the rate current.
  if (usUniverse().length > 0) {
    await refreshUsdInr(now);
    await checkAlpacaAccount(now);
  }
  // Stocks keep their candles overnight; they're fetched only while their
  // market is open. Except stocks with none at all (after a restart): their
  // last session is loaded anyway (Angel One and Alpaca serve past candles
  // any time), at most hourly, so the traders' record doesn't vanish until
  // the open.
  market.keepOnly([...new Set([...universe, ...stockUniverse(), ...usUniverse(), ...followed, MARKET_SYMBOL])]);
  const missingStocks =
    now - lastStockBackfillAt >= STOCK_BACKFILL_GAP_MS
      ? [...stockUniverse(), ...usUniverse()].filter((s) => !marketOpenFor(s, now) && !market.getBars(s))
      : [];
  if (missingStocks.length > 0) lastStockBackfillAt = now;
  const symbols = [...new Set([...scanList(now), ...followed, MARKET_SYMBOL])].filter((sym) => marketOpenFor(sym, now));
  await market.refresh([...symbols, ...missingStocks], now);
  await market.refreshMacro([...new Set([...scanList(now), MARKET_SYMBOL])], now);
}

/** One cycle: fresh candles, then every scanning user's scan and shadow tracking. */
export async function runScanCycle(now: number = Date.now()): Promise<void> {
  const desks = scanningDesks(now);
  if (desks.length === 0) return;
  await refreshMarket(now);
  for (const [uid] of desks) {
    const state = userState(uid);
    state.shadows = resolveShadows(state.shadows, (s) => market.getBars(s), now);
  }
  for (const [uid, desk] of desks) {
    try {
      await scanForUser(uid, desk, scanList(now), now);
    } catch (err) {
      console.error(`[ServerScanner] Scan failed for ${uid}:`, err);
    }
  }
  saveScannerState();

  // Coins whose just-closed candle wasn't out yet get one retry.
  const justClosedOpen = Math.floor(now / SIGNAL_INTERVAL_MS) * SIGNAL_INTERVAL_MS - SIGNAL_INTERVAL_MS;
  const late = scanList(now).filter((s) => (market.getBars(s)?.at(-1)?.timestampMs ?? 0) < justClosedOpen);
  if (late.length > 0) {
    setTimeout(async () => {
      const retryAt = Date.now();
      const updated = await market.refresh(late, retryAt);
      if (updated.length === 0) return;
      for (const [uid, desk] of scanningDesks(retryAt)) {
        await scanForUser(uid, desk, updated, retryAt).catch((err) => console.error(`[ServerScanner] Retry scan failed for ${uid}:`, err));
      }
      saveScannerState();
    }, LATE_CANDLE_RETRY_MS);
  }
}

/** "Scan now" from the app: fresh candles, then every coin for this user. */
export async function scanNow(uid: string): Promise<ServerScanReport | null> {
  const desk = getDeskState(uid);
  if (!desk) return null;
  const now = Date.now();
  await refreshMarket(now);
  const record = await scanForUser(uid, desk, scanList(now), now);
  saveScannerState();
  return record;
}

/**
 * Whether the server is scanning for this user: a recent scan, or (just after
 * a restart, or the app's first settings) its candle loop alive and a scan
 * due. The app scans by itself only when this is false, so it mustn't read
 * false while the server is about to scan: both would trade the same candle.
 */
export function scannerStatus(uid: string, now: number = Date.now()) {
  const state = users.get(uid);
  const desk = getDeskState(uid);
  const lastScanAt = state?.lastScanAt ?? 0;
  const firstSeen = deskFirstSeenAt(uid) ?? 0;
  const starting = now - firstSeen < SERVER_SCAN_FRESH_MS && !scannerHeartbeat(now).stalled;
  return {
    running: Boolean(desk?.scanning) && (now - lastScanAt < SERVER_SCAN_FRESH_MS || starting),
    /** The server has this user's settings (it loses them if its disk doesn't survive a restart). */
    hasDesk: Boolean(desk),
    lastScanAt,
    /** When the server's autopilot last opened a position for this user (0: none since the server started). */
    lastAutopilotOpenAt: lastServerOpenAt(uid),
    coins: universe.length,
    stocks: stockUniverse().length,
    usStocks: usUniverse().length,
    problems: market.problems(scanList(now)),
  };
}

export function reportsSince(uid: string, since: number): ServerScanReport[] {
  return (users.get(uid)?.reports ?? []).filter((r) => r.at > since);
}

/**
 * Each watched coin's trading costs: how often it traded over the last two
 * hours (share of minutes) and its bid-ask spread when a book has been read.
 */
export function coinActivity(): { symbol: string; activity: number | null; spreadPct: number | null }[] {
  return universe
    .map((symbol) => ({ symbol, activity: tradingActivity(market.getBars(symbol)), spreadPct: observedSpreads.get(symbol) ?? null }))
    .filter((c) => c.activity !== null || c.spreadPct !== null)
    .sort((a, b) => (b.spreadPct ?? 0) - (a.spreadPct ?? 0) || (a.activity ?? 1) - (b.activity ?? 1));
}

/** Each trader's recent results with this user's exits (measured on the next scan if not yet). */
export function exitEdgeTable(uid: string, now: number = Date.now()) {
  const desk = getDeskState(uid);
  return universe.length > 0 ? getExpectancyTable(measuredSymbols(), (s) => market.getBars(s), desk?.trailProfile, now, typicalSpread) : null;
}

export function shadowsFor(uid: string): ShadowSignal[] {
  return users.get(uid)?.shadows ?? [];
}

/** A cycle stuck longer than this (it shouldn't be: requests time out) no longer blocks the next. */
const STUCK_CYCLE_MS = 10 * 60 * 1000;
let lastTickAt = Date.now();
let lastCycleDoneAt = 0;
let cycleStartedAt: number | null = null;

/**
 * Whether the candle-close loop is alive: when it last fired and last
 * finished a cycle. `stalled` means it hasn't fired for three candles.
 */
export function scannerHeartbeat(now: number = Date.now()) {
  return {
    lastTickAt,
    lastCycleDoneAt,
    cycleRunning: cycleStartedAt !== null,
    stalled: now - lastTickAt > 3 * SIGNAL_INTERVAL_MS,
  };
}

/**
 * Runs a cycle just after each 5-minute candle closes. The next candle is
 * scheduled before this one's cycle runs, so a failed or slow cycle can't
 * stop the loop; a cycle still running when the next candle closes makes
 * that candle wait.
 */
export function startServerScanner(): void {
  loadScannerState();
  const schedule = () => {
    const delay = Math.max(1000, nextCandleFetchAt(Date.now()) - Date.now());
    timer = setTimeout(tick, delay);
  };
  const tick = async () => {
    const now = Date.now();
    lastTickAt = now;
    schedule();
    if (cycleStartedAt !== null && now - cycleStartedAt < STUCK_CYCLE_MS) {
      console.warn("[ServerScanner] Previous cycle still running; skipping this candle.");
      return;
    }
    cycleStartedAt = now;
    try {
      await runScanCycle(now);
    } catch (err) {
      console.error("[ServerScanner] Cycle failed:", err);
    } finally {
      cycleStartedAt = null;
      lastCycleDoneAt = Date.now();
    }
  };
  lastTickAt = Date.now();
  schedule();
  console.log("[ServerScanner] Scanning after every 5-minute candle close.");
}

/** Test hooks. */
export function _resetServerScanner(): void {
  users.clear();
  observedSpreads.clear();
  market.keepOnly([]);
  lastStockBackfillAt = 0;
  cycleStartedAt = null;
  universe = [];
  if (timer) clearTimeout(timer);
  timer = null;
}
