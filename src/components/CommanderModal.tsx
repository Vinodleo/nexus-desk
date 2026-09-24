import React from "react";
import { Loader2 } from "lucide-react";
import { Sheet } from "./ledger/Sheet";

interface CommanderModalProps {
  isOpen: boolean;
  onClose: () => void;
  summaryText?: string;
  isLoading?: boolean;
}

// The desk brief: a plain-language summary of the book from the commander agent.
export const CommanderModal: React.FC<CommanderModalProps> = ({ isOpen, onClose, summaryText, isLoading = false }) => (
  <Sheet
    isOpen={isOpen}
    onClose={onClose}
    title="Desk brief"
    subtitle="The commander explains the book. It can't open or close trades."
    footer={
      <button
        type="button"
        onClick={onClose}
        className="w-full min-h-12 rounded-full bg-accent text-on-accent font-semibold cursor-pointer"
      >
        Done
      </button>
    }
  >
    {isLoading ? (
      <div className="flex items-center gap-2.5 py-4 text-sm text-muted">
        <Loader2 className="w-4 h-4 animate-spin" />
        Writing the brief…
      </div>
    ) : (
      <p className="m-0 text-[15px] leading-relaxed whitespace-pre-line">
        {summaryText || "The brief isn't available right now. Trading, risk checks and the guardian don't depend on it."}
      </p>
    )}
  </Sheet>
);
