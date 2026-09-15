const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf-8');

code = code.replace(
  'import { FloorTab } from "./components/FloorTab";',
  'import { FloorTab } from "./components/FloorTab";\nimport { NetworkTab } from "./components/NetworkTab";'
);

code = code.replace(
  'const [activeTab, setActiveTab] = useState<"terminal" | "floor" | "lab" | "book">("terminal");',
  'const [activeTab, setActiveTab] = useState<"terminal" | "floor" | "lab" | "book" | "network">("terminal");'
);

const oldTabs = `                >
                  <BookOpen className="w-4 h-4" />
                  <span className="hidden sm:inline">Ledger</span>
                </button>`;

const newTabs = `                >
                  <BookOpen className="w-4 h-4" />
                  <span className="hidden sm:inline">Ledger</span>
                </button>
                <button
                  onClick={() => setActiveTab("network")}
                  className={\`flex flex-1 sm:flex-none items-center justify-center sm:justify-start gap-2 px-3 py-2.5 sm:px-4 sm:py-2 text-xs font-mono font-medium rounded-xl transition-all cursor-pointer \${
                    activeTab === "network"
                      ? "bg-blue-500/10 text-blue-400 border border-blue-500/20 shadow-[0_0_15px_rgba(59,130,246,0.1)]"
                      : "text-stone-400 hover:text-stone-200 hover:bg-[#151520] border border-transparent"
                  }\`}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-globe"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>
                  <span className="hidden sm:inline">Network</span>
                </button>`;

code = code.replace(oldTabs, newTabs);

const bookTabContent = `        <div className={\`animate-in fade-in zoom-in-95 duration-200 \${
          activeTab === "book" ? "block" : "hidden"
        }\`}>
          <BookTab`;

const networkTabContent = `        <div className={\`animate-in fade-in zoom-in-95 duration-200 \${
          activeTab === "network" ? "block" : "hidden"
        }\`}>
          <NetworkTab />
        </div>\n\n        <div className={\`animate-in fade-in zoom-in-95 duration-200 \${
          activeTab === "book" ? "block" : "hidden"
        }\`}>
          <BookTab`;

code = code.replace(bookTabContent, networkTabContent);

fs.writeFileSync('src/App.tsx', code);
