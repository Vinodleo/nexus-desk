import React from 'react';
import { BackgroundExecutionStatus } from '../services/backgroundTradingService';
import { Radio, Moon, Sun, VolumeX, ShieldCheck } from 'lucide-react';

interface BackgroundExecutionBadgeProps {
  status: BackgroundExecutionStatus;
  isPlaying: boolean;
  onClick: () => void;
  className?: string;
}

export const BackgroundExecutionBadge: React.FC<BackgroundExecutionBadgeProps> = ({
  status,
  isPlaying,
  onClick,
  className = '',
}) => {
  const isProtected = status.isAudioKeepAliveActive || status.isWakeLockActive;

  return (
    <button
      onClick={onClick}
      className={`group flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-mono transition-all cursor-pointer ${
        isProtected && isPlaying
          ? 'bg-emerald-950/70 hover:bg-emerald-900/80 border-emerald-600/70 text-emerald-300 shadow-sm'
          : isPlaying
          ? 'bg-cyan-950/60 hover:bg-cyan-900/70 border-cyan-700/50 text-cyan-300'
          : 'bg-[#12141c] hover:bg-[#181b26] border-stone-800 text-stone-400'
      } ${className}`}
      title="Configure 24/7 background execution & locked-device running mode"
    >
      {isProtected && isPlaying ? (
        <>
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
          </span>
          <span className="font-semibold text-[11px]">BG LOCKED: ON</span>
        </>
      ) : isPlaying ? (
        <>
          <Radio className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
          <span className="font-semibold text-[11px]">BG RUNNING</span>
        </>
      ) : (
        <>
          <Moon className="w-3.5 h-3.5 text-stone-500" />
          <span className="text-[11px]">BG IDLE</span>
        </>
      )}

      {status.isWakeLockActive && (
        <span title="Screen Wake Lock Active">
          <Sun className="w-3 h-3 text-amber-400 ml-0.5" aria-label="Screen Wake Lock Active" />
        </span>
      )}
      {status.isAudioKeepAliveActive && (
        <span title="Lock-Screen Audio Guardian Active">
          <VolumeX className="w-3 h-3 text-emerald-400 ml-0.5" aria-label="Lock-Screen Audio Guardian Active" />
        </span>
      )}
    </button>
  );
};
