import { describe, expect, it } from "vitest";
import { anchorAt, cleanAnchor, deskMoney, istDay, restartAnchor } from "../../src/shared/deskMoney";

// The money from the closed trades: where it stood at a moment, plus every
// close after it, each once.

const T = Date.parse("2026-10-09T06:00:00Z"); // 11:30 India time
const trade = (id: string, closedAtMs: number | undefined, realizedPnl: number, positionId = id) => ({ id, positionId, closedAtMs, realizedPnl });
const anchor = { at: T, equity: 100_000, allTimeRealizedPnl: 2_000, start: 100_000 };

describe("the desk's money", () => {
  it("is the anchor plus every close after it; closes before it are in the anchor already", () => {
    const trades = [trade("a", T + 60_000, 500), trade("b", T + 120_000, -200), trade("c", T - 60_000, 900)];
    expect(deskMoney(anchor, trades, "2026-10-09")).toEqual({ equity: 100_300, cash: 100_300, dailyRealizedPnl: 1_200, allTimeRealizedPnl: 2_300 });
  });

  it("counts a trade once however many copies arrive (the phone's and the server's), and none without a close time", () => {
    const trades = [trade("phone-a", T + 60_000, 500, "pos-a"), trade("server-a", T + 61_000, 500, "pos-a"), trade("old", undefined, 7_000)];
    expect(deskMoney(anchor, trades, "2026-10-09").equity).toBe(100_500);
  });

  it("takes today's P&L from India's day", () => {
    const lateYesterday = Date.parse("2026-10-08T18:29:00Z"); // 23:59 on the 8th in India
    const earlyToday = Date.parse("2026-10-08T18:31:00Z"); // 00:01 on the 9th
    expect(istDay(lateYesterday)).toBe("2026-10-08");
    expect(istDay(earlyToday)).toBe("2026-10-09");
    const trades = [trade("y", lateYesterday, -300), trade("t", earlyToday, 100)];
    expect(deskMoney({ ...anchor, at: 0 }, trades, "2026-10-09").dailyRealizedPnl).toBe(100);
    expect(deskMoney({ ...anchor, at: 0 }, trades, "2026-10-08").dailyRealizedPnl).toBe(-300);
  });

  it("moves its anchor without changing the money", () => {
    const trades = [trade("a", T + 60_000, 500), trade("b", T + 120_000, -200), trade("c", T - 60_000, 900)];
    const now = deskMoney(anchor, trades, "2026-10-09");
    const moved = anchorAt(now, trades, T + 90_000, 100_000);
    expect(moved).toEqual({ at: T + 90_000, equity: 100_500, allTimeRealizedPnl: 2_500, start: 100_000 });
    expect(deskMoney(moved, trades, "2026-10-09")).toEqual(now);
  });

  it("starts again at a picked amount: the all-time P&L from zero", () => {
    expect(restartAnchor(500_000, T)).toEqual({ at: T, equity: 500_000, allTimeRealizedPnl: 0, start: 500_000 });
  });

  it("reads only a whole anchor", () => {
    expect(cleanAnchor(anchor)).toEqual(anchor);
    expect(cleanAnchor({ ...anchor, equity: "1" })).toBeNull();
    expect(cleanAnchor({ ...anchor, start: 0 })).toBeNull();
    expect(cleanAnchor(null)).toBeNull();
  });
});
