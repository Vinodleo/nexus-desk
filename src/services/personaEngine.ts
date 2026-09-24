import { StrategySetup, TradeDirection, StrategyFamily, MetaLabelScore, PromotedLabModel } from "../types";
import {
  CandidateEvaluationContext,
  buildTrendSetup,
  buildMacroTrendSetup,
  buildBreakoutSetup,
  buildMeanReversionSetup,
  buildVolatilitySuppressor,
  buildEventNewsSuppressor,
} from "./strategyEngine";
import { arbitrateConflictingSetups } from "./riskEngine";

export interface TraderPersona {
  id: string;
  name: string;
  family: StrategyFamily;
  riskPosture: "conservative" | "balanced" | "aggressive";
  bio: string;
  weight: number; // panel voting weight — starts equal; wire to per-persona track record later
  evaluate: (ctx: CandidateEvaluationContext) => StrategySetup | null;
}

// --- The desk roster ---------------------------------------------------
// Ten differentiated traders rather than a hundred clones: a real desk's
// edge comes from genuinely different styles disagreeing with each other,
// not from a hundred people running the identical playbook off the same
// numbers. Each persona reuses the same validated indicator math (see
// strategyEngine.ts) with its own tuning, so adding an 11th or 50th voice
// later is one more roster entry, not new signal logic.
export const TRADER_PERSONAS: TraderPersona[] = [
  {
    id: "marcus-trend",
    name: "Marcus — Swing Trend Rider",
    family: "trend_following",
    riskPosture: "balanced",
    bio: "Rides established trends with the desk's standard parameters; lets winners run toward a 2.2R target.",
    weight: 1.0,
    evaluate: (ctx) =>
      buildTrendSetup(ctx, {
        idSuffix: "trend-marcus",
        name: "Marcus Swing Trend",
        minAdx: 22,
        stopAtrMult: 1.5,
        stopPriceFloorPct: 0.004,
        targetMult: 2.2,
        baseProbability: 0.58,
      }),
  },
  {
    id: "priya-momentum",
    name: "Priya — Momentum Scalper",
    family: "trend_following",
    riskPosture: "aggressive",
    bio: "Reacts faster than Marcus — lower ADX bar, tighter stop, quicker target. First in, first out.",
    weight: 1.0,
    evaluate: (ctx) =>
      buildTrendSetup(ctx, {
        idSuffix: "trend-priya",
        name: "Priya Momentum Scalp",
        minAdx: 18,
        stopAtrMult: 1.1,
        stopPriceFloorPct: 0.003,
        targetMult: 1.6,
        baseProbability: 0.54,
      }),
  },
  {
    id: "chen-conservative-trend",
    name: "Chen — Conservative Trend Follower",
    family: "trend_following",
    riskPosture: "conservative",
    bio: "Only acts on the strongest, cleanest trends — high ADX bar, wide stop to avoid being shaken out early.",
    weight: 1.0,
    evaluate: (ctx) =>
      buildTrendSetup(ctx, {
        idSuffix: "trend-chen",
        name: "Chen Conservative Trend",
        minAdx: 28,
        stopAtrMult: 1.8,
        stopPriceFloorPct: 0.005,
        targetMult: 2.6,
        baseProbability: 0.60,
      }),
  },
  {
    id: "warren-macro",
    name: "Warren — Macro Trend Follower",
    family: "trend_following",
    riskPosture: "conservative",
    bio: "Ignores intraday noise. Operates on 50/200 EMA structure. Takes very wide stop-losses (3.5x ATR) and aims for massive targets (5x risk) over longer durations.",
    weight: 1.0,
    evaluate: (ctx) =>
      buildMacroTrendSetup(ctx, {
        idSuffix: "macro-warren",
        name: "Warren Macro Trend",
        minAdx: 20,
        stopAtrMult: 3.5,
        stopPriceFloorPct: 0.015,
        targetMult: 5.0,
        baseProbability: 0.45,
      }),
  },
  {
    id: "diego-breakout-aggressive",
    name: "Diego — Aggressive Breakout Hunter",
    family: "breakout_confirmation",
    riskPosture: "aggressive",
    bio: "Trades the first sign of a breakout on a lighter volume bar — earlier entries, tighter risk.",
    weight: 1.0,
    evaluate: (ctx) =>
      buildBreakoutSetup(ctx, {
        idSuffix: "breakout-diego",
        name: "Diego Aggressive Breakout",
        volSurgeThreshold: 1.15,
        stopAtrMult: 1.0,
        stopPriceFloorPct: 0.0025,
        targetAtrMult: 2.0,
        targetStopMultFloor: 1.3,
        baseProbability: 0.50,
      }),
  },
  {
    id: "amara-breakout-confirmed",
    name: "Amara — Confirmed Breakout Trader",
    family: "breakout_confirmation",
    riskPosture: "conservative",
    bio: "Waits for a strong volume surge before trusting a breakout — fewer signals, higher conviction.",
    weight: 1.0,
    evaluate: (ctx) =>
      buildBreakoutSetup(ctx, {
        idSuffix: "breakout-amara",
        name: "Amara Confirmed Breakout",
        volSurgeThreshold: 1.6,
        stopAtrMult: 1.3,
        stopPriceFloorPct: 0.0035,
        targetAtrMult: 2.8,
        targetStopMultFloor: 1.6,
        baseProbability: 0.56,
      }),
  },
  {
    id: "sofia-range-scalp",
    name: "Sofia — Range Scalper",
    family: "mean_reversion",
    riskPosture: "aggressive",
    bio: "Fades minor RSI extremes inside tight ranges for quick reversion trades.",
    weight: 1.0,
    evaluate: (ctx) =>
      buildMeanReversionSetup(ctx, {
        idSuffix: "meanrev-sofia",
        name: "Sofia Range Scalp",
        rsiOversold: 35,
        rsiOverbought: 65,
        maxAdxForRange: 24,
        stopAtrMult: 0.8,
        stopPriceFloorPct: 0.003,
        baseProbability: 0.58,
      }),
  },
  {
    id: "kenji-extreme-reversion",
    name: "Kenji — Extreme Reversion Trader",
    family: "mean_reversion",
    riskPosture: "conservative",
    bio: "Only fades genuinely extreme RSI dislocations — fewer trades, bigger snap-back targets.",
    weight: 1.0,
    evaluate: (ctx) =>
      buildMeanReversionSetup(ctx, {
        idSuffix: "meanrev-kenji",
        name: "Kenji Extreme Reversion",
        rsiOversold: 25,
        rsiOverbought: 75,
        maxAdxForRange: 26,
        stopAtrMult: 1.2,
        stopPriceFloorPct: 0.004,
        baseProbability: 0.63,
      }),
  },
];

// --- The Lab's tuned trader --------------------------------------------
// A promoted Lab model carries the breakout parameters its walk-forward test
// found best (volume surge, stop and target in ATRs, RSI overextension
// limit). They join the panel as one more breakout trader using exactly
// those numbers, weighted a little higher because they were tested on
// history the other voices weren't tuned on. Unpromoting removes it.
export const LAB_PERSONA_ID = "lab-tuned-breakout";
export const LAB_PERSONA_WEIGHT = 1.5;

export function labTunedPersona(model: PromotedLabModel): TraderPersona | null {
  const p = model.optimizedParameters;
  if (!p || model.isSynthetic) return null;
  // Its out-of-sample win rate, kept within the range the other voices use.
  const baseProbability = Math.min(0.65, Math.max(0.45, (model.winRatePct || 50) / 100));
  return {
    id: LAB_PERSONA_ID,
    name: "Lab — Tuned Breakout",
    family: "breakout_confirmation",
    riskPosture: "balanced",
    bio: `Breakouts with the settings promoted from the Lab (${model.datasetName}).`,
    weight: LAB_PERSONA_WEIGHT,
    evaluate: (ctx) =>
      buildBreakoutSetup(ctx, {
        idSuffix: LAB_PERSONA_ID,
        name: "Lab Tuned Breakout",
        volSurgeThreshold: p.volSurgeThreshold,
        stopAtrMult: p.slMultiplier,
        stopPriceFloorPct: 0.0025,
        targetAtrMult: p.tpMultiplier,
        targetStopMultFloor: 1.0,
        baseProbability,
        rsiCeiling: p.rsiThreshold,
      }),
  };
}

/** The traders who vote: the fixed roster, plus the Lab's tuned trader when one is promoted. */
export function panelRoster(promotedModel?: PromotedLabModel | null): TraderPersona[] {
  const lab = promotedModel ? labTunedPersona(promotedModel) : null;
  return lab ? [...TRADER_PERSONAS, lab] : TRADER_PERSONAS;
}

// Suppressor personas never propose a directional trade — they can only
// veto the whole panel, the way a desk's risk or compliance officer can
// kill a trade regardless of how bullish the traders are.
export const SUPPRESSOR_PERSONAS: {
  id: string;
  name: string;
  evaluate: (ctx: CandidateEvaluationContext) => StrategySetup | null;
}[] = [
  {
    id: "elena-vol-risk",
    name: "Elena — Volatility Risk Officer",
    evaluate: buildVolatilitySuppressor,
  },
  {
    id: "omar-event-risk",
    name: "Omar — Event Risk Officer",
    evaluate: buildEventNewsSuppressor,
  },
];

interface PersonaBallot {
  personaName: string;
  direction: TradeDirection;
  setup: StrategySetup;
  weight: number;
}

export interface PanelResult {
  vetoed: boolean;
  vetoReason?: string;
  consensusDirection: TradeDirection | null;
  agreementScore: number; // 0..1 — weighted share of the winning direction among all qualifying ballots
  /**
   * Each trader's own setup on the winning side, strongest first (by voting
   * weight, then the trader's own estimate). Each is judged on its own;
   * nothing is averaged across traders.
   */
  candidates: StrategySetup[];
  /** The strongest of those, or null when none. */
  setup: StrategySetup | null;
  supportingPersonas: string[];
  /** Setups that qualified but were dropped for going against the 1-hour trend. */
  filteredByHigherTimeframe?: number;
  /** Those setups, for shadow tracking. */
  trendFilteredSetups?: StrategySetup[];
  /** Short setups set aside because only longs can be placed (ctx.longOnly), for shadow tracking. */
  shortOnlySetups?: StrategySetup[];
  /** Setups on the side that lost a genuine long-vs-short conflict, for shadow tracking. */
  outvotedSetups?: StrategySetup[];
  /** Setups the traders put forward when a risk officer vetoed the symbol, for shadow tracking. */
  vetoedSetups?: StrategySetup[];
  dissentingPersonas: string[];
  totalVotesCast: number; // personas that QUALIFIED (voted) — most scans, this is 0
  totalPersonasRun: number; // personas actually EVALUATED this cycle, qualified or not — the real "analysed" count
}

/**
 * Runs the trader panel for one symbol. Each trader puts forward its own
 * setup; suppressor personas (volatility, news) can veto the symbol. When
 * traders genuinely disagree on direction, each side is represented by its
 * best-scoring setup (arbitrateConflictingSetups) and the agreement score
 * shows how split the panel was, so autopilot treats the trade cautiously.
 */
export function runPersonaPanel(
  ctx: CandidateEvaluationContext,
  scoreForArbitration: (setup: StrategySetup) => MetaLabelScore,
  horizon: "intraday" | "swing" = "intraday"
): PanelResult {
  const roster = panelRoster(ctx.promotedModel);
  const totalPersonasRun = SUPPRESSOR_PERSONAS.length + roster.length;
  const ballots: PersonaBallot[] = [];
  let filteredByHigherTimeframe = 0;
  const trendFilteredSetups: StrategySetup[] = [];
  const shortOnlySetups: StrategySetup[] = [];
  // Swing (long-horizon) and intraday personas are never pooled into the
  // same vote; callers that want both run the panel twice.
  // Traders judge the chart as if there were no news: the event officer's
  // veto below handles a news pause, and this way what they would have
  // traded is still known (and followed).
  const traderCtx = { ...ctx, eventWindowActive: false };
  for (const persona of roster) {
    const setup = persona.evaluate(traderCtx);
    const setupHorizon = setup?.horizon || "intraday";
    if (!setup?.qualifies || setupHorizon !== horizon) continue;

    if (ctx.longOnly && setup.direction === "SHORT") {
      shortOnlySetups.push(setup);
      continue;
    }
    // Multi-timeframe confluence: a setup that directly fights a CLEAR 1h
    // trend is filtered before it becomes a ballot. A neutral/ranging/choppy
    // higher timeframe, or none yet, never blocks a trade.
    const macro = ctx.macroRegime || "neutral";
    const fightsHigherTimeframe =
      (macro === "trending_bullish" && setup.direction === "SHORT") ||
      (macro === "trending_bearish" && setup.direction === "LONG");
    if (fightsHigherTimeframe) {
      filteredByHigherTimeframe++;
      trendFilteredSetups.push(setup);
      continue;
    }

    ballots.push({ personaName: persona.name, direction: setup.direction, setup, weight: persona.weight });
  }

  const empty = {
    consensusDirection: null,
    agreementScore: 0,
    candidates: [],
    setup: null,
    supportingPersonas: [],
    dissentingPersonas: [],
    totalVotesCast: 0,
    totalPersonasRun,
    filteredByHigherTimeframe,
    trendFilteredSetups,
    shortOnlySetups,
  };

  // Risk officers can veto the symbol outright. What the traders wanted is
  // still reported, so tracking shows whether the veto saved or cost money.
  for (const suppressor of SUPPRESSOR_PERSONAS) {
    const verdict = suppressor.evaluate(ctx);
    if (verdict?.qualifies) {
      return {
        ...empty,
        vetoed: true,
        vetoReason: `${suppressor.name}: ${
          verdict.family === "volatility_filter"
            ? "volatility outside tolerable bounds"
            : `event/news blackout${ctx.eventHeadline ? ` (${ctx.eventHeadline})` : ""}`
        }`,
        vetoedSetups: ballots.map((b) => b.setup),
      };
    }
  }

  if (ballots.length === 0) return { ...empty, vetoed: false };

  const longBallots = ballots.filter((b) => b.direction === "LONG");
  const shortBallots = ballots.filter((b) => b.direction === "SHORT");
  const totalWeight = ballots.reduce((a, b) => a + b.weight, 0);

  let winningSide: PersonaBallot[];
  let losingSide: PersonaBallot[];
  if (longBallots.length > 0 && shortBallots.length > 0) {
    // Each side is represented by its best-scoring setup.
    const best = (side: PersonaBallot[]) =>
      side
        .map((b) => ({ setup: b.setup, metaScore: scoreForArbitration(b.setup) }))
        .sort((a, b) => b.metaScore.confidence - a.metaScore.confidence)[0];
    const arbitrated = arbitrateConflictingSetups([best(longBallots), best(shortBallots)]);
    const longWins = arbitrated!.setup.direction === "LONG";
    winningSide = longWins ? longBallots : shortBallots;
    losingSide = longWins ? shortBallots : longBallots;
  } else {
    winningSide = ballots;
    losingSide = [];
  }

  const candidates = [...winningSide]
    .sort((a, b) => b.weight - a.weight || b.setup.baseProbability - a.setup.baseProbability)
    .map((b) => b.setup);
  const winningWeight = winningSide.reduce((a, b) => a + b.weight, 0);

  return {
    ...empty,
    vetoed: false,
    consensusDirection: winningSide[0].direction,
    agreementScore: totalWeight > 0 ? Number((winningWeight / totalWeight).toFixed(3)) : 0,
    candidates,
    setup: candidates[0],
    supportingPersonas: winningSide.map((b) => b.personaName),
    dissentingPersonas: losingSide.map((b) => b.personaName),
    totalVotesCast: ballots.length,
    outvotedSetups: losingSide.map((b) => b.setup),
  };
}
