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
  loadLossStreakSince,
  saveLossStreakSince,
  SymbolQuarantineRecord,
} from "./services/storagePersistenceService";
import { scanAllMarkets, type FullScanReport } from "./services/marketScannerService";
import { addSkipCounts } from "./services/scanOutcome";
import { priceEntry } from "./services/entryPricing";
import { shadowStore } from "./services/shadowTracker";
import { useRiskPolicy } from "./hooks/useRiskPolicy";
import { useTheme } from "./hooks/useTheme";
import { liveMarketStream } from "./services/liveMarketStreamService";
import { CheckCircle2, AlertTriangle, X, Play, ArrowRight } from "lucide-react";

import { LoginScreen } from './components/LoginScreen';
import { BottomNavBar, TabType, useTabSlide } from "./components/BottomNavBar";
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
import { promoteCandidateModel } from "./services/mlService";
import { SecurityConsoleModal } from "./components/SecurityConsoleModal";
import { useAuth } from "./context/AuthContext";
import { useBackgroundExecution } from "./hooks/useBackgroundExecution";
import { useAwayNotice } from "./hooks/useAwayNotice";
import { AwayNotice } from "./components/ledger/AwayNotice";
import { BackgroundExecutionModal } from "./components/BackgroundExecutionModal";
import {
  playTradeExecutionSound,
  playProfitTargetSound,
  playStopLossSound,
} from "./utils/audioFeedback";
import { apiFetch } from "./services/apiClient";
import { computeClosedTradePnl } from "./shared/tradeMath";
import { blendedExitPrice, holdingDecision, openQuantity, planPartialQuantity, riskAtOpen } from "./shared/exitRules";
import { ruleFor } from "./services/marketRulesStore";
import { daemonEventToTrade, type DaemonCloseEvent } from "./services/daemonEvents";
import type { Quote } from "./shared/quotes";
import { entryPriceNow } from "./services/entryPriceNow";
import { LOSS_STREAK_LIMIT, cooldownUntil, lossStreak } from "./services/lossGuards";
import { getExpectancyTable, marketTrendFrom } from "./services/exitExpectancy";
import { fetchServerDeskControls, loadDeskControls, saveDeskControls } from "./services/deskControls";
import { useServerCloseHandler } from "./hooks/useServerCloseHandler";
import { useCoinDcxAccount } from "./hooks/useCoinDcxAccount";
import { adoptServerOpened, useGuardianSync } from "./hooks/useGuardianSync";
import { useDailyTelemetry } from "./hooks/useDailyTelemetry";
import { useLiveFeed } from "./hooks/useLiveFeed";
import {
  applyTickToPosition,
  markPriceFor,
  type SuspectTick,
  type TickExitReason,
} from "./services/positionTick";
import { isBuiltOnSyntheticPrices } from "./services/dataProvenance";
import { fetchLiveOrderBook } from "./services/orderBookService";
import { useServerScanner, type ServerScanReport } from "./hooks/useServerScanner";
import { useServerStatus } from "./hooks/useServerStatus";
import { useEventWindow } from "./hooks/useEventWindow";
import { useTrailProfile } from "./hooks/useTrailProfile";
import { showLocalTradePopup, useTradeNotifications } from "./hooks/useTradeNotifications";
import { tradeClosedMessage } from "./shared/tradeMessages";
import { holdMinutesFor, trailsAsRunner } from "./shared/coinHolds";
import { atrForExits as sharedAtrForExits, autopilotOpeningsLastHour, autopilotQueue, newPositionId, PHONE_SCAN_HOLD_REASON, positionFromProposal, selectAutopilotTrades } from "./services/autopilot";
import { buildCalibrator } from "./services/calibration";
import { experiencesFromShadows, withTradeExperiences } from "./services/experienceMemory";

// ATR recorded on a position for its trailing-stop rules.
function atrForExits(proposal: TradeProposal): number {
  const bars = liveMarketStream.getBars(proposal.symbol);
  return sharedAtrForExits(proposal.setup, bars?.at(-1)?.atr);
}

export default function App() {
  const { userRole, logSecurityAudit, currentUser, loading } = useAuth();
  const [isSecurityModalOpen, setIsSecurityModalOpen] = useState<boolean>(false);

  // Navigation: Floor, Queue, Book, Lab, Learning
  const [activeTab, setActiveTab] = useState<TabType>("floor");
  const tabSlideClass = useTabSlide(activeTab);
  // Autopilot and the kill switch, as last left on this device (off until known).
  const savedControls = React.useMemo(() => loadDeskControls(), []);
  const [decisionMode, setDecisionMode] = useState<DecisionMode>(savedControls?.autopilot ? "AUTO_WITHIN_LIMITS" : "MANUAL");
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
  const [killSwitchActive, setKillSwitchActive] = useState<boolean>(savedControls?.killSwitch ?? false);
  // Known once saved here or read from the server; the server isn't sent
  // settings before then, so a default can't overwrite its copy.
  const [controlsKnown, setControlsKnown] = useState<boolean>(savedControls !== null);
  useEffect(() => {
    if (controlsKnown) return;
    let cancelled = false;
    fetchServerDeskControls().then((server) => {
      if (cancelled) return;
      if (server) {
        setDecisionMode(server.autopilot ? "AUTO_WITHIN_LIMITS" : "MANUAL");
        setKillSwitchActive(server.killSwitch);
        if (server.killSwitch) setFailureState((prev) => ({ ...prev, globalKillSwitchActive: true }));
      }
      setControlsKnown(true);
    });
    return () => {
      cancelled = true;
    };
  }, [controlsKnown]);
  useEffect(() => {
    if (controlsKnown) saveDeskControls({ autopilot: decisionMode === "AUTO_WITHIN_LIMITS", killSwitch: killSwitchActive });
  }, [controlsKnown, decisionMode, killSwitchActive]);

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

  // On unlocking the phone: a pill, or a "While you were away" card when
  // trades opened or closed meanwhile (see useAwayNotice).
  const activePositionsRef = React.useRef<Position[]>([]);
  const closedTradesRef = React.useRef<HistoricalTrade[]>([]);
  const away = useAwayNotice(activePositionsRef, closedTradesRef);
  const handleReconcileMissedTicks = useCallback(
    (missedCycles: number, elapsedMs: number) => {
      if (!isPlaying || missedCycles <= 0) return;
      away.onUnlock(elapsedMs);
    },
    [isPlaying, away.onUnlock]
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
  // Trade pop-ups switched on for this phone (Settings); read when the app closes a trade itself.
  const tradePopupsOnRef = useRef(false);
  React.useEffect(() => { activePositionsRef.current = activePositions; }, [activePositions]);
  const [closedTrades, setClosedTrades] = useState<HistoricalTrade[]>(() =>
    loadStoredClosedTrades()
  );
  // Trailing-stop profile for new positions (chosen in the Lab's exit comparison).
  const { profile: trailProfileId, setProfile: setTrailProfileId } = useTrailProfile();
  const trailProfileRef = React.useRef(trailProfileId);
  trailProfileRef.current = trailProfileId;
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

  // After any close, in the app or by the server guardian, leave the coin
  // alone for a while: 2 hours after a loss, 5 minutes after a win.
  const lossGuardsRef = useRef<(trade: HistoricalTrade) => void>(() => {});
  lossGuardsRef.current = (trade: HistoricalTrade) => {
    const closedAtMs = trade.closedAtMs ?? Date.now();
    setSymbolQuarantines((prev) => ({
      ...prev,
      [trade.symbol]: {
        symbol: trade.symbol,
        quarantinedUntilMs: cooldownUntil({ isWin: trade.isWin, closedAtMs }),
        reason: trade.isWin ? `Post-trade cooldown on ${trade.symbol} (5m pause)` : `Loss recorded on ${trade.symbol}`,
        consecutiveLosses: trade.isWin ? 0 : (prev[trade.symbol]?.consecutiveLosses ?? 0) + 1,
        lastLossTimestamp: new Date(closedAtMs).toISOString(),
      },
    }));
    if (!trade.isWin) {
      logSecurityAudit("SYMBOL_QUARANTINED", `Symbol ${trade.symbol} quarantined for 120 minutes following loss (exit: ₹${trade.exitPrice}, PnL: ₹${trade.realizedPnl})`);
    }
  };

  // When the kill switch was last turned off: losses before it don't count.
  const lossStreakSinceRef = useRef<number>(loadLossStreakSince());

  // Three losses in a row in the book, however they closed: trip the kill
  // switch and turn autopilot off. Checked whenever the book changes, so a
  // streak the server's closes built up while the app was shut is caught
  // when it opens.
  useEffect(() => {
    if (killSwitchActive || lossStreak(closedTrades, lossStreakSinceRef.current) < LOSS_STREAK_LIMIT) return;
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
  }, [closedTrades, killSwitchActive, logSecurityAudit]);

  // A close the server guardian made: credited once, then the same guards.
  const handleServerClose = useCallback(
    (ev: DaemonCloseEvent): boolean => {
      const applied = applyServerClose(ev);
      if (applied) lossGuardsRef.current(daemonEventToTrade(ev));
      return applied;
    },
    [applyServerClose]
  );

  // Positions this app has closed (or is closing): a server copy of one
  // mustn't come back before the guardian hears it's gone.
  const isClosedLocally = useCallback(
    (id: string) => closingPositionIds.current.has(id) || closedTradesRef.current.some((t) => t.positionId === id),
    []
  );

  // A position the server's autopilot opened (the app may have been closed).
  const applyServerOpen = useCallback(
    (pos: Position) => {
      // Already have it, closed it, or hold that coin (the same signal opened here too).
      if (activePositionsRef.current.some((p) => p.id === pos.id || p.symbol === pos.symbol) || isClosedLocally(pos.id)) return;
      setActivePositions((prev) => adoptServerOpened(prev, [pos], isClosedLocally));
      setSelfApprovedCount((prev) => prev + 1);
      playTradeExecutionSound();
      setExecutionToast({
        id: `toast-${Date.now()}`,
        title: `■ [SELF-APPROVE] ${pos.symbol} opened on the server`,
        message: `${pos.direction} ${pos.quantity} @ ₹${pos.entryPrice} (${pos.setupName}). The server's autopilot opened it after its scan.`,
        type: "SUCCESS",
        timestamp: new Date().toLocaleTimeString(),
      });
    },
    [isClosedLocally]
  );

  // Live feed: prices, guardian closes and live-exit updates from the server.
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  // closePositionWithAutopsy is defined further down; the feed reaches it
  // through this ref so it always calls the current version.
  const closePositionRef = useRef<(pos: Position, exitPrice: number, reason: TickExitReason | "EXPIRY_TIME") => void>(
    () => {}
  );
  const tickSeq = useRef(0);

  // Server scan reports pushed over the socket; wired up below, once the
  // server-scanner hook exists.
  const liveScanReportRef = useRef<(r: ServerScanReport) => void>(() => {});

  // Best bid and ask for held coins, from the server. Positions are judged on
  // what they could be closed at (the bid for a long), not on trade prints,
  // which jump between the bid and the ask.
  const quotesRef = useRef<Map<string, Quote>>(new Map());

  // New prices for the open positions: stops, trailing, targets and banking.
  const applyMarks = (prices: Record<string, number>) => {
    const seq = ++tickSeq.current;
    setActivePositions((prev) => {
      if (prev.length === 0) return prev;
      let changed = false;
      const next: Position[] = [];
      for (const pos of prev) {
        const out = applyTickToPosition(pos, markPriceFor(pos, prices, quotesRef.current), pendingSuspectPrices.current, seq);
        if (out.kind === "exit") {
          const { position, price, reason } = out;
          // closePositionWithAutopsy de-duplicates, so a repeated updater run is harmless.
          setTimeout(() => closePositionRef.current(position, price, reason), 10);
          changed = true;
          continue;
        }
        if (out.kind === "updated" && out.changed) changed = true;
        if (out.kind === "updated" && out.banked) {
          const p = out.position;
          setTimeout(
            () =>
              setExecutionToast({
                id: `toast-banked-${p.id}`,
                title: `Banked half of ${p.symbol}`,
                message: `${p.bankedQuantity} closed at ₹${p.bankedPrice} (+1R). The stop is past break-even; the rest runs on the trailing stop.`,
                type: "SUCCESS",
                timestamp: new Date().toLocaleTimeString(),
              }),
            10
          );
        }
        next.push(out.position);
      }
      return changed ? next : prev;
    });
  };

  useLiveFeed({
    onScanReport: (r) => liveScanReportRef.current(r),
    onServerOpen: applyServerOpen,
    onTick: (prices) => {
      setLivePrices((prev) => ({ ...prev, ...prices }));
      applyMarks(prices);
    },
    onQuote: (quotes) => {
      for (const [symbol, q] of Object.entries(quotes)) {
        if (q && q.bid > 0 && q.ask >= q.bid) quotesRef.current.set(symbol, q);
      }
      applyMarks({});
    },
    onServerClose: (ev) => {
      console.log("[Daemon Position Guardian] Server closed trade event received:", ev);
      if (handleServerClose(ev)) {
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

  // Enforce each position's holding time: every 30s, close anything past its
  // limit that hasn't locked in profit (winners run on their trailing stop,
  // up to the extended limit), at the best known price.
  useEffect(() => {
    const checkHoldingTimeExpiry = () => {
      const now = Date.now();
      for (const pos of activePositionsRef.current) {
        if (holdingDecision(pos, now) === "expire") {
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
  const guardianOnline = useGuardianSync(activePositions, setActivePositions, handleServerClose, isClosedLocally);
  const zerodha = useZerodhaConnection();
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  // Where the gear was when Settings was opened: it opens from there.
  const [settingsFrom, setSettingsFrom] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

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
    globalKillSwitchActive: savedControls?.killSwitch ?? false,
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
    const currentExposure = activePositions.reduce((acc, p) => acc + (p.entryPrice * openQuantity(p)), 0);
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

  // Every closed trade goes into the memory, whoever closed it (this app or
  // the server's guardian), with the market's readings from when its setup
  // was found.
  useEffect(() => {
    setExperiences((prev) => withTradeExperiences(prev, closedTrades, shadowStore.all()));
  }, [closedTrades]);

  // Continuous Online Learning Background Worker
  useEffect(() => {
    // Check every hour if a day has passed since last training
    const interval = setInterval(() => {
      void checkAndRunOnlineLearning(shadowStore.all());
    }, 60 * 60 * 1000);

    // Also check shortly after launch
    const timeout = setTimeout(() => {
      void checkAndRunOnlineLearning(shadowStore.all());
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
  }, []);

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
      } = computeClosedTradePnl(
        pos.direction,
        pos.entryPrice,
        exitPrice,
        pos.quantity,
        reason,
        pos.bankedQuantity && pos.bankedPrice !== undefined ? { quantity: pos.bankedQuantity, price: pos.bankedPrice } : undefined,
        pos.symbol
      );

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
        // Several positions can close on the same price update: the position
        // id keeps each trade's id unique.
        id: `trade-closed-${pos.id}-${nowMs}`,
        positionId: pos.id,
        symbol: pos.symbol,
        direction: pos.direction,
        setupName: pos.setupName,
        entryPrice: pos.entryPrice,
        // Averaged over the half banked at +1R, if any.
        exitPrice: Number(blendedExitPrice(pos, exitPrice).toFixed(8)),
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
        stopAtExit: pos.stopLoss,
        riskAtOpen: riskAtOpen(pos),
        ...(pos.openedByServer ? { openedByServer: true } : {}),
        fillAtExit: exitPrice,
      };

      setClosedTrades((prev) => [newHistoricalTrade, ...prev]);
      // The same pop-up the server sends for its closes (same tag, so a close
      // both sides report shows once).
      if (tradePopupsOnRef.current) {
        void showLocalTradePopup(
          tradeClosedMessage({ ...newHistoricalTrade, positionId: pos.id })
        );
      }

      // Coin cooldown and the loss-streak kill switch (shared with server closes).
      lossGuardsRef.current(newHistoricalTrade);

      // Update self-approval learning statistics
      if (pos.isSelfApproved) {
        if (isWin) {
          setSelfApprovedWins((prev) => prev + 1);
        } else {
          setSelfApprovedLosses((prev) => prev + 1);
        }
      }

      // The trade goes into the memory with the other closed trades (the effect on closedTrades below).

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
    async (proposal: TradeProposal, isAutonomousSelfApproved: boolean = false) => {
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

      const isTrendOrSwing = trailsAsRunner(proposal.setup);

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

      // Enter at the price it would really fill at now (the ask for a long),
      // not the (older) candle close the signal came from; skip it if price
      // has already run too far.
      const priced = priceEntry(
        proposal.setup,
        await entryPriceNow(proposal.symbol, proposal.setup.direction, units * proposal.setup.entryPrice, quotesRef.current.get(proposal.symbol)),
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
        id: newPositionId(),
        symbol: proposal.symbol,
        direction: proposal.setup.direction,
        setupName: proposal.setup.name,
        entryPrice,
        currentPrice: entryPrice,
        quantity,
        stopLoss: proposal.setup.stopLoss,
        takeProfit: proposal.setup.takeProfit,
        initialTakeProfit: proposal.setup.takeProfit,
        initialStopLoss: proposal.setup.stopLoss,
        partialQuantity: planPartialQuantity(quantity, entryPrice, ruleFor(proposal.symbol, entryPrice)),
        unrealizedPnl: 0,
        unrealizedPnlPercent: 0,
        openTime: new Date().toISOString(),
        expectedHoldingTimeMinutes: holdMinutesFor(proposal.setup),
        metaConfidence: proposal.metaScore.confidence,
        isSelfApproved: isAutonomousSelfApproved,
        highestPrice: entryPrice,
        lowestPrice: entryPrice,
        trailActive: false,
        atrAtEntry: currentAtr,
        family: proposal.setup.family,
        horizon: proposal.setup.horizon,
        trailMode: isTrendOrSwing ? "TREND_RUNNER" : "SCALP_TIGHT",
        trailProfile: trailProfileRef.current,
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
    async (proposalsToApprove: TradeProposal[]) => {
      if (killSwitchActive || proposalsToApprove.length === 0) return;
      // These open paper positions. In Live mode a real order is placed only
      // by approving one trade yourself, never in a batch.
      if (tradingMode === "LIVE_COINDCX") return;

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

      // What each would really open at now (the ask for a long).
      const entryPrices = new Map(
        await Promise.all(
          claimable.map(
            async (p) =>
              [
                `${p.symbol}|${p.setup.direction}`,
                await entryPriceNow(p.symbol, p.setup.direction, p.riskCalc.recommendedPositionSizeUnits * p.setup.entryPrice, quotesRef.current.get(p.symbol)),
              ] as const
          )
        )
      );

      const { accepted, deferred } = selectAutopilotTrades(
        proposalsToApprove,
        {
          positions: activePositions,
          openedLastHour: autopilotOpeningsLastHour(activePositions, closedTrades),
          quarantines: symbolQuarantines,
        },
        riskPolicy,
        (symbol, direction) => entryPrices.get(`${symbol}|${direction}`) ?? liveMarketStream.getLastPrice(symbol)
      );

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

      const newPositions: Position[] = accepted.map((a) =>
        positionFromProposal(a, { id: newPositionId(), atr: atrForExits(a.proposal), trailProfile: trailProfileRef.current })
      );

      // Add only the accepted subset to active positions
      // The book as it is now: a position the server opened in one of these
      // coins may have arrived since the checks above.
      setActivePositions((prev) => {
        const held = new Set(prev.map((p) => p.symbol));
        return [...newPositions.filter((p) => !held.has(p.symbol)), ...prev];
      });

      // Mark accepted proposals as APPROVED; deferred ones change to DEFERRED, carrying why
      const approvedIds = new Set(accepted.map((a) => a.proposal.id));
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

      const symbolsList = accepted.map((a) => a.proposal.symbol).join(", ");
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
    [killSwitchActive, tradingMode, activePositions, closedTrades, symbolQuarantines, riskPolicy, logSecurityAudit]
  );

  // Autonomous Self-Approval Engine:
  // When Self-Approve is ON (AUTO_WITHIN_LIMITS), waiting trades the server's checks passed are
  // approved automatically, within the limits; ones this phone's own scan found wait for you.
  // Paper only: in Live mode every trade waits for you (the server's autopilot is paper-only too).
  useEffect(() => {
    if (decisionMode !== "AUTO_WITHIN_LIMITS" || killSwitchActive || tradingMode === "LIVE_COINDCX") return;

    // What this phone's own scan found waits for you, with why.
    const { take: pendingProposals, hold } = autopilotQueue(proposalQueue);
    if (hold.length > 0) {
      const held = new Set(hold.map((p) => p.id));
      setProposalQueue((prev) =>
        prev.map((p) => (held.has(p.id) && p.status === "PENDING_APPROVAL" ? { ...p, status: "DEFERRED", deferralReason: PHONE_SCAN_HOLD_REASON } : p))
      );
    }

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
    tradingMode,
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
  const mergeScanIntoQueue = useCallback((report: Pick<FullScanReport, "newProposals">) => {
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
    (report: Pick<FullScanReport, "outcomes">) => {
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

  // Scheduled-news pauses (US CPI, Fed decisions...): no new trades around them.
  const eventWindow = useEventWindow();
  const eventWindowRef = useRef(eventWindow);
  eventWindowRef.current = eventWindow;

  const runScan = async (symbols: string[] | undefined, onlyNewCandles: boolean) => {
    const report = await scanAllMarkets({
      symbols,
      onlyNewCandles,
      activePositions: activePositionsRef.current,
      dailyRealizedPnl,
      failureState,
      // Real results only: tracked setups and your closed trades, not the
      // generated starter memory.
      experiences: [...experiencesFromShadows(shadowStore.all()), ...experiences.filter((e) => !e.isSeeded)],
      riskPolicy,
      quarantines: symbolQuarantinesRef.current,
      getOrderBook: fetchLiveOrderBook,
      eventWindow: eventWindowRef.current,
      // Each trader's last day with your exits (remeasured hourly), and Bitcoin's trend.
      exitExpectancy: getExpectancyTable(
        liveMarketStream.getCryptoSymbols(),
        (s) => liveMarketStream.getBars(s),
        trailProfileRef.current
      ),
      marketTrend: marketTrendFrom(liveMarketStream.getBars("BTC/INR"), liveMarketStream.getMacroRegime("BTC/INR")),
      calibrators: {
        heuristic: buildCalibrator(shadowStore.all(), "heuristic"),
        tfjs: buildCalibrator(shadowStore.all(), "tfjs"),
      },
    });
    // Autopilot leaves these for you: the server's checks didn't see them.
    const marked = { ...report, newProposals: report.newProposals.map((p) => ({ ...p, scannedOnPhone: true })) };
    recordScan(marked);
    mergeScanIntoQueue(marked);
    shadowStore.add(marked.shadows);
    return marked;
  };
  // The candle-close listener below always calls the latest runScan.
  const runScanRef = useRef(runScan);
  runScanRef.current = runScan;

  // The server scans after every candle close, even with the app closed; its
  // results arrive here. This browser scans by itself only when the server
  // isn't scanning.
  const serverScanner = useServerScanner(
    {
      equity: effectiveEquity,
      riskLimits,
      dailyRealizedPnl,
      autopilot: decisionMode === "AUTO_WITHIN_LIMITS",
      tradingMode,
      trailProfile: trailProfileId,
      killSwitch: killSwitchActive,
      lossStreak: lossStreak(closedTrades, lossStreakSinceRef.current),
      scanning: isContinuousScanActive,
      failureState,
      quarantines: Object.fromEntries(
        Object.entries(symbolQuarantines).map(([sym, q]) => [sym, { quarantinedUntilMs: q.quarantinedUntilMs }])
      ),
      promotedModel: promotedLabModel,
    },
    (report) => {
      const now = Date.now();
      recordScan(report);
      // Scans from while the app was closed may hold proposals that have since expired.
      mergeScanIntoQueue({ newProposals: report.newProposals.filter((p) => p.expiresAt === undefined || p.expiresAt > now) });
    },
    controlsKnown
  );
  liveScanReportRef.current = serverScanner.handleLiveReport;
  const serverStatus = useServerStatus(isSettingsOpen);
  const tradeNotifications = useTradeNotifications();
  const appTheme = useTheme();
  // Trades already in the Book when the app opened: only closes after that bump the Book tab.
  const closedAtStartRef = useRef(closedTrades.length);
  // Today's closes, oldest first, for the Floor's line through the day.
  const todayCloses = useMemo(() => {
    const start = new Date().setHours(0, 0, 0, 0);
    return closedTrades
      .filter((t) => (t.closedAtMs ?? 0) >= start)
      .map((t) => ({ at: t.closedAtMs as number, pnl: t.realizedPnl }))
      .sort((a, b) => a.at - b.at);
  }, [closedTrades]);
  tradePopupsOnRef.current = tradeNotifications.state === "on";
  const scanLocationRef = useRef(serverScanner.location);
  scanLocationRef.current = serverScanner.location;

  // "Scan now": every coin, including ones already scanned this candle.
  const handleTriggerScanner = async () => {
    setIsScanningMarkets(true);
    try {
      const fromServer = scanLocationRef.current === "server" ? await serverScanner.scanNow() : null;
      const report = fromServer ?? (await runScanRef.current(undefined, false));
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
      // The server is scanning (or we're still asking whether it is).
      if (scanLocationRef.current !== "browser") return;
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
    // Turned off by you: losses before now no longer count toward the next trip.
    if (!nextState) {
      lossStreakSinceRef.current = Date.now();
      saveLossStreakSince(lossStreakSinceRef.current);
    }
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

      <AwayNotice notice={away.notice} onDismiss={away.dismiss} onOpenBook={() => setActiveTab("book")} />

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

        {/* Each tab slides in from the side it's on in the bottom bar. */}
        <div key={activeTab} className={tabSlideClass}>
          {activeTab === "floor" && (
            <LedgerFloor
              scanLocation={serverScanner.location}
              lastServerScanAt={serverScanner.lastScanAt}
              lastServerOpenAt={serverScanner.lastAutopilotOpenAt}
              syncGlowKey={away.glowKey}
              eventWindow={eventWindow}
              isLive={tradingMode === "LIVE_COINDCX"}
              equity={currentRiskCalculation.equity}
              dailyPnl={dailyRealizedPnl}
              dailyLossLimit={currentRiskCalculation.hardDailyLossLimit}
              todayCloses={todayCloses}
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
              onOpenSettings={(from) => {
                setSettingsFrom(from ? { left: from.left, top: from.top, width: from.width, height: from.height } : null);
                setIsSettingsOpen(true);
              }}
              settingsOpen={isSettingsOpen}
            />
          )}

          {activeTab === "queue" && (
            <LedgerQueue
              proposals={proposalQueue}
              onApprove={handleApproveProposal}
              onReject={handleRejectProposal}
              onApproveAll={
                tradingMode === "LIVE_COINDCX"
                  ? undefined
                  : () => {
                      const pendingProposals = proposalQueue.filter(
                        (p) => p.status === "PENDING_APPROVAL"
                      );
                      if (pendingProposals.length > 0) {
                        handleBatchApproveAllProposals(pendingProposals);
                      }
                    }
              }
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
              trailProfile={trailProfileId}
              onTrailProfileChange={setTrailProfileId}
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
                  hasTrainedModel: false,
                };
                const finish = (withModel: boolean) => {
                  setPromotedLabModel(
                    withModel ? { ...promoted, hasTrainedModel: true, featureVersion: result.featureVersion } : promoted
                  );
                  handleUpdateModelAccuracy({
                    accuracyPct: result.learnedMetrics.accuracyPercent,
                    winRatePct: result.learnedMetrics.winRate,
                    sharpeRatio: result.learnedMetrics.sharpeRatio,
                    datasetName: result.datasetName || `${result.symbol} Custom`,
                    lastUpdated: new Date().toISOString(),
                    totalCandlesEvaluated: result.totalCandles || result.candlesCount,
                  });
                };
                // The Lab's model goes live first, so the scanner never pairs
                // this promotion with an older model file.
                if (result.featureVersion) void promoteCandidateModel().then(finish);
                else finish(false);
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
        </div>
      </main>

      {/* Fixed Bottom Navigation Bar (Screenshots 1-7) */}
      <BottomNavBar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        pendingQueueCount={pendingCount}
        bookBumpKey={Math.max(0, closedTrades.length - closedAtStartRef.current)}
      />

      <SettingsSheet
        isOpen={isSettingsOpen}
        from={settingsFrom}
        theme={appTheme.theme}
        onThemeChange={appTheme.setTheme}
        notifications={tradeNotifications}
        serverStatus={serverStatus}
        scanLocation={serverScanner.location}
        lastServerScanAt={serverScanner.lastScanAt}
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
