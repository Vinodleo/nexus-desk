import { describe, expect, it } from "vitest";
import {
  BINS,
  DEFAULT_BOOST,
  addRow,
  binEdges,
  binOf,
  emptyTable,
  featureList,
  importance,
  judge,
  oneAtATime,
  readSetupLines,
  seeded,
  summary,
  trainBoosted,
  type BoostedModel,
  type SetupRow,
  type SetupTable,
} from "../../src/services/setupModel";
import { SETUP_READINGS, setupCsvHeader } from "../../src/services/historyReplay";

// The machine-learning test: a model learns from older setups and is judged
// only on later ones it never saw, its picks traded one at a time.

const TRADERS = ["Sofia Range Scalp", "Diego Aggressive Breakout"];
const FEATURES = featureList(TRADERS);
const RSI = FEATURES.findIndex((f) => f.name === "rsi");
const FIVE = 5 * 60_000;

/**
 * `n` coin setups an hour apart from `startMs`, alternating traders. With
 * `edge`, setups with RSI under 30 average +0.6R and the rest −0.3R;
 * without, every setup averages −0.2R whatever its readings.
 */
function setups(n: number, startMs: number, edge: boolean, seed: number): SetupRow[] {
  const random = seeded(seed);
  return Array.from({ length: n }, (_, k) => {
    const values = new Float64Array(FEATURES.length);
    FEATURES.forEach((f, j) => (values[j] = f.flag ? 0 : random() * 100));
    const rsi = values[RSI];
    values[FEATURES.findIndex((f) => f.name === "market:crypto")] = 1;
    const traderId = k % 2;
    values[FEATURES.findIndex((f) => f.name === `trader:${TRADERS[traderId]}`)] = 1;
    const mean = edge ? (rsi < 30 ? 0.6 : -0.3) : -0.2;
    const r = mean + (random() - 0.5) * 2;
    const entryMs = startMs + k * 60 * 60_000;
    return { market: "crypto" as const, trader: TRADERS[traderId], symbolId: k % 5, traderId, entryMs, r, exitMs: entryMs + 6 * FIVE, values };
  });
}

function tableOf(rows: SetupRow[], edges: number[][]): SetupTable {
  const t = emptyTable(rows.length, FEATURES.length);
  for (const row of rows) addRow(t, row, edges);
  return t;
}

function run(edge: boolean) {
  const t0 = Date.parse("2025-01-01T00:00:00Z");
  const train = setups(30_000, t0, edge, 1);
  const valid = setups(8_000, t0 + 30_000 * 3_600_000, edge, 2);
  const test = setups(12_000, t0 + 38_000 * 3_600_000, edge, 3);
  const edges = binEdges(train.slice(0, 5000).map((r) => Array.from(r.values)), FEATURES);
  const [tr, va, te] = [tableOf(train, edges), tableOf(valid, edges), tableOf(test, edges)];
  const steps = trainBoosted(tr, va, { ...DEFAULT_BOOST, minLeaf: 200, maxTrees: 120 });
  let step = steps.next();
  let trees = 0;
  while (!step.done) {
    trees = step.value;
    step = steps.next();
  }
  return { model: step.value as BoostedModel, trees, verdict: judge(step.value as BoostedModel, va, te) };
}

describe("the setup model", () => {
  it("puts readings in quantile bins, with a bin of its own for a missing one", () => {
    const edges = binEdges(Array.from({ length: 1000 }, (_, k) => [k]), [{ name: "x", group: "x", flag: false }])[0];
    expect(edges.length).toBe(BINS - 2);
    expect(binOf(NaN, edges)).toBe(0);
    expect(binOf(-5, edges)).toBe(1);
    expect(binOf(10_000, edges)).toBe(BINS - 1);
    expect(binOf(500, edges)).toBeGreaterThan(binOf(400, edges));
  });

  it("reads the saved setups' CSV, with the chosen exit profile's result", () => {
    const header = setupCsvHeader(["tight", "balanced", "patient", "fixed"]);
    const readings = SETUP_READINGS.map((_, k) => (k === 0 ? "28.5" : "")).join(",");
    const lines = [
      `1750000000000,Sofia Range Scalp,LONG,ranging_tight,trending_bullish,600,3,${readings},0.42,7,0.3,9,,,0.1,2`,
      // No result under "tight" (the history ended first): left out.
      `1750000300000,Diego Aggressive Breakout,LONG,ranging_tight,neutral,605,3,${readings},,,0.3,9,,,0.1,2`,
    ];
    // The row is reused line to line: kept ones are copied.
    const rows = [...readSetupLines(lines, header, "crypto", 4, FEATURES, TRADERS, "tight")].map((r) => ({ ...r, values: Float64Array.from(r.values) }));
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({ market: "crypto", trader: "Sofia Range Scalp", symbolId: 4, traderId: 0, entryMs: 1750000000000, r: 0.42, exitMs: 1750000000000 + 7 * FIVE });
    const value = (name: string) => row.values[FEATURES.findIndex((f) => f.name === name)];
    expect(value("rsi")).toBe(28.5);
    expect(Number.isNaN(value("adx"))).toBe(true);
    expect(value("minute")).toBe(600);
    expect(value("market:crypto")).toBe(1);
    expect(value("market:us")).toBe(0);
    expect(value("trader:Sofia Range Scalp")).toBe(1);
    expect(value("regime:ranging_tight")).toBe(1);
    expect(value("macro:trending_bullish")).toBe(1);
    expect(value("direction:SHORT")).toBe(0);
  });

  it("trades picks one at a time per trader and market", () => {
    const t = emptyTable(3, 1);
    const row = (entryMs: number, exitMs: number, r: number, traderId: number): SetupRow => ({ market: "us", trader: TRADERS[traderId], symbolId: 1, traderId, entryMs, r, exitMs, values: new Float64Array(1) });
    for (const r of [row(0, 100, 1, 0), row(50, 150, -1, 0), row(50, 150, 0.5, 1)]) addRow(t, r, [[]]);
    // The second comes while the same trader's first is still open.
    expect(oneAtATime(t, () => true).us).toEqual({ trades: 2, wins: 2, totalR: 1.5, sumSq: 1.25 });
    expect(summary({ trades: 4, wins: 3, totalR: 2, sumSq: 4 })).toEqual({ trades: 4, winPct: 75, avgR: 0.5, lowR: 0.5 - 2 * Math.sqrt(0.75 / 4) });
  });

  it("finds a real edge and passes it on months it never saw", () => {
    const { model, verdict } = run(true);
    const coins = verdict.crypto!;
    expect(coins.everySetup.avgR).toBeLessThan(0);
    expect(coins.share).toBeLessThan(1);
    expect(coins.picks.avgR).toBeGreaterThan(0.3);
    expect(coins.passed).toBe(true);
    // It relied on RSI above all.
    expect(importance(model, FEATURES)[0].label).toBe("RSI");
    expect(verdict.nse).toBeNull();
  });

  it("finds nothing where there's nothing to find", () => {
    const { verdict } = run(false);
    expect(verdict.crypto!.passed).toBe(false);
    expect(verdict.crypto!.picks.avgR).toBeLessThan(0.05);
  });
});
