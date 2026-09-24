import React, { useEffect, useState } from "react";
import { UploadCloud, DownloadCloud, Loader2, AlertTriangle } from "lucide-react";
import { syncToFirebase, syncFromFirebase, hasLegacyExchangeKeys, deleteLegacyExchangeKeys } from "../services/storagePersistenceService";
import { apiFetch } from "../services/apiClient";
import type { CoinDcxServerStatus } from "../types";
import { useAuth, type UserRole } from "../context/AuthContext";
import { Sheet, SheetLabel } from "./ledger/Sheet";

interface SecurityConsoleModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const ROLES: { id: UserRole; label: string; sub: string }[] = [
  { id: "commander", label: "Commander", sub: "Everything, including autopilot and Stop all" },
  { id: "trader", label: "Trader", sub: "Approve proposals and close positions" },
  { id: "auditor", label: "Auditor", sub: "Look only; can't trade or change settings" },
];

/** "KILL_SWITCH_ENGAGED" -> "Kill switch engaged" */
export function auditLabel(action: string): string {
  const s = action.toLowerCase().replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const Group: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="bg-surface border border-line rounded-2xl px-3.5 [&>*:last-child]:border-b-0">{children}</div>
);

const Row: React.FC<{ label: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode }> = ({ label, sub, children }) => (
  <div className="flex items-center justify-between gap-3 min-h-12 py-2 border-b border-line text-sm">
    <div className="min-w-0">
      <div>{label}</div>
      {sub && <div className="text-xs text-muted mt-0.5">{sub}</div>}
    </div>
    {children && <div className="shrink-0 font-semibold">{children}</div>}
  </div>
);

// Security and access: the signed-in account, the role that gates actions,
// where exchange keys live, cloud backup of the desk's memory, and the log.
export const SecurityConsoleModal: React.FC<SecurityConsoleModalProps> = ({ isOpen, onClose }) => {
  const { currentUser, userProfile, userRole, switchUserRole, logout, recentAudits, logSecurityAudit } = useAuth();
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
    setSync({ busy: true, message: "Backing up…" });
    await syncToFirebase(currentUser.uid);
    await logSecurityAudit("CLOUD_SYNC_PUSH", "Pushed local trading memory and telemetry to Cloud Firestore.");
    setSync({ busy: false, message: "Backed up to the cloud." });
  };

  const restore = async () => {
    if (!currentUser) return;
    setConfirmRestore(false);
    setSync({ busy: true, message: "Restoring…" });
    const ok = await syncFromFirebase(currentUser.uid);
    if (ok) {
      await logSecurityAudit("CLOUD_SYNC_PULL", "Downloaded cloud trading memory to local device.");
      setSync({ busy: true, message: "Restored. Reloading…" });
      setTimeout(() => window.location.reload(), 1200);
    } else {
      setSync({ busy: false, message: "Couldn't restore from the cloud." });
    }
  };

  const name = currentUser?.displayName || userProfile?.displayName || "You";
  const live = status?.liveRisk;

  return (
    <Sheet isOpen={isOpen} onClose={onClose} title="Security and access" subtitle="Your account, role, keys and activity">
      <SheetLabel>Account</SheetLabel>
      <Group>
        <div className="flex items-center gap-3 py-3 border-b border-line">
          <div className="w-11 h-11 shrink-0 rounded-full bg-accent-soft text-accent font-display text-lg flex items-center justify-center">
            {(name[0] || "Y").toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold truncate">{name}</div>
            <div className="text-xs text-muted truncate">
              {currentUser?.email || "Not signed in"}
              {userProfile?.provider ? ` · ${userProfile.provider}` : ""}
            </div>
          </div>
          {currentUser && (
            <button
              type="button"
              onClick={() => void logout()}
              className="shrink-0 min-h-9 px-3.5 rounded-full border border-line text-[13px] font-semibold text-loss cursor-pointer"
            >
              Sign out
            </button>
          )}
        </div>
      </Group>

      <SheetLabel>Role</SheetLabel>
      <div className="flex flex-col gap-2" role="radiogroup" aria-label="Role">
        {ROLES.map((r) => {
          const on = userRole === r.id;
          return (
            <button
              key={r.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => void switchUserRole(r.id)}
              className={`flex items-center justify-between gap-3 p-3.5 rounded-2xl border text-left cursor-pointer ${
                on ? "border-accent bg-accent-soft" : "border-line bg-surface"
              }`}
            >
              <span>
                <span className={`block text-sm font-semibold ${on ? "text-accent" : ""}`}>{r.label}</span>
                <span className="block text-xs text-muted mt-0.5">{r.sub}</span>
              </span>
              <span
                className={`w-5 h-5 shrink-0 rounded-full border-2 ${on ? "border-accent bg-accent shadow-[inset_0_0_0_3px_var(--nx-accent-soft)]" : "border-line"}`}
                aria-hidden="true"
              />
            </button>
          );
        })}
      </div>

      <SheetLabel>Exchange keys</SheetLabel>
      <Group>
        <Row label="CoinDCX" sub={status?.configured ? `Key ${status.keyMasked ?? ""}` : "Not set up on the server"}>
          <span className={status?.configured ? "text-gain" : "text-muted"}>{status ? (status.configured ? "Set" : "Missing") : "…"}</span>
        </Row>
        <Row label="Live orders" sub="Allowed only when LIVE_TRADING_ENABLED is true">
          <span className={live?.enabled ? "text-warn" : "text-muted"}>{live ? (live.enabled ? "Allowed" : "Blocked") : "…"}</span>
        </Row>
        <p className="m-0 py-3 text-xs text-muted leading-relaxed">
          Keys are set as environment variables on the server and never reach this browser. Create them with withdrawals
          turned off.
        </p>
      </Group>
      {hasLegacyKeys && (
        <div className="flex flex-col gap-2 p-3.5 rounded-2xl bg-danger-soft border border-danger-line text-[13px] leading-relaxed">
          <div className="flex gap-2 text-loss font-semibold">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            Old keys found in your cloud profile
          </div>
          <p className="m-0">
            An earlier version saved exchange keys unencrypted in Firestore. Delete that copy, then create new keys on the
            exchange, since the old ones may have been exposed.
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

      <SheetLabel>Cloud backup</SheetLabel>
      <Group>
        <p className="m-0 py-3 border-b border-line text-xs text-muted leading-relaxed">
          Copies the desk's memory, trades and stats to your Firestore account, so another device can pick them up.
        </p>
        <div className="flex gap-2 py-3">
          <button
            type="button"
            onClick={backUp}
            disabled={sync.busy || !currentUser}
            className="flex-1 min-h-11 rounded-full border border-line bg-surface text-sm font-semibold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
          >
            <UploadCloud className="w-4 h-4" />
            Back up now
          </button>
          <button
            type="button"
            onClick={() => setConfirmRestore(true)}
            disabled={sync.busy || !currentUser}
            className="flex-1 min-h-11 rounded-full border border-line bg-surface text-sm font-semibold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
          >
            <DownloadCloud className="w-4 h-4" />
            Restore
          </button>
        </div>
        {confirmRestore && (
          <div className="flex flex-wrap items-center gap-2 pb-3 text-[13px]">
            <span>Replace this device's data with the cloud copy?</span>
            <button type="button" onClick={restore} className="min-h-9 px-3.5 rounded-full bg-accent text-on-accent font-semibold cursor-pointer">
              Restore
            </button>
            <button type="button" onClick={() => setConfirmRestore(false)} className="min-h-9 px-3 text-muted cursor-pointer">
              Cancel
            </button>
          </div>
        )}
        {sync.message && (
          <div className="pb-3 text-xs text-muted flex items-center gap-2">
            {sync.busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {sync.message}
          </div>
        )}
      </Group>

      <SheetLabel>Activity</SheetLabel>
      {recentAudits.length === 0 ? (
        <p className="m-0 text-[13px] text-muted px-1">Sign-ins, role changes, Stop all and orders will be listed here.</p>
      ) : (
        <ul className="list-none m-0 p-0 bg-surface border border-line rounded-2xl px-3.5">
          {recentAudits.slice(0, 20).map((e) => (
            <li key={e.id} className="py-2.5 border-b border-line last:border-b-0">
              <div className="flex justify-between gap-3 text-sm">
                <span className="font-semibold">{auditLabel(e.action)}</span>
                <span className="text-xs text-muted tabular-nums shrink-0">{e.timestamp}</span>
              </div>
              <div className="text-xs text-muted mt-0.5">{e.details}</div>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
};
