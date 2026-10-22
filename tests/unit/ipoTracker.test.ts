import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpoBids, IpoSession } from "../../src/shared/ipo";
import type { IpoDeps, IpoListing } from "../../server/ipoTracker";
import type { PushMessage } from "../../server/push";

// The IPO tracker: the issues bidding now, the apply alert on the last day,
// the listing-day and later alerts for whoever got shares, and the rule's
// paper record.

let dir: string;
let ipo: typeof import("../../server/ipoTracker");

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-ipo-"));
  vi.stubEnv("NEXUS_DATA_DIR", dir);
  ipo = await import("../../server/ipoTracker");
});
afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

const ist = (s: string) => Date.parse(`${s}+05:30`);
const MIN = 60_000;

// Bidding Mon 19 to Wed 21 Oct 2026; allotment Thu 22; listing Mon 26.
const HOT: IpoListing = { symbol: "HOTCO", name: "Hot Co", opens: "2026-10-19", closes: "2026-10-21", priceLow: 95, priceHigh: 100, lotSize: 150 };
const COLD: IpoListing = { symbol: "COLDCO", name: "Cold Co", opens: "2026-10-19", closes: "2026-10-21", priceLow: 190, priceHigh: 200, lotSize: 75 };
const bids = (qib: number, total: number, at: number): IpoBids => ({ qib, nii: 10, retail: 12, total, at });

interface World {
  now: number;
  listings: IpoListing[];
  bids: Record<string, (now: number) => IpoBids | null>;
  quotes: Record<string, { open: number; low: number; ltp: number } | null>;
  sessions: Record<string, IpoSession[]>;
  everyone: PushMessage[];
  sent: { uid: string; message: PushMessage }[];
  listFails?: boolean;
}

let w: World;
const deps = (): IpoDeps => ({
  now: () => w.now,
  dir: () => dir,
  source: {
    issues: async () => {
      if (w.listFails) throw new Error("NSE's site answered 403 without cookies");
      return w.listings;
    },
    bids: async (symbol, now) => w.bids[symbol]?.(now) ?? null,
  },
  prices: {
    quote: async (symbol) => w.quotes[symbol] ?? null,
    // The sessions over by now: today's once the close is past.
    sessions: async (symbol, fromDay, now) => {
      const today = new Date(now + 5.5 * 60 * MIN).toISOString().slice(0, 10);
      const closed = now >= ist(`${today}T15:45:00`);
      return (w.sessions[symbol] ?? []).filter((s) => s.day >= fromDay && (s.day < today || (s.day === today && closed)));
    },
  },
  notifyAll: (message) => w.everyone.push(message),
  notify: (uid, message) => w.sent.push({ uid, message }),
});
const at = async (when: string) => {
  w.now = ist(when);
  await ipo.runIpoCheck(deps());
};

beforeEach(() => {
  fs.rmSync(path.join(dir, "ipo.json"), { force: true });
  ipo._resetIpoTracker();
  w = {
    now: 0,
    listings: [HOT, COLD],
    bids: { HOTCO: (now) => bids(45, 22, now), COLDCO: (now) => bids(3, 2.4, now) },
    quotes: {},
    sessions: {},
    everyone: [],
    sent: [],
  };
});

describe("while bidding", () => {
  it("lists the issues, reads their bids and says which fit the rule", async () => {
    await at("2026-10-20T11:00:00");
    const view = ipo.ipoView("u", w.now);
    expect(view.bidding.map((r) => [r.symbol, r.fits, r.lotCost])).toEqual([
      ["HOTCO", true, 15_000],
      ["COLDCO", false, 15_000],
    ]);
    expect(view.bidding[0].bids?.qib).toBe(45);
    expect(view.bidding[0].listsOn).toBe("2026-10-26");
    expect(view.bidding[0].allotmentOn).toBe("2026-10-22");
  });

  it("alerts everyone once on the last day from 2 pm, only for an issue that fits", async () => {
    await at("2026-10-20T15:00:00");
    await at("2026-10-21T13:30:00");
    expect(w.everyone).toEqual([]);
    await at("2026-10-21T14:05:00");
    expect(w.everyone).toHaveLength(1);
    expect(w.everyone[0].title).toBe("Apply today: Hot Co IPO");
    expect(w.everyone[0].body).toContain("Institutions bid 45×, the whole issue 22×");
    expect(w.everyone[0].body).toContain("One lot is ₹15,000 (150 shares at ₹100)");
    expect(w.everyone[0].body).toContain("by 5 pm. Allotment Thu 22 Oct, listing Mon 26 Oct.");
    await at("2026-10-21T14:20:00");
    expect(w.everyone).toHaveLength(1);
  });

  it("alerts when an issue comes to fit later on the last day, but not after 4:50 pm", async () => {
    w.bids.HOTCO = (now) => (now >= ist("2026-10-21T16:00:00") ? bids(45, 22, now) : bids(5, 4, now));
    await at("2026-10-21T14:05:00");
    expect(w.everyone).toEqual([]);
    await at("2026-10-21T16:05:00");
    expect(w.everyone.map((m) => m.title)).toEqual(["Apply today: Hot Co IPO"]);

    ipo._resetIpoTracker();
    w.everyone = [];
    await at("2026-10-21T16:55:00");
    expect(w.everyone).toEqual([]);
  });

  it("makes the rule's call once the last day's book has closed", async () => {
    await at("2026-10-21T15:00:00");
    expect(ipo._ipoState().ipos.map((i) => i.fit)).toEqual([null, null]);
    await at("2026-10-21T17:45:00");
    expect(ipo._ipoState().ipos.map((i) => [i.symbol, i.fit])).toEqual([
      ["HOTCO", true],
      ["COLDCO", false],
    ]);
    const view = ipo.ipoView("u", w.now);
    expect(view.bidding).toEqual([]);
    expect(view.recent.map((r) => r.symbol)).toEqual(["HOTCO", "COLDCO"]);
  });

  it("drops an issue never bid for, and shows NSE's refusal", async () => {
    w.bids.COLDCO = () => null;
    await at("2026-10-21T15:00:00");
    w.listFails = true;
    await at("2026-10-22T10:00:00");
    expect(ipo._ipoState().ipos.find((i) => i.symbol === "COLDCO")!.done).toBe(true);
    const view = ipo.ipoView("u", w.now);
    expect(view.recent.map((r) => r.symbol)).toEqual(["HOTCO"]);
    expect(view.lastError).toBe("NSE's site answered 403 without cookies");
  });

  it("shows issues opening later as coming up", async () => {
    w.listings = [...w.listings, { ...HOT, symbol: "NEXTCO", name: "Next Co", opens: "2026-10-27", closes: "2026-10-29" }];
    await at("2026-10-20T11:00:00");
    expect(ipo.ipoView("u", w.now).upcoming.map((r) => r.symbol)).toEqual(["NEXTCO"]);
  });
});

/** Bidding over and the rule's call made for HOTCO and COLDCO. */
async function closed(): Promise<void> {
  await at("2026-10-21T15:00:00");
  await at("2026-10-21T17:45:00");
}

describe("from listing day, for whoever got shares", () => {
  it("only takes 'I got shares' once bidding is over", async () => {
    await at("2026-10-20T11:00:00");
    expect(ipo.setHolding("u", "HOTCO", true, dir)).toBe(false);
    await closed();
    expect(ipo.setHolding("u", "HOTCO", true, dir)).toBe(true);
    expect(ipo.setHolding("u", "NOPE", true, dir)).toBe(false);
    expect(ipo.ipoView("u", w.now).recent.find((r) => r.symbol === "HOTCO")!.held).toBe(true);
    expect(ipo.ipoView("other", w.now).recent.find((r) => r.symbol === "HOTCO")!.held).toBe(false);
    expect(ipo.setHolding("u", "HOTCO", false, dir)).toBe(true);
    expect(ipo.ipoView("u", w.now).recent.find((r) => r.symbol === "HOTCO")!.held).toBe(false);
  });

  it("at a strong open says sell half; under the listing day's low later, sell the rest", async () => {
    await closed();
    ipo.setHolding("u", "HOTCO", true, dir);
    await at("2026-10-26T09:50:00");
    expect(w.sent).toEqual([]);
    w.quotes.HOTCO = { open: 130, low: 128, ltp: 133 };
    await at("2026-10-26T10:05:00");
    expect(w.sent.map((s) => [s.uid, s.message.title])).toEqual([["u", "Hot Co listed +30%: sell half"]]);
    expect(w.sent[0].message.body).toContain("opened at ₹130 against the ₹100 issue price");

    // After the close the day's session gives the stop: 125.
    w.sessions.HOTCO = [{ day: "2026-10-26", open: 130, high: 140, low: 125, close: 138 }];
    await at("2026-10-26T16:00:00");
    expect(ipo.ipoView("u", w.now).recent.find((r) => r.symbol === "HOTCO")!.plan!.stop).toBe(125);

    w.quotes.HOTCO = { open: 137, low: 126, ltp: 127 };
    await at("2026-10-27T11:00:00");
    expect(w.sent).toHaveLength(1);
    w.quotes.HOTCO = { open: 137, low: 122, ltp: 123 };
    await at("2026-10-27T11:15:00");
    expect(w.sent.map((s) => s.message.title)).toEqual(["Hot Co listed +30%: sell half", "Hot Co fell below its listing-day low: sell the rest"]);
    expect(w.sent[1].message.body).toBe("₹123 now under ₹125 (the listing day's low). Sell the rest.");
    await at("2026-10-27T11:30:00");
    expect(w.sent).toHaveLength(2);
  });

  it("at a weak open says sell it all, and nothing after", async () => {
    await closed();
    ipo.setHolding("u", "COLDCO", true, dir);
    w.quotes.COLDCO = { open: 204, low: 199, ltp: 201 };
    await at("2026-10-26T10:05:00");
    expect(w.sent.map((s) => s.message.title)).toEqual(["Cold Co listed +2%: sell it all"]);
    w.sessions.COLDCO = [{ day: "2026-10-26", open: 204, high: 210, low: 199, close: 205 }];
    await at("2026-10-26T16:00:00");
    w.quotes.COLDCO = { open: 190, low: 180, ltp: 181 };
    await at("2026-10-27T11:00:00");
    expect(w.sent).toHaveLength(1);
  });

  it("a week on, says sell the rest from 3 pm", async () => {
    await closed();
    ipo.setHolding("u", "HOTCO", true, dir);
    w.quotes.HOTCO = { open: 130, low: 128, ltp: 133 };
    await at("2026-10-26T10:05:00");
    w.sessions.HOTCO = [{ day: "2026-10-26", open: 130, high: 140, low: 125, close: 138 }];
    await at("2026-10-26T16:00:00");
    w.quotes.HOTCO = { open: 150, low: 148, ltp: 152 };
    await at("2026-11-02T14:45:00");
    expect(w.sent).toHaveLength(1);
    await at("2026-11-02T15:05:00");
    expect(w.sent[1].message.title).toBe("Hot Co: a week since listing, sell the rest");
    expect(w.sent[1].message.body).toBe("₹152 now, +52% on the ₹100 issue price. Sell the rest today.");
  });

  it("looks again when the day's candle comes after the close", async () => {
    await closed();
    w.quotes.HOTCO = { open: 130, low: 128, ltp: 133 };
    await at("2026-10-26T10:05:00");
    await at("2026-10-26T15:50:00");
    expect(ipo.ipoView("u", w.now).recent.find((r) => r.symbol === "HOTCO")!.plan).toBeNull();
    w.sessions.HOTCO = [{ day: "2026-10-26", open: 130, high: 140, low: 125, close: 138 }];
    await at("2026-10-26T16:05:00");
    expect(ipo.ipoView("u", w.now).recent.find((r) => r.symbol === "HOTCO")!.plan!.stop).toBe(125);
  });

  it("finds the listing day from the sessions when the server missed it", async () => {
    await closed();
    w.sessions.HOTCO = [
      { day: "2026-10-26", open: 130, high: 140, low: 125, close: 138 },
      { day: "2026-10-27", open: 137, high: 141, low: 131, close: 139 },
    ];
    w.quotes.HOTCO = { open: 138, low: 136, ltp: 140 };
    await at("2026-10-28T10:30:00");
    const row = ipo.ipoView("u", w.now).recent.find((r) => r.symbol === "HOTCO")!;
    expect(row.listedOn).toBe("2026-10-26");
    expect(row.open).toBe(130);
    expect(row.plan!.stop).toBe(125);
  });
});

describe("the rule's paper record", () => {
  it("keeps each listed issue's lot under the rule, picked against skipped", async () => {
    await closed();
    w.quotes = { HOTCO: { open: 130, low: 125, ltp: 133 }, COLDCO: { open: 204, low: 199, ltp: 201 } };
    await at("2026-10-26T10:05:00");
    w.sessions = {
      HOTCO: [
        { day: "2026-10-26", open: 130, high: 140, low: 125, close: 138 },
        { day: "2026-10-27", open: 137, high: 141, low: 120, close: 122 },
      ],
      COLDCO: [{ day: "2026-10-26", open: 204, high: 210, low: 199, close: 205 }],
    };
    await at("2026-10-27T16:00:00");
    const { record } = ipo.ipoView("u", w.now);
    expect(record.picked.count).toBe(1);
    expect(record.picked.won).toBe(1);
    expect(record.skipped.count).toBe(1);
    expect(record.rows.map((r) => [r.symbol, r.fit])).toEqual([
      ["HOTCO", true],
      ["COLDCO", false],
    ]);
    // Half at 130, the rest at the 125 stop, less the sale costs.
    expect(record.rows[0].rupees).toBeGreaterThan(75 * 30 + 75 * 25 - 200);
    expect(record.rows[0].rupees).toBeLessThan(75 * 30 + 75 * 25);
    // Finished and no one holding: done, kept for the record.
    expect(ipo._ipoState().ipos.every((i) => i.done)).toBe(true);
  });

  it("is kept across a restart", async () => {
    await closed();
    ipo._resetIpoTracker(dir);
    expect(ipo._ipoState().ipos.map((i) => [i.symbol, i.fit])).toEqual([
      ["HOTCO", true],
      ["COLDCO", false],
    ]);
  });
});

describe("Angel One's daily candles as sessions", () => {
  it("counts today's only once the close is past", () => {
    const rows = [
      ["2026-10-26T00:00:00+05:30", 130, 140, 125, 138, 1000],
      ["2026-10-27T00:00:00+05:30", 137, 141, 131, 139, 900],
    ];
    expect(ipo.completedSessions(rows, ist("2026-10-27T14:00:00")).map((s) => s.day)).toEqual(["2026-10-26"]);
    expect(ipo.completedSessions(rows, ist("2026-10-27T15:50:00")).map((s) => s.day)).toEqual(["2026-10-26", "2026-10-27"]);
    expect(ipo.completedSessions(rows, ist("2026-10-27T15:50:00"))[0]).toEqual({ day: "2026-10-26", open: 130, high: 140, low: 125, close: 138 });
  });
});

