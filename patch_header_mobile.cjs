const fs = require('fs');
let headerContent = fs.readFileSync('src/components/NexusHeader.tsx', 'utf-8');

const oldBrand = `<div className="hidden sm:flex items-center gap-1 ml-4 bg-[#0a0a0c] p-0.5 rounded-lg border border-[#1f1f24]">
              <button className="px-3 py-1 text-xs font-semibold rounded-md bg-[#1f1f24] text-emerald-400 shadow-sm border border-[#2a2a30]">
                Crypto (CoinDCX)
              </button>
              <button 
                className="px-3 py-1 text-xs font-semibold rounded-md text-stone-500 hover:text-stone-300 transition-colors"
                onClick={() => alert("Zerodha Indian Equities dashboard module will be built here next!")}
              >
                Indian Equities (Zerodha) 🔒
              </button>
            </div>`;

const newBrand = `<div className="flex items-center gap-1 ml-2 sm:ml-4 bg-[#0a0a0c] p-0.5 rounded-lg border border-[#1f1f24] overflow-x-auto hide-scrollbar">
              <button className="whitespace-nowrap px-2 sm:px-3 py-1 text-[10px] sm:text-xs font-semibold rounded-md bg-[#1f1f24] text-emerald-400 shadow-sm border border-[#2a2a30]">
                Crypto (CoinDCX)
              </button>
              <button 
                className="whitespace-nowrap px-2 sm:px-3 py-1 text-[10px] sm:text-xs font-semibold rounded-md text-stone-500 hover:text-stone-300 transition-colors"
                onClick={() => alert("Zerodha Indian Equities dashboard module will be built here next!")}
              >
                Indian Equities 🔒
              </button>
            </div>`;

headerContent = headerContent.replace(oldBrand, newBrand);

// Also remove the "hidden sm:inline-flex" from Radar live if needed to save space, but it's fine.
fs.writeFileSync('src/components/NexusHeader.tsx', headerContent);
