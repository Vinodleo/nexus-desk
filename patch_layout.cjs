const fs = require('fs');
let code = fs.readFileSync('src/components/SecurityConsoleModal.tsx', 'utf-8');

// 1. Fix Tab Navigation
code = code.replace(
  '<div className="flex items-center gap-1 px-4 pt-3 border-b border-[#1d1d28] bg-[#0c0c11]">',
  '<div className="flex items-center gap-1 px-4 pt-3 border-b border-[#1d1d28] bg-[#0c0c11] overflow-x-auto [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: "none" }}>'
);

code = code.replace(
  'className={`flex items-center gap-1.5 px-3 py-2 text-xs font-mono font-medium rounded-t-lg transition-colors cursor-pointer border-b-2 ${',
  'className={`flex items-center whitespace-nowrap shrink-0 gap-1.5 px-3 py-2 text-xs font-mono font-medium rounded-t-lg transition-colors cursor-pointer border-b-2 ${'
);

// 2. Fix Guardrails
const oldGuardrails = `                  <div className="flex items-center justify-between p-2 rounded-lg bg-[#161622] border border-[#262638]">
                    <div className="flex items-center gap-2 text-stone-200">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Firebase Auth Token Verification</span>
                    </div>
                    <span className="text-emerald-400 font-medium">ENFORCED</span>
                  </div>
                  <div className="flex items-center justify-between p-2 rounded-lg bg-[#161622] border border-[#262638]">
                    <div className="flex items-center gap-2 text-stone-200">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Hard 1.0% Equity Loss Cap per Trade</span>
                    </div>
                    <span className="text-emerald-400 font-medium">STRICT CODE</span>
                  </div>
                  <div className="flex items-center justify-between p-2 rounded-lg bg-[#161622] border border-[#262638]">
                    <div className="flex items-center gap-2 text-stone-200">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Emergency Kill-Switch Ingress</span>
                    </div>
                    <span className="text-emerald-400 font-medium">ONLINE</span>
                  </div>
                  <div className="flex items-center justify-between p-2 rounded-lg bg-[#161622] border border-[#262638]">
                    <div className="flex items-center gap-2 text-stone-200">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Immutable Cloud Firestore Audit Trail</span>
                    </div>
                    <span className="text-emerald-400 font-medium">SYNCHRONIZED</span>
                  </div>`;

const newGuardrails = `                  <div className="flex items-start sm:items-center justify-between gap-3 p-2.5 rounded-lg bg-[#161622] border border-[#262638]">
                    <div className="flex items-start sm:items-center gap-2 text-stone-200">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 mt-0.5 sm:mt-0 shrink-0" />
                      <span className="leading-tight">Firebase Auth Token Verification</span>
                    </div>
                    <span className="text-emerald-400 font-medium shrink-0 text-right whitespace-nowrap">ENFORCED</span>
                  </div>
                  <div className="flex items-start sm:items-center justify-between gap-3 p-2.5 rounded-lg bg-[#161622] border border-[#262638]">
                    <div className="flex items-start sm:items-center gap-2 text-stone-200">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 mt-0.5 sm:mt-0 shrink-0" />
                      <span className="leading-tight">Hard 1.0% Equity Loss Cap per Trade</span>
                    </div>
                    <span className="text-emerald-400 font-medium shrink-0 text-right whitespace-nowrap">STRICT CODE</span>
                  </div>
                  <div className="flex items-start sm:items-center justify-between gap-3 p-2.5 rounded-lg bg-[#161622] border border-[#262638]">
                    <div className="flex items-start sm:items-center gap-2 text-stone-200">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 mt-0.5 sm:mt-0 shrink-0" />
                      <span className="leading-tight">Emergency Kill-Switch Ingress</span>
                    </div>
                    <span className="text-emerald-400 font-medium shrink-0 text-right whitespace-nowrap">ONLINE</span>
                  </div>
                  <div className="flex items-start sm:items-center justify-between gap-3 p-2.5 rounded-lg bg-[#161622] border border-[#262638]">
                    <div className="flex items-start sm:items-center gap-2 text-stone-200">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 mt-0.5 sm:mt-0 shrink-0" />
                      <span className="leading-tight">Immutable Cloud Firestore Audit Trail</span>
                    </div>
                    <span className="text-emerald-400 font-medium shrink-0 text-right whitespace-nowrap">SYNCHRONIZED</span>
                  </div>`;

code = code.replace(oldGuardrails, newGuardrails);

fs.writeFileSync('src/components/SecurityConsoleModal.tsx', code);
