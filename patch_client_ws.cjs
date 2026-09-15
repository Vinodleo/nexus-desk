const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf-8');

const clientWsEffect = `
  // Live WebSocket Engine for Real Binance Data
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  
  useEffect(() => {
    // Determine the WS protocol and host based on current window location
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = \`\${protocol}//\${window.location.host}\`;
    
    const ws = new WebSocket(wsUrl);
    
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'TICK') {
          const newPrices = msg.data;
          setLivePrices(newPrices);
          
          // Update active positions based on REAL LIVE PRICES
          setActivePositions((prev) => {
            if (prev.length === 0) return prev;
            let changed = false;
            
            const nextPositions = prev.map((pos) => {
              // Convert INR symbols to USDT logic temporarily for live crypto test
              // If position is BTC/INR, look for BTC/USDT price.
              const baseAsset = pos.symbol.split('/')[0];
              const binanceSymbol = \`\${baseAsset}/USDT\`;
              const livePrice = newPrices[binanceSymbol];
              
              if (!livePrice) return pos; // No tick data yet
              
              // We'll treat the crypto USDT price as INR for display purposes here 
              // (In reality we'd multiply by USD/INR rate, approx 83)
              const realINRPrice = livePrice * 83.5; 
              
              const isLong = pos.direction === "LONG";
              const pnl = (realINRPrice - pos.entryPrice) * pos.quantity * (isLong ? 1 : -1);
              const pnlPercent = (pnl / pos.moneyPlaced) * 100;
              
              // To avoid infinite react loops, only update if the price actually moved
              if (Math.abs(realINRPrice - pos.currentPrice) > 0.0001) {
                changed = true;
              }
              
              return {
                ...pos,
                currentPrice: realINRPrice,
                unrealizedPnl: pnl,
                unrealizedPnlPercent: pnlPercent,
              };
            });
            
            return changed ? nextPositions : prev;
          });
        }
      } catch (err) {
        console.error("WS parse error", err);
      }
    };
    
    return () => {
      ws.close();
    };
  }, []);
`;

// Replace the old tick effect with the real WebSocket one
const oldTickEffectStart = '// Live Ticking Price Feed (WebSocket Simulation)';
const oldTickEffectEnd = '  }, [activePositions.length]); // Re-bind only if number of positions changes to avoid infinite loop from dependency';
const oldTickRegex = /\/\/ Live Ticking Price Feed \(WebSocket Simulation\)[\s\S]*?\}, \[activePositions\.length\]\); \/\/ Re-bind only if number of positions changes to avoid infinite loop from dependency/;

code = code.replace(oldTickRegex, clientWsEffect);

fs.writeFileSync('src/App.tsx', code);
