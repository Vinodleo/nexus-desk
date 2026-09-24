import { describe, expect, it } from "vitest";
import { LOSS_COOLDOWN_MS, WIN_COOLDOWN_MS, cooldownUntil, cooldownsFromCloses, lossStreak, mergeQuarantines } from "../../src/services/lossGuards";

// After any close, wherever it happened: a cooldown on the coin, and the
// loss streak that stops autopilot.

const t0 = Date.parse("2026-09-24T14:49:00Z");
const MIN = 60_000;

describe("coin cooldowns", () => {
  it("leave a coin alone 2 hours after a loss and 5 minutes after a win", () => {
    expect(cooldownUntil({ isWin: false, closedAtMs: t0 })).toBe(t0 + LOSS_COOLDOWN_MS);
    expect(cooldownUntil({ isWin: true, closedAtMs: t0 })).toBe(t0 + WIN_COOLDOWN_MS);
  });

  it("come from each coin's closes, keeping only those still running", () => {
    const q = cooldownsFromCloses(
      [
        { symbol: "ZEC/INR", isWin: false, closedAtMs: t0 },
        { symbol: "ZEC/INR", isWin: true, closedAtMs: t0 + 10 * MIN },
        { symbol: "BNB/INR", isWin: true, closedAtMs: t0 },
      ],
      t0 + 12 * MIN
    );
    // The loss's 2 hours outlast the later win's 5 minutes; BNB's pause is over.
    expect(q).toEqual({ "ZEC/INR": { quarantinedUntilMs: t0 + LOSS_COOLDOWN_MS } });
  });

  it("merge, keeping the later end", () => {
    expect(
      mergeQuarantines({ A: { quarantinedUntilMs: 5 }, B: { quarantinedUntilMs: 9 } }, { A: { quarantinedUntilMs: 7 }, B: { quarantinedUntilMs: 1 }, C: { quarantinedUntilMs: 3 } })
    ).toEqual({ A: { quarantinedUntilMs: 7 }, B: { quarantinedUntilMs: 9 }, C: { quarantinedUntilMs: 3 } });
  });
});

describe("lossStreak", () => {
  const closes = [
    { isWin: false, closedAtMs: t0 + 40 * MIN },
    { isWin: false, closedAtMs: t0 + 30 * MIN },
    { isWin: false, closedAtMs: t0 + 20 * MIN },
    { isWin: true, closedAtMs: t0 + 10 * MIN },
    { isWin: false, closedAtMs: t0 },
  ];
  it("counts losses in a row from the newest", () => {
    expect(lossStreak(closes)).toBe(3);
    expect(lossStreak([{ isWin: true, closedAtMs: t0 }, ...closes])).toBe(0);
  });
  it("starts fresh from when the kill switch was turned off", () => {
    expect(lossStreak(closes, t0 + 25 * MIN)).toBe(2);
  });
});
