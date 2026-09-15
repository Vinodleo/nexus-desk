const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf-8');

const oldTickLogic = `// Convert INR symbols to USDT logic temporarily for live crypto test
              // If position is BTC/INR, look for BTC/USDT price.
              const baseAsset = pos.symbol.split('/')[0];
              const binanceSymbol = \`\${baseAsset}/USDT\`;
              const livePrice = newPrices[binanceSymbol];
              
              if (!livePrice) return pos; // No tick data yet
              
              // We'll treat the crypto USDT price as INR for display purposes here 
              // (In reality we'd multiply by USD/INR rate, approx 83)
              const realINRPrice = livePrice * 83.5;`;

const newTickLogic = `// 1. Try direct matching for Indian Equities (from Zerodha Ticker)
              let realINRPrice = newPrices[pos.symbol];
              
              // 2. Fallback to Binance Crypto stream translation
              if (!realINRPrice) {
                const baseAsset = pos.symbol.split('/')[0];
                const binanceSymbol = \`\${baseAsset}/USDT\`;
                const liveCrypto = newPrices[binanceSymbol];
                if (liveCrypto) {
                  realINRPrice = liveCrypto * 83.5; // USD/INR conversion
                }
              }
              
              if (!realINRPrice) return pos; // No tick data yet`;

code = code.replace(oldTickLogic, newTickLogic);

fs.writeFileSync('src/App.tsx', code);
