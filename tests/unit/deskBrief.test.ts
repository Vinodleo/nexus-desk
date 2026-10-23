// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoricalTrade, Position } from "../../src/types";
import type { IpoView } from "../../src/components/ledger/IpoCard";
import type { ServerStatus } from "../../src/hooks/useServerStatus";

vi.mock("../../src/services/apiClient", () => ({ apiFetch: vi.fn(), authenticateSocket: vi.fn() }));
const { apiFetch } = await import("../../src/services/apiClient");
const { deskBrief } = await import("../../src/components/ledger/deskBrief");
const { CommanderModal } = await import("../../src/components/CommanderModal");

// The desk brief: the day in a headline and three figures, what needs the
// owner, what each strategy did today, every stop hitting, and questions
// answered from the desk's own records.

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => {
  vi.mocked(apiFetch).mockResolvedValue(new Response("Not found", { status: 404 }));
});

const NOW = Date.parse("2026-10-23T09:30:00Z"); // Friday 23 Oct, 3:00 pm in India
const HOUR = 3_600_000;

const closed = (symbol: string, pnl: number, hoursAgo: number, over: Partial<HistoricalTrade> = {}): HistoricalTrade => ({
  id: symbol, positionId: symbol, symbol, direction: "LONG", setupName: "Breakout 55/20", strategy: "breakout", entryPrice: 100, exitPrice: 101,
  quantity: 1, moneyPlaced: 20000, feesPaid: 20, realizedPnl: pnl, realizedPnlPercent: 0, isWin: pnl > 0, exitReason: "TRAILING_STOP",
  openedAt: "", closedAt: new Date(NOW - hoursAgo * HOUR).toISOString(), closedAtMs: NOW - hoursAgo * HOUR, ...over,
} as HistoricalTrade);

const pos = (symbol: string, qty: number, entry: number, stop: number, openedHoursAgo: number, over: Partial<Position> = {}): Position => ({
  id: symbol, symbol, direction: "LONG", setupName: "Breakout 55/20", strategy: "breakout", entryPrice: entry, currentPrice: entry,
  quantity: qty, stopLoss: stop, initialStopLoss: stop, takeProfit: 0, unrealizedPnl: 0, unrealizedPnlPercent: 0,
  openTime: new Date(NOW - openedHoursAgo * HOUR).toISOString(), expectedHoldingTimeMinutes: 525600, metaConfidence: 0.6, ...over,
});

// Gold sold below its 20-day low this morning at +1.8R, after 23 days; NVDA bought overnight; SOL held since Tuesday.
const gld = closed("GLD.US", 2140, 5, { riskAtOpen: 1189, holdingDurationMinutes: 23 * 1440 });
const desk = {
  closed: [gld, closed("AAPL.US", -500, 5 * 24, { riskAtOpen: 500 })],
  positions: [pos("NVDA.US", 1, 15000, 14500, 13), pos("SOL/INR", 2, 16000, 15200, 72)],
  todayPnl: 2140,
  lossLimit: 25000,
  todayLoss: 0,
  stopped: false,
};
// Hot Co fits the IPO rule and its bidding ends today at 5 pm.
const ipos = {
  bidding: [{ symbol: "HOTCO", name: "Hot Co", fits: true, closes: "2026-10-23", upiCutoff: 17 * 60 }],
  upcoming: [],
  recent: [],
} as unknown as IpoView;
const failedBackup = {
  scanner: { lastTickAt: NOW, lastCycleDoneAt: NOW, stalled: false },
  backup: { configured: true, keepDays: 30, lastAt: NOW - 30 * HOUR, files: 20, lastBytes: 1, lastError: "403 from the bucket", lastErrorAt: NOW - HOUR },
} as unknown as ServerStatus;

describe("the desk brief", () => {
  it("says the day in a headline, what needs you, what each strategy did and what every stop would take", () => {
    const b = deskBrief({ ...desk, now: NOW, ipos, server: failedBackup });
    expect(b.headline).toBe("Up ₹2,140 today");
    expect(b.open).toBe(2);
    expect(b.limitUsed).toBe(0);
    expect(b.needs.map((n) => `${n.lead} ${n.text}`)).toEqual([
      "Hot Co fits the IPO rule. Apply and approve the UPI request by 5 pm.",
      "The last backup failed. Settings → Server → Backups says why; it tries again every hour.",
    ]);
    // The slower strategies in their order, each in a line.
    expect(b.lines).toEqual([
      { label: "Coin breakout", text: "Holds SOL.", r: null, open: 1 },
      { label: "US breakout", text: "Bought NVDA.", r: null, open: 1 },
      { label: "Funds breakout", text: "Sold GLD (below its 20-day low) at +1.8R.", r: 2140 / 1189, open: 0 },
    ]);
    // NVDA −₹500 and SOL −₹1,600 at their stops: 8% of the day's ₹25,000.
    expect(b.stops).toEqual({ net: -2100, left: 25000, share: 8.4 });
    expect(b.answers.map((a) => a.question)).toEqual(["Why did GLD sell?", "What's next?", "How much is at risk?"]);
    expect(b.answers[0].answer).toBe("Below its 20-day low after 23 days. It ended at +1.8R, kept ₹2,140 after ₹20 fees (funds breakout).");
    expect(b.answers[2].answer).toBe("If every stop hit, the desk would lose ₹2,100 before fees: 8% of today's ₹25,000 limit, with ₹25,000 of it left.");
  });

  it("calls a stopped desk, a quiet day and a nearly spent loss limit what they are", () => {
    expect(deskBrief({ ...desk, now: NOW, stopped: true }).needs[0]).toMatchObject({ tone: "danger", lead: "Trading is stopped." });
    expect(deskBrief({ ...desk, now: NOW, stopped: true }).headline).toBe("Trading is stopped");
    const quiet = deskBrief({ ...desk, closed: [], positions: [pos("SOL/INR", 2, 16000, 15200, 72)], todayPnl: 0, now: NOW });
    expect(quiet.headline).toBe("A quiet day so far");
    expect(quiet.needs).toEqual([]);
    const spent = deskBrief({ ...desk, todayPnl: -21000, todayLoss: 21000, now: NOW });
    expect(spent.headline).toBe("Down ₹21,000 today");
    expect(spent.needs[0]).toMatchObject({ lead: "84% of today's loss limit is used." });
    // An IPO past its UPI cutoff no longer needs you.
    expect(deskBrief({ ...desk, now: NOW + 3 * HOUR, ipos }).needs).toEqual([]);
    // Nothing open, nothing at risk.
    expect(deskBrief({ ...desk, positions: [], now: NOW }).answers.at(-1)?.answer).toBe("Nothing is open, so nothing is at risk.");
  });

  it("shows it in the sheet, answering a question on a tap, with the commander's note under it", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    render(createElement(CommanderModal, { isOpen: true, onClose: vi.fn(), summaryText: "Markets steady.", desk: { ...desk, server: failedBackup } }));
    expect(screen.getByTestId("brief-headline").textContent).toBe("Up ₹2,140 today");
    expect(screen.getByTestId("brief-today").textContent).toBe("Today+₹2,140");
    expect(screen.getByTestId("brief-open").textContent).toBe("Open trades2");
    expect(screen.getByTestId("brief-need").textContent).toBe("The last backup failed. Settings → Server → Backups says why; it tries again every hour.");
    expect(screen.getAllByTestId("brief-line").map((l) => l.textContent)).toEqual([
      "Coin breakoutHolds SOL.1 open",
      "US breakoutBought NVDA.1 open",
      "Funds breakoutSold GLD (below its 20-day low) at +1.8R.+1.8R",
    ]);
    expect(screen.queryByTestId("brief-answer")).toBeNull();
    const ask = screen.getByRole("button", { name: "Why did GLD sell?" });
    fireEvent.click(ask);
    expect(ask.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("brief-answer").textContent).toMatch(/^Below its 20-day low after 23 days/);
    fireEvent.click(ask);
    expect(screen.queryByTestId("brief-answer")).toBeNull();
    expect(screen.getByTestId("brief-market").textContent).toBe("Markets steady.");
  });
});
