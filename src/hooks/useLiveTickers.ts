import { useState, useEffect, useRef } from "react";
import { liveMarketStream } from "../services/liveMarketStreamService";

export interface TickerInfo {
  symbol: string;
  price: number;
  /** 24-hour change in %, from CoinDCX's ticker (0 until it loads). */
  changePercent: number;
  direction: "up" | "down" | "none";
}

/** Last traded price and 24-hour change for each tracked symbol. */
export function useLiveTickers() {
  const [tickers, setTickers] = useState<TickerInfo[]>([]);
  const prevPrices = useRef<Record<string, number>>({});

  useEffect(() => {
    const updateTickers = () => {
      const updated: TickerInfo[] = [];
      for (const sym of liveMarketStream.getActiveSymbols()) {
        const price = liveMarketStream.getLastPrice(sym);
        if (!price) continue;
        const previous = prevPrices.current[sym] ?? price;
        prevPrices.current[sym] = price;
        updated.push({
          symbol: sym,
          price,
          changePercent: liveMarketStream.dailyChanges.get(sym) ?? 0,
          direction: price > previous ? "up" : price < previous ? "down" : "none",
        });
      }
      setTickers(updated);
    };

    updateTickers();
    return liveMarketStream.subscribe(updateTickers);
  }, []);

  return tickers;
}
