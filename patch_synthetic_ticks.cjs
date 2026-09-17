const fs = require('fs');
let content = fs.readFileSync('server.ts', 'utf-8');

const injectionCode = `
  const syntheticSymbols = {
    "NIFTY": 24350.0,
    "BANKNIFTY": 51200.0,
    "RELIANCE": 2980.0,
    "TCS": 4250.0,
    "HDFCBANK": 1640.0,
    "GOLD/INR": 74250.0,
    "USD/INR": 85.35,
    "JUP/INR": 71.48,
    "AVAX/INR": 2652.0,
    "NEAR/INR": 459.0,
    "JUP": 71.48,
    "AVAX": 2652.0,
    "NEAR": 459.0
  };
  
  setInterval(() => {
    const updates = {};
    Object.keys(syntheticSymbols).forEach(sym => {
       if (!currentPrices[sym]) {
          const drift = (Math.random() - 0.49) * 0.001 * syntheticSymbols[sym];
          syntheticSymbols[sym] = Number((syntheticSymbols[sym] + drift).toFixed(4));
          updates[sym] = syntheticSymbols[sym];
       }
    });
    
    if (Object.keys(updates).length > 0 && globalWss) {
      globalWss.clients.forEach((client) => {
        if (client.readyState === 1) { // WebSocket.OPEN
          client.send(JSON.stringify({ type: 'TICK', data: updates }));
        }
      });
    }
  }, 2000);
`;

content = content.replace('startServer();', injectionCode + '\nstartServer();');
fs.writeFileSync('server.ts', content);
