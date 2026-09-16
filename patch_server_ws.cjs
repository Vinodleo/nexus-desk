const fs = require('fs');
let serverContent = fs.readFileSync('server.ts', 'utf-8');

// Replace the polling block
const oldPollRegex = /\/\/ High-Frequency CoinDCX Polling[\s\S]*?\}, 1000\);/m;

const newWsRelay = `
  // High-Frequency CoinDCX Socket.io Relay
  const io = require("socket.io-client");
  const dcxSocket = io("wss://stream.coindcx.com", {
    transports: ["websocket"],
    reconnection: true
  });
  
  const currentPrices = {};

  dcxSocket.on("connect", () => {
    dcxSocket.emit("join", { channelName: "coindcx" });
    ['BTC', 'ETH', 'SOL', 'AVAX', 'NEAR'].forEach(sym => {
      dcxSocket.emit("join", { channelName: \`I-\${sym}_INR\` });
    });
  });

  dcxSocket.on("ticker", (data) => {
    try {
      const payload = typeof data === 'string' ? JSON.parse(data) : data;
      if (payload && payload.s && payload.c) {
        if (['BTCINR', 'ETHINR', 'SOLINR', 'AVAXINR', 'NEARINR'].includes(payload.s)) {
          const sym = payload.s.replace('INR', '/INR');
          currentPrices[sym] = parseFloat(payload.c);
          
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: 'TICK', data: { [sym]: currentPrices[sym] }, is24h: true }));
            }
          });
        }
      }
    } catch(e) {}
  });

  dcxSocket.on("new-trade", (data) => {
    try {
      const payload = typeof data === 'string' ? JSON.parse(data) : data;
      const innerData = typeof payload.data === 'string' ? JSON.parse(payload.data) : payload.data;
      if (innerData && innerData.s && innerData.p) {
        const sym = innerData.s.replace('INR', '/INR');
        currentPrices[sym] = parseFloat(innerData.p);
        
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'TICK', data: { [sym]: currentPrices[sym] } }));
          }
        });
      }
    } catch(e) {}
  });
`;

serverContent = serverContent.replace(oldPollRegex, newWsRelay);
fs.writeFileSync('server.ts', serverContent);
console.log("Patched server with relay");
