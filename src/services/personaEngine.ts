import { StrategySetup, TradeDirection, StrategyFamily, MetaLabelScore } from "../types";
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
  setup: StrategySetup | null; // blended representative setup for the winning direction
  supportingPersonas: string[];
  dissentingPersonas: string[];
  totalVotesCast: number; // personas that QUALIFIED (voted) — most scans, this is 0
  totalPersonasRun: number; // personas actually EVALUATED this cycle, qualified or not — the real "analysed" count
}

function blendSetups(
  ballots: PersonaBallot[],
  direction: TradeDirection
): StrategySetup {
  const totalWeight = ballots.reduce((acc, b) => acc + b.weight, 0) || 1;
  const rep = ballots[0].setup;
  const entryPrice = rep.entryPrice;
  // Blend stop/target *distances*, never raw price levels, so direction stays correct.
  const stopDist =
    ballots.reduce(
      (acc, b) =>
        acc +
        Math.abs(b.setup.entryPrice - b.setup.stopLoss) * b.weight,
      0
    ) / totalWeight;
  const targetDist =
    ballots.reduce(
      (acc, b) =>
        acc +
        Math.abs(b.setup.takeProfit - b.setup.entryPrice) * b.weight,
      0
    ) / totalWeight;
  const baseProbability =
    ballots.reduce((acc, b) => acc + b.setup.baseProbability * b.weight, 0) /
    totalWeight;

  return {
    ...rep,
    id: `setup-panel-${direction}-${rep.symbol}`,
    name: `Panel Consensus (${ballots
      .map((b) => b.personaName.split(" — ")[0])
      .join(", ")})`,
    direction,
    entryPrice,
    stopLoss: Number(
      (direction === "LONG"
        ? entryPrice - stopDist
        : entryPrice + stopDist
      ).toFixed(2)
    ),
    takeProfit: Number(
      (direction === "LONG"
        ? entryPrice + targetDist
        : entryPrice - targetDist
      ).toFixed(2)
    ),
    riskRewardRatio: Number((targetDist / (stopDist || 1)).toFixed(2)),
    baseProbability: Number(baseProbability.toFixed(3)),
    qualifies: true,
  };
}

/**
 * Runs the full trader panel for one symbol and returns a single resolved
 * consensus result. Directional personas vote; suppressor personas can
 * veto the whole symbol outright. When personas genuinely disagree (real
 * support on both sides), the panel calls arbitrateConflictingSetups() —
 * previously defined in riskEngine.ts but never actually called anywhere
 * — to pick a side by meta-labeled confidence, and reports a
 * correspondingly low agreement score so the risk/autopilot layer treats
 * the trade with appropriate caution.
 */
export function runPersonaPanel(
  ctx: CandidateEvaluationContext,
  scoreForArbitration: (setup: StrategySetup) => MetaLabelScore,
  horizon: "intraday" | "swing" = "intraday"
): PanelResult {
  for (const suppressor of SUPPRESSOR_PERSONAS) {
    const verdict = suppressor.evaluate(ctx);
    if (verdict?.qualifies) {
      return {
        vetoed: true,
        vetoReason: `${suppressor.name}: ${
          verdict.family === "volatility_filter"
            ? "volatility outside tolerable bounds"
            : "active event/news blackout"
        }`,
        consensusDirection: null,
        agreementScore: 0,
        setup: null,
        supportingPersonas: [],
        dissentingPersonas: [],
        totalVotesCast: 0,
        totalPersonasRun: SUPPRESSOR_PERSONAS.length,
      };
    }
  }

  // Swing (long-horizon) and intraday personas are never pooled into the
  // same consensus vote — averaging a multi-day macro thesis's stop/target
  // together with an intraday scalp's produces numbers that serve neither.
  // Each horizon gets its own independent panel; callers that want both
  // run this twice.
  const ballots: PersonaBallot[] = [];
  for (const persona of TRADER_PERSONAS) {
    const setup = persona.evaluate(ctx);
    const setupHorizon = setup?.horizon || "intraday";
    if (!setup?.qualifies || setupHorizon !== horizon) continue;

    // Multi-timeframe confluence: a setup that qualifies on the 5m view but
    // directly fights a CLEAR 1h trend gets filtered here, before it ever
    // becomes a ballot. A neutral/ranging/choppy higher timeframe — or no
    // higher-timeframe data yet — expresses no opinion and never blocks a
    // trade; this only filters genuine conflict, not absence of agreement.
    const macro = ctx.macroRegime || "neutral";
    const fightsHigherTimeframe =
      (macro === "trending_bullish" && setup.direction === "SHORT") ||
      (macro === "trending_bearish" && setup.direction === "LONG");
    if (fightsHigherTimeframe) {
      continue;
    }

    ballots.push({
      personaName: persona.name,
      direction: setup.direction,
      setup,
      weight: persona.weight,
    });
  }

  if (ballots.length === 0) {
    return {
      vetoed: false,
      consensusDirection: null,
      agreementScore: 0,
      setup: null,
      supportingPersonas: [],
      dissentingPersonas: [],
      totalVotesCast: 0,
      totalPersonasRun:
        SUPPRESSOR_PERSONAS.length + TRADER_PERSONAS.length,
    };
  }

  const longBallots = ballots.filter((b) => b.direction === "LONG");
  const shortBallots = ballots.filter((b) => b.direction === "SHORT");
  const longWeight = longBallots.reduce((a, b) => a + b.weight, 0);
  const shortWeight = shortBallots.reduce((a, b) => a + b.weight, 0);
  const totalWeight = longWeight + shortWeight;
  const genuineConflict =
    longBallots.length > 0 && shortBallots.length > 0;

  let winningDirection: TradeDirection;
  let winningSide: PersonaBallot[];
  let losingSide: PersonaBallot[];

  if (genuineConflict) {
    const longSetup = blendSetups(longBallots, "LONG");
    const shortSetup = blendSetups(shortBallots, "SHORT");
    const arbitrated = arbitrateConflictingSetups([
      { setup: longSetup, metaScore: scoreForArbitration(longSetup) },
      { setup: shortSetup, metaScore: scoreForArbitration(shortSetup) },
    ]);
    winningDirection = arbitrated!.setup.direction;
    winningSide = winningDirection === "LONG" ? longBallots : shortBallots;
    losingSide = winningDirection === "LONG" ? shortBallots : longBallots;
  } else {
    winningDirection = longBallots.length > 0 ? "LONG" : "SHORT";
    winningSide = longBallots.length > 0 ? longBallots : shortBallots;
    losingSide = [];
  }

  const winningWeight = winningSide.reduce((a, b) => a + b.weight, 0);
  const agreementScore =
    totalWeight > 0
      ? Number((winningWeight / totalWeight).toFixed(3))
      : 0;

  return {
    vetoed: false,
    consensusDirection: winningDirection,
    agreementScore,
    setup: blendSetups(winningSide, winningDirection),
    supportingPersonas: winningSide.map((b) => b.personaName),
    dissentingPersonas: losingSide.map((b) => b.personaName),
    totalVotesCast: ballots.length,
    totalPersonasRun:
      SUPPRESSOR_PERSONAS.length + TRADER_PERSONAS.length,
  };
}
