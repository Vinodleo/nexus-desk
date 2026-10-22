import { describe, expect, it } from "vitest";
import {
  IPO_RULE,
  addWeekdays,
  allotmentDay,
  dayLabel,
  expectedListing,
  fitsIpoRule,
  holderStep,
  ipoPlan,
  ipoRecord,
  ipoSaleCosts,
  listingOpen,
  type IpoSession,
} from "../../src/shared/ipo";

// The IPO rule: apply when the institutions bid many times over; on listing
// day sell half at a strong open (all on a weak one); keep the rest a week at
// most, sold below the listing day's low.

const bids = (qib: number | null, total: number | null) => ({ qib, nii: 5, retail: 8, total, at: 0 });
const session = (day: string, open: number, high: number, low: number, close: number): IpoSession => ({ day, open, high, low, close });

describe("which issues the rule picks", () => {
  it("needs the institutions and the whole issue bid many times over", () => {
    expect(fitsIpoRule(bids(IPO_RULE.qib, IPO_RULE.total))).toBe(true);
    expect(fitsIpoRule(bids(150, 60))).toBe(true);
    // Institutions keen but the issue as a whole not.
    expect(fitsIpoRule(bids(40, 6))).toBe(false);
    // The issue bid many times over, mostly by others.
    expect(fitsIpoRule(bids(8, 30))).toBe(false);
    expect(fitsIpoRule(bids(null, 30))).toBe(false);
    expect(fitsIpoRule(null)).toBe(false);
  });
});

describe("the issue's days", () => {
  it("counts allotment and listing in working days after bidding closes (T+1, T+3)", () => {
    // Closes Wednesday 21 Oct 2026: allotted Thursday, lists Monday.
    expect(allotmentDay("2026-10-21")).toBe("2026-10-22");
    expect(expectedListing("2026-10-21")).toBe("2026-10-26");
    // Closes Friday: allotted Monday, lists Wednesday.
    expect(expectedListing("2026-10-23")).toBe("2026-10-28");
    expect(addWeekdays("2026-10-23", 1)).toBe("2026-10-26");
    expect(dayLabel("2026-10-26")).toBe("Mon 26 Oct");
  });
});

describe("the rule on one lot", () => {
  it("sells it all at a weak open", () => {
    const plan = ipoPlan(100, 150, [session("2026-10-26", 104, 110, 101, 108)])!;
    expect(plan.strong).toBe(false);
    expect(plan.openPct).toBeCloseTo(0.04, 9);
    expect(plan.sales).toEqual([{ day: "2026-10-26", price: 104, shares: 150, why: "weak-open" }]);
    expect(plan.held).toBe(0);
    expect(plan.stop).toBeNull();
    const costs = ipoSaleCosts(150 * 104);
    expect(plan.result!.rupees).toBeCloseTo(150 * 4 - costs, 9);
    expect(plan.result!.pct).toBeCloseTo((150 * 4 - costs) / 15_000, 9);
  });

  it("sells half at a strong open and the rest when a later session goes under the listing day's low", () => {
    const plan = ipoPlan(100, 150, [
      session("2026-10-26", 130, 140, 125, 138),
      session("2026-10-27", 137, 145, 131, 141),
      session("2026-10-28", 139, 140, 120, 122),
      session("2026-10-29", 121, 124, 118, 119),
    ])!;
    expect(plan.strong).toBe(true);
    expect(plan.stop).toBe(125);
    expect(plan.sales).toEqual([
      { day: "2026-10-26", price: 130, shares: 75, why: "open" },
      { day: "2026-10-28", price: 125, shares: 75, why: "stop" },
    ]);
    expect(plan.held).toBe(0);
    expect(plan.result!.rupees).toBeCloseTo(75 * 30 + 75 * 25 - ipoSaleCosts(75 * 130) - ipoSaleCosts(75 * 125), 9);
  });

  it("sells the rest at the open when a session opens under the stop (a gap)", () => {
    const plan = ipoPlan(100, 151, [session("2026-10-26", 130, 140, 125, 138), session("2026-10-27", 118, 121, 115, 116)])!;
    // An odd lot: half rounded down at the open.
    expect(plan.sales.map((s) => [s.shares, s.price, s.why])).toEqual([
      [75, 130, "open"],
      [76, 118, "stop"],
    ]);
  });

  it("keeps the rest until a week on, then sells it at that session's close", () => {
    const rising = ["2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-11-02"].map((d, k) => session(d, 140 + k, 150 + k, 136 + k, 145 + k));
    const held = ipoPlan(100, 150, [session("2026-10-26", 130, 140, 125, 138), ...rising])!;
    expect(held.sellBy).toBe("2026-11-02");
    // Up to Friday the rest is still held.
    const sofar = ipoPlan(100, 150, [session("2026-10-26", 130, 140, 125, 138), ...rising.slice(0, 4)])!;
    expect(sofar.held).toBe(75);
    expect(sofar.result).toBeNull();
    // Monday 2 Nov is a week on: sold at its close.
    expect(held.sales[1]).toEqual({ day: "2026-11-02", price: 149, shares: 75, why: "week" });
    expect(held.result).not.toBeNull();
  });

  it("waits for the listing day's session, and needs a price and a lot", () => {
    expect(ipoPlan(100, 150, [])).toBeNull();
    expect(ipoPlan(0, 150, [session("2026-10-26", 130, 140, 125, 138)])).toBeNull();
  });
});

describe("what a holder should do now", () => {
  const base = { issuePrice: 100, listedOn: "2026-10-26", minutes: 11 * 60 };
  it("on listing day: sell half at a strong open, all at a weak one", () => {
    expect(holderStep({ ...base, open: null, stop: null, listedOn: null, today: "2026-10-26", ltp: null })).toBe("wait");
    expect(holderStep({ ...base, open: 130, stop: null, today: "2026-10-26", ltp: 131 })).toBe("sell-half");
    expect(holderStep({ ...base, open: 103, stop: null, today: "2026-10-26", ltp: 104 })).toBe("sell-all");
    expect(listingOpen(100, 110).strong).toBe(true);
  });

  it("after it: hold above the listing day's low, sell the rest under it or a week on", () => {
    expect(holderStep({ ...base, open: 130, stop: 125, today: "2026-10-28", ltp: 127 })).toBe("hold");
    expect(holderStep({ ...base, open: 130, stop: 125, today: "2026-10-28", ltp: 124 })).toBe("sell-rest-stop");
    expect(holderStep({ ...base, open: 130, stop: 125, today: "2026-11-02", ltp: 150 })).toBe("sell-rest-week");
    expect(holderStep({ ...base, open: 103, stop: 101, today: "2026-10-27", ltp: 110 })).toBe("done");
  });
});

describe("the paper record", () => {
  it("averages each lot's result and counts the ones that made money", () => {
    const r = ipoRecord([{ rupees: 3000, pct: 0.2 }, { rupees: -1000, pct: -0.05 }]);
    expect(r).toMatchObject({ count: 2, won: 1, avgRupees: 1000 });
    expect(r.avgPct).toBeCloseTo(0.075, 9);
    expect(ipoRecord([])).toEqual({ count: 0, won: 0, avgPct: 0, avgRupees: 0 });
  });

  it("charges a sale its delivery costs, the depository's charge included", () => {
    // ₹15,000 sold: ₹15 brokerage, ₹15 STT, ₹20 DP, small exchange charges, GST.
    const c = ipoSaleCosts(15_000);
    expect(c).toBeGreaterThan(50);
    expect(c).toBeLessThan(65);
    expect(ipoSaleCosts(0)).toBe(0);
  });
});
