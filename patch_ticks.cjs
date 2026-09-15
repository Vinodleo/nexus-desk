const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf-8');

const tickEffect = `
  // Live Ticking Price Feed (WebSocket Simulation)
  useEffect(() => {
    if (activePositions.length === 0) return;

    const interval = setInterval(() => {
      setActivePositions((prev) => 
        prev.map((pos) => {
          // Random walk simulation (slightly drift current price)
          const volatility = 0.0005; // 0.05% fluctuation per tick
          const drift = 1 + (Math.random() - 0.5) * volatility;
          const newPrice = pos.currentPrice * drift;
          
          const isLong = pos.direction === "LONG";
          const pnl = (newPrice - pos.entryPrice) * pos.quantity * (isLong ? 1 : -1);
          const pnlPercent = (pnl / pos.moneyPlaced) * 100;
          
          return {
            ...pos,
            currentPrice: newPrice,
            unrealizedPnl: pnl,
            unrealizedPnlPercent: pnlPercent,
          };
        })
      );
    }, 1000);

    return () => clearInterval(interval);
  }, [activePositions.length]); // Re-bind only if number of positions changes to avoid infinite loop from dependency
`;

code = code.replace(
  '  // Persist closed trades to LocalStorage',
  tickEffect + '\n  // Persist closed trades to LocalStorage'
);

fs.writeFileSync('src/App.tsx', code);
