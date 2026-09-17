const fs = require('fs');
let content = fs.readFileSync('src/App.tsx', 'utf-8');

// Patch handleApproveProposal
const newPosRegex = /const newPosition: Position = \{[\s\S]*?isSelfApproved: isAutonomousSelfApproved,\n      \};/;
const newPosReplacement = `const bars = liveMarketStream.getBars(proposal.symbol);
      const currentAtr = bars.length > 0 ? (bars[bars.length - 1].atr || proposal.setup.entryPrice * 0.005) : proposal.setup.entryPrice * 0.005;
      
      const newPosition: Position = {
        id: \`pos-\${Date.now().toString().slice(-6)}\`,
        symbol: proposal.symbol,
        direction: proposal.setup.direction,
        setupName: proposal.setup.name,
        entryPrice: proposal.setup.entryPrice,
        currentPrice: proposal.setup.entryPrice,
        quantity: units,
        stopLoss: proposal.setup.stopLoss,
        takeProfit: proposal.setup.takeProfit,
        unrealizedPnl: 0,
        unrealizedPnlPercent: 0,
        openTime: new Date().toISOString(),
        expectedHoldingTimeMinutes: 30,
        metaConfidence: proposal.metaScore.confidence,
        isSelfApproved: isAutonomousSelfApproved,
        highestPrice: proposal.setup.entryPrice,
        lowestPrice: proposal.setup.entryPrice,
        trailActive: false,
        atrAtEntry: currentAtr,
      };`;
content = content.replace(newPosRegex, newPosReplacement);

// Patch handleBatchApproveAllProposals
const batchPosRegex = /return \{\n\s*id: \`pos-\$\{Date\.now\(\)\.toString\(\)\.slice\(-6\)\}-\$\{index\}\`,[\s\S]*?isSelfApproved: true,\n\s*\};/g;
const batchPosReplacement = `const bars = liveMarketStream.getBars(proposal.symbol);
          const currentAtr = bars.length > 0 ? (bars[bars.length - 1].atr || proposal.setup.entryPrice * 0.005) : proposal.setup.entryPrice * 0.005;
          return {
            id: \`pos-\${Date.now().toString().slice(-6)}-\${index}\`,
            symbol: proposal.symbol,
            direction: proposal.setup.direction,
            setupName: proposal.setup.name,
            entryPrice: proposal.setup.entryPrice,
            currentPrice: proposal.setup.entryPrice,
            quantity: units,
            stopLoss: proposal.setup.stopLoss,
            takeProfit: proposal.setup.takeProfit,
            unrealizedPnl: 0,
            unrealizedPnlPercent: 0,
            openTime: new Date().toISOString(),
            expectedHoldingTimeMinutes: 30,
            metaConfidence: proposal.metaScore.confidence,
            isSelfApproved: true,
            highestPrice: proposal.setup.entryPrice,
            lowestPrice: proposal.setup.entryPrice,
            trailActive: false,
            atrAtEntry: currentAtr,
          };`;
content = content.replace(batchPosRegex, batchPosReplacement);

fs.writeFileSync('src/App.tsx', content);
