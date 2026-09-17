const fs = require('fs');
let content = fs.readFileSync('src/components/BookTab.tsx', 'utf-8');

const regex = /<span className="text-\[10px\] text-stone-400 uppercase">Stop Loss: <\/span>\n\s*<span className="text-rose-400 font-medium">\n\s*₹\{pos\.stopLoss\.toFixed\(2\)\}\n\s*<\/span>/g;
const replacement = `<span className="text-[10px] text-stone-400 uppercase">Stop Loss: </span>
                        <span className="text-rose-400 font-medium flex items-center gap-2">
                          ₹{pos.stopLoss.toFixed(2)}
                          {pos.trailActive && (
                            <span className="bg-emerald-500/20 text-emerald-400 text-[9px] px-1 py-0.5 rounded uppercase tracking-widest border border-emerald-500/30">
                              Trailing
                            </span>
                          )}
                        </span>`;
                            
if (content.match(regex)) {
   content = content.replace(regex, replacement);
   fs.writeFileSync('src/components/BookTab.tsx', content);
   console.log("Patched BookTab.tsx");
} else {
   console.log("Could not find SL string in BookTab.tsx (second attempt)");
}
