import { GoogleGenAI, Type } from "@google/genai";
import type { MarketBar, TradeProposal } from "../src/types";
import { marketOf } from "../src/shared/marketLimits";

// Gemini as a second opinion on the server autopilot's trades. After a
// trade passes every check the server has, and just before it opens, Gemini
// sees the setup, the trader's record and the last three hours of candles,
// and says take it or skip it. It can only skip: it never opens a trade the
// checks refused, and "paused" traders never reach it. When it can't answer
// (no key, the daily cap, Google's free-tier limit, an error), the trade goes
// ahead on the server's checks as before, and it's counted as not reviewed.
//
// Setup: GEMINI_API_KEY (Google AI Studio) on the server. Optional:
// GEMINI_REVIEW_MODELS (comma-separated, tried in order) and
// GEMINI_REVIEW_DAILY_LIMIT (reviews per day, India time).

/** Flash-Lite first: Google's free tier gives it the most requests a day. */
const DEFAULT_REVIEW_MODELS = ["gemini-3.1-flash-lite", "gemini-3.8-flash"];
/** Stays under the free tier's daily requests for Flash-Lite. */
export const DEFAULT_REVIEW_DAILY_LIMIT = 300;
/** At most about nine a minute (the free tier allows ten or more). */
const MIN_GAP_MS = 6500;
const TIMEOUT_MS = 20_000;
/** After Google says "too many", wait this long before asking again. */
const LIMIT_COOLDOWN_MS = 5 * 60_000;
/** Candles shown to Gemini: three hours of 5-minute ones. */
const CANDLES_SHOWN = 36;

export type ReviewOutcome = "take" | "skip" | "unreviewed";

export interface ReviewVerdict {
  outcome: ReviewOutcome;
  /** Gemini's reason, or why it wasn't asked / didn't answer. */
  reason: string;
  model?: string;
  /** Set when there's no GEMINI_API_KEY: nothing to record. */
  off?: true;
}

/** One Gemini call; swapped in tests. Resolves to the reply's text. */
export type GenerateFn = (req: { model: string; system: string; prompt: string }) => Promise<string>;

export function reviewerConfigured(): boolean {
  return !!process.env.GEMINI_API_KEY?.trim();
}

export function reviewModels(): string[] {
  const configured = (process.env.GEMINI_REVIEW_MODELS || "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : DEFAULT_REVIEW_MODELS;
}

export function reviewDailyLimit(): number {
  const raw = process.env.GEMINI_REVIEW_DAILY_LIMIT?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_REVIEW_DAILY_LIMIT;
}

const istDay = (ms: number) => new Date(ms + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);

interface DayCounts {
  day: string;
  /** Answers Gemini gave (taken + skipped). */
  reviewed: number;
  taken: number;
  skipped: number;
  /** Trades that went ahead without an answer. */
  unreviewed: number;
  /** Times Google said the free tier's limit was reached. */
  limitHits: number;
}

const fresh = (day: string): DayCounts => ({ day, reviewed: 0, taken: 0, skipped: 0, unreviewed: 0, limitHits: 0 });
let counts = fresh("");
let lastCallAt = 0;
let cooldownUntil = 0;
let lastError: string | null = null;
let last: { symbol: string; outcome: ReviewOutcome; reason: string; at: number } | null = null;
let minGapMs = MIN_GAP_MS;

function today(now: number): DayCounts {
  const day = istDay(now);
  if (counts.day !== day) counts = fresh(day);
  return counts;
}

/** Today's reviews, for Settings: how much the free tier is handling. */
export function reviewerStatus(now: number = Date.now()) {
  const c = today(now);
  return {
    configured: reviewerConfigured(),
    models: reviewModels(),
    dailyLimit: reviewDailyLimit(),
    ...c,
    limitReached: c.reviewed >= reviewDailyLimit() || now < cooldownUntil,
    lastError,
    last,
  };
}

const round = (n: number) => Number(n.toPrecision(6));

/** What Gemini is shown for one trade: plain JSON, prices in rupees. */
export function reviewPrompt(p: TradeProposal, bars: MarketBar[] | undefined): string {
  const s = p.setup;
  const market = { coins: "CoinDCX coin, INR spot, 24/7", stocks: "Indian stock, NSE intraday", us: "US stock, priced in INR" }[marketOf(p.symbol)];
  const candles = (bars ?? []).slice(-CANDLES_SHOWN).map((b) => [
    new Date(b.timestampMs ?? Date.parse(b.time)).toISOString().slice(11, 16),
    round(b.open),
    round(b.high),
    round(b.low),
    round(b.close),
    Math.round(b.volume ?? 0),
  ]);
  return JSON.stringify({
    symbol: p.symbol,
    market,
    direction: s.direction,
    trader: s.name,
    style: s.family,
    entry: round(s.entryPrice),
    stop: round(s.stopLoss),
    target: round(s.takeProfit),
    riskReward: Number(s.riskRewardRatio.toFixed(2)),
    marketMood: p.regime,
    indicators: {
      emaAligned: s.features.emaAlignment,
      volumeVsAverage: Number(s.features.volumeSurgeRatio.toFixed(2)),
      vwapDistancePct: Number(s.features.vwapDistancePercent.toFixed(2)),
      adx: Math.round(s.features.adx),
      rsi: Math.round(s.features.rsi),
    },
    estimatedWinChance: Number((p.metaScore?.calibratedWinProbability ?? p.metaScore?.confidence ?? 0).toFixed(2)),
    traderRecentAverageR: p.exitEdge ? { r: Number(p.exitEdge.r.toFixed(2)), trades: p.exitEdge.trades } : null,
    candles5mUtc: { columns: ["time", "open", "high", "low", "close", "volume"], rows: candles },
  });
}

const SYSTEM = [
  "You review intraday trades for a small paper-trading desk just before they open.",
  "Each trade already passed the desk's risk checks. Your job is to skip trades the chart argues against:",
  "entering after the move is spent, straight into nearby resistance (support for a short), against the recent trend,",
  "on fading volume, or with a stop that recent candles would easily hit.",
  "Take trades the chart supports. Skipping good trades costs as much as taking bad ones, so don't skip without a clear reason.",
  "Stops include fees and the spread; a loss costs about 1R, a winner often banks half at +1R and trails the rest.",
  'Reply as JSON: {"take": boolean, "reason": one plain sentence under 20 words}.',
].join(" ");

let client: GoogleGenAI | null = null;
const geminiGenerate: GenerateFn = async ({ model, system, prompt }) => {
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!.trim() });
  const response = await client.models.generateContent({
    model,
    contents: prompt,
    config: {
      systemInstruction: system,
      temperature: 0.2,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: { take: { type: Type.BOOLEAN }, reason: { type: Type.STRING } },
        required: ["take", "reason"],
      },
    },
  });
  return response?.text ?? "";
};

const statusOf = (err: any): number | undefined => err?.status ?? err?.statusCode ?? err?.code;
const isLimit = (err: any) => statusOf(err) === 429 || /quota|rate.?limit|resource_exhausted/i.test(String(err?.message ?? ""));
const isMissingModel = (err: any) => statusOf(err) === 404 || /not found|not supported|unknown model/i.test(String(err?.message ?? ""));
const shortError = (err: any) => String(err?.message ?? err).replace(/\s+/g, " ").slice(0, 160);

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer in ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function unreviewed(c: DayCounts, symbol: string, reason: string, now: number): ReviewVerdict {
  c.unreviewed++;
  last = { symbol, outcome: "unreviewed", reason, at: now };
  return { outcome: "unreviewed", reason };
}

/**
 * Gemini's take-or-skip on a trade the autopilot is about to open. Never
 * throws: anything short of a clear answer comes back "unreviewed".
 */
export async function reviewTrade(
  proposal: TradeProposal,
  bars: MarketBar[] | undefined,
  now: number = Date.now(),
  generate: GenerateFn = geminiGenerate
): Promise<ReviewVerdict> {
  if (!reviewerConfigured()) return { outcome: "unreviewed", reason: "Gemini isn't set up", off: true };
  const c = today(now);
  if (c.reviewed >= reviewDailyLimit()) return unreviewed(c, proposal.symbol, `today's ${reviewDailyLimit()} reviews are used up`, now);
  if (now < cooldownUntil) return unreviewed(c, proposal.symbol, "Google's free-tier limit was reached; trying again shortly", now);

  const wait = lastCallAt + minGapMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();

  const prompt = reviewPrompt(proposal, bars);
  let failure = "no answer";
  for (const model of reviewModels()) {
    try {
      const text = await withTimeout(generate({ model, system: SYSTEM, prompt }), TIMEOUT_MS);
      const reply = JSON.parse(text);
      if (typeof reply?.take !== "boolean") throw new Error("the answer wasn't take or skip");
      const reason = String(reply.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || (reply.take ? "Looks fine." : "Chart argues against it.");
      const outcome: ReviewOutcome = reply.take ? "take" : "skip";
      c.reviewed++;
      if (reply.take) c.taken++;
      else c.skipped++;
      lastError = null;
      last = { symbol: proposal.symbol, outcome, reason, at: now };
      return { outcome, reason, model };
    } catch (err: any) {
      if (isLimit(err)) {
        c.limitHits++;
        cooldownUntil = now + LIMIT_COOLDOWN_MS;
        lastError = "Google's free-tier limit reached";
        return unreviewed(c, proposal.symbol, "Google's free-tier limit was reached", now);
      }
      failure = isMissingModel(err) ? `model ${model} isn't available (set GEMINI_REVIEW_MODELS)` : shortError(err);
      console.warn(`[Reviewer] ${model}: ${failure}`);
    }
  }
  lastError = failure;
  return unreviewed(c, proposal.symbol, failure, now);
}

/** Test hook. */
export function _resetReviewer(opts: { minGapMs?: number } = {}): void {
  counts = fresh("");
  lastCallAt = 0;
  cooldownUntil = 0;
  lastError = null;
  last = null;
  minGapMs = opts.minGapMs ?? MIN_GAP_MS;
}
