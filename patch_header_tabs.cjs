const fs = require('fs');
let headerContent = fs.readFileSync('src/components/NexusHeader.tsx', 'utf-8');

const oldBrand = `            <span className="font-sans text-sm sm:text-base font-semibold tracking-wide text-white truncate">
              Nexus Desk
            </span>
            <span className="hidden sm:inline-flex items-center gap-1 text-[10px] font-mono text-emerald-400 shrink-0 ml-1">`;

const newBrand = `            <span className="font-sans text-sm sm:text-base font-semibold tracking-wide text-white truncate">
              Nexus Desk
            </span>
            
            {/* Market Segment Toggle */}
            <div className="hidden sm:flex items-center gap-1 ml-4 bg-[#0a0a0c] p-0.5 rounded-lg border border-[#1f1f24]">
              <button className="px-3 py-1 text-xs font-semibold rounded-md bg-[#1f1f24] text-emerald-400 shadow-sm border border-[#2a2a30]">
                Crypto (CoinDCX)
              </button>
              <button 
                className="px-3 py-1 text-xs font-semibold rounded-md text-stone-500 hover:text-stone-300 transition-colors"
                onClick={() => alert("Zerodha Indian Equities dashboard module will be built here next!")}
              >
                Indian Equities (Zerodha) 🔒
              </button>
            </div>

            <span className="hidden sm:inline-flex items-center gap-1 text-[10px] font-mono text-emerald-400 shrink-0 ml-2">`;

headerContent = headerContent.replace(oldBrand, newBrand);
fs.writeFileSync('src/components/NexusHeader.tsx', headerContent);
