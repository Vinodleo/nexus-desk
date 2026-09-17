const fs = require('fs');
let content = fs.readFileSync('src/App.tsx', 'utf-8');

// The mangled piece is:
/*
              handleUpdateModelAccuracy({
                accuracyPct: result.learnedMetrics.accuracyPercent,
                winRatePct: result.learnedMetrics.winRate,
                sharpeRatio: result.learnedMetrics.sharpeRatio,
                datasetName: result.datasetName || `${result.symbol} Custom`,
                lastUpdated: new Date().toISOString(),
                totalCandlesEvaluated: result.totalCandles || result.candlesCount
              })
              }, 1200);
            }}
*/

const mangledRegex = /handleUpdateModelAccuracy\(\{[\s\S]*?\}\)[\s]*\}, 1200\);\s*\}\}/;

const fixedPiece = `              handleUpdateModelAccuracy({
                accuracyPct: result.learnedMetrics.accuracyPercent,
                winRatePct: result.learnedMetrics.winRate,
                sharpeRatio: result.learnedMetrics.sharpeRatio,
                datasetName: result.datasetName || \`\${result.symbol} Custom\`,
                lastUpdated: new Date().toISOString(),
                totalCandlesEvaluated: result.totalCandles || result.candlesCount
              });
            }}
            onUpdateModelAccuracy={handleUpdateModelAccuracy}
            isRunningWalkForward={isRunningWalkForward}
            onRerunWalkForward={() => {
              setIsRunningWalkForward(true);
              setTimeout(() => {
                setIsRunningWalkForward(false);
                setExecutionToast({
                  id: \`toast-\${Date.now()}\`,
                  title: "Walk-Forward Validation Complete",
                  message: "5/5 embargoed folds passed. Deflated Sharpe ratio 1.48 with 72h purge window.",
                  type: "SUCCESS",
                  timestamp: new Date().toLocaleTimeString(),
                });
              }, 1200);
            }}`;

if (mangledRegex.test(content)) {
    content = content.replace(mangledRegex, fixedPiece);
    fs.writeFileSync('src/App.tsx', content);
    console.log("Fixed App.tsx LabTab mangled section");
} else {
    console.log("Could not find mangled section");
}
