import React, { useState } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import { Segmented } from "./ui";
import { indiaClock, indiaDay } from "./format";
import { useServerLog, type LogLine } from "../../hooks/useServerLog";

// Settings → Server → Recent log (owner's ask, 23 Oct): what the server wrote
// lately, newest first, in place of `fly logs` in Cloud Shell. Keys, tokens
// and emails are masked by the server. Warnings and errors stand out, and can
// be shown alone.

const tone: Record<LogLine["level"], string> = { info: "text-ink", warn: "text-warn", error: "text-loss" };

export const ServerLog: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"all" | "problems">("all");
  const log = useServerLog(open, view === "problems");
  const lines = log.lines ?? [];

  return (
    <div className="bg-surface border border-line rounded-[18px] px-3.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="w-full min-h-12 flex items-center justify-between gap-2 text-left text-sm font-semibold cursor-pointer"
      >
        Recent log
        <ChevronDown className={`w-4 h-4 text-muted nx-chevron${open ? " nx-chevron-open" : ""}`} />
      </button>
      <div className={`nx-fold${open ? " nx-fold-open" : ""}`} inert={!open} data-testid="log-fold">
        <div>
          <div className="pb-3.5 flex flex-col gap-2.5">
            <Segmented
              label="Which lines"
              options={[
                { id: "all", label: "All" },
                { id: "problems", label: "Warnings and errors" },
              ]}
              value={view}
              onChange={setView}
            />
            <div className="flex items-center justify-between gap-2 text-xs text-muted">
              <span>{log.updatedAt ? `Newest first · looked ${indiaClock(log.updatedAt, true)}` : "Newest first"}</span>
              <button
                type="button"
                aria-label="Look again"
                onClick={() => void log.refresh()}
                className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-inset cursor-pointer"
              >
                <RefreshCw className={`w-4 h-4 ${log.loading ? "motion-safe:animate-spin" : ""}`} />
              </button>
            </div>

            {log.lines === undefined ? (
              <p className="m-0 text-sm text-muted">Reading the log…</p>
            ) : log.lines === null ? (
              <p className="m-0 text-sm text-muted">Couldn't read the server's log.</p>
            ) : lines.length === 0 ? (
              <p className="m-0 text-sm text-muted">{view === "problems" ? "No warnings or errors lately." : "Nothing logged yet."}</p>
            ) : (
              <ol className="m-0 p-0 list-none max-h-[60vh] overflow-y-auto rounded-[12px] bg-inset px-2.5 py-1.5 [&>li+li]:border-t [&>li+li]:border-line" aria-label="Log lines">
                {lines.map((l, i) => {
                  const day = indiaDay(l.at);
                  const newDay = i === 0 || indiaDay(lines[i - 1].at) !== day;
                  return (
                    <li key={`${l.at}-${i}`}>
                      {newDay && <div className="pt-1.5 pb-0.5 text-[11px] font-bold text-muted uppercase tracking-[0.06em]">{day}</div>}
                      <div className={`py-1 font-mono text-[11px] leading-snug whitespace-pre-wrap break-words ${tone[l.level]}`} data-level={l.level}>
                        <span className="text-muted">{indiaClock(l.at, true)} </span>
                        {l.text}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
