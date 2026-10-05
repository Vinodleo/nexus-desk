// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoricalTrade } from "../../src/types";
import { financialYearOf, taxReport, taxReportCsv, taxYears } from "../../src/services/taxReport";
import { daemonEventToTrade } from "../../src/services/daemonEvents";
import { TaxReportCard } from "../../src/components/ledger/TaxReportCard";

// The yearly tax report for the CA: a financial year's closed trades, by how
// India taxes each market, live and paper apart.

afterEach(cleanup);

const ist = (s: string) => Date.parse(`${s}+05:30`);
const DAY = 24 * 60 * 60 * 1000;

const trade = (over: Partial<HistoricalTrade>): HistoricalTrade => ({
  id: "t", symbol: "BTC/INR", direction: "LONG", setupName: "Breakout 55/20", entryPrice: 100, exitPrice: 100, quantity: 1, moneyPlaced: 100,
  realizedPnl: 0, realizedPnlPercent: 0, isWin: false, exitReason: "STOP_LOSS", openedAt: "", closedAt: "",
  openedAtMs: ist("2026-06-01T10:00:00"), closedAtMs: ist("2026-07-01T10:00:00"),
  ...over,
});

// Live: a coin winner (bought ₹10,000, sold ₹12,000, ₹130 fees) and loser (₹10,000 to ₹9,000, ₹112 fees),
// a US trade held 10 days and one held 25 months, an Indian intraday trade; a paper trade; last year's live one.
const trades: HistoricalTrade[] = [
  trade({ id: "c1", strategy: "breakout", entryPrice: 1000, exitPrice: 1200, quantity: 10, grossPnl: 2000, feesPaid: 130, realizedPnl: 1870 }),
  trade({ id: "c2", symbol: "SOL/INR", entryPrice: 100, exitPrice: 90, quantity: 100, grossPnl: -1000, feesPaid: 112, realizedPnl: -1112 }),
  trade({ id: "u1", symbol: "AAPL.US", strategy: "momentum", entryPrice: 20000, exitPrice: 21000, quantity: 1, grossPnl: 1000, feesPaid: 20, realizedPnl: 980,
    openedAtMs: ist("2026-06-21T20:00:00") }),
  trade({ id: "u2", symbol: "MSFT.US", strategy: "breakout", entryPrice: 30000, exitPrice: 36000, quantity: 0.5, grossPnl: 3000, feesPaid: 30, realizedPnl: 2970,
    openedAtMs: ist("2024-05-15T20:00:00"), closedAtMs: ist("2026-06-20T20:00:00") }),
  trade({ id: "n1", symbol: "RELIANCE", setupName: "Sofia, Range Scalp", direction: "SHORT", entryPrice: 1500, exitPrice: 1490, quantity: 10, grossPnl: 100, feesPaid: 40, realizedPnl: 60 }),
].map((t) => ({ ...t, isLiveOrder: true }));
trades.push(trade({ id: "p1", entryPrice: 1000, exitPrice: 1100, quantity: 1, grossPnl: 100, feesPaid: 13, realizedPnl: 87 }));
trades.push({ ...trade({ id: "old", closedAtMs: ist("2026-03-31T23:59:00"), grossPnl: 500, realizedPnl: 480, feesPaid: 20 }), isLiveOrder: true });
// No close time: left out.
trades.push({ ...trade({ id: "undated", closedAtMs: undefined, grossPnl: 999 }), isLiveOrder: true });

describe("the tax report", () => {
  it("places a trade in India's financial year, 1 April to 31 March", () => {
    expect(financialYearOf(ist("2027-03-31T23:59:00"))).toBe("2026-27");
    expect(financialYearOf(ist("2027-04-01T00:00:00"))).toBe("2027-28");
    expect(financialYearOf(ist("2029-12-01T00:00:00"))).toBe("2029-30");
    expect(taxYears(trades, true)).toEqual(["2026-27", "2025-26"]);
    expect(taxYears(trades, false)).toEqual(["2026-27"]);
  });

  it("taxes coin winners alone, counts TDS on each sale, splits US gains by how long they were held, and nets Indian intraday", () => {
    const r = taxReport(trades, "2026-27", true);
    // Coins: 30% plus cess on the winner's ₹2,000 alone; TDS 1% of both sales (₹12,000 and ₹9,000).
    expect(r.coins.rows.map((x) => x.symbol)).toEqual(["BTC/INR", "SOL/INR"]);
    expect(r.coins).toMatchObject({ gains: 2000, losses: -1000, tds: 210, tax: 624 });
    expect(r.coins.rows[0]).toMatchObject({ buyValue: 10000, saleValue: 12000, fees: 130, gain: 2000, net: 1870, daysHeld: 30, strategy: "breakout" });
    // US: held 10 days short-term; held 25 months long-term; after fees.
    expect(r.us).toMatchObject({ shortTerm: 980, longTerm: 2970 });
    expect(r.us.rows.find((x) => x.symbol === "MSFT.US")).toMatchObject({ longTerm: true, buyValue: 15000, saleValue: 18000 });
    // India: a short sells first, buys back for less.
    expect(r.india.net).toBe(60);
    expect(r.india.rows[0]).toMatchObject({ saleValue: 15000, buyValue: 14900, gain: 100 });
    // The paper trade, last year's and the undated one aren't in it.
    expect([...r.coins.rows, ...r.us.rows, ...r.india.rows]).toHaveLength(5);
    expect(taxReport(trades, "2026-27", false).coins.rows.map((x) => x.saleValue)).toEqual([1100]);
  });

  it("writes a CSV for the CA: a row per trade, then each market's totals", () => {
    const csv = taxReportCsv(taxReport(trades, "2026-27", true));
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(
      "Market,Symbol,Strategy,Bought on,Sold on,Days held,Quantity,Bought for (₹),Sold for (₹),Fees (₹),Gain before fees (₹),Net after fees (₹),TDS 1% (₹),Term"
    );
    expect(lines).toContain("Coins (crypto),BTC/INR,breakout,2026-06-01,2026-07-01,30,10,10000.00,12000.00,130.00,2000.00,1870.00,120.00,");
    expect(lines).toContain("US stocks,MSFT.US,breakout,2024-05-15,2026-06-20,766,0.5,15000.00,18000.00,30.00,3000.00,2970.00,,long-term");
    // A name with a comma is quoted.
    expect(lines.some((l) => l.includes('"Sofia, Range Scalp"'))).toBe(true);
    expect(lines).toContain("Coins: tax estimate (30% + 4% cess on the gains),624.00");
    expect(lines).toContain("US stocks: short-term net after fees,980.00");
  });

  it("keeps whether a server-closed trade was live", () => {
    const ev = { id: "e", positionId: "p", symbol: "BTC/INR", direction: "LONG", entryPrice: 1, exitPrice: 1, quantity: 1, moneyPlaced: 1, realizedPnl: 0,
      realizedPnlPercent: 0, isWin: false, exitReason: "STOP_LOSS", openedAt: new Date(0).toISOString(), closedAt: new Date(DAY).toISOString() } as any;
    expect(daemonEventToTrade({ ...ev, isLiveOrder: true }).isLiveOrder).toBe(true);
    expect(daemonEventToTrade(ev).isLiveOrder).toBeUndefined();
  });
});

describe("the tax report card", () => {
  it("shows live trades first, each market's sums, and saves the CSV; paper trades marked as untaxed", () => {
    const save = vi.fn();
    render(createElement(TaxReportCard, { trades, save }));
    expect(screen.getByLabelText("Financial year")).toBeTruthy();
    expect(screen.getByTestId("tax-coins").textContent).toBe(
      "Coins · 2 trades" + "Winners gained ₹2,000, losers lost ₹1,000: losses offset nothing." + "Tax on the winners: about ₹624 (30% plus 4% cess)." +
        "TDS: ₹210 withheld (1% of each sale), credited when you file."
    );
    expect(screen.getByTestId("tax-us").textContent).toContain("Short-term +₹980 (your slab rate) · long-term +₹2,970 (12.5%)");
    expect(screen.getByTestId("tax-india").textContent).toContain("+₹60 after costs");
    fireEvent.click(screen.getByText("Download for your CA (CSV)"));
    expect(save).toHaveBeenCalledWith("nexus-desk-tax-2026-27-live.csv", expect.stringContaining("Coins (crypto),BTC/INR"));

    // Last year's: just the one trade.
    fireEvent.change(screen.getByLabelText("Financial year"), { target: { value: "2025-26" } });
    expect(screen.getByTestId("tax-coins").textContent).toContain("Coins · 1 trade");

    fireEvent.click(screen.getByText("Paper"));
    expect(screen.getByTestId("tax-paper-note")).toBeTruthy();
    expect(screen.getByTestId("tax-coins").textContent).toContain("TDS: ₹11 would be withheld");
    cleanup();

    // Paper only so far: it opens on paper; no live trades yet.
    render(createElement(TaxReportCard, { trades: trades.filter((t) => !t.isLiveOrder), save }));
    expect(screen.getByTestId("tax-paper-note")).toBeTruthy();
    fireEvent.click(screen.getByText("Live"));
    expect(screen.getByTestId("tax-empty").textContent).toBe("No live trades closed yet.");
  });
});
