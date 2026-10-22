// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipoPlan, ipoRecord } from "../../src/shared/ipo";

// The Lab's IPO card: bidding now against the rule's bar, waiting to list or
// just listed with what the rule says and "I got shares", coming up, and the
// rule's paper record.

vi.mock("../../src/services/apiClient", () => ({ apiFetch: vi.fn(), authenticateSocket: vi.fn() }));
const { apiFetch } = await import("../../src/services/apiClient");
const { IpoCard, planText } = await import("../../src/components/ledger/IpoCard");

const row = (over: Record<string, unknown>) => ({
  symbol: "HOTCO", name: "Hot Co", opens: "2026-10-19", closes: "2026-10-21", priceLow: 95, priceHigh: 100, lotSize: 150, lotCost: 15_000,
  bids: { qib: 45, nii: 18, retail: 12, total: 22, at: 0 }, upiCutoff: 19 * 60, fits: true, fit: null, allotmentOn: "2026-10-22", listsOn: "2026-10-26",
  listedOn: null, open: null, openPct: null, plan: null, held: false, ...over,
});
const listed = ipoPlan(200, 75, [
  { day: "2026-10-12", open: 204, high: 210, low: 199, close: 205 },
])!;
const view = {
  success: true,
  rule: { qib: 20, total: 10 },
  bidding: [row({}), row({ symbol: "COLDCO", name: "Cold Co", fits: false, bids: { qib: 3, nii: 1, retail: 4, total: 2.4, at: 0 } })],
  upcoming: [row({ symbol: "NEXTCO", name: "Next Co", opens: "2026-10-27", closes: "2026-10-29", bids: null, fits: false })],
  recent: [
    row({ symbol: "WAITCO", name: "Wait Co", closes: "2026-10-20", fit: true, allotmentOn: "2026-10-21", listsOn: "2026-10-23" }),
    row({ symbol: "OLDCO", name: "Old Co", fit: false, priceHigh: 200, listedOn: "2026-10-12", open: 204, openPct: 0.02, plan: listed }),
  ],
  record: {
    picked: ipoRecord([{ rupees: 4000, pct: 0.27 }]),
    skipped: ipoRecord([listed.result!]),
    rows: [{ symbol: "OLDCO", name: "Old Co", listedOn: "2026-10-12", fit: false, pct: listed.result!.pct, rupees: listed.result!.rupees }],
  },
  lastCheckAt: Date.parse("2026-10-21T14:05:00+05:30"),
  lastError: null,
  nextAt: 0,
};

beforeEach(() => {
  // Wednesday 21 Oct 2026, 2:10 pm in India: Hot Co's last bidding day.
  vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-10-21T14:10:00+05:30") });
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/ipos/held") return new Response(JSON.stringify({ ...view, success: true, sent: JSON.parse(String(init?.body)) }));
    return new Response(JSON.stringify(view));
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the IPO card", () => {
  it("shows the issues bidding now against the rule's bar, with the last day's call to apply", async () => {
    render(createElement(IpoCard));
    const hot = await screen.findByTestId("ipo-bidding-HOTCO");
    expect(hot.textContent).toContain("Fits the rule");
    expect(hot.textContent).toContain("Closes today, 7 pm · ₹95–100 · lot ₹15,000");
    expect(hot.textContent).toContain("Institutions45×");
    expect(hot.textContent).toContain("Whole issue22×");
    expect(hot.textContent).toContain("Apply and approve the UPI request by 7 pm today.");
    const cold = screen.getByTestId("ipo-bidding-COLDCO");
    expect(cold.textContent).toContain("Not yet");
    expect(cold.textContent).toContain("2.4×");
    expect(cold.textContent).not.toContain("Apply and approve");
    expect(screen.getByTestId("ipo-upcoming-NEXTCO").textContent).toContain("Tue 27 Oct to Thu 29 Oct");
  });

  it("says when an issue lists and what the rule did, and takes 'I got shares'", async () => {
    render(createElement(IpoCard));
    expect((await screen.findByTestId("ipo-plan-WAITCO")).textContent).toBe("Allotment Wed 21 Oct, listing Fri 23 Oct.");
    expect(screen.getByTestId("ipo-plan-OLDCO").textContent).toMatch(/^Listed Mon 12 Oct at ₹204 \(\+2%\)\. The rule sold all at ₹204: \+₹\d+ a lot \(\+\d+%\)\.$/);
    // A finished one has nothing to hold.
    expect(screen.getByTestId("ipo-recent-OLDCO").querySelector("button")).toBeNull();

    const button = screen.getByRole("button", { name: "I got shares" });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("button", { name: "✓ I got shares: alerts on" }).getAttribute("aria-pressed")).toBe("true"));
    const [, init] = vi.mocked(apiFetch).mock.calls.find(([p]) => p === "/api/ipos/held")!;
    expect(JSON.parse(String(init!.body))).toEqual({ symbol: "WAITCO", held: true });
  });

  it("shows the rule's paper record, picked against skipped", async () => {
    render(createElement(IpoCard));
    expect((await screen.findByTestId("ipo-record-picked")).textContent).toBe("Picked: 1 listed · 1 made money+27% · +₹4,000 a lot");
    expect(screen.getByTestId("ipo-record-skipped").textContent).toContain("Skipped: 1 listed");
  });

  it("says when NSE couldn't be read", async () => {
    vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({ ...view, lastError: "NSE's site answered 403 without cookies" })));
    render(createElement(IpoCard));
    expect((await screen.findByTestId("ipo-error")).textContent).toBe("Couldn't read NSE: NSE's site answered 403 without cookies");
  });
});

describe("the rule's line for a listing", () => {
  it("says what's left to do while the rest is held", () => {
    const plan = ipoPlan(100, 150, [{ day: "2026-10-26", open: 130, high: 140, low: 125, close: 138 }])!;
    const r = row({ listedOn: "2026-10-26", open: 130, openPct: 0.3, plan, fit: true });
    expect(planText(r as any, "2026-10-27")).toBe("Listed Mon 26 Oct at ₹130 (+30%). Half sold at the open; the rest is sold under ₹125 or on Mon 2 Nov.");
    // Listing day before its close: from the open alone.
    expect(planText({ ...r, plan: null } as any, "2026-10-26")).toBe("Listed Mon 26 Oct at ₹130 (+30%). Sell half; keep the rest above today's low.");
    expect(planText(row({ fit: true }) as any, "2026-10-23")).toBe("Listing Mon 26 Oct, trading from 10 am.");
  });
});
