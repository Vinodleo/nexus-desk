import React, { useState } from "react";
import { Play, Pause, ShieldCheck } from "lucide-react";
import type { BackgroundExecutionStatus } from "../services/backgroundTradingService";
import { usePWAInstall } from "../hooks/usePWAInstall";
import { Sheet, SheetLabel } from "./ledger/Sheet";
import { Switch } from "./ledger/ui";

interface BackgroundExecutionModalProps {
  isOpen: boolean;
  onClose: () => void;
  status: BackgroundExecutionStatus;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onToggleWakeLock: () => void;
  onToggleAudioKeepAlive: () => void;
  onRequestNotifications: () => void;
}

const Row: React.FC<{ label: string; sub: React.ReactNode; children: React.ReactNode }> = ({ label, sub, children }) => (
  <div className="flex items-center justify-between gap-3 min-h-14 py-2.5 border-b border-line last:border-b-0 text-sm">
    <div className="min-w-0">
      <div>{label}</div>
      <div className="text-xs text-muted mt-0.5 leading-relaxed">{sub}</div>
    </div>
    <div className="shrink-0">{children}</div>
  </div>
);

// Keeping the desk running on this device: the scanning heartbeat, the
// lock-screen keep-alive, screen wake lock, alerts and installing the app.
// Open positions are guarded by the server either way.
export const BackgroundExecutionModal: React.FC<BackgroundExecutionModalProps> = ({
  isOpen,
  onClose,
  status,
  isPlaying,
  onTogglePlay,
  onToggleWakeLock,
  onToggleAudioKeepAlive,
  onRequestNotifications,
}) => {
  const pwa = usePWAInstall();
  const [testSent, setTestSent] = useState(false);
  const [showIOSSteps, setShowIOSSteps] = useState(false);

  const alertsOn = status.notificationsPermission === "granted";
  const alertsBlocked = status.notificationsPermission === "denied" || status.notificationsPermission === "unsupported";

  const sendTest = () => {
    try {
      new Notification("Nexus Desk", {
        body: "Alerts are on. You'll hear about stops, targets and autopilot trades here.",
        icon: "/pwa-192x192.png",
      });
      setTestSent(true);
      setTimeout(() => setTestSent(false), 3000);
    } catch {
      // Some browsers only allow notifications from a service worker.
    }
  };

  return (
    <Sheet isOpen={isOpen} onClose={onClose} title="Run in the background" subtitle="Keep scanning and trading while this device is locked">
      <section className="bg-surface border border-line rounded-2xl p-3.5 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold">{isPlaying ? "Desk running" : "Desk paused"}</div>
          <div className="text-xs text-muted mt-0.5 tabular-nums">
            {isPlaying
              ? `Scanning and managing trades · ${status.heartbeatCount.toLocaleString("en-IN")} ticks`
              : "No scanning on this device until you start it"}
          </div>
        </div>
        <button
          type="button"
          onClick={onTogglePlay}
          className={`shrink-0 min-h-11 px-4 rounded-full font-semibold text-sm flex items-center gap-2 cursor-pointer ${
            isPlaying ? "border border-line bg-surface" : "bg-accent text-on-accent"
          }`}
        >
          {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          {isPlaying ? "Pause" : "Start"}
        </button>
      </section>

      <div className="flex gap-2.5 p-3.5 rounded-2xl bg-accent-soft text-accent text-[13px] leading-relaxed">
        <ShieldCheck className="w-5 h-5 shrink-0" strokeWidth={1.8} />
        <span>
          Open positions are guarded on the server, so stops and targets still work if this tab closes or the phone loses
          signal. The settings below keep new scanning going on this device.
        </span>
      </div>

      <SheetLabel>On this device</SheetLabel>
      <div className="bg-surface border border-line rounded-2xl px-3.5">
        <Row label="Keep running when locked" sub="Plays silent audio so the phone doesn't freeze the app">
          <Switch checked={status.isAudioKeepAliveActive} onChange={onToggleAudioKeepAlive} label="Keep running when locked" />
        </Row>
        <Row
          label="Keep the screen on"
          sub={status.wakeLockError ? <span className="text-loss">{status.wakeLockError}</span> : "Stops the display from sleeping"}
        >
          <Switch checked={status.isWakeLockActive} onChange={onToggleWakeLock} label="Keep the screen on" />
        </Row>
        <Row
          label="Trade alerts"
          sub={
            alertsBlocked
              ? "Blocked. Allow notifications for this site in your browser settings."
              : "Stops, targets and autopilot trades on the lock screen"
          }
        >
          {alertsOn ? (
            <button type="button" onClick={sendTest} className="min-h-9 px-3.5 rounded-full border border-line text-[13px] font-semibold cursor-pointer">
              {testSent ? "Sent" : "Test"}
            </button>
          ) : (
            <button
              type="button"
              onClick={onRequestNotifications}
              disabled={alertsBlocked}
              className="min-h-9 px-3.5 rounded-full bg-accent text-on-accent text-[13px] font-semibold cursor-pointer disabled:opacity-50"
            >
              Allow
            </button>
          )}
        </Row>
      </div>

      {!pwa.isInstalled && (pwa.isInstallable || pwa.isIOS) && (
        <>
          <SheetLabel>Install</SheetLabel>
          <div className="bg-surface border border-line rounded-2xl p-3.5 flex flex-col gap-2.5">
            <div className="text-[13px] text-muted leading-relaxed">
              As a home-screen app, Nexus Desk runs full screen and is less likely to be paused by the browser.
            </div>
            {pwa.isInstallable ? (
              <button
                type="button"
                onClick={() => void pwa.install()}
                className="self-start min-h-10 px-4 rounded-full bg-accent text-on-accent text-sm font-semibold cursor-pointer"
              >
                Install the app
              </button>
            ) : showIOSSteps ? (
              <ol className="m-0 pl-5 text-[13px] leading-relaxed">
                <li>Tap the Share button in Safari.</li>
                <li>Choose Add to Home Screen.</li>
                <li>Open Nexus Desk from the new icon.</li>
              </ol>
            ) : (
              <button
                type="button"
                onClick={() => setShowIOSSteps(true)}
                className="self-start min-h-10 px-4 rounded-full border border-line text-sm font-semibold cursor-pointer"
              >
                How to add to Home Screen
              </button>
            )}
          </div>
        </>
      )}
    </Sheet>
  );
};
