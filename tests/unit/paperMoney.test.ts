// @vitest-environment jsdom
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dailyLossLimitFor } from "../../src/services/riskEngine";
import { AMOUNT_CHOICES, cleanMarketLimits, PAPER_MONEY_CHOICES, RISK_CHOICES } from "../../src/shared/marketLimits";
import { loadPaperStart, PAPER_START_INR, restartedPaperCapital, savePaperStart } from "../../src/services/storagePersistenceService";

// Paper money (Settings): the paper balance can start again at a larger
// amount, with trade sizes and a daily loss limit to match.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-paper-money-"));
vi.stubEnv("NEXUS_DATA_DIR", dataDir);
afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => localStorage.clear());

describe("paper money", () => {
  it("starts at ₹1 lakh, and starts again at the amount picked, the all-time P&L from zero and today's kept", () => {
    expect(loadPaperStart()).toBe(PAPER_START_INR);
    savePaperStart(1_000_000);
    expect(loadPaperStart()).toBe(1_000_000);
    expect(restartedPaperCapital(1_000_000, -1200)).toEqual({ equity: 1_000_000, cash: 1_000_000, dailyRealizedPnl: -1200, allTimeRealizedPnl: 0 });
    expect(PAPER_MONEY_CHOICES).toContain(1_000_000);
  });

  it("offers trade sizes to match: up to ₹2 lakh a trade and ₹10,000 to lose, kept as set", () => {
    expect(AMOUNT_CHOICES).toEqual(expect.arrayContaining([100_000, 200_000]));
    expect(RISK_CHOICES).toEqual(expect.arrayContaining([5_000, 10_000]));
    const limits = cleanMarketLimits({ coins: { amountPerTradeInr: 100_000, maxOpenTrades: 2, riskPerTradeInr: 10_000, breakoutTrades: 3 } });
    expect(limits.coins).toMatchObject({ amountPerTradeInr: 100_000, riskPerTradeInr: 10_000 });
  });
});

describe("the daily loss limit", () => {
  it("is 2.5% of the money, never under ₹2,500", () => {
    expect(dailyLossLimitFor(100_000)).toBe(2_500);
    expect(dailyLossLimitFor(1_000_000)).toBe(25_000);
    expect(dailyLossLimitFor(40_000)).toBe(2_500);
    expect(dailyLossLimitFor(0)).toBe(2_500);
    expect(dailyLossLimitFor(Number.NaN)).toBe(2_500);
  });

  it("lets a ₹10 lakh desk keep trading after one ₹10,000 stop; a ₹1 lakh desk stops for the day", async () => {
    const { riskPolicyFor } = await import("../../server/scanner/scannerService");
    const { deskNote } = await import("../../server/scanner/dailyCoins");
    const desk = (equity: number) =>
      ({
        equity, riskLimits: { maxOrderValueInr: 10_000, maxAllowedExposureFraction: 0.1 }, dailyRealizedPnl: 0, pnlDay: "2026-10-05",
        autopilot: true, tradingMode: "PAPER", killSwitch: false, scanning: true,
        failureState: { globalKillSwitchActive: false }, quarantines: {}, promotedModel: null, updatedAt: 0,
      }) as any;
    const lost = { dailyPnl: () => -10_000 };
    expect(riskPolicyFor(desk(1_000_000)).hardDailyLossLimit).toBe(25_000);
    expect(deskNote("u", desk(1_000_000), riskPolicyFor(desk(1_000_000)), lost, 0)).toBeNull();
    expect(deskNote("u", desk(100_000), riskPolicyFor(desk(100_000)), lost, 0)).toBe("Today's loss limit is reached.");
  });
});
