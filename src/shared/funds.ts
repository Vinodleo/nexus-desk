import { isUsSymbol, usTicker } from "./usMarket";

// Funds across kinds of assets, all listed in the US since before 2015: gold,
// silver and gold miners; long, middle and inflation-linked US government
// bonds, company bonds and high-yield ones; commodities and oil; the dollar;
// US property; shares outside the US and in emerging markets; the Nasdaq 100
// and small US companies. The stocks' replay since 2016 tests the classic
// strategies on them (server/history/stocksLong.ts), and breakout 55/20
// paper-trades them (server/scanner/usBreakout.ts) on slots of its own.

export const FUNDS = ["GLD", "SLV", "GDX", "TLT", "IEF", "TIP", "LQD", "HYG", "DBC", "USO", "UUP", "VNQ", "EFA", "EEM", "QQQ", "IWM"];

/** Whether a symbol is one of the funds ("GLD.US"). */
export const isFundSymbol = (symbol: string | undefined): boolean => !!symbol && isUsSymbol(symbol) && FUNDS.includes(usTicker(symbol));
