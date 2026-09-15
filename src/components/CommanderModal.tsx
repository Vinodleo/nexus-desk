import React from "react";
import { X, Sparkles, ShieldCheck } from "lucide-react";

interface CommanderModalProps {
  isOpen: boolean;
  onClose: () => void;
  summaryText?: string;
  isLoading?: boolean;
}

export const CommanderModal: React.FC<CommanderModalProps> = ({
  isOpen,
  onClose,
  summaryText,
  isLoading = false,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/75 backdrop-blur-xs transition-opacity animate-in fade-in duration-200">
      {/* Background click to dismiss */}
      <div className="absolute inset-0" onClick={onClose} />

      {/* Modal / Bottom Sheet container */}
      <div className="relative w-full max-w-lg bg-[#111114] border border-[#27272e] rounded-t-3xl sm:rounded-2xl p-6 shadow-2xl z-10 select-none">
        {/* Top pill bar for mobile slide indicator */}
        <div className="w-10 h-1 rounded-full bg-stone-700 mx-auto mb-4 sm:hidden" />

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-mono tracking-[0.2em] text-stone-400 uppercase">
              Commander
            </span>
            <button
              onClick={onClose}
              className="text-stone-400 hover:text-white p-1 rounded-lg cursor-pointer transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <h3 className="font-serif text-2xl text-stone-100 font-normal">
            Desk brief
          </h3>

          <div className="text-sm text-stone-300 font-sans leading-relaxed space-y-2">
            {isLoading ? (
              <div className="flex items-center gap-2 py-4 text-stone-400 font-mono text-xs">
                <span className="animate-spin text-stone-200">◌</span>
                <span>Commander is synthesizing desk intelligence...</span>
              </div>
            ) : summaryText ? (
              <p>{summaryText}</p>
            ) : (
              <p>
                Grok is unreachable. The playbook, risk, and tickets do not depend on this call.
              </p>
            )}

            <div className="pt-2 text-xs font-mono text-stone-400 flex items-center gap-1.5 border-t border-[#1f1f26]">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              <span>
                Deterministic rules active · Fractional-Kelly sizing · Fail-closed gate
              </span>
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              onClick={onClose}
              className="px-6 py-2 rounded-xl bg-[#202026] hover:bg-[#2a2a33] text-stone-100 text-xs font-mono tracking-wider border border-[#32323c] cursor-pointer transition-all"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
