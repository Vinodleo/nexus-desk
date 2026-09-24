// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetScannedCandles, scanAllMarkets } from "../../src/services/marketScannerService";
import { runPersonaPanel } from "../../src/services/personaEngine";
import { computeMetaLabelScore } from "../../src/services/metaLabeling";
import { decorateBarsWithIndicators } from "../../src/services/marketDataService";
import { PAUSE_AFTER_MS, PAUSE_BEFORE_MS, eventWindowAt, parseCalendar } from "../../src/shared/eventCalendar";
import { NewsPause } from "../../src/components/ledger/LedgerFloor";
import type { MarketBar } from "../../src/types";

vi.spyOn(console, "warn").mockImplementation(() => {});
afterEach(cleanup);

const FIVE = 5 * 60 * 1000;
const lastOpen = Math.floor(Date.now() / FIVE) * FIVE - FIVE;
const rising: MarketBar[] = Array.from({ length: 150 }, (_, i) => {
  const c = 12000 + i * 8;
  return { time: String(i), timestampMs: lastOpen - (149 - i) * FIVE, open: c - 2, high: c + 4, low: c - 4, close: c, volume: 100 + i };
});
const options = (extra: object = {}) => ({
  symbols: ["SOL/INR"],
  barsMap: { "SOL/INR": rising },
  activePositions: [],
  dailyRealizedPnl: 0,
  failureState: {
    globalKillSwitchActive: false, simulateAgentTimeout: false, simulateStaleMarketData: false,
    simulateDailyLossBreach: false, simulateOrderBookThinLiquidity: false, simulateConflictingSignals: false,
  },
  ...extra,
});

describe("each trader's setup on its own", () => {
  it("the panel returns every agreeing trader's own setup, not a blend", () => {
    const bars = decorateBarsWithIndicators(rising);
    const panel = runPersonaPanel(
      { symbol: "SOL/INR", timeframe: "5m", bars, regime: "trending_bullish", eventWindowActive: false, longOnly: true },
      (setup) => computeMetaLabelScore({ setup, regime: "trending_bullish", empiricalWinRate: 0.5, sampleCount: 0, similarityScore: 0 })
    );
    expect(panel.candidates.length).toBeGreaterThan(1);
    expect(panel.candidates.every((s) => !s.name.startsWith("Panel Consensus"))).toBe(true);
    expect(new Set(panel.candidates.map((s) => s.stopLoss)).size).toBeGreaterThan(1); // each keeps its own stop
    expect(panel.setup).toBe(panel.candidates[0]);
  });

  beforeEach(() => _resetScannedCandles());

  it("proposes the best one per coin and follows the rest as weaker setups", async () => {
    const report = await scanAllMarkets(options());
    expect(report.newProposals).toHaveLength(1);
    const proposed = report.shadows.filter((s) => s.kind === "proposed");
    const weaker = report.shadows.filter((s) => s.kind === "weaker_setup");
    expect(proposed).toHaveLength(1);
    expect(proposed[0].setupName).toBe(report.newProposals[0].setup.name);
    expect(weaker.length).toBeGreaterThan(0);
    expect(weaker.every((s) => s.setupName !== proposed[0].setupName)).toBe(true);
  });
});

describe("news pause", () => {
  const T = Date.parse("2026-09-25T12:30:00Z");
  const raw = [
    { title: "CPI m/m", country: "USD", date: "2026-09-25T08:30:00-04:00", impact: "High" },
    { title: "Retail Sales", country: "USD", date: "2026-09-25T08:30:00-04:00", impact: "Medium" },
    { title: "ECB Rate", country: "EUR", date: "2026-09-25T08:30:00-04:00", impact: "High" },
    { title: "Federal Funds Rate", country: "USD", date: "2026-09-26T14:00:00-04:00", impact: "High" },
    { title: "broken", country: "USD", date: "not a date", impact: "High" },
  ];

  it("keeps high-impact US events from the calendar", () => {
    const events = parseCalendar(raw);
    expect(events.map((e) => [e.title, e.at])).toEqual([
      ["CPI m/m", T],
      ["Federal Funds Rate", Date.parse("2026-09-26T18:00:00Z")],
    ]);
  });

  it("pauses from 15 minutes before to 30 minutes after, and says what's next", () => {
    const events = parseCalendar(raw);
    expect(eventWindowAt(events, T - PAUSE_BEFORE_MS - 1)).toMatchObject({ active: false, next: { headline: "USD CPI m/m", startsAt: T - PAUSE_BEFORE_MS } });
    expect(eventWindowAt(events, T - PAUSE_BEFORE_MS)).toMatchObject({ active: true, headline: "USD CPI m/m", until: T + PAUSE_AFTER_MS });
    expect(eventWindowAt(events, T + PAUSE_AFTER_MS + 1).active).toBe(false);
  });

  beforeEach(() => _resetScannedCandles());

  it("stops new trades during the pause, and follows what would have been traded", async () => {
    const report = await scanAllMarkets(options({ eventWindow: { active: true, headline: "USD CPI m/m" } }));
    expect(report.newProposals).toEqual([]);
    expect(report.outcomes[0]).toEqual({ symbol: "SOL/INR", proposed: false, reason: "vetoed" });
    expect(report.resultsBySymbol[0].summaryNote).toMatch(/event\/news blackout \(USD CPI m\/m\)/);
    const vetoed = report.shadows.filter((s) => s.kind === "vetoed");
    expect(vetoed.length).toBeGreaterThan(0);
  });

  it("shows the pause on the Floor, and the next one within two hours", () => {
    const now = Date.parse("2026-09-25T12:20:00Z");
    const active = render(createElement(NewsPause, { window: { active: true, headline: "USD CPI m/m", until: now + 40 * 60_000 }, now }));
    expect(active.container.textContent).toMatch(/News pause until .* for USD CPI m\/m\. No new trades/);
    cleanup();
    const soon = render(createElement(NewsPause, { window: { active: false, next: { headline: "USD CPI m/m", startsAt: now + 60 * 60_000 } }, now }));
    expect(soon.container.textContent).toMatch(/News pause from .* for USD CPI m\/m/);
    cleanup();
    const later = render(createElement(NewsPause, { window: { active: false, next: { headline: "USD CPI m/m", startsAt: now + 5 * 3600_000 } }, now }));
    expect(later.container.textContent).toBe("");
  });
});
