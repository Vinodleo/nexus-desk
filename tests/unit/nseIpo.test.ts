import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bidsFrom, listingFrom, nseDay, nseIpoSource, priceBand, _resetNseIpo } from "../../server/nseIpo";

// NSE's IPO pages as the tracker reads them: dates, price bands, the issue
// lists (SME left out) and the table of how many times over each group bid.

const current = [
  {
    symbol: "HOTCO", companyName: "Hot Co Limited", series: "EQ", issueStartDate: "19-Oct-2026", issueEndDate: "21-Oct-2026",
    status: "Active", issuePrice: "Rs.95 to Rs.100", lotSize: "150", noOfTime: "5.20",
  },
  { symbol: "TINYCO", companyName: "Tiny Co Ltd", series: "SME", issueStartDate: "20-Oct-2026", issueEndDate: "22-Oct-2026", issuePrice: "Rs.50" },
];
const upcoming = [
  { symbol: "NEXTCO", companyName: "Next Co Limited", series: "EQ", issueStartDate: "27-Oct-2026", issueEndDate: "29-Oct-2026", issuePrice: "", lotSize: null },
];
const categories = {
  dataList: [
    { srNo: "1", category: "Qualified Institutional Buyers (QIBs)", noOfShareOffered: "1,000", noOfSharesBid: "45,000", noOfTotalMeant: "45.00" },
    { srNo: "2", category: "Non Institutional Investors (NIIs)", noOfTotalMeant: "18.40" },
    { srNo: "3", category: "Retail Individual Investors (RIIs)", noOfTotalMeant: "12.10" },
    { srNo: "", category: "Total", noOfTotalMeant: "22.30" },
  ],
  updateTime: "21-Oct-2026 14:00:00",
};

describe("NSE's dates and prices", () => {
  it("reads its dates and price bands", () => {
    expect(nseDay("21-Oct-2026")).toBe("2026-10-21");
    expect(nseDay("5-Jan-2027 17:00:00")).toBe("2027-01-05");
    expect(nseDay("")).toBeNull();
    expect(priceBand("Rs.95 to Rs.100")).toEqual({ low: 95, high: 100 });
    expect(priceBand("Rs.1,050 - Rs.1,105")).toEqual({ low: 1050, high: 1105 });
    expect(priceBand("Rs.100")).toEqual({ low: 100, high: 100 });
    expect(priceBand("")).toEqual({ low: null, high: null });
  });
});

describe("the issue lists", () => {
  it("reads a main-board issue and leaves SME ones out", () => {
    expect(listingFrom(current[0])).toEqual({
      symbol: "HOTCO", name: "Hot Co", opens: "2026-10-19", closes: "2026-10-21", priceLow: 95, priceHigh: 100, lotSize: 150, times: 5.2,
    });
    expect(listingFrom(current[1])).toBeNull();
    // Coming up, its price not set yet.
    expect(listingFrom(upcoming[0])).toMatchObject({ symbol: "NEXTCO", priceLow: null, priceHigh: null, lotSize: null });
    expect(listingFrom({ symbol: "X", issueStartDate: "soon" })).toBeNull();
  });

  it("reads how many times over each group bid", () => {
    expect(bidsFrom(categories, 5)).toEqual({ qib: 45, nii: 18.4, retail: 12.1, total: 22.3, at: 5 });
    expect(bidsFrom({ dataList: [] }, 5)).toBeNull();
  });
});

describe("reading NSE", () => {
  let calls: { url: string; cookie?: string }[];
  beforeEach(() => {
    _resetNseIpo();
    calls = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  const page = () => new Response("<html></html>", { status: 200, headers: [["set-cookie", "nsit=abc; Path=/"], ["set-cookie", "nseappid=xyz; Path=/"]] });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("takes the home page's cookies first, then the lists and the bids", async () => {
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const cookie = (init?.headers as Record<string, string> | undefined)?.Cookie;
      calls.push({ url, cookie });
      if (url.includes("/api/ipo-current-issue")) return json(current);
      if (url.includes("/api/all-upcoming-issues")) return json(upcoming);
      if (url.includes("/api/ipo-active-category")) return json(categories);
      return page();
    });
    const issues = await nseIpoSource.issues(0);
    expect(issues.map((i) => i.symbol)).toEqual(["HOTCO", "NEXTCO"]);
    expect(calls[0].url).toBe("https://www.nseindia.com/market-data/all-upcoming-issues-ipo");
    expect(calls.filter((c) => c.url.includes("/api/")).every((c) => c.cookie === "nsit=abc; nseappid=xyz")).toBe(true);
    expect(await nseIpoSource.bids("HOTCO", 0)).toMatchObject({ qib: 45, total: 22.3 });
    // The cookies are kept: one home-page visit.
    expect(calls.filter((c) => !c.url.includes("/api/"))).toHaveLength(1);
  });

  it("takes fresh cookies once when NSE refuses, and says when its format can't be read", async () => {
    let refused = false;
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push({ url });
      if (url.includes("/api/ipo-current-issue")) {
        if (!refused) {
          refused = true;
          return json({}, 403);
        }
        return json([{ symbol: "HOTCO", series: "EQ", startDate: "19-Oct-2026" }]);
      }
      if (url.includes("/api/")) return json([]);
      return page();
    });
    await expect(nseIpoSource.issues(0)).rejects.toThrow("NSE listed 1 main-board issues in a form the desk can't read");
    expect(calls.filter((c) => !c.url.includes("/api/"))).toHaveLength(2);
  });

  it("says when the home page sets no cookies", async () => {
    vi.stubGlobal("fetch", async () => new Response("Access denied", { status: 403 }));
    await expect(nseIpoSource.issues(0)).rejects.toThrow("NSE's site answered 403 without cookies");
  });
});
