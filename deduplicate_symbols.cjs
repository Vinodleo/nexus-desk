const fs = require('fs');
const content = fs.readFileSync('src/services/marketDataService.ts', 'utf-8');

const regex = /export const SUPPORTED_SYMBOLS: SymbolConfig\[\] = \[\s*([^\]]+)\s*\];/;
const match = content.match(regex);

if (match) {
    const symbolsBlock = match[1];
    
    // Quick trick, we can evaluate it if we stub SymbolConfig.
    // Instead, let's just parse it using standard JS parsing.
    let cleaned = content.replace(
        /  \{ symbol: "BTC\/INR"[\s\S]*?\{ symbol: "USD\/INR", name: "US Dollar \/ Indian Rupee", basePrice: 85\.35, tickSize: 0\.0025, lotSize: 1000, volatility: 0\.08, correlatedGroup: "FOREX" \},/,
        ''
    );
    
    // Wait, let's make sure we don't accidentally remove everything. Let's just remove the exact duplicated block.
    // Let me check the exact lines.
}
