import React from "react";
import { Loader2 } from "lucide-react";

export const LoadingScreen: React.FC<{ message?: string }> = ({ message = "Opening the desk…" }) => (
  <div className="min-h-screen bg-canvas text-ink font-ui flex flex-col items-center justify-center gap-4" role="status">
    <div className="font-display text-[28px] font-semibold">Nexus Desk</div>
    <div className="flex items-center gap-2 text-sm text-muted">
      <Loader2 className="w-4 h-4 animate-spin" />
      {message}
    </div>
  </div>
);
