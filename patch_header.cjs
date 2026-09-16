const fs = require('fs');
let content = fs.readFileSync('src/components/NexusHeader.tsx', 'utf-8');

content = content.replace(
  '  dailyPnl: number;',
  '  dailyPnl: number;\n  netPnl?: number;'
);

const beforeProps = `export const NexusHeader: React.FC<NexusHeaderProps> = ({
  equity,
  dailyPnl,`;

const afterProps = `export const NexusHeader: React.FC<NexusHeaderProps> = ({
  equity,
  dailyPnl,
  netPnl = 0,`;

content = content.replace(beforeProps, afterProps);

// Find the Key Metrics Row
const gridRegex = /<div className="grid grid-cols-4 gap-1\.5 sm:gap-2 my-2\.5 sm:my-3 pt-1 text-left">/;
const newGrid = `<div className="grid grid-cols-5 gap-1.5 sm:gap-2 my-2.5 sm:my-3 pt-1 text-left">`;

content = content.replace(gridRegex, newGrid);

// We need to add the ALL-TIME block next to the DAY block.
// We can find the Cash block and insert the ALL-TIME block right before Cash block.
const cashBlock = `          <div className="min-w-0">
            <div className="text-[9px] sm:text-[10px] font-mono tracking-wider text-stone-400 uppercase">
              Cash
            </div>`;

const netPnlBlock = `          <div className="min-w-0">
            <div className="text-[9px] sm:text-[10px] font-mono tracking-wider text-stone-400 uppercase">
              All-Time
            </div>
            <div
              className={\`text-xs sm:text-base font-mono font-medium mt-0.5 truncate \${
                netPnl === 0
                  ? "text-stone-300"
                  : netPnl > 0
                  ? "text-emerald-400"
                  : "text-rose-400"
              }\`}
            >
              {netPnl === 0 ? "" : netPnl > 0 ? "+" : "-"}₹{Math.abs(netPnl).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>
`;

content = content.replace(cashBlock, netPnlBlock + cashBlock);

fs.writeFileSync('src/components/NexusHeader.tsx', content);
console.log('patched header');
