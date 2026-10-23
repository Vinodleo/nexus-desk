import React, { useState } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import { HoldButton } from "./ui";
import { useBackups, type BackupDay } from "../../hooks/useBackups";
import { indiaClock, indiaDay } from "./format";

// Settings → Server → Restore a backup (owner's ask, 23 Oct): instead of
// RESTORE_BACKUP in Cloud Shell. Pick a day, hold to restore; the server
// keeps what's there now aside, restarts to put the day back, and says how
// it went.

/** A moment in India time: "Fri 23 Oct, 4:10 pm". */
export const indiaWhen = (ms: number): string => `${indiaDay(ms)}, ${indiaClock(ms)}`;

/** The newest backups shown before "Show older". */
export const SHOWN_BACKUPS = 7;

const size = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export const RestoreBackup: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<BackupDay | null>(null);
  const [showAll, setShowAll] = useState(false);
  const backups = useBackups(open);
  const { list, phase, note } = backups;
  const result = list?.restore ?? null;
  const labelOf = (day: string) => {
    const d = list?.days.find((x) => x.day === day);
    return d ? indiaWhen(d.at) : day;
  };

  return (
    <div className="bg-surface border border-line rounded-[18px] px-3.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="w-full min-h-12 flex items-center justify-between gap-2 text-left text-sm font-semibold cursor-pointer"
      >
        Restore a backup
        <ChevronDown className={`w-4 h-4 text-muted nx-chevron${open ? " nx-chevron-open" : ""}`} />
      </button>
      <div className={`nx-fold${open ? " nx-fold-open" : ""}`} inert={!open} data-testid="restore-fold">
        <div>
          <div className="pb-3.5 flex flex-col gap-2.5">
            <p className="m-0 text-xs text-muted leading-relaxed">
              Puts the server's saved state back as it was when a backup was made: open trades, the Book, settings and the
              strategies' checks. What's there now is kept aside on the server. The server restarts to do it, which takes about a minute.
            </p>

            {phase === "restarting" || phase === "sending" ? (
              <p className="m-0 text-sm flex items-center gap-2" role="status">
                <RefreshCw className="w-4 h-4 shrink-0 text-accent motion-safe:animate-spin" />
                {phase === "sending" ? "Asking the server…" : `Restoring ${picked ? indiaWhen(picked.at) : "the backup"}: the server is restarting…`}
              </p>
            ) : phase === "slow" ? (
              <p className="m-0 text-sm text-warn" role="status">
                The server hasn't come back yet. It may still be starting: look again in a minute.
              </p>
            ) : phase === "done" && result ? (
              result.ok ? (
                <div className="flex flex-col gap-2" role="status">
                  <p className="m-0 text-sm text-gain font-semibold">
                    Restored {labelOf(result.day)} ({result.files} files). Reload the app to see it.
                  </p>
                  <button
                    type="button"
                    onClick={() => window.location.reload()}
                    className="self-start min-h-9 px-3.5 rounded-full bg-accent text-on-accent text-[13px] font-bold cursor-pointer"
                  >
                    Reload the app
                  </button>
                </div>
              ) : (
                <p className="m-0 text-sm text-loss" role="status">
                  Couldn't restore {labelOf(result.day)}: {result.error}. The server started with its files as they were.
                </p>
              )
            ) : list === undefined ? (
              <p className="m-0 text-sm text-muted">Looking for backups…</p>
            ) : !list || list.days.length === 0 ? (
              <p className="m-0 text-sm text-muted">{list ? "No backups yet: the first is made a few minutes after the server starts." : null}</p>
            ) : (
              <>
                <div role="radiogroup" aria-label="Backups" className="flex flex-col gap-1.5">
                  {(showAll ? list.days : list.days.slice(0, SHOWN_BACKUPS)).map((d) => {
                    const on = picked?.day === d.day;
                    return (
                      <button
                        key={d.day}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => setPicked(on ? null : d)}
                        className={`min-h-11 px-3 rounded-[12px] border flex items-center justify-between gap-2 text-left text-sm cursor-pointer tabular-nums ${
                          on ? "border-accent bg-accent-soft" : "border-line"
                        }`}
                      >
                        <span>{indiaWhen(d.at)}</span>
                        <span className="text-xs text-muted">{size(d.bytes)}</span>
                      </button>
                    );
                  })}
                </div>
                {!showAll && list.days.length > SHOWN_BACKUPS && (
                  <button type="button" onClick={() => setShowAll(true)} className="self-start text-xs font-semibold text-accent underline cursor-pointer">
                    Show {list.days.length - SHOWN_BACKUPS} older
                  </button>
                )}
                {picked && (
                  <HoldButton
                    label={`Hold to restore ${indiaWhen(picked.at)}`}
                    keepHoldingLabel="Keep holding to restore"
                    onHold={() => void backups.restore(picked.day)}
                    className="w-full min-h-12 rounded-[14px] border-[1.5px] border-loss text-loss text-sm font-bold"
                    fillClassName="bg-loss/25"
                  />
                )}
              </>
            )}

            {note && (
              <p className="m-0 text-xs text-loss" role="alert">
                {note}
              </p>
            )}
            {phase === "idle" && result && (
              <p className="m-0 text-xs text-muted" data-testid="restore-last">
                Last restore: the backup of {labelOf(result.day)}, {result.ok ? `done ${indiaWhen(result.at)}` : `failed ${indiaWhen(result.at)} (${result.error})`}.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
