const fs = require('fs');
let content = fs.readFileSync('src/components/BookTab.tsx', 'utf-8');

const regex = /<span className="text-gray-400">SL:<\/span>\n\s*<span className="font-mono">₹\{pos\.stopLoss\.toFixed\(2\)\}<\/span>/g;
const replacement = `<span className="text-gray-400">SL:</span>
                            <div className="flex items-center gap-1">
                              <span className="font-mono">₹{pos.stopLoss.toFixed(2)}</span>
                              {pos.trailActive && (
                                <span className="text-[10px] bg-green-500/20 text-green-400 px-1 py-0.5 rounded font-bold uppercase tracking-wider ml-1">
                                  Trailing
                                </span>
                              )}
                            </div>`;
                            
if (content.match(regex)) {
   content = content.replace(regex, replacement);
   fs.writeFileSync('src/components/BookTab.tsx', content);
   console.log("Patched BookTab.tsx");
} else {
   console.log("Could not find SL string in BookTab.tsx");
}
