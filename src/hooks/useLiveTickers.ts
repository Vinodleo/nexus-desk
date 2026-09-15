import { useState, useEffect } from "react";
import { liveMarketStream } from "../services/liveMarketStreamService";

export interface TickerInfo {
  symbol: string;
  price: number;
  changePercent: number;
}

export function useLiveTickers() {
  const [tickers, setTickers] = useState<TickerInfo[]>([]);

  useEffect(() => {
    const updateTickers = () => {
      const active = liveMarketStream.getActiveSymbols();
      const updated = active.map(sym => {
        const bars = liveMarketStream.getBars(sym);
        if (!bars || bars.length === 0) return null;
        
        const last = bars[bars.length - 1];
        // Compare with first bar of the day or just the first in our 120 window
        const first = bars[0];
        const changePercent = ((last.close - first.open) / first.open) * 100;
        
        return {
          symbol: sym,
          price: last.close,
          changePercent,
        };
      }).filter(Boolean) as TickerInfo[];

      setTickers(updated);
    };

    updateTickers();
    const unsubscribe = liveMarketStream.subscribe(updateTickers);
    return unsubscribe;
  }, []);

  return tickers;
}
