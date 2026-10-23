import React, { useEffect, useState } from "react";
import { useLookOnly } from "../../context/LookOnly";
import { AlertTriangle, DownloadCloud, Loader2, UploadCloud } from "lucide-react";
import { syncToFirebase, syncFromFirebase, hasLegacyExchangeKeys, deleteLegacyExchangeKeys } from "../../services/storagePersistenceService";
import { apiFetch } from "../../services/apiClient";
import type { CoinDcxServerStatus } from "../../types";
import { useAuth, type SecurityAuditEntry } from "../../context/AuthContext";
import type { NotifyState } from "../../hooks/useTradeNotifications";
import { Sheet } from "./Sheet";
import { Fold } from "./labUi";

// Settings → This phone: who's signed in, that the server does the trading
// (nothing here needs to stay awake), this phone's pop-ups and where the
// exchange keys live, what was done lately, and a copy of this phone's
// memory in the cloud. It replaced "Run in the background" (wake lock,
// silent audio: the server trades with the phone off) and "Security and
// access" (roles, which mean nothing on a one-person desk).

/** "KILL_SWITCH_ENGAGED" -> "Kill switch engaged" */
export function auditLabel(action: string): string {
  const s = action.toLowerCase().replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type Tone = "gain" | "loss" | "accent" | "warn" | "muted";

/** What an activity entry says in plain words, and its dot's colour. */
export function activityOf(e: Pick<SecurityAuditEntry, "action" | "details">): { label: string; tone: Tone } {
  switch (e.action) {
    case "KILL_SWITCH_ENGAGED":
      return { label: "Stopped all trading", tone: "loss" };
    case "KILL_SWITCH_DISENGAGED":
      return { label: "Resumed trading", tone: "gain" };
    case "KILL_SWITCH_TRIGGERED":
      return { label: "Stopped after 3 losses in a row", tone: "loss" };
    case "ORDER_APPROVED":
      return { label: "Approved a trade", tone: "gain" };
    case "ORDER_VETOED":
      return { label: "Skipped a proposal", tone: "muted" };
    case "POSITION_MANUAL_CLOSE":
      return { label: "Closed a trade by hand", tone: "accent" };
    case "AUTOPILOT_DEFERRED":
      return { label: "Autopilot left proposals for you", tone: "warn" };
    case "DECISION_MODE_CHANGED":
      return { label: /AUTO_WITHIN_LIMITS/.test(e.details) ? "Autopilot on" : "Autopilot off", tone: "accent" };
    case "SYMBOL_QUARANTINED":
      return { label: "Rested a symbol after a loss", tone: "warn" };
    case "GOOGLE_SIGN_IN":
    case "EMAIL_SIGN_IN":
      return { label: "Signed in", tone: "muted" };
    case "SIGN_OUT":
      return { label: "Signed out", tone: "muted" };
    case "CLOUD_SYNC_PUSH":
      return { label: "Copied the memory to the cloud", tone: "muted" };
    case "CLOUD_SYNC_PULL":
      return { label: "Brought the memory back from the cloud", tone: "muted" };
    default:
      return { label: auditLabel(e.action), tone: "muted" };
  }
}

const DOT: Record<Tone, string> = { gain: "bg-gain", loss: "bg-loss", accent: "bg-accent", warn: "bg-warn", muted: "bg-muted" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** When it happened: "12 Oct, 9:41 am" from the time in its id, else the time it was saved with. */
export function activityTime(e: Pick<SecurityAuditEntry, "id" | "timestamp">): string {
  const ms = Number(/^audit-(\d{12,})-/.exec(e.id)?.[1]);
  if (!Number.isFinite(ms) || ms <= 0) return e.timestamp;
  const d = new Date(ms);
  const h = d.getHours();
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

const POPUPS: Record<NotifyState, { text: string; on: boolean }> = {
  on: { text: "On", on: true },
  off: { text: "Off · Settings turns them on", on: false },
  blocked: { text: "Blocked in the browser", on: false },
  unsupported: { text: "Not on this browser", on: false },
  working: { text: "…", on: false },
};

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-center justify-between gap-3 min-h-[50px] py-2 border-b border-line last:border-b-0 text-sm">
    <span>{label}</span>
    <span className="text-right min-w-0">{children}</span>
  </div>
);

export const ThisPhoneSheet: React.FC<{ isOpen: boolean; onClose: () => void; popups?: NotifyState }> = ({ isOpen, onClose, popups }) => {
  const { currentUser, userProfile, userRole, switchUserRole, logout, recentAudits, logSecurityAudit } = useAuth();
  const lookOnly = useLookOnly();
  const [status, setStatus] = useState<CoinDcxServerStatus | null>(null);
  const [hasLegacyKeys, setHasLegacyKeys] = useState(false);
  const [deletingLegacy, setDeletingLegacy] = useState(false);
  const [sync, setSync] = useState<{ busy: boolean; message: string | null }>({ busy: false, message: null });
  const [confirmRestore, setConfirmRestore] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setConfirmRestore(false);
      return;
    }
    apiFetch("/api/coindcx/status")
      .then((res) => res.json())
      .then((data) => data.success && setStatus(data))
      .catch(() => setStatus(null));
    if (currentUser) hasLegacyExchangeKeys(currentUser.uid).then(setHasLegacyKeys);
  }, [isOpen, currentUser]);

  const deleteLegacy = async () => {
    if (!currentUser) return;
    setDeletingLegacy(true);
    const ok = await deleteLegacyExchangeKeys(currentUser.uid);
    setDeletingLegacy(false);
    if (ok) {
      setHasLegacyKeys(false);
      logSecurityAudit("LEGACY_KEYS_DELETED", "Deleted plain-text exchange keys previously stored in Firestore");
    }
  };

  const backUp = async () => {
    if (!currentUser) return;
    setSync({ busy: true, message: "Copying…" });
    await syncToFirebase(currentUser.uid);
    await logSecurityAudit("CLOUD_SYNC_PUSH", "Pushed local trading memory and telemetry to Cloud Firestore.");
    setSync({ busy: false, message: "Copied to the cloud." });
  };

  const restore = async () => {
    if (!currentUser) return;
    setConfirmRestore(false);
    setSync({ busy: true, message: "Bringing it back…" });
    const ok = await syncFromFirebase(currentUser.uid);
    if (ok) {
      await logSecurityAudit("CLOUD_SYNC_PULL", "Downloaded cloud trading memory to local device.");
      setSync({ busy: true, message: "Done. Reloading…" });
      setTimeout(() => window.location.reload(), 1200);
    } else {
      setSync({ busy: false, message: "Couldn't bring it back from the cloud." });
    }
  };

  const name = currentUser?.displayName || userProfile?.displayName || "You";
  const google = userProfile?.provider === "google";
  const popup = popups ? POPUPS[popups] : null;
  const activity = recentAudits.slice(0, 8);

  return (
    <Sheet isOpen={isOpen} onClose={onClose} title="This phone">
      <div className="bg-surface border border-line rounded-[18px] p-3.5 flex items-center gap-3">
        <div aria-hidden="true" className="w-11 h-11 shrink-0 rounded-full bg-accent text-on-accent font-display text-xl font-semibold flex items-center justify-center">
          {(name[0] || "Y").toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold truncate">{name}</div>
          <div className="text-xs text-muted truncate">
            {currentUser?.email || "Not signed in"}
            {google ? " · Google" : ""}
          </div>
        </div>
        {currentUser && (
          <button
            type="button"
            onClick={() => void logout()}
            className="shrink-0 min-h-10 px-3.5 rounded-full border border-line bg-surface text-[13px] font-semibold cursor-pointer"
          >
            Sign out
          </button>
        )}
      </div>

      <div className="flex gap-3 items-start p-3.5 rounded-[18px] bg-accent-soft text-accent">
        <span aria-hidden="true" className="relative w-2.5 h-2.5 mt-[5px] shrink-0">
          <span className="absolute inset-0 rounded-full bg-gain motion-safe:animate-ping opacity-60" />
          <span className="absolute inset-0 rounded-full bg-gain" />
        </span>
        <p className="m-0 text-[13px] leading-relaxed">
          <strong>The server does the trading.</strong> Stops and exits run on it day and night, with this phone locked or off. Nothing
          here needs to stay awake.
        </p>
      </div>

      {lookOnly ? (
        <p className="m-0 p-3.5 rounded-[18px] bg-accent-soft text-[13px] leading-relaxed" data-testid="look-only-phone">
          <strong>Look only.</strong> This account sees the owner's desk and can't change anything.
        </p>
      ) : userRole !== "commander" && (
        <div className="flex flex-col gap-2 p-3.5 rounded-[18px] bg-warn-soft text-warn-ink text-[13px] leading-relaxed">
          <p className="m-0">
            This phone is set to <strong>{userRole === "auditor" ? "look only" : "approve and close only"}</strong>, so some buttons won't
            work here.
          </p>
          <button
            type="button"
            onClick={() => void switchUserRole("commander")}
            className="self-start min-h-9 px-3.5 rounded-full bg-accent text-on-accent text-[13px] font-semibold cursor-pointer"
          >
            Allow everything again
          </button>
        </div>
      )}

      <div className="bg-surface border border-line rounded-[18px] px-3.5">
        {popup && (
          <Row label="Trade pop-ups">
            <span className={`inline-flex items-center gap-1.5 font-semibold ${popup.on ? "text-gain" : "text-muted"}`}>
              {popup.on && <span aria-hidden="true" className="w-[7px] h-[7px] rounded-full bg-gain" />}
              {popup.text}
            </span>
          </Row>
        )}
        <Row label="CoinDCX keys">
          <span className="text-muted">{status ? (status.configured ? "On the server only" : "Not set up") : "…"}</span>
        </Row>
      </div>

      {hasLegacyKeys && (
        <div className="flex flex-col gap-2 p-3.5 rounded-[18px] bg-danger-soft border border-danger-line text-[13px] leading-relaxed">
          <div className="flex gap-2 text-loss font-semibold">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            Old keys found in your cloud profile
          </div>
          <p className="m-0">
            An earlier version saved exchange keys unencrypted in Firestore. Delete that copy, then create new keys on the exchange, since
            the old ones may have been exposed.
          </p>
          <button
            type="button"
            onClick={deleteLegacy}
            disabled={deletingLegacy}
            className="self-start min-h-9 px-3.5 rounded-full bg-loss text-on-accent text-[13px] font-semibold cursor-pointer disabled:opacity-60"
          >
            {deletingLegacy ? "Deleting…" : "Delete the old keys"}
          </button>
        </div>
      )}

      <section aria-label="Recent activity" className="bg-surface border border-line rounded-[18px] px-3.5 py-3 flex flex-col gap-2.5">
        <div className="text-xs font-semibold text-muted uppercase tracking-[0.06em]">Recent activity</div>
        {activity.length === 0 ? (
          <p className="m-0 text-[13px] text-muted">Stopping and resuming trading, approvals and sign-ins show here.</p>
        ) : (
          <ul className="list-none m-0 p-0 flex flex-col gap-3">
            {activity.map((e) => {
              const a = activityOf(e);
              return (
                <li key={e.id} className="grid grid-cols-[14px_1fr_auto] gap-x-2.5 items-center text-[13px]">
                  <span aria-hidden="true" className={`w-2 h-2 rounded-full ${DOT[a.tone]}`} />
                  <span className="min-w-0 truncate">{a.label}</span>
                  <span className="text-muted tabular-nums">{activityTime(e)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Fold title="Copy this phone's memory to the cloud">
        <p className="m-0 text-xs text-muted leading-relaxed">
          The trades and the money are on the server already. This copies what this phone learned (its memory of past setups, and its stats) to your
          Firestore account, so a new phone can bring it back.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={backUp}
            disabled={sync.busy || !currentUser}
            className="flex-1 min-h-11 rounded-full border border-line bg-surface text-sm font-semibold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
          >
            <UploadCloud className="w-4 h-4" />
            Copy now
          </button>
          <button
            type="button"
            onClick={() => setConfirmRestore(true)}
            disabled={sync.busy || !currentUser}
            className="flex-1 min-h-11 rounded-full border border-line bg-surface text-sm font-semibold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
          >
            <DownloadCloud className="w-4 h-4" />
            Bring back
          </button>
        </div>
        {confirmRestore && (
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <span>Replace this phone's memory with the cloud copy?</span>
            <button type="button" onClick={restore} className="min-h-9 px-3.5 rounded-full bg-accent text-on-accent font-semibold cursor-pointer">
              Replace
            </button>
            <button type="button" onClick={() => setConfirmRestore(false)} className="min-h-9 px-3 text-muted cursor-pointer">
              Cancel
            </button>
          </div>
        )}
        {sync.message && (
          <div className="text-xs text-muted flex items-center gap-2">
            {sync.busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {sync.message}
          </div>
        )}
      </Fold>
    </Sheet>
  );
};
