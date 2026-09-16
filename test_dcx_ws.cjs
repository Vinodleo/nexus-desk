const { io } = require("socket.io-client");
const socket = io("wss://stream.coindcx.com", { 
  transports: ['websocket'],
  reconnection: true
});

socket.on("connect", () => {
  console.log("Connected SIO");
  socket.emit('join', { channelName: 'B-BTC_INR@ticker' });
  socket.emit('join', { channelName: 'I-BTC_INR@ticker' });
  socket.emit('join', { channelName: 'coindcx' }); // Some examples say this
});
socket.on("connect_error", (err) => console.log("CE:", err.message));
socket.on("ticker", (data) => console.log("ticker:", data));
socket.on("depth-update", (data) => console.log("depth:", data));
socket.on("disconnect", () => console.log("Disconnected"));
setTimeout(() => { process.exit(0); }, 5000);
