const fs = require('fs');

// Patch App.tsx
let appContent = fs.readFileSync('src/App.tsx', 'utf-8');
appContent = appContent.replace(/BTC\/USDT/g, "BTC/INR");
appContent = appContent.replace(/ETH\/USDT/g, "ETH/INR");
appContent = appContent.replace(/SOL\/USDT/g, "SOL/INR");
appContent = appContent.replace(/AVAX\/USDT/g, "AVAX/INR");
appContent = appContent.replace(/NEAR\/USDT/g, "NEAR/INR");
fs.writeFileSync('src/App.tsx', appContent);

// Patch marketDataService.ts
let mdContent = fs.readFileSync('src/services/marketDataService.ts', 'utf-8');
mdContent = mdContent.replace(/BTC\/USDT/g, "BTC/INR");
mdContent = mdContent.replace(/ETH\/USDT/g, "ETH/INR");
mdContent = mdContent.replace(/SOL\/USDT/g, "SOL/INR");
mdContent = mdContent.replace(/AVAX\/USDT/g, "AVAX/INR");
mdContent = mdContent.replace(/NEAR\/USDT/g, "NEAR/INR");
fs.writeFileSync('src/services/marketDataService.ts', mdContent);

// Patch LabTab.tsx
let labContent = fs.readFileSync('src/components/LabTab.tsx', 'utf-8');
labContent = labContent.replace(/BTCUSDT/g, "BTCINR");
labContent = labContent.replace(/BTC \/ USDT/g, "BTC / INR");
labContent = labContent.replace(/ETHUSDT/g, "ETHINR");
labContent = labContent.replace(/ETH \/ USDT/g, "ETH / INR");
labContent = labContent.replace(/SOLUSDT/g, "SOLINR");
labContent = labContent.replace(/SOL \/ USDT/g, "SOL / INR");
fs.writeFileSync('src/components/LabTab.tsx', labContent);

// Patch FloorTab.tsx
let floorContent = fs.readFileSync('src/components/FloorTab.tsx', 'utf-8');
floorContent = floorContent.replace(/USDT/g, "INR");
fs.writeFileSync('src/components/FloorTab.tsx', floorContent);

// Patch ApprovalQueue.tsx
let queueContent = fs.readFileSync('src/components/ApprovalQueue.tsx', 'utf-8');
queueContent = queueContent.replace(/BTC\/USDT/g, "BTC/INR");
queueContent = queueContent.replace(/ETH\/USDT/g, "ETH/INR");
fs.writeFileSync('src/components/ApprovalQueue.tsx', queueContent);

// Patch experienceMemory.ts
let emContent = fs.readFileSync('src/services/experienceMemory.ts', 'utf-8');
emContent = emContent.replace(/BTC\/USDT/g, "BTC/INR");
emContent = emContent.replace(/ETH\/USDT/g, "ETH/INR");
fs.writeFileSync('src/services/experienceMemory.ts', emContent);

console.log("Patched other files to INR");
