const fs = require('fs');
let code = fs.readFileSync('src/components/QueueTab.tsx', 'utf-8');

// We need to add local state for the approving animation.
// Currently: `import React from "react";` -> `import React, { useState } from "react";`

code = code.replace(
  'import React from "react";',
  'import React, { useState } from "react";'
);

code = code.replace(
  'export const QueueTab: React.FC<QueueTabProps> = ({',
  'export const QueueTab: React.FC<QueueTabProps> = ({\n  '
);

code = code.replace(
  /export const QueueTab: React\.FC<QueueTabProps> = \(\{\s+recentlyApproved = \[\]/m,
  'export const QueueTab: React.FC<QueueTabProps> = ({\n  recentlyApproved = []'
);

// We'll just find the component body opening and add the state.
code = code.replace(
  '}) => {\n',
  '}) => {\n  const [approvingIds, setApprovingIds] = useState<string[]>([]);\n\n  const handleApprove = (proposal: TradeProposal) => {\n    setApprovingIds(prev => [...prev, proposal.id]);\n    setTimeout(() => {\n      onApproveProposal(proposal);\n      setApprovingIds(prev => prev.filter(id => id !== proposal.id));\n    }, 400);\n  };\n\n'
);

// Replace the button click handler
code = code.replace(
  'onClick={() => onApproveProposal(proposal)}',
  'onClick={() => handleApprove(proposal)}'
);

// Update button classes to include scaling/animation logic based on approvingIds
const oldBtn = 'className={`flex-1 py-2.5 rounded-xl font-semibold text-xs font-mono tracking-wider shadow-sm transition-all cursor-pointer text-center ${';
const newBtn = 'className={`flex-1 py-2.5 rounded-xl font-semibold text-xs font-mono tracking-wider shadow-sm transition-all cursor-pointer flex items-center justify-center gap-2 ${approvingIds.includes(proposal.id) ? "scale-95 opacity-80" : "scale-100 hover:-translate-y-0.5"} ${';
code = code.replace(oldBtn, newBtn);

const oldText = '{isRankOne ? "Approve #1 Ticket" : "Approve Ticket"}';
const newText = '{approvingIds.includes(proposal.id) ? (\n                      <>\n                        <Zap className="w-3.5 h-3.5 animate-bounce" />\n                        Executing...\n                      </>\n                    ) : (\n                      isRankOne ? "Approve #1 Ticket" : "Approve Ticket"\n                    )}';
code = code.replace(oldText, newText);


fs.writeFileSync('src/components/QueueTab.tsx', code);
