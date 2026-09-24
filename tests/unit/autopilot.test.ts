import { describe, expect, it } from "vitest";
import type { TradeProposal } from "../../src/types";
import { DEFAULT_RISK_POLICY } from "../../src/services/riskEngine";
import { autopilotOpeningsLastHour, positionFromProposal, selectAutopilotTrades } from "../../src/services/autopilot";
import { adoptServerOpened } from "../../src/hooks/useGuardianSync";

// Self-Approve's rules, shared by the app and the server scanner.

const now = Date.parse("2026-09-24T10:00:00Z");
const policy = { ...DEFAULT_RISK_POLICY, equity: 100000, maxAllowedExposureFraction: 0.5 };

function proposal(symbol: string, over: Partial<TradeProposal> = {}, setup: Partial<TradeProposal["setup"]> = {}): TradeProposal {
  return {
    id: `prop-${symbol}`,
    symbol,
    status: "PENDING_APPROVAL",
    ensembleAgreement: 1,
    personaVotesCast: 3,
    riskCalc: { recommendedPositionSizeUnits: 10, riskDollars: 100 },
    metaScore: { confidence: 0.6, calibratedWinProbability: 0.6 },
    setup: {
      symbol,
      name: "Test Breakout",
      direction: "LONG",
      entryPrice: 1000,
      stopLoss: 980,
      takeProfit: 1060,
      family: "breakout_confirmation",
      horizon: "intraday",
      ...setup,
    },
    ...over,
  } as unknown as TradeProposal;
}

const empty = { positions: [], openedLastHour: 0, quarantines: {} };
const at = (price: number) => () => price;

describe("selectAutopilotTrades", () => {
  it("opens a proposal the panel agrees on, at the live price", () => {
    const { accepted, deferred } = selectAutopilotTrades([proposal("SOL/INR")], empty, policy, at(1001), now);
    expect(deferred).toEqual([]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].entryPrice).toBe(1001);
    expect(accepted[0].units).toBeGreaterThan(0);
  });

  it("counts each accepted trade against the limits for the next", () => {
    const three = ["A/INR", "B/INR", "C/INR", "D/INR"].map((s) => proposal(s));
    const { accepted, deferred } = selectAutopilotTrades(three, empty, policy, at(1000), now);
    expect(accepted).toHaveLength(3);
    expect(deferred[0].reason).toMatch(/max 3 simultaneous positions/);
  });

  it("defers with the reason: held coin, quarantine, swing, split panel, hourly cap, price run away", () => {
    const cases: [TradeProposal, Parameters<typeof selectAutopilotTrades>[1], RegExp][] = [
      [proposal("SOL/INR"), { ...empty, positions: [{ symbol: "SOL/INR", quantity: 1, currentPrice: 1000 }] }, /already holding/],
      [proposal("SOL/INR"), { ...empty, quarantines: { "SOL/INR": { quarantinedUntilMs: now + 60_000 } } }, /quarantined/],
      [proposal("SOL/INR", {}, { horizon: "swing" }), empty, /Swing/],
      [proposal("SOL/INR", { ensembleAgreement: 0.5 }), empty, /panel consensus 50%/],
      [proposal("SOL/INR"), { ...empty, openedLastHour: 3 }, /3 autonomous approvals\/hour/],
    ];
    for (const [p, book, reason] of cases) {
      const { accepted, deferred } = selectAutopilotTrades([p], book, policy, at(1000), now);
      expect(accepted).toEqual([]);
      expect(deferred[0].reason).toMatch(reason);
    }
    // Price already most of the way to the target.
    expect(selectAutopilotTrades([proposal("SOL/INR")], empty, policy, at(1050), now).deferred[0].reason).toMatch(/reward is left/);
  });
});

describe("autopilotOpeningsLastHour", () => {
  it("counts open and closed self-approved trades from the last hour, once each", () => {
    const positions = [
      { id: "p1", isSelfApproved: true, openTime: new Date(now - 10 * 60_000).toISOString() },
      { id: "p2", isSelfApproved: false, openTime: new Date(now - 10 * 60_000).toISOString() },
      { id: "p3", isSelfApproved: true, openTime: new Date(now - 90 * 60_000).toISOString() },
    ];
    const closed = [
      // Closed trades show "HH:MM"; the ms time is what counts (it used to be skipped).
      { positionId: "c1", isSelfApproved: true, openedAt: "15:20", openedAtMs: now - 30 * 60_000 },
      { positionId: "c2", isSelfApproved: true, openedAt: "13:00", openedAtMs: now - 2 * 60 * 60_000 },
    ];
    expect(autopilotOpeningsLastHour(positions, closed, now)).toBe(2);
    // Server-side openings the app closed since are counted too, not twice.
    expect(autopilotOpeningsLastHour(positions, closed, now, ["c1", "s9"])).toBe(3);
  });
});

describe("positionFromProposal", () => {
  it("builds the position the way manual approval does", () => {
    const pos = positionFromProposal({ proposal: proposal("SOL/INR"), entryPrice: 1001, units: 10 }, { id: "x", atr: 5, trailProfile: "patient", now });
    expect(pos).toMatchObject({
      id: "x",
      entryPrice: 1001,
      quantity: 10,
      stopLoss: 980,
      takeProfit: 1060,
      initialStopLoss: 980,
      initialTakeProfit: 1060,
      isSelfApproved: true,
      trailMode: "TREND_RUNNER",
      trailProfile: "patient",
      atrAtEntry: 5,
      openTime: new Date(now).toISOString(),
    });
  });
});

describe("adoptServerOpened", () => {
  const base = positionFromProposal({ proposal: proposal("SOL/INR"), entryPrice: 1000, units: 1 }, { id: "a", atr: 5, trailProfile: "tight" });
  it("adds server-opened positions the app hasn't seen, unless it closed them", () => {
    const server = [
      { ...base, id: "s1", symbol: "ETH/INR", openedByServer: true, clientSeen: false },
      { ...base, id: "s2", symbol: "BTC/INR", openedByServer: true, clientSeen: false },
      { ...base, id: "s3", symbol: "XRP/INR", openedByServer: true, clientSeen: true },
      { ...base, id: "s4", symbol: "ADA/INR" },
    ];
    const next = adoptServerOpened([base], server, (id) => id === "s2");
    expect(next.map((p) => p.id)).toEqual(["s1", "a"]);
    const prev = [base];
    expect(adoptServerOpened(prev, [{ ...base, id: "a", symbol: "ETH/INR", openedByServer: true, clientSeen: false }], () => false)).toBe(prev);
  });

  it("never adds a second position in a coin the book already holds", () => {
    const prev = [base];
    const dup = { ...base, id: "srv-dup", openedByServer: true, clientSeen: false };
    expect(adoptServerOpened(prev, [dup], () => false)).toBe(prev);
    // Nor two copies from the server in one go.
    const other = { ...base, symbol: "ETH/INR", openedByServer: true, clientSeen: false };
    expect(adoptServerOpened([], [{ ...other, id: "e1" }, { ...other, id: "e2" }], () => false).map((p) => p.id)).toEqual(["e1"]);
  });
});
