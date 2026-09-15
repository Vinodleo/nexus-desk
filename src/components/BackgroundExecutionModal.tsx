import React, { useState } from 'react';
import {
  BackgroundExecutionStatus,
} from '../services/backgroundTradingService';
import { PWAInstallButton } from './PWAInstallButton';
import {
  Moon,
  Sun,
  Shield,
  Bell,
  Activity,
  Smartphone,
  CheckCircle2,
  AlertTriangle,
  X,
  Radio,
  Cpu,
  RefreshCw,
  Power,
  VolumeX,
} from 'lucide-react';

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
  const [testNotificationSent, setTestNotificationSent] = useState(false);

  if (!isOpen) return null;

  const handleTestNotification = () => {
    if (status.notificationsPermission !== 'granted') {
      onRequestNotifications();
      return;
    }

    try {
      new Notification('⚡ Nexus Desk Background Active', {
        body: 'Trading engine is executing live in background. Stop-loss & auto-approvals active.',
        icon: '/pwa-192x192.png',
      });
      setTestNotificationSent(true);
      setTimeout(() => setTestNotificationSent(false), 3000);
    } catch {
      // Fallback
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 overflow-y-auto animate-in fade-in duration-150">
      <div className="w-full max-w-xl rounded-2xl bg-[#0f1118] border border-[#222736] p-6 shadow-2xl space-y-5 text-stone-200 my-auto">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#202533] pb-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-cyan-950/80 border border-cyan-700/60 text-cyan-400">
              <Radio className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-mono font-bold text-white tracking-wide">
                  24/7 Background Execution Engine
                </h3>
                <span className="px-2 py-0.5 rounded-full bg-cyan-950 border border-cyan-800 text-[10px] font-mono text-cyan-300 uppercase">
                  PWA + Worker
                </span>
              </div>
              <p className="text-xs text-stone-400 font-sans mt-0.5">
                Run the trading desk autonomously even when your phone is locked or minimized.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-stone-800 text-stone-400 hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Master Running Status Card */}
        <div className="p-4 rounded-xl bg-[#141824] border border-[#252c40] space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-cyan-400" />
              <span className="text-xs font-mono font-bold text-stone-200">
                Live Trading Engine Heartbeat
              </span>
            </div>
            <div className="flex items-center gap-2">
              {isPlaying ? (
                <span className="px-2.5 py-1 rounded-full bg-emerald-950/90 border border-emerald-600/70 text-emerald-300 text-[11px] font-mono font-bold flex items-center gap-1.5 shadow-sm">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  ACTIVE ({status.heartbeatCount} ticks)
                </span>
              ) : (
                <span className="px-2.5 py-1 rounded-full bg-stone-900 border border-stone-800 text-stone-400 text-[11px] font-mono">
                  PAUSED
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between pt-1">
            <p className="text-xs text-stone-300 font-sans leading-relaxed">
              When enabled, a background Web Worker continuously drives market bars, radar scanning, position stop-losses, and autonomous limit order approvals.
            </p>
            <button
              onClick={onTogglePlay}
              className={`ml-4 shrink-0 px-3.5 py-2 rounded-xl font-mono text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                isPlaying
                  ? 'bg-rose-950/80 hover:bg-rose-900 border border-rose-700/60 text-rose-200'
                  : 'bg-emerald-600 hover:bg-emerald-500 text-stone-950'
              }`}
            >
              <Power className="w-3.5 h-3.5" />
              <span>{isPlaying ? 'Pause Desk' : 'Start Desk'}</span>
            </button>
          </div>
        </div>

        {/* 3 Key Background Capabilities */}
        <div className="space-y-3">
          <h4 className="text-[11px] font-mono text-stone-400 uppercase tracking-wider">
            Mobile & Lock-Screen Guardians
          </h4>

          {/* 1. Locked Screen Execution (Audio Guardian) */}
          <div className="p-3.5 rounded-xl bg-[#11141d] border border-[#1f2433] flex items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <VolumeX className="w-4 h-4 text-cyan-400" />
                <span className="text-xs font-mono font-bold text-white">
                  Lock-Screen Keep-Alive (Audio Guardian)
                </span>
                {status.isAudioKeepAliveActive ? (
                  <span className="px-2 py-0.5 rounded bg-emerald-950 border border-emerald-700 text-emerald-300 text-[10px] font-mono">
                    ONLINE
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded bg-stone-900 border border-stone-800 text-stone-500 text-[10px] font-mono">
                    OFF
                  </span>
                )}
              </div>
              <p className="text-[11px] text-stone-400 font-sans leading-relaxed">
                Mobile operating systems (iOS Safari and Android) aggressively freeze JavaScript when you press the lock button.
                This utilizes an inaudible Web Audio loop to retain high-priority OS execution so the bot keeps trading in your pocket.
              </p>
            </div>
            <button
              onClick={onToggleAudioKeepAlive}
              className={`shrink-0 px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-all cursor-pointer ${
                status.isAudioKeepAliveActive
                  ? 'bg-emerald-950 border border-emerald-600 text-emerald-300 hover:bg-emerald-900'
                  : 'bg-stone-800 border border-stone-700 text-stone-300 hover:bg-stone-700'
              }`}
            >
              {status.isAudioKeepAliveActive ? 'Enabled' : 'Enable'}
            </button>
          </div>

          {/* 2. Screen Wake Lock (Prevent Screen Sleep) */}
          <div className="p-3.5 rounded-xl bg-[#11141d] border border-[#1f2433] flex items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Sun className="w-4 h-4 text-amber-400" />
                <span className="text-xs font-mono font-bold text-white">
                  Prevent Device Lock (Always-On Kiosk)
                </span>
                {status.isWakeLockActive ? (
                  <span className="px-2 py-0.5 rounded bg-amber-950 border border-amber-700 text-amber-300 text-[10px] font-mono">
                    SCREEN AWAKE
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded bg-stone-900 border border-stone-800 text-stone-500 text-[10px] font-mono">
                    DEFAULT
                  </span>
                )}
              </div>
              <p className="text-[11px] text-stone-400 font-sans leading-relaxed">
                Holds the Screen Wake Lock API to prevent your phone or computer from turning off the display, keeping the live trading floor visible and running continuously.
              </p>
              {status.wakeLockError && (
                <p className="text-[10px] font-mono text-rose-400">
                  {status.wakeLockError}
                </p>
              )}
            </div>
            <button
              onClick={onToggleWakeLock}
              className={`shrink-0 px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-all cursor-pointer ${
                status.isWakeLockActive
                  ? 'bg-amber-950 border border-amber-600 text-amber-300 hover:bg-amber-900'
                  : 'bg-stone-800 border border-stone-700 text-stone-300 hover:bg-stone-700'
              }`}
            >
              {status.isWakeLockActive ? 'Active' : 'Keep Awake'}
            </button>
          </div>

          {/* 3. Lock-Screen Push Notifications */}
          <div className="p-3.5 rounded-xl bg-[#11141d] border border-[#1f2433] flex items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Bell className="w-4 h-4 text-cyan-400" />
                <span className="text-xs font-mono font-bold text-white">
                  Lock-Screen Trade Notifications
                </span>
                {status.notificationsPermission === 'granted' ? (
                  <span className="px-2 py-0.5 rounded bg-emerald-950 border border-emerald-700 text-emerald-300 text-[10px] font-mono">
                    PERMITTED
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded bg-stone-900 border border-stone-800 text-stone-500 text-[10px] font-mono">
                    {status.notificationsPermission.toUpperCase()}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-stone-400 font-sans leading-relaxed">
                Receive lock-screen banner alerts whenever a trade is autonomously approved, a stop-loss is triggered, or a take-profit target is achieved while your device is locked.
              </p>
            </div>
            <div className="flex flex-col gap-1.5 shrink-0">
              {status.notificationsPermission !== 'granted' ? (
                <button
                  onClick={onRequestNotifications}
                  className="px-3 py-1.5 rounded-lg bg-cyan-950 border border-cyan-700 text-cyan-300 hover:bg-cyan-900 text-xs font-mono font-bold transition-all cursor-pointer"
                >
                  Allow Alerts
                </button>
              ) : (
                <button
                  onClick={handleTestNotification}
                  className="px-3 py-1.5 rounded-lg bg-stone-800 border border-stone-700 text-stone-300 hover:bg-stone-700 text-xs font-mono transition-all cursor-pointer"
                >
                  {testNotificationSent ? 'Sent!' : 'Test Notification'}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* PWA Standalone App Option */}
        <div className="p-3.5 rounded-xl bg-[#090b10] border border-[#1d2230] space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Smartphone className="w-4 h-4 text-cyan-400" />
              <span className="text-xs font-mono font-bold text-stone-200">
                Install as Home Screen App (PWA)
              </span>
            </div>
            <PWAInstallButton variant="compact" />
          </div>
          <p className="text-[11px] text-stone-400 font-sans leading-relaxed">
            Running Nexus Desk as an installed standalone app isolates it from browser tab limits, provides full-screen institutional view, and maximizes background task priority.
          </p>
        </div>

        {/* Telemetry & Reconciled Sleep Cycles */}
        <div className="grid grid-cols-3 gap-2.5 p-3 rounded-xl bg-[#0b0d13] border border-[#181c26] text-xs font-mono">
          <div>
            <span className="text-[10px] text-stone-500 uppercase block">Worker Heartbeats</span>
            <div className="text-cyan-300 font-bold mt-0.5">{status.heartbeatCount}</div>
          </div>
          <div>
            <span className="text-[10px] text-stone-500 uppercase block">Sleep Reconciled</span>
            <div className="text-emerald-400 font-bold mt-0.5">+{status.totalReconciledCycles} bars</div>
          </div>
          <div>
            <span className="text-[10px] text-stone-500 uppercase block">Lock-Screen State</span>
            <div className="text-stone-300 font-bold mt-0.5 truncate">
              {status.isAudioKeepAliveActive ? 'Protected' : 'Standard'}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-2 border-t border-[#1c212c]">
          <span className="text-[11px] font-mono text-stone-500 flex items-center gap-1.5">
            <Shield className="w-3.5 h-3.5 text-emerald-400" />
            <span>Fail-closed execution remains active in background</span>
          </span>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-stone-100 hover:bg-white text-stone-950 font-mono text-xs font-bold transition-all cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
