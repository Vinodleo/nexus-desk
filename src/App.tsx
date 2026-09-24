import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  DecisionMode,
  ExperienceVector,
  FailureInjectionState,
  MarketBar,
  Position,
  HistoricalTrade,
  RegimeType,
  StrategySetup,
  TradeProposal,
  PromotedLabModel,
  ExecutionToast,
  RiskCalculation,
} from "./types";
import {
  generateInitialExperienceDatabase,
  retrieveSimilarExperiences,
} from "./services/experienceMemory";
import {
  loadStoredExperiences,
  saveStoredExperiences,
  loadStoredStats,
  saveStoredStats,
  loadStoredCapital,
  saveStoredCapital,
  loadStoredPositions,
  saveStoredPositions,
  resetStoredExperiencesToBaseline,
  loadStoredClosedTrades,
  saveStoredClosedTrades,
  loadStoredModelAccuracy,
  saveStoredModelAccuracy,
  LearnedModelAccuracy,
  loadStoredPromotedLabModel,
  saveStoredPromotedLabModel,
  loadStoredQuarantines,
  saveStoredQuarantines,
  SymbolQuarantineRecord,
} from "./services/storagePersistenceService";
import { scanAllMarkets, type FullScanReport } from "./services/marketScannerService";
import { addSkipCounts } from "./services/scanOutcome";
import { priceEntry } from "./services/entryPricing";
import { shadowStore } from "./services/shadowTracker";
import { useRiskPolicy } from "./hooks/useRiskPolicy";
import { liveMarketStream } from "./services/liveMarketStreamService";
import { CheckCircle2, AlertTriangle, X, Play, ArrowRight } from "lucide-react";

import { LoginScreen } from './components/LoginScreen';
import { BottomNavBar, TabType } from "./components/BottomNavBar";
import { LedgerFloor } from "./components/ledger/LedgerFloor";
import { SettingsSheet } from "./components/ledger/SettingsSheet";
import { useZerodhaConnection } from "./hooks/useZerodhaConnection";
import { LedgerQueue } from "./components/ledger/LedgerQueue";
import { LedgerBook } from "./components/ledger/LedgerBook";
import { LedgerRisk } from "./components/ledger/LedgerRisk";
import { LedgerLab } from "./components/ledger/LedgerLab";
import { LedgerLearning } from "./components/ledger/LedgerLearning";
import { CommanderModal } from "./components/CommanderModal";
import { checkAndRunOnlineLearning } from "./services/onlineLearningService";
import { SecurityConsoleModal } from "./components/SecurityConsoleModal";
import { useAuth } from "./context/AuthContext";
import { useBackgroundExecution } from "./hooks/useBackgroundExecution";
import { BackgroundExecutionModal } from "./components/BackgroundExecutionModal";
import {
  playTradeExecutionSound,
  playProfitTargetSound,
  playStopLossSound,
} from "./utils/audioFeedback";
import { apiFetch } from "./services/apiClient";
import { computeClosedTradePnl } from "./shared/tradeMath";
import type { DaemonCloseEvent } from "./services/daemonEvents";
import { useServerCloseHandler } from "./hooks/useServerCloseHandler";
import { useCoinDcxAccount } from "./hooks/useCoinDcxAccount";
import { useGuardianSync } from "./hooks/useGuardianSync";
import { useDailyTelemetry } from "./hooks/useDailyTelemetry";
import { useLiveFeed } from "./hooks/useLiveFeed";
import {
  applyTickToPosition,
  priceForPosition,
  type SuspectTick,
  type TickExitReason,
} from "./services/positionTick";
import { isBuiltOnSyntheticPrices } from "./services/dataProvenance";
import { fetchLiveOrderBook } from "./services/orderBookService";

// ATR recorded on a position for its trailing-stop rules. The indicator used
// to be floored at 0.3% of price, and the exit rules were tuned with that
// floor, so it's kept here until the exits are reworked.
function atrForExits(proposal: TradeProposal): number {
  const bars = liveMarketStream.getBars(proposal.symbol);
  const atr = bars && bars.length > 0 ? bars[bars.length - 1].atr : undefined;
  return Math.max(atr ?? 0, proposal.setup.entryPrice * 0.003);
}

export default function App() {
  const { userRole, logSecurityAudit, currentUser, loading } = useAuth();
  const [isSecurityModalOpen, setIsSecurityModalOpen] = useState<boolean>(false);

  // Navigation: Floor, Queue, Book, Lab, Learning
  const [activeTab, setActiveTab] = useState<TabType>("floor");
  const [decisionMode, setDecisionMode] =
    useState<DecisionMode>("AUTO_WITHIN_LIMITS");
  const [executionToast, setExecutionToast] = useState<ExecutionToast | null>(
    null
  );
  const [isCommanderModalOpen, setIsCommanderModalOpen] =
    useState<boolean>(false);
  const [commanderLoading, setCommanderLoading] = useState<boolean>(false);
  const [commanderBrief, setCommanderBrief] = useState<string>(
    "The brief isn't available right now. Trading, risk checks and the guardian don't depend on it."
  );

  // Dynamic Learning & Self-Approval Track Record (Initialized from LocalStorage)
  const [selfApprovedCount, setSelfApprovedCount] = useState<number>(() => loadStoredStats().selfApprovedCount);
  const [selfApprovedWins, setSelfApprovedWins] = useState<number>(() => loadStoredStats().selfApprovedWins);
  const [selfApprovedLosses, setSelfApprovedLosses] = useState<number>(() => loadStoredStats().selfApprovedLosses);

  // Capital & Portfolio State (Initialized from LocalStorage)
  const [equity, setEquity] = useState<number>(() => loadStoredCapital().equity);
  const [dailyRealizedPnl, setDailyRealizedPnl] = useState<number>(() => loadStoredCapital().dailyRealizedPnl);
  const [allTimeRealizedPnl, setAllTimeRealizedPnl] = useState<number>(() => loadStoredCapital().allTimeRealizedPnl || 0);
  const [cash, setCash] = useState<number>(() => loadStoredCapital().cash);
  const [killSwitchActive, setKillSwitchActive] = useState<boolean>(false);

  const {
    tradingMode,
    handleToggleTradingMode,
    coinDcxStatus,
    refreshCoinDcxStatus,
    coinDcxBalance,
    fetchCoinDcxBalance,
  } = useCoinDcxAccount(setExecutionToast);

  // Persist Stats & Capital changes to Browser LocalStorage
  useEffect(() => {
    saveStoredStats({
      selfApprovedCount,
      selfApprovedWins,
      selfApprovedLosses,
      lastUpdated: new Date().toISOString(),
    });
  }, [selfApprovedCount, selfApprovedWins, selfApprovedLosses]);

  useEffect(() => {
    saveStoredCapital({
      equity,
      cash,
      dailyRealizedPnl,
      allTimeRealizedPnl,
    });
  }, [equity, cash, dailyRealizedPnl, allTimeRealizedPnl]);

  // Core Market State
  const [currentSymbol, setCurrentSymbol] = useState<string>("BTC/INR");
  const [isPlaying, setIsPlaying] = useState<boolean>(true);

  useEffect(() => {
    // Start the market data feed once (candles, prices, market rules).
    if (!liveMarketStream.isReady) void liveMarketStream.initialize();
  }, []);

  // Background Trading Loop & Web Worker Heartbeat Reference
  const lastStepTimeRef = useRef<number>(Date.now());

  // Background Web Worker Heartbeat listener (continues unthrottled when screen locked or minimized)
  const handleBackgroundTick = useCallback(() => {
    if (!isPlaying) return;
  }, [isPlaying]);

  // Fast-Forward Reconcile missed ticks when device screen is unlocked
  const handleReconcileMissedTicks = useCallback(
    (missedCycles: number, elapsedMs: number) => {
      if (!isPlaying || missedCycles <= 0) return;

      setExecutionToast({
        id: `toast-reconcile-${Date.now()}`,
        title: "■ Background Resynced",
        message: `Device was locked for ${Math.round(
          elapsedMs / 1000
        )}s. Live market feeds re-established.`,
        type: "INFO",
        timestamp: new Date().toLocaleTimeString(),
      });
    },
    [isPlaying]
  );

  const [isBackgroundModalOpen, setIsBackgroundModalOpen] = useState<boolean>(false);

  // Background Execution Engine Hook: Screen Wake Lock, Web Worker, Audio Guardian, Native Alerts
  const {
    status: backgroundStatus,
    toggleWakeLock,
    toggleAudioKeepAlive,
    requestNotifications,
    sendAlertNotification,
  } = useBackgroundExecution({
    isPlaying,
    onBackgroundTick: handleBackgroundTick,
    onReconcileMissedTicks: handleReconcileMissedTicks,
  });

  // Positions (initialized to empty flat state per Screenshot 2)
  const [activePositions, setActivePositions] = useState<Position[]>(() => loadStoredPositions());

  // Persist open positions on every change — unrealized P&L and open
  // trades need to survive a reload, not just realized P&L (which
  // saveStoredCapital above already covers).
  useEffect(() => {
    saveStoredPositions(activePositions);
  }, [activePositions]);

  // Auto-dismiss execution toast after 7s
  useEffect(() => {
    if (!executionToast) return;
    const timer = setTimeout(() => {
      setExecutionToast(null);
    }, 7000);
    return () => clearTimeout(timer);
  }, [executionToast]);

  // Price-guard recovery state: when a tick is rejected as an implausible
  // single-move (see the guard below), we remember it here per position. If
  // the *next* tick for that position lands close to this remembered value,
  // two independent ticks have now agreed — strong evidence the feed
  // genuinely moved (e.g. it just recovered from an outage) rather than one
  // bad print — so we accept it immediately instead of staying stuck
  // comparing forever against an increasingly stale reference price.
  const pendingSuspectPrices = useRef<Map<string, SuspectTick>>(new Map());
  // Guards against the same proposal being turned into two positions when a
  // manual approval (handleApproveProposal) and an autopilot approval
  // (handleBatchApproveAllProposals) race each other — both read
  // proposalQueue/activePositions from a snapshot that can be stale for a
  // moment after the other one writes, since React state updates aren't
  // synchronous. A ref is: mutating it is immediate and synchronous, so
  // "claiming" a proposal ID here closes the race regardless of state-update
  // timing.
  const inFlightProposalIds = useRef<Set<string>>(new Set());
  // Same race as inFlightProposalIds, but on the closing side: a stop-loss/
  // take-profit hit gets detected inside setActivePositions' functional
  // updater, but the actual close (P&L credit + history record) is
  // deferred via setTimeout. If two price-update passes (e.g. a real WS
  // tick and the REST-poll backstop) both read the position as still open
  // before the first pass's removal has landed, both independently detect
  // the same stop/target hit and each schedules its own close — crediting
  // the P&L twice and writing two history entries for one real trade. This
  // claims a position the instant a close is first triggered, so a second,
  // near-simultaneous trigger for the same position is a no-op.
  const closingPositionIds = useRef<Set<string>>(new Set());
  const activePositionsRef = React.useRef<Position[]>([]);
  React.useEffect(() => { activePositionsRef.current = activePositions; }, [activePositions]);
  const [closedTrades, setClosedTrades] = useState<HistoricalTrade[]>(() =>
    loadStoredClosedTrades()
  );
  const closedTradesRef = React.useRef<HistoricalTrade[]>([]);
  React.useEffect(() => { closedTradesRef.current = closedTrades; }, [closedTrades]);

  // Per-Symbol Quarantine (Embargo): prevents re-approving a symbol after consecutive losses
  const [symbolQuarantines, setSymbolQuarantines] = useState<Record<string, SymbolQuarantineRecord>>(() =>
    loadStoredQuarantines()
  );
  const symbolQuarantinesRef = React.useRef<Record<string, SymbolQuarantineRecord>>({});
  React.useEffect(() => {
    symbolQuarantinesRef.current = symbolQuarantines;
    saveStoredQuarantines(symbolQuarantines);
  }, [symbolQuarantines]);

  // Apply closes made by the server guardian, crediting each exactly once.
  const applyServerClose = useServerCloseHandler(closingPositionIds, closedTradesRef, {
    setActivePositions,
    setClosedTrades,
    setEquity,
    setCash,
    setDailyRealizedPnl,
    setAllTimeRealizedPnl,
  });

  // Live feed: prices, guardian closes and live-exit updates from the server.
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  // closePositionWithAutopsy is defined further down; the feed reaches it
  // through this ref so it always calls the current version.
  const closePositionRef = useRef<(pos: Position, exitPrice: number, reason: TickExitReason | "EXPIRY_TIME") => void>(
    () => {}
  );
  const tickSeq = useRef(0);

  useLiveFeed({
    onTick: (prices) => {
      const seq = ++tickSeq.current;
      setLivePrices((prev) => ({ ...prev, ...prices }));
      setActivePositions((prev) => {
        if (prev.length === 0) return prev;
        let changed = false;
        const next: Position[] = [];
        for (const pos of prev) {
          const out = applyTickToPosition(pos, priceForPosition(pos, prices), pendingSuspectPrices.current, seq);
          if (out.kind === "exit") {
            const { position, price, reason } = out;
            // closePositionWithAutopsy de-duplicates, so a repeated updater run is harmless.
            setTimeout(() => closePositionRef.current(position, price, reason), 10);
            changed = true;
            continue;
          }
          if (out.kind === "updated" && out.changed) changed = true;
          next.push(out.position);
        }
        return changed ? next : prev;
      });
    },
    onServerClose: (ev) => {
      console.log("[Daemon Position Guardian] Server closed trade event received:", ev);
      if (applyServerClose(ev)) {
        setExecutionToast({
          id: `toast-daemon-${Date.now()}`,
          title: `■ [24/7 DAEMON GUARDIAN] ${ev.symbol} Auto-Closed`,
          message: `Server-side guardian closed ${ev.symbol} (${ev.direction}) @ ₹${ev.exitPrice} [${ev.exitReason}]. Net P&L: ₹${ev.realizedPnl >= 0 ? "+" : ""}${ev.realizedPnl}`,
          type: ev.isWin ? "SUCCESS" : "WARNING",
          timestamp: new Date().toLocaleTimeString(),
        });
      }
    },
    onLiveExitUpdate: (rec) => {
      if (rec.status === "CLOSED") {
        fetchCoinDcxBalance();
      } else if (rec.status === "EXIT_FAILED") {
        setExecutionToast({
          id: `toast-live-exit-${Date.now()}`,
          title: `🚨 LIVE EXIT FAILED: ${rec.market}`,
          message: `The server could not close ${rec.quantity} ${rec.market} after ${rec.exitAttempts} attempts (${rec.lastError}). Close it manually on CoinDCX.`,
          type: "WARNING",
          timestamp: new Date().toLocaleTimeString(),
        });
        sendAlertNotification(`🚨 Live exit failed: ${rec.market}`, {
          body: "Close the position manually on CoinDCX.",
        });
      }
    },
  });

  // Enforce each position's max holding time (the UI's "Hard Limit
  // Protected"): every 30s, close anything past its limit at the best known
  // price.
  useEffect(() => {
    const checkHoldingTimeExpiry = () => {
      const now = Date.now();
      for (const pos of activePositionsRef.current) {
        const openedMs = pos.openTime ? new Date(pos.openTime).getTime() : now;
        if ((now - openedMs) / 60000 >= (pos.expectedHoldingTimeMinutes || 30)) {
          closePositionRef.current(pos, pos.currentPrice || pos.entryPrice, "EXPIRY_TIME");
        }
      }
    };
    const interval = setInterval(checkHoldingTimeExpiry, 30000);
    return () => clearInterval(interval);
  }, []);

  // Persist closed trades to LocalStorage
  useEffect(() => {
    saveStoredClosedTrades(closedTrades);
  }, [closedTrades]);

  // ==========================================
  // SERVER DAEMON SYNC & WEB WORKER BACKGROUND TIMER
  // ==========================================

  // 1-2. Push position changes to the guardian; pull closes it made while asleep.
  const guardianOnline = useGuardianSync(activePositions, setActivePositions, applyServerClose);
  const zerodha = useZerodhaConnection();
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);

  // 3. Web Worker un-throttled background heartbeat
  useEffect(() => {
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL("./workers/ticker.worker.ts", import.meta.url), { type: "module" });
      worker.postMessage({ command: "START" });

      worker.onmessage = (e) => {
        if (e.data?.type === "TICK") {
          // Re-evaluate pending state without OS throttling
        }
      };
    } catch (e) {
      console.warn("Web Worker background timer not supported:", e);
    }

    return () => {
      if (worker) {
        worker.postMessage({ command: "STOP" });
        worker.terminate();
      }
    };
  }, []);

  // 4. Screen Wake Lock API (keeps mobile / laptop awake while monitoring active positions)
  useEffect(() => {
    let wakeLock: any = null;
    const requestWakeLock = async () => {
      try {
        if ("wakeLock" in navigator && activePositions.length > 0) {
          wakeLock = await (navigator as any).wakeLock.request("screen");
        }
      } catch (err) {
        console.debug("Wake lock could not be acquired:", err);
      }
    };

    if (activePositions.length > 0) {
      requestWakeLock();
    } else if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }

    return () => {
      if (wakeLock) wakeLock.release().catch(() => {});
    };
  }, [activePositions.length]);

  const [learnedAccuracy, setLearnedAccuracy] = useState<LearnedModelAccuracy>(() =>
    loadStoredModelAccuracy()
  );

  // New Promoted Lab Model State
  const [promotedLabModel, setPromotedLabModel] = useState<PromotedLabModel | null>(() => loadStoredPromotedLabModel());

  useEffect(() => {
    if (promotedLabModel) {
      saveStoredPromotedLabModel(promotedLabModel);
    }
  }, [promotedLabModel]);

  const handleUpdateModelAccuracy = (updated: LearnedModelAccuracy) => {
    setLearnedAccuracy(updated);
    saveStoredModelAccuracy(updated);
    setExecutionToast({
      id: `toast-${Date.now()}`,
      title: "Model Accuracy Calibrated",
      message: `Active Model Accuracy updated to ${updated.accuracyPct}% (${updated.datasetName}).`,
      type: "SUCCESS",
      timestamp: new Date().toLocaleTimeString(),
    });
  };

  // Failure Injection & Risk States
  const [failureState, setFailureState] = useState<FailureInjectionState>({
    globalKillSwitchActive: false,
    simulateAgentTimeout: false,
    simulateStaleMarketData: false,
    simulateDailyLossBreach: false,
    simulateOrderBookThinLiquidity: false,
    simulateConflictingSignals: false,
  });

  // Equity the desk trades against: the CoinDCX balance in live mode, the
  // paper book otherwise. Trade sizes and limits are worked out from it.
  const effectiveEquity =
    tradingMode === "LIVE_COINDCX" && coinDcxBalance.totalInr > 0 ? coinDcxBalance.totalInr : equity;
  const { policy: riskPolicy, limits: riskLimits, setLimits: setRiskLimits } = useRiskPolicy(effectiveEquity);

  const currentRiskCalculation = useMemo<RiskCalculation>(() => {
    const currentExposure = activePositions.reduce((acc, p) => acc + (p.entryPrice * p.quantity), 0);
    const exposureFraction = effectiveEquity > 0 ? currentExposure / effectiveEquity : 0;
    const passed = !killSwitchActive && !failureState.globalKillSwitchActive && dailyRealizedPnl > -riskPolicy.hardDailyLossLimit;

    return {
      equity: effectiveEquity,
      maxRiskPerTradeFraction: riskPolicy.maxRiskFraction,
      hardDailyLossLimit: riskPolicy.hardDailyLossLimit,
      currentDailyLoss: Math.abs(Math.min(0, dailyRealizedPnl)),
      portfolioExposureFraction: exposureFraction,
      maxAllowedExposureFraction: riskPolicy.maxAllowedExposureFraction,
      openPositionCount: activePositions.length,
      maxSimultaneousPositions: riskPolicy.maxSimultaneousPositions,
      fractionalKellyFraction: 0.25,
      recommendedPositionSizeUnits: 0,
      recommendedDollarExposure: 0,
      riskDollars: effectiveEquity * riskPolicy.maxRiskFraction,
      passedAllChecks: passed,
      rejectionReason: !passed
        ? (killSwitchActive || failureState.globalKillSwitchActive)
          ? "Global Kill Switch Active"
          : "Daily Loss Limit Exceeded"
        : undefined,
    };
  }, [effectiveEquity, riskPolicy, activePositions, killSwitchActive, failureState.globalKillSwitchActive, dailyRealizedPnl]);

  // Trade Proposal Queue matching Screenshot 4 & 6
  const [proposalQueue, setProposalQueue] = useState<TradeProposal[]>([]);
  const [isScanningMarkets, setIsScanningMarkets] = useState<boolean>(false);

  // Dynamic Experience Memory Bank (continuous learning without rewriting base rules, backed by LocalStorage)
  const [experiences, setExperiences] = useState<ExperienceVector[]>(() =>
    loadStoredExperiences()
  );

  // Auto-save experience memory bank to Browser LocalStorage whenever new trades are learned
  useEffect(() => {
    saveStoredExperiences(experiences);
  }, [experiences]);

  // Continuous Online Learning Background Worker
  useEffect(() => {
    // Check every hour if a day has passed since last training
    const interval = setInterval(() => {
      checkAndRunOnlineLearning(experiences);
    }, 60 * 60 * 1000);

    // Also check shortly after launch
    const timeout = setTimeout(() => {
      checkAndRunOnlineLearning(experiences);
    }, 5000);

    const handleModelTrained = () => {
      const updatedModel = loadStoredPromotedLabModel();
      if (updatedModel) {
        setPromotedLabModel(updatedModel);
      }
    };
    window.addEventListener("nexus-model-trained", handleModelTrained);

    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
      window.removeEventListener("nexus-model-trained", handleModelTrained);
    };
  }, [experiences]);

  // Autonomous Continuous Scanning State (evaluates universe continuously)
  const [isContinuousScanActive, setIsContinuousScanActive] =
    useState<boolean>(true);

  // Live Sample Telemetry: what agents analysed, selected and rejected today
  // (IST day). At midnight IST the counters and daily realized P&L reset.
  const resetDailyPnl = useCallback(() => setDailyRealizedPnl(0), []);
  const [sampleTelemetry, setSampleTelemetry] = useDailyTelemetry(resetDailyPnl);

  // Close Position with full agent trade autopsy & audio feedback
  const closePositionWithAutopsy = useCallback(
    async (
      pos: Position,
      exitPrice: number,
      reason: "MANUAL" | "STOP_LOSS" | "TRAILING_STOP" | "TAKE_PROFIT" | "EXPIRY_TIME"
    ) => {
      // Claim this position before doing anything else. If another
      // near-simultaneous trigger already claimed it, back out — this is
      // what was producing two closed-trade entries (and double-crediting
      // P&L) for a single real close.
      if (closingPositionIds.current.has(pos.id)) {
        return;
      }
      closingPositionIds.current.add(pos.id);

      const {
        grossPnl: rawGrossPnl,
        feesPaid: totalFeesPaid,
        realizedPnl: finalPnl,
        realizedPnlPercent: pnlPercent,
        entryNotional,
        isWin,
      } = computeClosedTradePnl(pos.direction, pos.entryPrice, exitPrice, pos.quantity, reason);

      // Remove from active positions & update capital
      setActivePositions((prev) => prev.filter((p) => p.id !== pos.id));
      setDailyRealizedPnl((prev) => Number((prev + finalPnl).toFixed(2)));
      setAllTimeRealizedPnl((prev) => Number((prev + finalPnl).toFixed(2)));
      setEquity((prev) => Number((prev + finalPnl).toFixed(2)));
      setCash((prev) => Number((prev + finalPnl).toFixed(2)));

      // Live positions are exited by the server (idempotently, with retries),
      // so the exchange order goes out even if this tab closes right now.
      if (pos.isLiveOrder) {
        apiFetch("/api/live/close-position", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ positionId: pos.id, reason }),
        })
          .then((res) => res.json())
          .then((exitData) => {
            if (exitData.success) {
              fetchCoinDcxBalance();
            } else {
              setExecutionToast({
                id: `toast-${Date.now()}`,
                title: "⚠️ Live exit not confirmed yet",
                message: `${pos.symbol}: ${exitData.error || "exit pending"}. The server keeps retrying.`,
                type: "WARNING",
                timestamp: new Date().toLocaleTimeString(),
              });
            }
          })
          .catch((err) => {
            console.error("Failed to request live exit:", err);
          });
      }

      // Audio & Alert notification
      if (isWin) {
        playProfitTargetSound();
        const alertTitle =
          reason === "TRAILING_STOP"
            ? `■ [Nexus Desk] Trailing Profit Captured: ${pos.symbol}`
            : reason === "TAKE_PROFIT"
            ? `■ [Nexus Desk] Target Hit: ${pos.symbol}`
            : `■ [Nexus Desk] Trade Profit Captured: ${pos.symbol}`;
        sendAlertNotification(alertTitle, {
          body: `${pos.direction} closed with +₹${finalPnl.toFixed(2)} (${pnlPercent >= 0 ? "+" : ""}${pnlPercent}%). Profit secured into portfolio.`,
        });
      } else {
        playStopLossSound();
        if (reason === "TRAILING_STOP") {
          sendAlertNotification(`■ [Nexus Desk] Trailing Stop Hit: ${pos.symbol}`, {
            body: `${pos.direction} stopped at ₹${exitPrice.toFixed(2)} (-₹${Math.abs(finalPnl).toFixed(2)} net after fees). Capital protected at breakeven.`,
          });
        } else if (reason === "STOP_LOSS") {
          sendAlertNotification(`■ [Nexus Desk] Stop-Loss Hit: ${pos.symbol}`, {
            body: `${pos.direction} stopped at ₹${exitPrice.toFixed(2)} (-₹${Math.abs(finalPnl).toFixed(2)}). Capital safeguarded.`,
          });
        } else if (reason === "EXPIRY_TIME") {
          sendAlertNotification(`■ [Nexus Desk] Holding-Time Limit Hit: ${pos.symbol}`, {
            body: `${pos.direction} force-closed after exceeding its max holding time, at ₹${exitPrice.toFixed(2)} (-₹${Math.abs(finalPnl).toFixed(2)}).`,
          });
        }
      }

      // Display professional high-visibility notification toast
      setExecutionToast({
        id: `toast-${Date.now()}`,
        title:
          reason === "TAKE_PROFIT"
            ? `Target Hit: ${pos.symbol} (+₹${finalPnl.toFixed(2)})`
            : reason === "TRAILING_STOP"
            ? isWin
              ? `Trailing Profit Captured: ${pos.symbol} (+₹${finalPnl.toFixed(2)})`
              : `Trailing Breakeven Stop: ${pos.symbol} (-₹${Math.abs(finalPnl).toFixed(2)})`
            : reason === "STOP_LOSS"
            ? `Stop-Loss Executed: ${pos.symbol} (-₹${Math.abs(finalPnl).toFixed(2)})`
            : reason === "EXPIRY_TIME"
            ? `Holding Time Exceeded: ${pos.symbol} (${finalPnl >= 0 ? "+" : ""}₹${finalPnl.toFixed(2)})`
            : `Trade Exited: ${pos.symbol} (${finalPnl >= 0 ? "+" : ""}₹${finalPnl.toFixed(2)})`,
        message: !isWin
          ? `Loss logged to Experience Memory. Base strategy rules remain frozen to prevent curve-fitting. Future similar setups in this regime will be automatically vetoed by the Meta-Labeler.`
          : `Profit captured. Outcome signature added to experience memory. Base rules preserved.`,
        type: isWin ? "SUCCESS" : "WARNING",
        timestamp: new Date().toLocaleTimeString(),
      });

      // 4-way post-classification
      const classification = isWin
        ? (pos.metaConfidence || 0.5) >= 0.52
          ? "good_decision_good_outcome"
          : "bad_decision_good_outcome"
        : (pos.metaConfidence || 0.5) >= 0.52
        ? "good_decision_bad_outcome"
        : "bad_decision_bad_outcome";

      const moneyPlaced = Number((pos.entryPrice * pos.quantity).toFixed(2));
      const closedAtFormatted = new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      const openedAtFormatted = pos.openTime
        ? new Date(pos.openTime).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })
        : closedAtFormatted;

      const durationMins = Math.max(
        1,
        Math.round(
          (Date.now() -
            (pos.openTime ? new Date(pos.openTime).getTime() : Date.now())) /
            60000
        )
      );

      const nowMs = Date.now();
      const newHistoricalTrade: HistoricalTrade = {
        id: `trade-closed-${nowMs}`,
        positionId: pos.id,
        symbol: pos.symbol,
        direction: pos.direction,
        setupName: pos.setupName,
        entryPrice: pos.entryPrice,
        exitPrice,
        quantity: pos.quantity,
        moneyPlaced,
        grossPnl: rawGrossPnl,
        feesPaid: totalFeesPaid,
        realizedPnl: finalPnl,
        realizedPnlPercent: pnlPercent,
        isWin,
        exitReason: reason,
        openedAt: openedAtFormatted,
        closedAt: closedAtFormatted,
        openedAtMs: pos.openTime ? new Date(pos.openTime).getTime() : nowMs,
        closedAtMs: nowMs,
        holdingDurationMinutes: durationMins,
        isSelfApproved: pos.isSelfApproved,
      };

      setClosedTrades((prev) => [newHistoricalTrade, ...prev]);

      // Per-Symbol Cooldown & Quarantine:
      // 1. If a trade closes with a loss (or 3 consecutive losses), embargo for 120 minutes.
      // 2. If a trade closes with a win or break-even, impose a mandatory 15-minute re-entry cooldown
      // to eliminate rapid churn on the same asset.
      if (!isWin) {
        const symbolClosedTrades = [newHistoricalTrade, ...closedTradesRef.current.filter((t) => t.symbol === pos.symbol)];
        const consecutiveSymbolLosses = symbolClosedTrades.slice(0, 3).filter((t) => !t.isWin).length;
        if (consecutiveSymbolLosses >= 3 || !isWin) {
          // Embargo the symbol for 2 hours (120 minutes)
          const embargoDurationMs = 120 * 60 * 1000;
          const quarantinedUntilMs = Date.now() + embargoDurationMs;
          setSymbolQuarantines((prev) => ({
            ...prev,
            [pos.symbol]: {
              symbol: pos.symbol,
              quarantinedUntilMs,
              reason: consecutiveSymbolLosses >= 3
                ? `3 consecutive losses recorded on ${pos.symbol}`
                : `Loss recorded on ${pos.symbol}`,
              consecutiveLosses: consecutiveSymbolLosses,
              lastLossTimestamp: new Date().toISOString(),
            },
          }));
          logSecurityAudit(
            "SYMBOL_QUARANTINED",
            `Symbol ${pos.symbol} quarantined for 120 minutes following loss (exit: ₹${exitPrice}, PnL: ₹${finalPnl})`
          );
        }

        // Auto-Trip on 3 Consecutive Losses:
        // Check global consecutive closed trades. If 3 consecutive losses occur,
        // automatically activate the Emergency Kill Switch and turn off Self-Approval / Autopilot.
        const recentGlobalTrades = [newHistoricalTrade, ...closedTradesRef.current].slice(0, 3);
        const globalConsecutiveLosses = recentGlobalTrades.length === 3 && recentGlobalTrades.every((t) => !t.isWin);
        if (globalConsecutiveLosses) {
          setKillSwitchActive(true);
          setDecisionMode("MANUAL");
          setExecutionToast({
            id: `toast-killswitch-${Date.now()}`,
            title: "EMERGENCY SAFETY TRIP: 3 CONSECUTIVE LOSSES",
            message: "Kill Switch activated. Self-approval autopilot turned OFF. Trading halted to preserve capital.",
            type: "WARNING",
            timestamp: new Date().toLocaleTimeString(),
          });
          logSecurityAudit(
            "KILL_SWITCH_TRIGGERED",
            "Emergency Kill Switch tripped automatically due to 3 consecutive losses across portfolio. Autopilot reverted to MANUAL."
          );
          sendAlertNotification("■ [Nexus Desk] KILL SWITCH AUTO-TRIPPED", {
            body: "3 consecutive losses detected. Autopilot self-approval disabled. Manual intervention required.",
          });
        }
      } else {
        // 5-minute cooldown (1 full 5m bar) following a win/exit to prevent immediate micro-churn
        // while allowing the bot to catch continuation legs in strong trends.
        const winCooldownMs = 5 * 60 * 1000;
        const quarantinedUntilMs = Date.now() + winCooldownMs;
        setSymbolQuarantines((prev) => ({
          ...prev,
          [pos.symbol]: {
            symbol: pos.symbol,
            quarantinedUntilMs,
            reason: `Post-trade cooldown on ${pos.symbol} (5m pause)`,
            consecutiveLosses: 0,
            lastLossTimestamp: new Date().toISOString(),
          },
        }));
      }

      // Update self-approval learning statistics
      if (pos.isSelfApproved) {
        if (isWin) {
          setSelfApprovedWins((prev) => prev + 1);
        } else {
          setSelfApprovedLosses((prev) => prev + 1);
        }
      }

      // CONTINUOUS LEARNING WITHOUT REWRITING RULES:
      // Construct rich multi-dimensional experience vector and store in memory bank
      const newExpVector: ExperienceVector = {
        id: `exp-live-${Date.now()}`,
        timestamp: new Date().toISOString(),
        symbol: pos.symbol,
        setupName: pos.setupName,
        family: pos.setupName.toLowerCase().includes("breakout")
          ? "breakout_confirmation"
          : pos.setupName.toLowerCase().includes("reversion")
          ? "mean_reversion"
          : "trend_following",
        regime: "trending_bullish",
        features: {
          adx: 25.5,
          rsi: 50.0,
          volatilityRatio: 1.18,
          volumeSurgeRatio: 2.05,
          vwapDist: 1.35,
        },
        metaConfidence: pos.metaConfidence || 0.52,
        decision: "TRADE",
        outcome: isWin ? "WIN" : "LOSS",
        pnl: finalPnl,
        pnlPercent,
        postClassification: classification as any,
        tags: [
          pos.symbol,
          isWin ? "win" : "loss",
          reason,
          "frozen_rules_preserved",
          "memory_veto_active",
        ],
      };

      setExperiences((prev) => [newExpVector, ...prev]);

      // Call Trade Autopsy Agent endpoint server-side
      try {
        await apiFetch("/api/agent/trade-autopsy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            trade: {
              symbol: pos.symbol,
              direction: pos.direction,
              entryPrice: pos.entryPrice,
              exitPrice,
              realizedPnl: finalPnl,
              pnlPercent,
              setupName: pos.setupName,
              metaConfidence: pos.metaConfidence,
              outcome: isWin ? "WIN" : "LOSS",
              exitReason: reason,
            },
          }),
        });
      } catch {
        // Graceful fail-closed handling
      }
    },
    [logSecurityAudit, sendAlertNotification]
  );
  closePositionRef.current = closePositionWithAutopsy;

  const handleClosePosition = useCallback(
    (pos: Position) => {
      if (userRole === "auditor") {
        setExecutionToast({
          id: `toast-${Date.now()}`,
          title: "Security Clearance Restricted",
          message:
            "Auditor clearance is read-only. Switch to Desk Trader or Commander to manually close positions.",
          type: "WARNING",
          timestamp: new Date().toLocaleTimeString(),
        });
        return;
      }
      logSecurityAudit(
        "POSITION_MANUAL_CLOSE",
        `Manual exit triggered for ${pos.symbol} ${pos.direction} (${pos.quantity} units @ ₹${pos.currentPrice})`
      );
      closePositionWithAutopsy(pos, pos.currentPrice, "MANUAL");
    },
    [closePositionWithAutopsy, userRole, logSecurityAudit]
  );

  // Execute Limit Order & Start Trade Upon Approval (Manual or Autonomous Self-Approval)
  const handleApproveProposal = useCallback(
    (proposal: TradeProposal, isAutonomousSelfApproved: boolean = false) => {
      if (userRole === "auditor") {
        setExecutionToast({
          id: `toast-${Date.now()}`,
          title: "Security Clearance Restricted",
          message:
            "Auditor clearance is read-only. Switch to Desk Trader or Commander to approve orders.",
          type: "WARNING",
          timestamp: new Date().toLocaleTimeString(),
        });
        return;
      }

      if (killSwitchActive) {
        setExecutionToast({
          id: `toast-${Date.now()}`,
          title: "Kill Switch Active",
          message:
            "Emergency stop is engaged. Cannot open new positions while kill switch is active.",
          type: "WARNING",
          timestamp: new Date().toLocaleTimeString(),
        });
        return;
      }

      // Claim this proposal before doing anything else. If autopilot's batch
      // approval grabbed it in the same instant, it's already claimed and we
      // back out here instead of opening a second, duplicate position.
      if (inFlightProposalIds.current.has(proposal.id)) {
        return;
      }
      inFlightProposalIds.current.add(proposal.id);

      const units = proposal.riskCalc.recommendedPositionSizeUnits;
      if (units <= 0) {
        console.error("Attempted to approve proposal with 0 units.", proposal);
        inFlightProposalIds.current.delete(proposal.id);
        return;
      }

      const currentAtr = atrForExits(proposal);

      const isTrendOrSwing =
        proposal.setup.family === "trend_following" ||
        proposal.setup.family === "breakout_confirmation" ||
        proposal.setup.horizon === "swing";

      const isLiveExecution = tradingMode === "LIVE_COINDCX";

      // If in live mode, ensure we have credentials configured
      // Never send real money on a signal computed from generated prices.
      if (isLiveExecution && isBuiltOnSyntheticPrices(proposal)) {
        inFlightProposalIds.current.delete(proposal.id);
        setExecutionToast({
          id: `toast-${Date.now()}`,
          title: "Live order blocked: generated price data",
          message: `${proposal.symbol}'s signal was computed on ${Math.round(
            (proposal.dataQuality?.syntheticBarShare ?? 0) * 100
          )}% generated price history. Wait for a fresh scan on real data, or trade it in paper mode.`,
          type: "WARNING",
          timestamp: new Date().toLocaleTimeString(),
        });
        return;
      }

      if (isLiveExecution && !coinDcxStatus?.configured) {
        inFlightProposalIds.current.delete(proposal.id);
        setExecutionToast({
          id: `toast-${Date.now()}`,
          title: "CoinDCX API Credentials Required",
          message:
            "Live exchange routing requires COINDCX_API_KEY and COINDCX_API_SECRET to be set on the server.",
          type: "WARNING",
          timestamp: new Date().toLocaleTimeString(),
        });
        return;
      }

      // Enter at the live price, not the (older) candle close the signal
      // came from; skip it if price has already run too far.
      const priced = priceEntry(
        proposal.setup,
        liveMarketStream.getLastPrice(proposal.symbol),
        units,
        proposal.riskCalc.riskDollars
      );
      if (!priced.ok) {
        inFlightProposalIds.current.delete(proposal.id);
        setProposalQueue((prev) =>
          prev.map((p) => (p.id === proposal.id ? { ...p, status: "EXPIRED", deferralReason: priced.reason } : p))
        );
        setExecutionToast({
          id: `toast-${Date.now()}`,
          title: `${proposal.symbol} skipped: price moved`,
          message: priced.reason,
          type: "INFO",
          timestamp: new Date().toLocaleTimeString(),
        });
        return;
      }
      const entryPrice = priced.entryPrice;
      const quantity = priced.units;

      const newPosition: Position = {
        id: `pos-${Date.now().toString().slice(-6)}`,
        symbol: proposal.symbol,
        direction: proposal.setup.direction,
        setupName: proposal.setup.name,
        entryPrice,
        currentPrice: entryPrice,
        quantity,
        stopLoss: proposal.setup.stopLoss,
        takeProfit: proposal.setup.takeProfit,
        initialTakeProfit: proposal.setup.takeProfit,
        unrealizedPnl: 0,
        unrealizedPnlPercent: 0,
        openTime: new Date().toISOString(),
        expectedHoldingTimeMinutes: proposal.setup.horizon === "swing" ? 4320 : 30,
        metaConfidence: proposal.metaScore.confidence,
        isSelfApproved: isAutonomousSelfApproved,
        highestPrice: entryPrice,
        lowestPrice: entryPrice,
        trailActive: false,
        atrAtEntry: currentAtr,
        family: proposal.setup.family,
        horizon: proposal.setup.horizon,
        trailMode: isTrendOrSwing ? "TREND_RUNNER" : "SCALP_TIGHT",
        isLiveOrder: isLiveExecution,
      };

      // Dispatch order to backend (either simulated paper with slippage or live CoinDCX HMAC order)
      apiFetch("/api/execute-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: proposal.symbol,
          side: proposal.setup.direction,
          quantity,
          price: entryPrice,
          orderType: "MARKET",
          isPaperTrade: !isLiveExecution,
          confirmLiveOrder: isLiveExecution,
          positionId: newPosition.id,
        }),
      })
        .then((res) => res.json())
        .then((tradeData) => {
          if (isLiveExecution) {
            if (tradeData.success) {
              if (tradeData.orderId) {
                // The server may round the size to CoinDCX's quantity step.
                const sentQty = Number(tradeData.executedQuantity);
                setActivePositions((prev) =>
                  prev.map((p) =>
                    p.id === newPosition.id
                      ? {
                          ...p,
                          exchangeOrderId: tradeData.orderId,
                          ...(sentQty > 0 ? { quantity: sentQty } : {}),
                        }
                      : p
                  )
                );
              }
              // Immediately fetch updated account balances
              fetchCoinDcxBalance();
            } else {
              // Rollback local position if rejected by CoinDCX
              setActivePositions((prev) => prev.filter((p) => p.id !== newPosition.id));
              setExecutionToast({
                id: `toast-${Date.now()}`,
                title: "❌ CoinDCX Live Order Rejected",
                message: tradeData.error || "Order rejected by exchange.",
                type: "WARNING",
                timestamp: new Date().toLocaleTimeString(),
              });
            }
          }
        })
        .catch((err) => {
          console.error("Order dispatch error:", err);
        });

      // Add to active positions
      setActivePositions((prev) => [newPosition, ...prev]);

      // Mark proposal as approved
      setProposalQueue((prev) =>
        prev.map((p) =>
          p.id === proposal.id ? { ...p, status: "APPROVED" } : p
        )
      );

      // Update Live Sample Selected telemetry
      setSampleTelemetry((prev) => ({
        ...prev,
        selectedCount: prev.selectedCount + 1,
      }));

      if (isAutonomousSelfApproved) {
        setSelfApprovedCount((prev) => prev + 1);
      }

      // Audio & Toast
      playTradeExecutionSound();
      setExecutionToast({
        id: `toast-${Date.now()}`,
        title: isAutonomousSelfApproved
          ? `■ [AI SELF-APPROVED] ${proposal.symbol} ${proposal.setup.direction}`
          : `Limit Order Filled: ${proposal.symbol}`,
        message: isAutonomousSelfApproved
          ? `Agent Swarm self-approved ${proposal.symbol} with ${Math.round(
              proposal.metaScore.calibratedWinProbability * 100
            )}% P(Win). Entered at ₹${entryPrice} with ${priced.rewardToRisk.toFixed(2)}R to the target.`
          : `${proposal.setup.direction} ${quantity} ${proposal.symbol} at ₹${entryPrice}. Stop and target are set.`,
        type: "SUCCESS",
        timestamp: new Date().toLocaleTimeString(),
      });

      logSecurityAudit(
        "ORDER_APPROVED",
        `${isAutonomousSelfApproved ? "[AI SELF-APPROVED]" : "Operator Approved"} ${proposal.setup.direction} ${proposal.symbol} @ ₹${entryPrice}`
      );

      if (isAutonomousSelfApproved) {
        sendAlertNotification(`■ [Nexus Desk] Autonomous Trade: ${proposal.symbol}`, {
          body: `${proposal.setup.direction} @ ₹${entryPrice} (${Math.round(proposal.metaScore.calibratedWinProbability * 100)}% Win Probability).`,
        });
      }

      if (!isAutonomousSelfApproved) {
        // Open positions live on the Floor.
        setActiveTab("floor");
      }
    },
    [killSwitchActive, userRole, logSecurityAudit, tradingMode, coinDcxStatus, fetchCoinDcxBalance]
  );

  // Batch Auto-Approval Engine:
  // When Self-Approve is ON, trades in the queue are auto-approved ONLY while doing so keeps
  // the book within the same live limits a human approver would be bound by: max simultaneous
  // positions, max portfolio exposure, no duplicate-symbol stacking, a rolling-hour cap on
  // autonomous approvals, and trader-panel consensus. Anything that would breach a limit is
  // left PENDING_APPROVAL for a human to review manually, rather than being silently approved
  // or silently dropped.
  const handleBatchApproveAllProposals = useCallback(
    (proposalsToApprove: TradeProposal[]) => {
      if (killSwitchActive || proposalsToApprove.length === 0) return;

      // Drop anything already claimed by a manual approval (or a previous,
      // still-in-flight autopilot batch) before doing any of the position/
      // exposure/consensus math below — closes the same race described on
      // inFlightProposalIds above, from the autopilot side this time.
      const claimable = proposalsToApprove.filter(
        (p) => !inFlightProposalIds.current.has(p.id)
      );
      if (claimable.length === 0) return;
      claimable.forEach((p) => inFlightProposalIds.current.add(p.id));
      proposalsToApprove = claimable;

      const policy = riskPolicy;
      const oneHourAgoMs = Date.now() - 60 * 60 * 1000;

      // Seed running counters from the CURRENT live book, not the scan-time snapshot each
      // proposal was individually checked against — several proposals from the same scan
      // cycle could otherwise all "pass" independently and then collectively blow through
      // maxSimultaneousPositions / maxAllowedExposureFraction when approved together.
      let runningPositionCount = activePositions.length;
      let runningExposure = activePositions.reduce(
        (acc, p) => acc + p.quantity * p.currentPrice,
        0
      );
      // Fix 1-Hour Cap Bug: Count ALL trades opened by autopilot within the rolling hour,
      // including active positions AND closed trades. Previously only activePositions were counted,
      // so if a trade hit stop-loss quickly, active positions dropped to 0, resetting the counter
      // and allowing an infinite loss-whipsaw loop.
      const activeHourlyAutopilot = activePositions.filter(
        (p) => p.isSelfApproved && new Date(p.openTime).getTime() >= oneHourAgoMs
      ).length;
      const closedHourlyAutopilot = closedTrades.filter((t) => {
        if (!t.isSelfApproved) return false;
        const timeMs = t.openedAt ? new Date(t.openedAt).getTime() : 0;
        return !isNaN(timeMs) && timeMs >= oneHourAgoMs;
      }).length;
      let runningHourlyAutopilotCount = activeHourlyAutopilot + closedHourlyAutopilot;
      const heldSymbols = new Set(activePositions.map((p) => p.symbol));

      const accepted: TradeProposal[] = [];
      const deferred: { proposal: TradeProposal; reason: string }[] = [];
      const pricedById = new Map<string, { entryPrice: number; units: number }>();

      for (const proposal of proposalsToApprove) {
        const units = proposal.riskCalc.recommendedPositionSizeUnits;
        if (units <= 0) {
           deferred.push({ proposal, reason: "Position size rounded to 0 after exchange lot-size snapping." });
           continue;
        }

        // Per-Symbol Quarantine Gate: Check if symbol is currently embargoed due to recent losses
        const quarantineRec = symbolQuarantines[proposal.symbol];
        if (quarantineRec && quarantineRec.quarantinedUntilMs > Date.now()) {
          const remainingMins = Math.ceil((quarantineRec.quarantinedUntilMs - Date.now()) / 60000);
          deferred.push({
            proposal,
            reason: `Symbol is quarantined (${remainingMins}m remaining) due to consecutive loss guard.`,
          });
          continue;
        }

        // Swing/long-horizon setups (e.g. the macro trend-following persona)
        // always go to manual review, regardless of consensus. These commit
        // capital for days-to-weeks with much wider stops — a call that size
        // and duration should get a human's eyes, not a quick-consensus vote
        // tuned for intraday setups.
        if (proposal.setup.horizon === "swing") {
          deferred.push({ proposal, reason: "Swing/long-horizon setup — always requires manual approval, regardless of consensus." });
          continue;
        }

        // Signals computed on generated price history aren't evidence about
        // the real market. Autopilot never acts on them; a human can still
        // approve one knowingly (it's badged in the queue).
        if (isBuiltOnSyntheticPrices(proposal)) {
          const pct = Math.round((proposal.dataQuality?.syntheticBarShare ?? 0) * 100);
          deferred.push({ proposal, reason: `Built on generated price history (${pct}% of bars) — manual review only.` });
          continue;
        }

        // Enter at the live price; skip it if price has already run too far.
        const priced = priceEntry(
          proposal.setup,
          liveMarketStream.getLastPrice(proposal.symbol),
          units,
          proposal.riskCalc.riskDollars
        );
        if (!priced.ok) {
          deferred.push({ proposal, reason: priced.reason });
          continue;
        }
        const addedExposure = priced.units * priced.entryPrice;
        const exposureFractionIfAdded = (runningExposure + addedExposure) / policy.equity;

        const wouldExceedPositions =
          runningPositionCount + 1 > policy.maxSimultaneousPositions;
        const wouldExceedExposure =
          exposureFractionIfAdded > policy.maxAllowedExposureFraction;
        const alreadyHeld = heldSymbols.has(proposal.symbol);
        const wouldExceedHourlyCap =
          runningHourlyAutopilotCount + 1 > policy.autopilotMaxApprovalsPerHour;

        // Trader-panel consensus gate: autopilot only fast-tracks a proposal
        // the desk broadly agrees on. A contested/low-conviction call still
        // clears risk/EV but is left for a human — a real desk escalates
        // disagreement rather than auto-firing on a split vote.
        const agreement = proposal.ensembleAgreement ?? 1;
        const votes = proposal.personaVotesCast ?? 1;
        const lacksConsensus =
          agreement < policy.autopilotMinConsensus || votes < policy.autopilotMinPersonaVotes;

        if (wouldExceedPositions || wouldExceedExposure || alreadyHeld || wouldExceedHourlyCap || lacksConsensus) {
          const reasons: string[] = [];
          if (wouldExceedPositions) reasons.push(`would exceed max ${policy.maxSimultaneousPositions} simultaneous positions`);
          if (wouldExceedExposure) reasons.push(`would exceed max ${(policy.maxAllowedExposureFraction * 100).toFixed(0)}% portfolio exposure`);
          if (alreadyHeld) reasons.push(`already holding a ${proposal.symbol} position`);
          if (wouldExceedHourlyCap) reasons.push(`would exceed ${policy.autopilotMaxApprovalsPerHour} autonomous approvals/hour`);
          if (lacksConsensus) reasons.push(`panel consensus ${(agreement * 100).toFixed(0)}% with ${votes} vote(s) — needs ${(policy.autopilotMinConsensus * 100).toFixed(0)}%/${policy.autopilotMinPersonaVotes}`);
          deferred.push({ proposal, reason: reasons.join("; ") });
          continue;
        }

        accepted.push(proposal);
        pricedById.set(proposal.id, { entryPrice: priced.entryPrice, units: priced.units });
        runningPositionCount += 1;
        runningExposure += addedExposure;
        runningHourlyAutopilotCount += 1;
        heldSymbols.add(proposal.symbol);
      }

      // Deferred means "revisit later," not "claimed forever" — release
      // these back so the next scan cycle or a human can still act on them.
      deferred.forEach((d) => inFlightProposalIds.current.delete(d.proposal.id));

      if (deferred.length > 0) {
        logSecurityAudit(
          "AUTOPILOT_DEFERRED",
          `Self-Approve held back ${deferred.length} proposal(s) pending manual review: ${deferred
            .map((d) => `${d.proposal.symbol} (${d.reason})`)
            .join("; ")}`
        );
      }

      if (accepted.length === 0) return;

      const newPositions: Position[] = accepted.map((proposal, index) => {
        const { entryPrice, units } = pricedById.get(proposal.id)!;

        const currentAtr = atrForExits(proposal);

        const isTrendOrSwing =
          proposal.setup.family === "trend_following" ||
          proposal.setup.family === "breakout_confirmation" ||
          proposal.setup.horizon === "swing";

        return {
          id: `pos-${Date.now().toString().slice(-6)}-${index}`,
          symbol: proposal.symbol,
          direction: proposal.setup.direction,
          setupName: proposal.setup.name,
          entryPrice,
          currentPrice: entryPrice,
          quantity: units,
          stopLoss: proposal.setup.stopLoss,
          takeProfit: proposal.setup.takeProfit,
          initialTakeProfit: proposal.setup.takeProfit,
          unrealizedPnl: 0,
          unrealizedPnlPercent: 0,
          openTime: new Date().toISOString(),
          expectedHoldingTimeMinutes: proposal.setup.horizon === "swing" ? 4320 : 30,
          metaConfidence: proposal.metaScore.confidence,
          isSelfApproved: true,
          highestPrice: entryPrice,
          lowestPrice: entryPrice,
          trailActive: false,
          atrAtEntry: currentAtr,
          family: proposal.setup.family,
          horizon: proposal.setup.horizon,
          trailMode: isTrendOrSwing ? "TREND_RUNNER" : "SCALP_TIGHT",
        };
      });

      // Add only the accepted subset to active positions
      setActivePositions((prev) => [...newPositions, ...prev]);

      // Mark accepted proposals as APPROVED; deferred ones change to DEFERRED, carrying why
      const approvedIds = new Set(accepted.map((p) => p.id));
      const deferredReasonById = new Map(deferred.map((d) => [d.proposal.id, d.reason]));
      setProposalQueue((prev) =>
        prev.map((p) =>
          approvedIds.has(p.id) 
            ? { ...p, status: "APPROVED" } 
            : deferredReasonById.has(p.id)
              ? { ...p, status: "DEFERRED", deferralReason: deferredReasonById.get(p.id) } 
              : p
        )
      );

      setSelfApprovedCount((prev) => prev + accepted.length);

      playTradeExecutionSound();

      const symbolsList = accepted.map((p) => p.symbol).join(", ");
      setExecutionToast({
        id: `toast-${Date.now()}`,
        title: `■ [SELF-APPROVE] ${accepted.length} Trade${
          accepted.length > 1 ? "s" : ""
        } Auto-Approved`,
        message:
          deferred.length > 0
            ? `Self-Approve mode active: ${symbolsList} auto-approved. ${deferred.length} held back — exceeded a limit or lacked panel consensus, awaiting manual review.`
            : `Self-Approve mode active: All trades in queue (${symbolsList}) auto-approved and executed into active book.`,
        type: "SUCCESS",
        timestamp: new Date().toLocaleTimeString(),
      });
    },
    [killSwitchActive, activePositions, closedTrades, symbolQuarantines, riskPolicy, logSecurityAudit]
  );

  // Autonomous Self-Approval Engine:
  // When Self-Approve is ON (AUTO_WITHIN_LIMITS), ALL trades in the queue are automatically approved
  useEffect(() => {
    if (decisionMode !== "AUTO_WITHIN_LIMITS" || killSwitchActive) return;

    const pendingProposals = proposalQueue.filter(
      (p) => p.status === "PENDING_APPROVAL"
    );

    if (pendingProposals.length > 0) {
      // Auto-approve all trades in the queue
      const timer = setTimeout(() => {
        handleBatchApproveAllProposals(pendingProposals);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [
    decisionMode,
    proposalQueue,
    killSwitchActive,
    handleBatchApproveAllProposals,
  ]);

  const handleRejectProposal = (proposalId: string, reason: string) => {
    if (userRole === "auditor") {
      setExecutionToast({
        id: `toast-${Date.now()}`,
        title: "Security Clearance Restricted",
        message:
          "Auditor clearance is read-only. Switch to Desk Trader or Commander to veto proposals.",
        type: "WARNING",
        timestamp: new Date().toLocaleTimeString(),
      });
      return;
    }

    logSecurityAudit("ORDER_VETOED", `Vetoed proposal ${proposalId}: ${reason}`);

    setProposalQueue((prev) =>
      prev.map((p) =>
        p.id === proposalId
          ? {
              ...p,
              status: "REJECTED",
              supervisorNotes: `${p.supervisorNotes} [VETOED: ${reason}]`,
            }
          : p
      )
    );

    setSampleTelemetry((prev) => ({ ...prev, skippedByYou: prev.skippedByYou + 1 }));

    setExecutionToast({
      id: `toast-${Date.now()}`,
      title: "Proposal Vetoed",
      message: `Ticket skipped and logged to experience memory. Reason: ${reason}`,
      type: "INFO",
      timestamp: new Date().toLocaleTimeString(),
    });
  };

  // Trigger Universe Scan
  // Adds a scan's results to the queue: new proposals in, expired ones out,
  // no duplicates of a queued proposal or an open position, best first.
  const mergeScanIntoQueue = useCallback((report: FullScanReport) => {
    const now = Date.now();
    setProposalQueue((prev) => {
      const live = prev.filter(
        (p) => !((p.status === "PENDING_APPROVAL" || p.status === "DEFERRED") && p.expiresAt !== undefined && p.expiresAt < now)
      );
      const taken = new Set([
        ...activePositionsRef.current.map((p) => `${p.symbol}-${p.setupName}`),
        ...live.filter((p) => p.status === "PENDING_APPROVAL").map((p) => `${p.symbol}-${p.setup.name}`),
      ]);
      const fresh = report.newProposals.filter((p) => !taken.has(`${p.symbol}-${p.setup.name}`));
      if (fresh.length === 0 && live.length === prev.length) return prev;
      return [...fresh, ...live]
        .sort(
          (a, b) =>
            b.metaScore.calibratedWinProbability - a.metaScore.calibratedWinProbability ||
            b.evAssessment.expectedNetValue - a.evAssessment.expectedNetValue
        )
        .slice(0, 10);
    });
  }, []);

  const recordScan = useCallback(
    (report: FullScanReport) => {
      const proposed = report.outcomes.filter((o) => o.proposed).length;
      setSampleTelemetry((prev) => ({
        ...prev,
        analyzedCount: prev.analyzedCount + report.outcomes.length,
        selectedCount: prev.selectedCount + proposed,
        rejectedCount: prev.rejectedCount + (report.outcomes.length - proposed),
        skipReasons: addSkipCounts(prev.skipReasons, report.outcomes),
      }));
    },
    [setSampleTelemetry]
  );

  const runScan = async (symbols: string[] | undefined, onlyNewCandles: boolean) => {
    const report = await scanAllMarkets({
      symbols,
      onlyNewCandles,
      activePositions: activePositionsRef.current,
      dailyRealizedPnl,
      failureState,
      experiences,
      riskPolicy,
      quarantines: symbolQuarantinesRef.current,
      getOrderBook: fetchLiveOrderBook,
    });
    recordScan(report);
    mergeScanIntoQueue(report);
    shadowStore.add(report.shadows);
    return report;
  };
  // The candle-close listener below always calls the latest runScan.
  const runScanRef = useRef(runScan);
  runScanRef.current = runScan;

  // "Scan now": every coin, including ones already scanned this candle.
  const handleTriggerScanner = async () => {
    setIsScanningMarkets(true);
    try {
      const report = await runScanRef.current(undefined, false);
      setExecutionToast({
        id: `toast-${Date.now()}`,
        title: "Scan finished",
        message:
          report.newProposals.length > 0
            ? `${report.newProposals.length} new proposal(s) from ${report.outcomes.length} coins.`
            : `Checked ${report.outcomes.length} coins; nothing met the bar this time.`,
        type: report.newProposals.length > 0 ? "SUCCESS" : "INFO",
        timestamp: new Date().toLocaleTimeString(),
      });
    } catch (err) {
      console.error("Scanner Error:", err);
    } finally {
      setIsScanningMarkets(false);
    }
  };

  // Automatic scanning: each coin is scanned once, right after each of its
  // 5-minute candles closes. A one-minute backstop picks up any candle the
  // close event missed (and the first candles after start-up); coins whose
  // latest candle was already scanned are skipped.
  useEffect(() => {
    if (!isContinuousScanActive) return;
    const scanNew = (symbols?: string[]) => {
      // Wait for the first candles; until then every coin would count as "no data".
      if (!liveMarketStream.isReady) return;
      runScanRef.current(symbols, true).catch((err) => console.error("Scanner Error:", err));
    };
    const unsubscribe = liveMarketStream.onCandleClose((symbols) => scanNew(symbols));
    const backstop = setInterval(() => scanNew(undefined), 60 * 1000);
    const first = setTimeout(() => scanNew(undefined), 3000);
    return () => {
      unsubscribe();
      clearInterval(backstop);
      clearTimeout(first);
    };
  }, [isContinuousScanActive]);

  // Follow every setup the scanner found on real candles, to measure what
  // the filters skip (see shadowTracker). Resolved after each candle close,
  // and once a minute as a backstop.
  useEffect(() => {
    const resolve = () => shadowStore.resolve((sym) => liveMarketStream.getBars(sym));
    const unsubscribe = liveMarketStream.onCandleClose(resolve);
    const timer = setInterval(resolve, 60 * 1000);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, []);

  // Drop proposals whose signal has expired, even between scans.
  useEffect(() => {
    const sweep = setInterval(() => {
      const now = Date.now();
      setProposalQueue((prev) => {
        const next = prev.filter(
          (p) => !((p.status === "PENDING_APPROVAL" || p.status === "DEFERRED") && p.expiresAt !== undefined && p.expiresAt < now)
        );
        return next.length === prev.length ? prev : next;
      });
    }, 30 * 1000);
    return () => clearInterval(sweep);
  }, []);

  // Commander Modal Trigger & Server Analysis
  const handleWakeCommander = async () => {
    setIsCommanderModalOpen(true);
    setCommanderLoading(true);
    try {
      // Use the symbol actually on screen, with its real current indicators
      // and real recent swing high/low — not a hardcoded placeholder
      // unrelated to whatever the market is actually doing right now.
      const bars = liveMarketStream.getBars(currentSymbol);
      const latestBar = bars && bars.length > 0 ? bars[bars.length - 1] : null;
      const recentBars = bars ? bars.slice(-50) : [];
      const recentSwingHigh = recentBars.length > 0 ? Math.max(...recentBars.map((b) => b.high)) : undefined;
      const recentSwingLow = recentBars.length > 0 ? Math.min(...recentBars.map((b) => b.low)) : undefined;

      const res = await apiFetch("/api/agent/market-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: currentSymbol,
          price: latestBar?.close,
          indicators: latestBar
            ? {
                adx: latestBar.adx,
                rsi: latestBar.rsi,
                atrPercent: latestBar.atr && latestBar.close ? (latestBar.atr / latestBar.close) * 100 : undefined,
                ema9: latestBar.ema9,
                ema21: latestBar.ema21,
                ema50: latestBar.ema50,
                vwap: latestBar.vwap,
              }
            : {},
          recentSwingHigh,
          recentSwingLow,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const brief =
          data.regimeSummary ||
          data.summary ||
          data.analysis?.summary ||
          (typeof data.analysis === "string" ? data.analysis : null) ||
          "The brief isn't available right now. Trading, risk checks and the guardian don't depend on it.";
        setCommanderBrief(brief);
      } else {
        setCommanderBrief(
          "The brief isn't available right now. Trading, risk checks and the guardian don't depend on it."
        );
      }
    } catch {
      setCommanderBrief(
        "The brief isn't available right now. Trading, risk checks and the guardian don't depend on it."
      );
    } finally {
      setCommanderLoading(false);
    }
  };

  const handleToggleKillSwitch = () => {
    if (userRole === "auditor") {
      setExecutionToast({
        id: `toast-${Date.now()}`,
        title: "Security Clearance Restricted",
        message:
          "Auditor clearance is read-only. Switch to Commander to engage or disengage the Kill Switch.",
        type: "WARNING",
        timestamp: new Date().toLocaleTimeString(),
      });
      return;
    }

    const nextState = !killSwitchActive;
    setKillSwitchActive(nextState);
    setFailureState((prev) => ({
      ...prev,
      globalKillSwitchActive: nextState,
    }));

    logSecurityAudit(
      nextState ? "KILL_SWITCH_ENGAGED" : "KILL_SWITCH_DISENGAGED",
      `Emergency halt ${nextState ? "engaged" : "disengaged"} by operator (${userRole})`
    );

    setExecutionToast({
      id: `toast-${Date.now()}`,
      title: nextState ? "KILL SWITCH ENGAGED" : "KILL SWITCH DISENGAGED",
      message: nextState
        ? "Emergency halt triggered. All ticket execution and new limit orders are strictly blocked."
        : "Safety locks cleared. System returned to standard supervisor monitoring.",
      type: nextState ? "WARNING" : "SUCCESS",
      timestamp: new Date().toLocaleTimeString(),
    });
  };

  const handleDecisionModeChange = (mode: DecisionMode) => {
    if (userRole === "auditor" && mode === "AUTO_WITHIN_LIMITS") {
      setExecutionToast({
        id: `toast-${Date.now()}`,
        title: "Security Clearance Restricted",
        message:
          "Auditor clearance cannot enable Autonomous Self-Approval mode. Switch to Commander role.",
        type: "WARNING",
        timestamp: new Date().toLocaleTimeString(),
      });
      return;
    }
    setDecisionMode(mode);
    logSecurityAudit("DECISION_MODE_CHANGED", `Operational mode switched to ${mode}`);
  };

  const pendingCount = proposalQueue.filter(
    (p) => p.status === "PENDING_APPROVAL"
  ).length;

  return (
    <div className="min-h-screen w-full max-w-full overflow-x-hidden flex flex-col pb-20 bg-canvas text-ink font-ui">

      {/* Main Content Area */}
      <main className="flex-1 max-w-2xl w-full mx-auto space-y-4 px-5 pt-4">
        {/* Latest desk notification */}
        {executionToast && (
          <div
            role="status"
            className={`p-3.5 rounded-2xl border flex items-start justify-between gap-3 ${
              executionToast.type === "SUCCESS"
                ? "bg-surface border-line"
                : executionToast.type === "WARNING"
                ? "bg-danger-soft border-danger-line"
                : "bg-accent-soft border-transparent"
            }`}
          >
            <div className="flex items-start gap-2.5 min-w-0">
              <div className="mt-0.5 shrink-0">
                {executionToast.type === "SUCCESS" ? (
                  <CheckCircle2 className="w-4 h-4 text-gain" />
                ) : executionToast.type === "WARNING" ? (
                  <AlertTriangle className="w-4 h-4 text-loss" />
                ) : (
                  <Play className="w-4 h-4 text-accent" />
                )}
              </div>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <h4 className="m-0 font-semibold text-sm">{executionToast.title}</h4>
                  <span className="text-[11px] text-muted tabular-nums">{executionToast.timestamp}</span>
                </div>
                <p className="m-0 text-[13px] mt-0.5 text-muted leading-relaxed">{executionToast.message}</p>
              </div>
            </div>

            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setExecutionToast(null)}
              className="shrink-0 w-8 h-8 -m-1 rounded-full text-muted hover:bg-inset flex items-center justify-center cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {activeTab === "floor" && (
          <LedgerFloor
            isLive={tradingMode === "LIVE_COINDCX"}
            equity={currentRiskCalculation.equity}
            dailyPnl={dailyRealizedPnl}
            allTimePnl={allTimeRealizedPnl}
            autopilotOn={decisionMode === "AUTO_WITHIN_LIMITS"}
            onAutopilotChange={(on) => handleDecisionModeChange(on ? "AUTO_WITHIN_LIMITS" : "MANUAL")}
            exposureFraction={currentRiskCalculation.portfolioExposureFraction}
            dailyLossLeft={currentRiskCalculation.hardDailyLossLimit - currentRiskCalculation.currentDailyLoss}
            stopped={killSwitchActive}
            onToggleStop={handleToggleKillSwitch}
            positions={activePositions}
            onClosePosition={handleClosePosition}
            guardianOnline={guardianOnline}
            liveTradingEnabled={coinDcxStatus?.liveRisk ? Boolean(coinDcxStatus.liveRisk.enabled) : null}
            pendingProposals={pendingCount}
            scan={{
              analyzed: sampleTelemetry.analyzedCount,
              selected: sampleTelemetry.selectedCount,
              rejected: sampleTelemetry.rejectedCount,
              skipReasons: sampleTelemetry.skipReasons,
            }}
            onOpenQueue={() => setActiveTab("queue")}
            onOpenSettings={() => setIsSettingsOpen(true)}
          />
        )}

        {activeTab === "queue" && (
          <LedgerQueue
            proposals={proposalQueue}
            onApprove={handleApproveProposal}
            onReject={handleRejectProposal}
            onApproveAll={() => {
              const pendingProposals = proposalQueue.filter(
                (p) => p.status === "PENDING_APPROVAL"
              );
              if (pendingProposals.length > 0) {
                handleBatchApproveAllProposals(pendingProposals);
              }
            }}
            onScan={handleTriggerScanner}
            isScanning={isScanningMarkets}
            continuousScan={isContinuousScanActive}
            onContinuousScanChange={setIsContinuousScanActive}
            autopilotOn={decisionMode === "AUTO_WITHIN_LIMITS"}
            memoryCount={experiences.length}
            isLive={tradingMode === "LIVE_COINDCX"}
          />
        )}

        {activeTab === "book" && (
          <LedgerBook
            trades={closedTrades}
            onUpdateTrade={(updatedTrade) => {
              setClosedTrades((prev) =>
                prev.map((t) => (t.id === updatedTrade.id ? updatedTrade : t))
              );
            }}
            riskBlocked={
              !currentRiskCalculation.passedAllChecks ||
              failureState.simulateStaleMarketData ||
              failureState.simulateDailyLossBreach ||
              failureState.simulateOrderBookThinLiquidity
            }
            risk={
              <LedgerRisk
                riskCalc={currentRiskCalculation}
                failureState={failureState}
                onUpdateFailureState={(key, val) =>
                  setFailureState((prev) => ({ ...prev, [key]: val }))
                }
                onResetFailures={() =>
                  setFailureState((prev) => ({
                    ...prev,
                    simulateAgentTimeout: false,
                    simulateStaleMarketData: false,
                    simulateDailyLossBreach: false,
                    simulateOrderBookThinLiquidity: false,
                    simulateConflictingSignals: false,
                  }))
                }
                stopped={killSwitchActive}
                onToggleStop={handleToggleKillSwitch}
                coinDcxStatus={coinDcxStatus}
                onRefreshCoinDcxStatus={refreshCoinDcxStatus}
                onRefreshBalance={fetchCoinDcxBalance}
              />
            }
          />
        )}

        {activeTab === "learning" && (
          <LedgerLearning
            experiences={experiences}
            autopilotTrades={selfApprovedWins + selfApprovedLosses}
            autopilotWins={selfApprovedWins}
            promotedLabModel={promotedLabModel}
            onOpenLab={() => setActiveTab("lab")}
          />
        )}

        {activeTab === "lab" && (
          <LedgerLab
            promotedLabModel={promotedLabModel}
            onPromote={(result) => {
              if (result.isSynthetic) {
                setExecutionToast({
                  id: `toast-${Date.now()}`,
                  title: "Promotion blocked: generated data",
                  message: "This Lab result was trained on generated candles, not market history. Retrain on real data to promote.",
                  type: "WARNING",
                  timestamp: new Date().toLocaleTimeString(),
                });
                return;
              }
              const promoted: PromotedLabModel = {
                promotedAt: new Date().toISOString(),
                datasetName: result.datasetName || `${result.symbol} Custom`,
                accuracyPct: result.learnedMetrics.accuracyPercent,
                winRatePct: result.learnedMetrics.winRate,
                sharpeRatio: result.learnedMetrics.sharpeRatio,
                totalCandlesEvaluated: result.totalCandles || result.candlesCount,
                distilledRulesCount: result.distilledLessons.length,
                distilledLessons: result.distilledLessons,
                sourceExchange: result.sourceExchange,
                isSynthetic: result.isSynthetic,
                optimizedParameters: result.optimizedParameters,
                hasTrainedModel: result.distilledLessons.some(l => l.action.includes('TensorFlow.js')),
              };
              setPromotedLabModel(promoted);
              handleUpdateModelAccuracy({
                accuracyPct: result.learnedMetrics.accuracyPercent,
                winRatePct: result.learnedMetrics.winRate,
                sharpeRatio: result.learnedMetrics.sharpeRatio,
                datasetName: result.datasetName || `${result.symbol} Custom`,
                lastUpdated: new Date().toISOString(),
                totalCandlesEvaluated: result.totalCandles || result.candlesCount
              });
            }}
            onRevert={() => {
              setPromotedLabModel(null);
              saveStoredPromotedLabModel(null);
              setExecutionToast({
                id: `toast-${Date.now()}`,
                title: "Lab model removed",
                message: "The desk is back on the built-in rules, adjusted by live learning.",
                type: "INFO",
                timestamp: new Date().toLocaleTimeString(),
              });
            }}
          />
        )}
      </main>

      {/* Fixed Bottom Navigation Bar (Screenshots 1-7) */}
      <BottomNavBar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        pendingQueueCount={pendingCount}
      />

      <SettingsSheet
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        tradingMode={tradingMode}
        onTradingModeChange={handleToggleTradingMode}
        coinDcxStatus={coinDcxStatus}
        coinDcxBalance={coinDcxBalance}
        onRefreshBalance={fetchCoinDcxBalance}
        zerodhaStatus={zerodha.status}
        zerodhaError={zerodha.error}
        onZerodhaConnect={zerodha.connect}
        dailyLossLimit={riskPolicy.hardDailyLossLimit}
        maxOpenPositions={riskPolicy.maxSimultaneousPositions}
        riskLimits={riskLimits}
        onRiskLimitsChange={setRiskLimits}
        onOpenDeskBrief={() => {
          setIsSettingsOpen(false);
          handleWakeCommander();
        }}
        onOpenBackground={() => {
          setIsSettingsOpen(false);
          setIsBackgroundModalOpen(true);
        }}
        onOpenSecurity={() => {
          setIsSettingsOpen(false);
          setIsSecurityModalOpen(true);
        }}
      />

      {/* Commander Desk Brief Modal (Screenshot 6) */}
      <CommanderModal
        isOpen={isCommanderModalOpen}
        onClose={() => setIsCommanderModalOpen(false)}
        summaryText={commanderBrief}
        isLoading={commanderLoading}
      />


      {/* Firebase Security, RBAC & Audit Console */}
      <SecurityConsoleModal
        isOpen={isSecurityModalOpen}
        onClose={() => setIsSecurityModalOpen(false)}
      />

      {/* 24/7 Background Execution & Device-Lock Guardian Modal */}
      <BackgroundExecutionModal
        isOpen={isBackgroundModalOpen}
        onClose={() => setIsBackgroundModalOpen(false)}
        status={backgroundStatus}
        isPlaying={isPlaying}
        onTogglePlay={() => setIsPlaying((prev) => !prev)}
        onToggleWakeLock={toggleWakeLock}
        onToggleAudioKeepAlive={toggleAudioKeepAlive}
        onRequestNotifications={requestNotifications}
      />
    </div>
  );
}
