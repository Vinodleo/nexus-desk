const { io } = require("socket.io-client");
const socket = io("wss://stream.coindcx.com", { transports: ['websocket'] });

socket.on("connect", () => {
  console.log("Connected to SIO");
  socket.emit('join', { "channelName": "B-BTC_USDT@ticker" });
});
socket.on("connect_error", (err) => {
  console.log("Connect Error:", err.message);
  process.exit(1);
});
socket.on("depth-update", (data) => console.log("Data:", data));
socket.on("ticker", (data) => console.log("Ticker:", data));
setTimeout(() => { console.log('Timeout'); process.exit(0); }, 5000);
