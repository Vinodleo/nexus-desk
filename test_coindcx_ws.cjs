const WebSocket = require('ws');

const ws = new WebSocket('wss://stream.coindcx.com');
ws.on('open', () => {
  console.log('Connected to CoinDCX WS');
  ws.send(JSON.stringify({
    "type": "join",
    "channel": "ticker"
  }));
});
ws.on('message', (msg) => {
  console.log('Received:', msg.toString().substring(0, 200));
  process.exit(0);
});
ws.on('error', (e) => {
  console.log('WS Error:', e.message);
  process.exit(1);
});
setTimeout(() => {
  console.log('Timeout');
  process.exit(0);
}, 5000);
