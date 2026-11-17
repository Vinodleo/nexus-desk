import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bidsFrom, clockMinutes, companyKey, detailFrom, listedShares, listingFrom, nseDay, nseIpoSource, priceBand, symbolForName, _resetNseIpo } from "../../server/nseIpo";

// NSE's IPO pages as the tracker reads them: dates, price bands, the issue
// lists (SME left out), the table of how many times over each group bid,
// and an issue's lot and UPI cutoff. The replies are NSE's own from 22 Oct
// 2026 (two issues bidding), trimmed.

const nse = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/nse_ipo_2026-10-22.json"), "utf8"));
const current: any[] = [...nse.current, { symbol: "TINYCO", companyName: "Tiny Co Ltd", series: "SME", issueStartDate: "20-Oct-2026", issueEndDate: "22-Oct-2026", issuePrice: "Rs.50" }];
const upcoming: any[] = nse.upcoming;
const categories = nse.activeCategory;

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
    expect(listingFrom(current[1])).toEqual({
      symbol: "JPL", name: "Jio Platforms", opens: "2026-10-21", closes: "2026-10-23", priceLow: 1065, priceHigh: 1119, lotSize: null, times: 2.3312991599371453,
    });
    expect(listingFrom(current[2])).toBeNull();
    // The upcoming list carries the issues bidding now too, without the bids.
    expect(listingFrom(upcoming[0])).toMatchObject({ symbol: "PARASHLTH", name: "Paras Healthcare", priceLow: 660, priceHigh: 693, times: null });
    expect(listingFrom({ symbol: "X", issueStartDate: "soon" })).toBeNull();
  });

  it("reads how many times over each group bid, from the group's own row", () => {
    // "Individuals(Other than RIIs)" comes before the retail row, with no figure of its own.
    expect(bidsFrom(categories, 5)).toEqual({ qib: 9.686279295754126, nii: 3.7655418013037827, retail: 1.2479737515738236, total: 4.005566114675352, at: 5 });
    expect(bidsFrom({ dataList: [] }, 5)).toBeNull();
  });

  it("reads an issue's lot and the last day's UPI cutoff from its page", () => {
    expect(detailFrom(nse.detail)).toEqual({ lotSize: 12, upiCutoff: 19 * 60 });
    expect(detailFrom({})).toEqual({ lotSize: null, upiCutoff: null });
    expect(clockMinutes("23-Oct-2026 (upto 5:30 pm)")).toBe(17 * 60 + 30);
    expect(clockMinutes("12 PM")).toBe(12 * 60);
    expect(clockMinutes("soon")).toBeNull();
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
      if (url.includes("/api/ipo-detail?symbol=JPL&series=EQ")) return json(nse.detail);
      return page();
    });
    const issues = await nseIpoSource.issues(0);
    expect(issues.map((i) => i.symbol)).toEqual(["PARASHLTH", "JPL"]);
    expect(calls[0].url).toBe("https://www.nseindia.com/market-data/all-upcoming-issues-ipo");
    expect(calls.filter((c) => c.url.includes("/api/")).every((c) => c.cookie === "nsit=abc; nseappid=xyz")).toBe(true);
    expect(await nseIpoSource.bids("JPL", 0)).toMatchObject({ qib: 9.686279295754126, total: 4.005566114675352 });
    expect(await nseIpoSource.detail("JPL", 0)).toEqual({ lotSize: 12, upiCutoff: 19 * 60 });
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

// NSE's list of listed shares (EQUITY_L.csv, its header and rows' form): an
// issue doesn't always trade under the symbol it was bid for. M. K. Sons Fine
// Jewels bid as MKSONS and listed on 4 Nov 2026 as MKJEWELS.
const EQUITY_L = [
  "\uFEFFSYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE",
  "20MICRONS,20 Microns Limited,EQ,06-OCT-2008,5,1,INE144J01027,5",
  "BCSSL,Bombay Coated & Special Steels Limited,EQ,05-NOV-2026,10,1,INE0ABC01011,10",
  "MKJEWELS,M.K. Sons Fine Jewels Limited,BE,04-NOV-2026,10,1,INE0XYZ01019,10",
  'OLDJEWEL,"M.K. Sons Fine Jewels, Limited",EQ,12-MAR-2001,10,1,INE111A01011,10',
  "",
].join("\r\n");

describe("NSE's list of listed shares", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the list and finds a newly listed issue by its name", () => {
    const shares = listedShares(EQUITY_L);
    expect(shares[0]).toEqual({ symbol: "20MICRONS", name: "20 Microns Limited", listedOn: "2008-10-06" });
    expect(shares[3]).toEqual({ symbol: "OLDJEWEL", name: "M.K. Sons Fine Jewels, Limited", listedOn: "2001-03-12" });
    expect(companyKey("M. K. Sons Fine Jewels")).toBe(companyKey("M.K. Sons Fine Jewels Limited"));
    expect(companyKey("Bombay Coated and Special Steels")).toBe(companyKey("Bombay Coated & Special Steels Ltd."));
    // Only shares listed since bidding opened: not an older company of the same name.
    expect(symbolForName(shares, "M. K. Sons Fine Jewels", "2026-10-28")).toBe("MKJEWELS");
    expect(symbolForName(shares, "Bombay Coated and Special Steels", "2026-10-29")).toBe("BCSSL");
    expect(symbolForName(shares, "M. K. Sons Fine Jewels", "2026-11-05")).toBeNull();
    expect(symbolForName(shares, "Not Listed Yet", "2026-10-28")).toBeNull();
    expect(() => listedShares("<html>Access denied</html>")).toThrow("NSE's list of listed shares came in a form the desk can't read");
  });

  it("reads it from NSE's archive at most once an hour", async () => {
    _resetNseIpo();
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(EQUITY_L, { status: 200 });
    });
    expect(await nseIpoSource.listedSymbol("M. K. Sons Fine Jewels", "2026-10-28", 0)).toBe("MKJEWELS");
    expect(await nseIpoSource.listedSymbol("Bombay Coated and Special Steels", "2026-10-29", 30 * 60_000)).toBe("BCSSL");
    expect(urls).toEqual(["https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv"]);
    await nseIpoSource.listedSymbol("M. K. Sons Fine Jewels", "2026-10-28", 61 * 60_000);
    expect(urls).toHaveLength(2);
    vi.stubGlobal("fetch", async () => new Response("Access denied", { status: 403 }));
    await expect(nseIpoSource.listedSymbol("X", "2026-10-28", 200 * 60_000)).rejects.toThrow("NSE's list of listed shares: HTTP 403");
  });
});
