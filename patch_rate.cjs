const fs = require('fs');
let serverContent = fs.readFileSync('server.ts', 'utf-8');
serverContent = serverContent.replace('const INR_RATE = 84.5;', 'const INR_RATE = 95.90; // Updated to match current CoinGecko/CoinDCX premium rate');
fs.writeFileSync('server.ts', serverContent);
