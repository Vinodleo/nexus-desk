import React, { useState } from 'react';
import { usePWAInstall } from '../hooks/usePWAInstall';
import { Download, Smartphone, X, CheckCircle2, Share2, PlusSquare } from 'lucide-react';

interface PWAInstallButtonProps {
  className?: string;
  variant?: 'compact' | 'full';
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({
  className = '',
  variant = 'compact',
}) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  // If already running as an installed standalone PWA, show a badge or null
  if (isInstalled) {
    if (variant === 'full') {
      return (
        <div className={`flex items-center gap-2 px-3 py-2 rounded-xl bg-emerald-950/40 border border-emerald-700/50 text-emerald-300 text-xs font-mono ${className}`}>
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          <span>Installed as Standalone App</span>
        </div>
      );
    }
    return null;
  }

  return (
    <>
      {/* Chromium / Android / Desktop Install Flow */}
      {isInstallable && (
        <button
          onClick={install}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-cyan-950/80 hover:bg-cyan-900/90 border border-cyan-700/60 text-cyan-300 text-xs font-mono transition-all shadow-sm cursor-pointer ${className}`}
          title="Install Nexus Desk to run in standalone background mode"
        >
          <Download className="w-3.5 h-3.5 text-cyan-400" />
          <span>Install App</span>
        </button>
      )}

      {/* iOS Safari Flow */}
      {isIOS && (
        <button
          onClick={() => setShowIOSGuide(true)}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#141724] hover:bg-[#1a2030] border border-cyan-800/50 text-cyan-300 text-xs font-mono transition-all cursor-pointer ${className}`}
          title="Install on iPhone / iPad home screen"
        >
          <Smartphone className="w-3.5 h-3.5 text-cyan-400" />
          <span>Add to Home</span>
        </button>
      )}

      {/* Fallback Install Guide Modal for iOS */}
      {showIOSGuide && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-sm rounded-2xl bg-[#12141c] border border-stone-800 p-6 shadow-2xl space-y-4 text-stone-200">
            <div className="flex items-center justify-between border-b border-stone-800 pb-3">
              <div className="flex items-center gap-2">
                <Smartphone className="w-5 h-5 text-cyan-400" />
                <h3 className="text-sm font-mono font-bold text-white uppercase tracking-wider">
                  Install on iPhone / iPad
                </h3>
              </div>
              <button
                onClick={() => setShowIOSGuide(false)}
                className="p-1 rounded-lg hover:bg-stone-800 text-stone-400 hover:text-white transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-stone-300 leading-relaxed font-sans">
              Installing Nexus Desk on your home screen enables standalone execution, full-screen trading, and continuous background session stability:
            </p>

            <div className="space-y-3 bg-[#0a0c12] p-3.5 rounded-xl border border-stone-800/80 text-xs font-mono text-stone-300">
              <div className="flex items-start gap-2.5">
                <div className="p-1 rounded bg-stone-800 text-cyan-400 mt-0.5">
                  <Share2 className="w-3.5 h-3.5" />
                </div>
                <div>
                  <span className="font-bold text-white">Step 1:</span> Tap the <strong className="text-cyan-300">Share</strong> button at the bottom of Safari.
                </div>
              </div>
              <div className="flex items-start gap-2.5">
                <div className="p-1 rounded bg-stone-800 text-emerald-400 mt-0.5">
                  <PlusSquare className="w-3.5 h-3.5" />
                </div>
                <div>
                  <span className="font-bold text-white">Step 2:</span> Scroll down and tap <strong className="text-emerald-300">Add to Home Screen</strong>.
                </div>
              </div>
            </div>

            <button
              onClick={() => setShowIOSGuide(false)}
              className="w-full py-2.5 rounded-xl bg-stone-100 hover:bg-white text-stone-950 font-mono text-xs font-bold transition-all cursor-pointer"
            >
              Got It
            </button>
          </div>
        </div>
      )}
    </>
  );
};
