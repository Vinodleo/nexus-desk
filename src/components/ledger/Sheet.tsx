import React, { useEffect, useId } from "react";
import { X } from "lucide-react";
import { usePresence } from "./motion";

// A pop-up in the Private Ledger style: a bottom sheet on phones, a centred
// card on wider screens. Closes on the backdrop, the X button or Escape.
// Slides up (pops in on wider screens) and back down when closed.
export const Sheet: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}> = ({ isOpen, onClose, title, subtitle, children, footer }) => {
  const titleId = useId();
  const { mounted, leaving } = usePresence(isOpen);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!mounted) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4 font-ui text-ink">
      <div
        className={`absolute inset-0 bg-ink/40 ${leaving ? "nx-backdrop-out" : "nx-backdrop-in"}`}
        onClick={leaving ? undefined : onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`relative w-full max-w-lg max-h-[90vh] flex flex-col bg-canvas rounded-t-3xl sm:rounded-3xl shadow-xl ${
          leaving ? "nx-sheet-out pointer-events-none" : "nx-sheet-in"
        }`}
      >
        <div className="w-10 h-1 rounded-full bg-line mx-auto mt-2.5 sm:hidden" aria-hidden="true" />
        <header className="flex items-start justify-between gap-3 px-5 pt-3 sm:pt-5 pb-3">
          <div className="min-w-0">
            <h2 id={titleId} className="m-0 font-display text-2xl font-semibold">
              {title}
            </h2>
            {subtitle && <div className="text-[13px] text-muted mt-0.5">{subtitle}</div>}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="w-10 h-10 shrink-0 rounded-full border border-line bg-surface flex items-center justify-center cursor-pointer hover:bg-inset"
          >
            <X className="w-[18px] h-[18px]" strokeWidth={1.6} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 pb-5 flex flex-col gap-4">{children}</div>
        {footer && <div className="px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 border-t border-line">{footer}</div>}
      </div>
    </div>
  );
};

/** Small uppercase section label used inside sheets and settings. */
export const SheetLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-xs font-semibold text-muted uppercase tracking-[0.08em] px-1 -mb-2">{children}</div>
);
