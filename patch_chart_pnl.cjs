const fs = require('fs');
let content = fs.readFileSync('src/components/ChartTab.tsx', 'utf-8');

const pnlString = `
          <div className="flex flex-col items-end">
            <span className={\`text-xs font-mono font-bold \${position.unrealizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}\`}>
              {position.unrealizedPnl >= 0 ? "+" : ""}₹{position.unrealizedPnl.toFixed(2)}
            </span>
            <span className={\`text-[10px] font-mono \${position.unrealizedPnlPercent >= 0 ? "text-emerald-500/70" : "text-rose-500/70"}\`}>
              {position.unrealizedPnlPercent >= 0 ? "+" : ""}{position.unrealizedPnlPercent.toFixed(2)}%
            </span>
          </div>
        </div>
`;

content = content.replace(/<\/div>\\n\s*<div className="flex items-center gap-1\.5 text-xs font-mono text-stone-400">/, pnlString + '        <div className="flex items-center gap-1.5 text-xs font-mono text-stone-400">');

fs.writeFileSync('src/components/ChartTab.tsx', content);
