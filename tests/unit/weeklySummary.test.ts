import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClosedTrade } from "../../server/guardian";

// The Sunday pop-up: the week's paper trades and how each slower strategy is
// doing against its replay.

let dir: string;
let ws: typeof import("../../server/weeklySummary");

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-weekly-"));
  vi.stubEnv("NEXUS_DATA_DIR", dir);
  ws = await import("../../server/weeklySummary");
});
afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

const ist = (s: string) => Date.parse(`${s}+05:30`);
// Sunday 11 Oct 2026, 10:30 in India.
const NOW = ist("2026-10-11T10:30:00");
const DAY = 24 * 60 * 60 * 1000;

const trade = (over: Partial<DaemonClosedTrade>): DaemonClosedTrade =>
  ({
    id: "t", positionId: "p", symbol: "SOL/INR", direction: "LONG", entryPrice: 100, exitPrice: 100, quantity: 1, moneyPlaced: 100,
    grossPnl: 0, feesPaid: 0, realizedPnl: 0, realizedPnlPercent: 0, isWin: false, exitReason: "STOP_LOSS",
    closedAt: new Date(NOW - DAY).toISOString(), openedAt: new Date(NOW - 5 * DAY).toISOString(), userId: "u", riskAtOpen: 300,
    ...over,
  }) as DaemonClosedTrade;
const replays = { coinBreakout: 0.87, usBreakout: 0.39, usMomentum: 0.26 };

describe("when the weekly summary goes", () => {
  it("is Sunday 10 am in India, sent late after a restart until Tuesday", () => {
    // A Wednesday: the Sunday before.
    expect(ws.lastSendTime(ist("2026-10-07T12:00:00"))).toEqual({ at: ist("2026-10-04T10:00:00"), week: "2026-10-04" });
    // Sunday before 10: still last week's.
    expect(ws.lastSendTime(ist("2026-10-11T09:59:00")).week).toBe("2026-10-04");
    expect(ws.lastSendTime(ist("2026-10-11T10:00:00")).week).toBe("2026-10-11");
    expect(ws.summaryDue(NOW, null)).toBe(true);
    expect(ws.summaryDue(NOW, "2026-10-11")).toBe(false);
    expect(ws.summaryDue(ist("2026-10-12T20:00:00"), "2026-10-04")).toBe(true);
    // More than two days late: skipped, the next one comes on Sunday.
    expect(ws.summaryDue(ist("2026-10-13T11:00:00"), "2026-10-04")).toBe(false);
  });
});

describe("the weekly summary", () => {
  it("says what the week made and how each strategy compares with its replay", () => {
    const trades = [
      trade({ symbol: "BTC/INR", strategy: "breakout", realizedPnl: 600, closedAt: new Date(NOW - DAY).toISOString() }),
      trade({ symbol: "AAPL.US", strategy: "breakout", realizedPnl: -100, riskAtOpen: 100, closedAt: new Date(NOW - 3 * DAY).toISOString() }),
      // Two weeks ago: counts so far, not this week.
      trade({ symbol: "ETH/INR", strategy: "breakout", realizedPnl: -300, closedAt: new Date(NOW - 14 * DAY).toISOString() }),
    ];
    const open = [{ symbol: "MSFT.US", strategy: "momentum" as const }];
    expect(ws.weeklySummaryMessage(trades, open, replays, NOW)).toEqual({
      title: "Your week on paper: +₹500",
      body:
        "2 closed (1 won), 1 still open. " +
        "Coin breakout: 2 closed so far, +0.50R a trade (replay +0.87R). " +
        "US breakout: 1 closed so far, −1.00R a trade (replay +0.39R). " +
        "US momentum: 1 open, none closed yet. " +
        "Too early to judge: it takes about 30 trades each.",
      tag: "weekly-summary",
      url: "/",
    });
  });

  it("puts a strategy clearly behind its replay first", () => {
    const trades = Array.from({ length: 12 }, (_, k) => trade({ id: `t${k}`, symbol: "BTC/INR", strategy: "breakout", realizedPnl: -300, closedAt: new Date(NOW - 20 * DAY).toISOString() }));
    const msg = ws.weeklySummaryMessage(trades, [], replays, NOW)!;
    expect(msg.title).toBe("Your week on paper: nothing closed");
    expect(msg.body).toBe(
      "No trades closed; 0 open. Coin breakout is behind its replay: see the Lab's scorecard. Coin breakout: 12 closed so far, −1.00R a trade (replay +0.87R, behind)."
    );
  });

  it("says nothing on a week with nothing open, closed or traded so far, and drops \"on paper\" once a trade is live", () => {
    expect(ws.weeklySummaryMessage([], [], replays, NOW)).toBeNull();
    const live = ws.weeklySummaryMessage([trade({ strategy: "breakout", realizedPnl: -120, isLiveOrder: true })], [], replays, NOW)!;
    expect(live.title).toBe("Your week: −₹120");
  });

  it("goes to each desk once a week, remembered across a restart", () => {
    const notify = vi.fn();
    let now = NOW;
    const deps = {
      now: () => now,
      dir: () => dir,
      desks: () => ["u", "quiet"],
      trades: (uid: string) => (uid === "u" ? [trade({ strategy: "breakout", realizedPnl: 600 })] : []),
      open: () => [],
      replays: () => replays,
      notify,
    };
    ws._resetWeeklySummary();
    expect(ws.runWeeklySummary(deps)).toBe(true);
    // The quiet desk has nothing to say.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe("u");
    now += 60 * 60 * 1000;
    expect(ws.runWeeklySummary(deps)).toBe(false);
    ws._resetWeeklySummary(dir);
    expect(ws.runWeeklySummary(deps)).toBe(false);
    // Next Sunday.
    now = NOW + 7 * DAY;
    expect(ws.runWeeklySummary(deps)).toBe(true);
    expect(notify).toHaveBeenCalledTimes(2);
  });
});

beforeEach(() => ws?._resetWeeklySummary());
