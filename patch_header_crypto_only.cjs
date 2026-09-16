const fs = require('fs');
let headerContent = fs.readFileSync('src/components/NexusHeader.tsx', 'utf-8');

const oldStatic = `  const staticItems: TickerTapeItem[] = [
    { symbol: "NIFTY 50", price: "24,350.00", change: "+0.64%", isPositive: true },
    { symbol: "BANKNIFTY", price: "51,200.00", change: "+0.82%", isPositive: true },
    { symbol: "RELIANCE", price: "2,980.00", change: "+1.15%", isPositive: true },
    { symbol: "TCS", price: "4,250.00", change: "+0.45%", isPositive: true },
    { symbol: "USD/INR", price: "85.35", change: "+0.04%", isPositive: true },
    { symbol: "GOLD (10g)", price: "74,250.00", change: "+0.55%", isPositive: true },
  ];`;

const newStatic = `  // We removed the hardcoded Indian Equities to keep this a dedicated Crypto dashboard.
  // We will build a completely separate Zerodha/Indian Equities dashboard later.
  const staticItems: TickerTapeItem[] = [];`;

headerContent = headerContent.replace(oldStatic, newStatic);
fs.writeFileSync('src/components/NexusHeader.tsx', headerContent);
