import React from "react";
import { Sparkles, ShieldCheck, Shield, Lock, Check } from "lucide-react";
import { DecisionMode } from "../types";
import { useAuth } from "../context/AuthContext";
import { BackgroundExecutionStatus } from "../services/backgroundTradingService";
import { BackgroundExecutionBadge } from "./BackgroundExecutionBadge";
import { PWAInstallButton } from "./PWAInstallButton";

import { useLiveTickers } from "../hooks/useLiveTickers";

export interface TickerTapeItem {
  symbol: string;
  price: string;
  change: string;
  isPositive: boolean;
  direction?: "up" | "down" | "none";
}

interface NexusHeaderProps {
  equity: number;
  dailyPnl: number;
  netPnl?: number;
  cash: number;
  openCount: number;
  maxPositions: number;
  decisionMode: DecisionMode;
  onDecisionModeChange: (mode: DecisionMode) => void;
  onOpenLab: () => void;
  onWakeCommander: () => void;
  killSwitchActive: boolean;
  onToggleKillSwitch: () => void;
  tapeMode: "SIMULATED TAPE" | "LIVE TAPE";
  onToggleTapeMode?: () => void;
  onOpenSecurityConsole?: () => void;
  modelAccuracyPct?: number;
  isLabPromoted?: boolean;
  promotedDatasetName?: string;
  backgroundStatus?: BackgroundExecutionStatus;
  isPlaying?: boolean;
  onOpenBackgroundModal?: () => void;
}


const PriceTick = ({ price, direction }: { price: string, direction?: "up" | "down" | "none" }) => {
  const [flash, setFlash] = React.useState<"up" | "down" | "none">("none");
  
  React.useEffect(() => {
    if (direction && direction !== "none") {
      setFlash(direction);
      const t = setTimeout(() => setFlash("none"), 300);
      return () => clearTimeout(t);
    }
  }, [price, direction]);

  return (
    <span className={`transition-colors duration-300 rounded px-0.5 ${
      flash === "up" ? "bg-emerald-500/30 text-emerald-300" :
      flash === "down" ? "bg-rose-500/30 text-rose-300" :
      "text-stone-200"
    }`}>
      {price}
    </span>
  );
};

export const NexusHeader: React.FC<NexusHeaderProps> = ({
  equity,
  dailyPnl,
  netPnl = 0,
  cash,
  openCount,
  maxPositions = 5,
  decisionMode,
  onDecisionModeChange,
  onOpenLab,
  onWakeCommander,
  killSwitchActive,
  onToggleKillSwitch,
  tapeMode,
  onToggleTapeMode,
  onOpenSecurityConsole,
  modelAccuracyPct,
  isLabPromoted = false,
  promotedDatasetName,
  backgroundStatus,
  isPlaying = false,
  onOpenBackgroundModal,
}) => {
  const { currentUser, userProfile, userRole, openAuthModal } = useAuth();
  const dailyPct = (dailyPnl / (equity || 100000)) * 100;
  const isPnlPositive = dailyPnl >= 0;

  const liveCrypto = useLiveTickers();

  // Realistic Indian equities, macro and combine with live crypto
  // We removed the hardcoded Indian Equities to keep this a dedicated Crypto dashboard.
  // We will build a completely separate Zerodha/Indian Equities dashboard later.
  const staticItems: TickerTapeItem[] = [];

  const liveItems: TickerTapeItem[] = liveCrypto.map(tc => ({
    symbol: tc.symbol,
    price: tc.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }),
    change: `${tc.changePercent > 0 ? '+' : ''}${tc.changePercent.toFixed(2)}%`,
    isPositive: tc.changePercent >= 0,
    direction: tc.direction
  }));

  const tickerItems = [...staticItems, ...liveItems];

  return (
    <header className="w-full bg-[#0a0a0c] border-b border-[#1f1f24] select-none">
      <div className="max-w-7xl mx-auto px-3 sm:px-4 pt-3 pb-2.5">
        {/* Top Branding Row */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Sparkles className="w-4 h-4 text-stone-200 shrink-0" />
            <span className="font-sans text-sm sm:text-base font-semibold tracking-wide text-white truncate">
              Nexus Desk
            </span>
            
            {/* Market Segment Toggle */}
            <div className="flex items-center gap-1 ml-2 sm:ml-4 bg-[#0a0a0c] p-0.5 rounded-lg border border-[#1f1f24] overflow-x-auto hide-scrollbar">
              <button className="whitespace-nowrap px-2 sm:px-3 py-1 text-[10px] sm:text-xs font-semibold rounded-md bg-[#1f1f24] text-emerald-400 shadow-sm border border-[#2a2a30]">
                Crypto (CoinDCX)
              </button>
              <button 
                className="whitespace-nowrap px-2 sm:px-3 py-1 text-[10px] sm:text-xs font-semibold rounded-md text-stone-500 hover:text-stone-300 transition-colors"
                onClick={() => alert("Zerodha Indian Equities dashboard module will be built here next!")}
              >
                Indian Equities 🔒
              </button>
            </div>

            <span className="hidden sm:inline-flex items-center gap-1 text-[10px] font-mono text-emerald-400 shrink-0 ml-2">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span>RADAR LIVE</span>
            </span>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 text-[10px] font-mono tracking-wider text-stone-400 shrink-0">
            <span className="hidden md:inline text-stone-400">350</span>
            <span className="hidden md:inline text-stone-600">·</span>
            <span className="hidden md:inline text-stone-300">CHAMPION</span>
            {isLabPromoted && (
              <span
                className="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-cyan-950/80 border border-cyan-700/60 text-cyan-300 text-[9px]"
                title={`Integrated with Promoted Lab Model: ${promotedDatasetName || ""}`}
              >
                LAB INTEGRATED
              </span>
            )}
            {modelAccuracyPct && (
              <>
                <span className="hidden md:inline text-stone-600">·</span>
                <button
                  onClick={onOpenLab}
                  className="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-950/80 border border-emerald-700/60 text-emerald-300 text-[9px] hover:text-white transition-colors cursor-pointer"
                  title="Calibrated Model Accuracy (Click to open Lab)"
                >
                  <span className="font-semibold">{modelAccuracyPct}%</span>
                  <span className="text-emerald-500/80">ACC</span>
                </button>
              </>
            )}
            <span className="hidden sm:inline text-stone-600">·</span>
            <button
              onClick={onToggleTapeMode}
              className="hidden sm:inline hover:text-stone-200 cursor-pointer transition-colors"
              title="Toggle simulated vs live tape feed"
            >
              {tapeMode}
            </button>
            <span className="hidden sm:inline text-stone-600">·</span>
            <span className="hidden sm:inline px-1 py-0.5 rounded bg-stone-900 border border-stone-800 text-[9px] text-stone-300">
              PAPER
            </span>

            {/* Clean, Visible Security & Operator Clearance Button */}
            <button
              onClick={onOpenSecurityConsole || openAuthModal}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-emerald-950/80 hover:bg-emerald-900 border border-emerald-700/60 text-emerald-300 hover:text-white transition-all cursor-pointer text-[10px] font-mono shadow-xs"
              title="Open Firebase Security & RBAC Console"
            >
              <Lock className="w-3 h-3 text-emerald-400 shrink-0" />
              <span className="font-bold uppercase tracking-wider">{userRole}</span>
              <span className="text-emerald-500/70 hidden sm:inline">·</span>
              <span className="text-emerald-200/90 hidden sm:inline font-normal">SECURITY</span>
            </button>
          </div>
        </div>

        {/* Key Metrics Row */}
        <div className="grid grid-cols-5 gap-1.5 sm:gap-2 my-2.5 sm:my-3 pt-1 text-left">
          <div className="min-w-0">
            <div className="text-[9px] sm:text-[10px] font-mono tracking-wider text-stone-400 uppercase">
              Equity
            </div>
            <div className="text-xs sm:text-base font-mono font-medium text-stone-100 mt-0.5 truncate">
              ₹{equity.toLocaleString("en-IN")}
            </div>
          </div>

          <div className="min-w-0">
            <div className="text-[9px] sm:text-[10px] font-mono tracking-wider text-stone-400 uppercase">
              Day
            </div>
            <div
              className={`text-xs sm:text-base font-mono font-medium mt-0.5 truncate ${
                dailyPnl === 0
                  ? "text-stone-300"
                  : isPnlPositive
                  ? "text-emerald-400"
                  : "text-rose-400"
              }`}
            >
              {dailyPnl === 0 ? "" : isPnlPositive ? "+" : "-"}₹{Math.abs(dailyPnl).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{" "}
              <span className="text-[9px] sm:text-[11px]">
                {dailyPct >= 0 ? "+" : ""}
                {dailyPct.toFixed(2)}%
              </span>
            </div>
          </div>

          <div className="min-w-0">
            <div className="text-[9px] sm:text-[10px] font-mono tracking-wider text-stone-400 uppercase">
              All-Time
            </div>
            <div
              className={`text-xs sm:text-base font-mono font-medium mt-0.5 truncate ${
                netPnl === 0
                  ? "text-stone-300"
                  : netPnl > 0
                  ? "text-emerald-400"
                  : "text-rose-400"
              }`}
            >
              {netPnl === 0 ? "" : netPnl > 0 ? "+" : "-"}₹{Math.abs(netPnl).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>
          <div className="min-w-0">
            <div className="text-[9px] sm:text-[10px] font-mono tracking-wider text-stone-400 uppercase">
              Cash
            </div>
            <div className="text-xs sm:text-base font-mono font-medium text-stone-100 mt-0.5 truncate">
              ₹{cash.toLocaleString("en-IN")}
            </div>
          </div>

          <div className="min-w-0">
            <div className="text-[9px] sm:text-[10px] font-mono tracking-wider text-stone-400 uppercase">
              Gross
            </div>
            <div className="text-xs sm:text-base font-mono font-medium text-stone-100 mt-0.5 truncate">
              {openCount === 0 ? "0%" : `${((openCount / maxPositions) * 100).toFixed(0)}%`}{" "}
              <span className="text-[9px] sm:text-[11px] text-stone-400">
                · {openCount}/{maxPositions}
              </span>
            </div>
          </div>
        </div>

        {/* Quick Action Buttons Row */}
        <div className="flex items-center justify-between gap-2 mb-2.5 sm:mb-3 flex-wrap">
          <div className="flex items-center gap-2">
            <button
              onClick={onOpenLab}
              className="px-3 sm:px-4 py-1.5 rounded-lg bg-[#141418] border border-[#2b2b32] hover:bg-[#1a1a20] hover:border-stone-500 text-stone-200 text-xs font-mono tracking-wide transition-all cursor-pointer"
            >
              Lab
            </button>

            <button
              onClick={onWakeCommander}
              className="px-3 sm:px-4 py-1.5 rounded-lg bg-stone-100 hover:bg-white text-stone-900 text-xs font-mono font-medium tracking-wide shadow-sm hover:shadow transition-all flex items-center gap-1.5 cursor-pointer"
            >
              <span>Wake commander</span>
              <span className="opacity-60">· 2</span>
            </button>
          </div>

          <div className="flex items-center gap-2">
            {backgroundStatus && onOpenBackgroundModal && (
              <BackgroundExecutionBadge
                status={backgroundStatus}
                isPlaying={isPlaying}
                onClick={onOpenBackgroundModal}
              />
            )}
            <PWAInstallButton variant="compact" />
          </div>
        </div>

        {/* Control Mode Pills Row */}
        <div className="grid grid-cols-4 gap-1 bg-[#121215] p-1 rounded-xl border border-[#222227]">
          <button
            onClick={onToggleKillSwitch}
            className={`py-1.5 px-0.5 rounded-lg text-center font-mono text-[10px] sm:text-[11px] tracking-wider transition-all cursor-pointer truncate ${
              killSwitchActive
                ? "bg-rose-950 text-rose-300 border border-rose-600 font-semibold"
                : "text-stone-400 hover:text-stone-200 hover:bg-white/5"
            }`}
          >
            KILL SWITCH
          </button>

          <button
            onClick={() => onDecisionModeChange("MANUAL")}
            className={`py-1.5 px-0.5 rounded-lg text-center font-mono text-[10px] sm:text-[11px] tracking-wider transition-all cursor-pointer truncate ${
              decisionMode === "MANUAL"
                ? "bg-[#202026] text-white border border-[#383842] font-semibold"
                : "text-stone-400 hover:text-stone-200 hover:bg-white/5"
            }`}
          >
            MANUAL
          </button>

          <button
            onClick={() => onDecisionModeChange("SEMI_AUTO")}
            className={`py-1.5 px-0.5 rounded-lg text-center font-mono text-[10px] sm:text-[11px] tracking-wider transition-all cursor-pointer truncate ${
              decisionMode === "SEMI_AUTO"
                ? "bg-[#202026] text-white border border-[#383842] font-semibold"
                : "text-stone-400 hover:text-stone-200 hover:bg-white/5"
            }`}
          >
            SEMI
          </button>

          <button
            onClick={() => onDecisionModeChange("AUTO_WITHIN_LIMITS")}
            className={`py-1.5 px-0.5 rounded-lg text-center font-mono text-[10px] sm:text-[11px] tracking-wider transition-all cursor-pointer flex items-center justify-center gap-1 truncate ${
              decisionMode === "AUTO_WITHIN_LIMITS"
                ? "bg-emerald-950 text-emerald-300 border border-emerald-600 font-semibold"
                : "text-stone-400 hover:text-stone-200 hover:bg-white/5"
            }`}
          >
            {decisionMode === "AUTO_WITHIN_LIMITS" && (
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
            )}
            <span className="truncate">SELF-APPROVE</span>
          </button>
        </div>
      </div>

      {/* Horizontal Ticker Tape Row */}
      <div className="w-full bg-[#08080a] border-t border-[#1a1a20] py-1 px-3 overflow-hidden flex items-center">
        <div className="animate-marquee items-center gap-6 whitespace-nowrap text-[11px] font-mono select-none">
          {/* Duplicate list to enable continuous smooth loop */}
          {[...tickerItems, ...tickerItems].map((item, idx) => (
            <div key={idx} className="inline-flex items-center gap-1.5">
              <span className="text-stone-400">{item.symbol}</span>
              <PriceTick price={item.price} direction={item.direction} />
              <span
                className={
                  item.isPositive ? "text-emerald-400" : "text-rose-400"
                }
              >
                {item.change}
              </span>
              {idx % 4 === 0 && (
                <span className="ml-2 px-1.5 py-0.5 rounded bg-[#18181e] text-[9px] font-mono text-stone-400 border border-[#2b2b34]">
                  {tapeMode}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </header>
  );
};
