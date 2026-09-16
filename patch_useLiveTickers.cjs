const fs = require('fs');
let content = fs.readFileSync('src/hooks/useLiveTickers.ts', 'utf-8');

const newHook = `
import { useState, useEffect, useRef } from "react";
import { liveMarketStream } from "../services/liveMarketStreamService";

export interface TickerInfo {
  symbol: string;
  price: number;
  changePercent: number;
  direction: 'up' | 'down' | 'none';
}

export function useLiveTickers() {
  const [tickers, setTickers] = useState<TickerInfo[]>([]);
  const prevPrices = useRef<Record<string, number>>({});

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
        
        const currentPrice = last.close;
        const previousPrice = prevPrices.current[sym] || currentPrice;
        
        let direction: 'up' | 'down' | 'none' = 'none';
        if (currentPrice > previousPrice) direction = 'up';
        else if (currentPrice < previousPrice) direction = 'down';
        
        prevPrices.current[sym] = currentPrice;

        return {
          symbol: sym,
          price: currentPrice,
          changePercent,
          direction
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
`;

fs.writeFileSync('src/hooks/useLiveTickers.ts', newHook);
console.log("Patched hook");
