// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The Lab's "Traders over two years" card: the server's history replay, as
// far as it has got.

vi.mock("../../src/services/apiClient", () => ({ apiFetch: vi.fn(), authenticateSocket: vi.fn() }));
const { apiFetch } = await import("../../src/services/apiClient");
const { HistoryCard } = await import("../../src/components/ledger/HistoryCard");

afterEach(cleanup);

const rec = (trades: number, wins: number, winR: number, lossR: number) => ({ trades, wins, winR, lossR, totalR: winR + lossR });
const view = (over: Record<string, unknown> = {}) => ({
  success: true,
  running: false,
  phase: "idle",
  current: null,
  finished: 3,
  total: 3,
  run: {
    startedAt: Date.parse("2026-10-01T10:00:00Z"),
    finishedAt: Date.parse("2026-10-01T16:00:00Z"),
    fromMs: Date.parse("2024-10-01T00:00:00Z"),
    toMs: Date.parse("2026-10-01T00:00:00Z"),
    markets: { crypto: { done: 2, failed: 1, skipped: 0 }, us: { done: 0, failed: 0, skipped: 0 }, nse: { done: 0, failed: 0, skipped: 0 } },
    problems: [{ symbol: "WIF/INR", note: "WIFUSDT isn't on Binance" }],
  },
  records: {
    tight: {
      "2026-Q2": { "crypto:Sofia Range Scalp": rec(10, 6, 3, -2), "crypto:Diego Aggressive Breakout": rec(10, 4, 2, -4) },
      "2026-Q3": { "crypto:Sofia Range Scalp": rec(10, 5, 2, -3) },
    },
    patient: { "2026-Q3": { "crypto:Sofia Range Scalp": rec(20, 12, 8, -4) } },
  },
  ...over,
});
const reply = (body: unknown) => new Response(JSON.stringify(body));

describe("Traders over two years", () => {
  it("shows each trader's result with your exits, by half-year, and every exit profile on the same setups", async () => {
    vi.mocked(apiFetch).mockResolvedValue(reply(view()));
    render(createElement(HistoryCard, { trailProfile: "tight" }));
    const list = await screen.findByTestId("history-traders");
    const rows = within(list).getAllByRole("listitem");
    // Best first: Sofia averages +0.00R over 20, Diego −0.20R over 10.
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Sofia Range Scalp20 setups · 55% won · win +0.45R · loss −0.56R+0.00R"),
      expect.stringContaining("Diego Aggressive Breakout10 setups · 40% won · win +0.50R · loss −0.67R−0.20R"),
    ]);
    // One half-year here (Apr–Sep 2026): Sofia's +0.00, Diego's −0.20.
    expect(screen.getByText("Apr–Sep 2026")).toBeTruthy();
    const exits = screen.getByTestId("history-exits");
    expect(exits.textContent).toContain("Tight (yours)30 setups · 50% won · −0.07R");
    expect(exits.textContent).toContain("Patient20 setups · 60% won · +0.20R");
    expect(screen.getByTestId("history-status").textContent).toBe("1 Oct 2024 – 1 Oct 2026 · updated 1 Oct 2026");
    expect(screen.getByText(/WIF\/INR \(WIFUSDT isn't on Binance\)/)).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Coins · 2" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "US · 0" }));
    expect(screen.getByText("No results here.")).toBeTruthy();
  });

  it("shows nothing for a reply without results (an older server)", async () => {
    vi.mocked(apiFetch).mockResolvedValue(reply({ success: true, events: [] }));
    const { container } = render(createElement(HistoryCard, { trailProfile: "tight" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe("");
  });

  it("shows progress while it runs, and can replay again once it's done", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(reply(view({ running: true, phase: "waiting_for_nse", current: "RELIANCE", finished: 40, total: 131 })));
    render(createElement(HistoryCard, { trailProfile: "tight" }));
    expect((await screen.findByTestId("history-status")).textContent).toBe("Replaying: 40 of 131 markets checked · waiting for NSE to close RELIANCE");
    expect(screen.queryByRole("button", { name: "Replay again" })).toBeNull();
    cleanup();

    vi.mocked(apiFetch).mockResolvedValue(reply(view()));
    render(createElement(HistoryCard, { trailProfile: "tight" }));
    fireEvent.click(await screen.findByRole("button", { name: "Replay again" }));
    expect(apiFetch).toHaveBeenCalledWith("/api/history/run", { method: "POST" });
  });
});
