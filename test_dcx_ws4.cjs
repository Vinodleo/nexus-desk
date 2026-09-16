const { io } = require("socket.io-client");
const socket = io("wss://stream.coindcx.com", { transports: ['websocket'] });
socket.on("connect", () => {
  console.log("Connected");
  socket.emit('join', { "channelName": "coindcx" });
});
let count = 0;
socket.on("new-trade", (data) => {
  console.log("trade:", data);
  count++;
  if (count > 2) process.exit(0);
});
setTimeout(() => { process.exit(0); }, 3000);
