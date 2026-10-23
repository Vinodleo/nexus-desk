// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Lab → Today: what the scheduled checks did last (one timeline), their full
// cards folded under it, and the Lab's title.

vi.mock("../../src/services/apiClient", () => ({ apiFetch: vi.fn(), authenticateSocket: vi.fn() }));
const { apiFetch } = await import("../../src/services/apiClient");
const { ChecksTimeline, CheckDetails, checkTags } = await import("../../src/components/ledger/LabDesk");

afterEach(cleanup);

const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).getTime();
const pick = (symbol: string, outcome: string, reason?: string) => ({ symbol, trader: "Breakout 55/20", outcome, reason });
const routes: Record<string, unknown> = {
  "/api/daily-coins": {
    success: true, traders: [], nextAt: 0,
    run: { at: at(12, 5, 40), day: "2026-10-12", coins: 22, failed: [], picks: [] },
  },
  "/api/us-breakout": {
    success: true, gate: null, slots: null, nextAt: 0,
    run: { at: at(10, 1, 15), day: "2026-10-09", coins: 20, failed: ["BRK.B.US"], picks: [pick("AMZN.US", "opened"), pick("AAPL.US", "sold"), pick("MSFT.US", "kept")] },
  },
  "/api/funds-breakout": {
    success: true, gate: null, slots: null, nextAt: 0,
    run: { at: at(10, 1, 16), day: "2026-10-09", coins: 16, failed: [], picks: [pick("GLD.US", "opened"), pick("SLV.US", "waiting", "would exceed 3 open funds breakout trades at once")] },
  },
  "/api/us-momentum": {
    success: true, gate: null, slots: null, nextAt: 0,
    run: {
      at: at(10, 1, 17), day: "2026-10-09", coins: 20, failed: [], marketUp: true,
      top: [{ symbol: "META.US", rise: 0.4 }, { symbol: "AVGO.US", rise: 0.3 }, { symbol: "NVDA.US", rise: 0.2 }],
      picks: [pick("META.US", "kept"), pick("AVGO.US", "kept"), pick("NVDA.US", "kept")],
    },
  },
};
beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (path: string) => new Response(JSON.stringify(routes[path] ?? null), { status: routes[path] ? 200 : 404 }));
});

describe("what the checks did", () => {
  it("puts each outcome's names in one chip, four at most", () => {
    const picks = ["A", "B", "C", "D", "E", "F"].map((s) => pick(`${s}.US`, "opened")) as any;
    expect(checkTags({ picks: [...picks, pick("X/INR", "sold"), pick("Y/INR", "paused")] as any })).toEqual([
      { outcome: "opened", text: "Bought A, B, C, D +2" },
      { outcome: "sold", text: "Sold X" },
      { outcome: "paused", text: "Paused Y" },
    ]);
    expect(checkTags({ picks: [] })).toEqual([]);
  });

  it("lists each check's last run, newest first, with what it read and did", async () => {
    render(createElement(ChecksTimeline));
    const list = await screen.findByTestId("checks-timeline");
    await within(list).findByText("US momentum check");
    expect(within(list).getAllByRole("listitem").map((li) => li.getAttribute("data-testid"))).toEqual(["check-coins", "check-momentum", "check-funds", "check-us"]);
    expect(screen.getByTestId("check-coins").textContent).toContain("Checked 22 coins. Nothing to buy or sell that day.");
    expect(screen.getByTestId("check-us").textContent).toContain("Checked 20 stocks; 1 couldn't be read.Bought AMZNSold AAPLKept MSFT");
    expect(screen.getByTestId("check-funds").textContent).toContain("Bought GLDWaited SLV");
    expect(screen.getByTestId("check-momentum").textContent).toContain(
      "Checked 20 stocks. SPY above its 200-day average: it holds the week's top 3 (META, AVGO, NVDA).Kept META, AVGO, NVDA"
    );
  });

  it("shows nothing before any check has run", async () => {
    vi.mocked(apiFetch).mockImplementation(async () => new Response("Not found", { status: 404 }));
    const { container } = render(createElement(ChecksTimeline));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe("");
  });

  it("folds each check's full card away under the timeline, open on a tap, a tab each", () => {
    const tabs = [
      { id: "coins" as const, label: "Coins", node: createElement("p", null, "the coins card") },
      { id: "us" as const, label: "US", node: createElement("p", null, "the US card") },
    ];
    render(createElement(CheckDetails, { tabs }));
    const toggle = screen.getByRole("button", { name: "Each check in full" });
    const fold = screen.getByTestId("check-details");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(fold.className).not.toContain("nx-fold-open");
    // Kept in the page (it loads meanwhile) but out of reach while folded.
    expect(fold.textContent).toContain("the US card");
    expect(fold.hasAttribute("inert")).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(fold.className).toContain("nx-fold-open");
    expect(fold.hasAttribute("inert")).toBe(false);
    // Coins first; a tap on US shows its card alone.
    expect(screen.getByTestId("check-tab-coins").hidden).toBe(false);
    expect(screen.getByTestId("check-tab-us").hidden).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "US" }));
    expect(screen.getByRole("button", { name: "US" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("check-tab-coins").hidden).toBe(true);
    expect(screen.getByTestId("check-tab-us").hidden).toBe(false);
  });

  it("remembers the check last picked on this device", () => {
    localStorage.setItem("nx-check-tab", "us");
    const tabs = [
      { id: "coins" as const, label: "Coins", node: createElement("p", null, "the coins card") },
      { id: "us" as const, label: "US", node: createElement("p", null, "the US card") },
    ];
    const { unmount } = render(createElement(CheckDetails, { tabs }));
    expect(screen.getByTestId("check-tab-us").hidden).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Coins" }));
    expect(localStorage.getItem("nx-check-tab")).toBe("coins");
    unmount();
    localStorage.setItem("nx-check-tab", "nonsense");
    render(createElement(CheckDetails, { tabs }));
    expect(screen.getByTestId("check-tab-coins").hidden).toBe(false);
    localStorage.removeItem("nx-check-tab");
  });
});

describe("the Lab's title", () => {
  it("says Paper or Live", async () => {
    const { LedgerLab } = await import("../../src/components/ledger/LedgerLab");
    const props = { promotedLabModel: null, onPromote: vi.fn(), onRevert: vi.fn() };
    const { rerender } = render(createElement(LedgerLab, props));
    expect(screen.getByRole("banner").textContent).toBe("LabPaper");
    rerender(createElement(LedgerLab, { ...props, isLive: true }));
    expect(screen.getByRole("banner").textContent).toBe("LabLive");
  });
});
