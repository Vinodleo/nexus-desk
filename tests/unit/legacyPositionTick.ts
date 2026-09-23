// VERBATIM copy of the per-position tick logic that ran inline in App.tsx's
// WebSocket handler before the refactor (origin/main). Used only to prove the
// extracted applyTickToPosition behaves identically. Do not edit.
/* eslint-disable */
import type { Position } from "../../src/types";

export interface LegacyResult {
  pushed: Position[];
  exits: { pos: Position; price: number; reason: string }[];
  changed: boolean;
}

export function legacyTick(prev: Position[], newPrices: Record<string, number>, pendingSuspectPrices: { current: Map<string, number> }): LegacyResult {
  let changed = false;
  const nextPositions: Position[] = [];
  const exits: LegacyResult["exits"] = [];
  const setTimeout = (fn: () => void, _ms?: number) => fn();
  const closePositionWithAutopsy = (pos: Position, price: number, reason: string) => exits.push({ pos: { ...pos }, price, reason });
  for (const pos of prev) {
              let realINRPrice = newPrices[pos.symbol];

              if (!realINRPrice) {
                const baseAsset = pos.symbol.split('/')[0];
                const binanceSymbol = `${baseAsset}/USDT`;
                const liveCrypto = newPrices[binanceSymbol];
                if (liveCrypto) {
                  realINRPrice = liveCrypto * 83.5;
                }
              }

              if (!realINRPrice) {
                nextPositions.push(pos);
                continue;
              }

              // Price sanity guard: reject a single tick that implies an
              // implausible move (e.g. a stale/synthetic fallback price
              // getting mixed in with a real feed) rather than trusting it
              // blindly. A real market — even a volatile crypto pair —
              // essentially never moves >25% between consecutive ticks;
              // seeing that is a strong sign the tick is bad data, not a
              // real move, and acting on it risks stopping a position out
              // against a number that was never actually true.
              const referencePrice = pos.currentPrice || pos.entryPrice;
              const tickDeviation =
                referencePrice > 0
                  ? Math.abs(realINRPrice - referencePrice) / referencePrice
                  : 0;

              if (tickDeviation > 0.25) {
                const pending = pendingSuspectPrices.current.get(pos.id);
                const confirmsPending =
                  pending !== undefined &&
                  Math.abs(realINRPrice - pending) / pending < 0.03;

                if (confirmsPending) {
                  // A second, independent tick landed close to the first
                  // "suspect" one — that's real agreement, not a fluke.
                  // Accept it: jump straight to the confirmed price rather
                  // than slowly re-testing the 25% gate bar by bar.
                  console.log(
                    `[PriceGuard] Confirmed recovery for ${pos.symbol}: ${referencePrice} -> ${realINRPrice} (two consecutive ticks agreed). Accepting.`
                  );
                  pendingSuspectPrices.current.delete(pos.id);
                } else {
                  console.warn(
                    `[PriceGuard] Rejected implausible tick for ${pos.symbol}: ${referencePrice} -> ${realINRPrice} (${(tickDeviation * 100).toFixed(0)}% single-tick move). Awaiting confirmation. Position left unchanged.`
                  );
                  pendingSuspectPrices.current.set(pos.id, realINRPrice);
                  nextPositions.push(pos);
                  continue;
                }
              } else if (pendingSuspectPrices.current.has(pos.id)) {
                // Tick came back within normal range on its own — drop
                // whatever we were waiting to confirm.
                pendingSuspectPrices.current.delete(pos.id);
              }

              const isLong = pos.direction === "LONG";

              // Evaluate Stop Loss, Trailing Profit Lock, and Take Profit against LIVE tick
              let hitExit = false;
              let exitReason: "STOP_LOSS" | "TAKE_PROFIT" | "TRAILING_STOP" | null = null;
              let exitFillPrice = realINRPrice;

              const atr = pos.atrAtEntry || (pos.entryPrice * 0.005);
              const isTrendRunner =
                pos.trailMode === "TREND_RUNNER" ||
                pos.family === "trend_following" ||
                pos.family === "breakout_confirmation" ||
                (pos.expectedHoldingTimeMinutes || 30) > 60;

              if (isLong) {
                // Track peak high price
                pos.highestPrice = Math.max(pos.highestPrice || pos.entryPrice, realINRPrice);
                const peakGain = Math.max(0, pos.highestPrice - pos.entryPrice);
                const profitInATR = atr > 0 ? peakGain / atr : 0;
                const profitPct = (peakGain / pos.entryPrice) * 100;
                const initialTP = pos.initialTakeProfit || pos.takeProfit;
                const targetDist = Math.max(0.001, initialTP - pos.entryPrice);
                const targetProgress = peakGain / targetDist;

                if (isTrendRunner) {
                  // --- TREND RUNNER MODE (LONG) ---
                  // Activate trail once solidly established (at least 0.8% gain, 1.2 ATR, or 50% towards target)
                  if (!pos.trailActive && (profitPct >= 0.80 || profitInATR >= 1.2 || targetProgress >= 0.50)) {
                    pos.trailActive = true;
                  }

                  if (pos.trailActive) {
                    // When price reaches or exceeds the initial target:
                    if (realINRPrice >= initialTP) {
                      const targetLockPrice = initialTP;
                      if (targetLockPrice > pos.stopLoss) {
                        pos.stopLoss = targetLockPrice;
                        changed = true;
                      }

                      // Expand target to runner stage
                      const extendedTarget = initialTP + targetDist * 1.5;
                      if (pos.takeProfit < extendedTarget) {
                        pos.takeProfit = extendedTarget;
                        changed = true;
                      }

                      // Trail behind highest peak at 1.5 ATR distance, never falling below targetLockPrice
                      const runnerTrailStop = Math.max(targetLockPrice, pos.highestPrice - (atr * 1.5));
                      if (runnerTrailStop > pos.stopLoss) {
                        pos.stopLoss = runnerTrailStop;
                        changed = true;
                      }
                    } else {
                      // Pre-target phase: Breathing room with break-even floor once trail is active
                      const breakevenFloor = pos.entryPrice * 1.002;
                      const structuralTrail = pos.highestPrice - (atr * 1.5);
                      const dynamicStop = Math.max(breakevenFloor, structuralTrail);

                      if (dynamicStop > pos.stopLoss) {
                        pos.stopLoss = dynamicStop;
                        changed = true;
                      }
                    }
                  }

                  // Exit Evaluation for Long Trend Runner
                  if (realINRPrice >= pos.takeProfit) {
                    hitExit = true;
                    exitReason = "TAKE_PROFIT";
                    exitFillPrice = realINRPrice;
                  } else if (realINRPrice <= pos.stopLoss) {
                    hitExit = true;
                    if (pos.trailActive || pos.stopLoss >= pos.entryPrice) {
                      exitReason = "TRAILING_STOP";
                      exitFillPrice = realINRPrice;
                    } else {
                      exitReason = "STOP_LOSS";
                      exitFillPrice = realINRPrice;
                    }
                  }
                } else {
                  // --- SCALP MODE (LONG) ---
                  // Require meaningful progress: at least 0.60% profit, 1.0 ATR, or 40% towards TP
                  // to prevent cutting trades prematurely on random 0.15% bid-ask spread flickers.
                  if (!pos.trailActive && (profitPct >= 0.60 || profitInATR >= 1.0 || targetProgress >= 0.40)) {
                    pos.trailActive = true;
                  }

                  if (pos.trailActive) {
                    // Pre-target scalp breakeven: +0.18% covers 0.10% CoinDCX round-trip fees + micro spread
                    const breakevenFloor = pos.entryPrice * 1.0018;
                    let ratchetGain = pos.entryPrice * 0.0018;
                    if (profitInATR >= 1.8 || targetProgress >= 0.75) {
                      ratchetGain = Math.max(ratchetGain, peakGain * 0.70);
                    } else if (profitInATR >= 1.0 || targetProgress >= 0.50) {
                      ratchetGain = Math.max(ratchetGain, peakGain * 0.50);
                    }

                    const dynamicStop = Math.max(breakevenFloor, pos.entryPrice + ratchetGain);
                    if (dynamicStop > pos.stopLoss) {
                      pos.stopLoss = dynamicStop;
                      changed = true;
                    }
                  }

                  // Exit Evaluation for Long Scalpers
                  if (realINRPrice >= pos.takeProfit) {
                    hitExit = true;
                    exitReason = "TAKE_PROFIT";
                    exitFillPrice = realINRPrice;
                  } else if (realINRPrice <= pos.stopLoss) {
                    hitExit = true;
                    if (pos.trailActive || pos.stopLoss >= pos.entryPrice) {
                      exitReason = "TRAILING_STOP";
                      exitFillPrice = realINRPrice;
                    } else {
                      exitReason = "STOP_LOSS";
                      exitFillPrice = realINRPrice;
                    }
                  }
                }
              } else {
                // Short Trailing Stop & Profit Lock Logic
                pos.lowestPrice = Math.min(pos.lowestPrice || pos.entryPrice, realINRPrice);
                const peakGain = Math.max(0, pos.entryPrice - pos.lowestPrice);
                const profitInATR = atr > 0 ? peakGain / atr : 0;
                const profitPct = (peakGain / pos.entryPrice) * 100;
                const initialTP = pos.initialTakeProfit || pos.takeProfit;
                const targetDist = Math.max(0.001, pos.entryPrice - initialTP);
                const targetProgress = peakGain / targetDist;

                if (isTrendRunner) {
                  // --- TREND RUNNER MODE (SHORT) ---
                  // Activate trail once solidly established (at least 0.8% gain, 1.2 ATR, or 50% towards target)
                  if (!pos.trailActive && (profitPct >= 0.80 || profitInATR >= 1.2 || targetProgress >= 0.50)) {
                    pos.trailActive = true;
                  }

                  if (pos.trailActive) {
                    if (realINRPrice <= initialTP) {
                      const targetLockPrice = initialTP;
                      if (targetLockPrice < pos.stopLoss) {
                        pos.stopLoss = targetLockPrice;
                        changed = true;
                      }

                      // Expand target to runner stage
                      const extendedTarget = initialTP - targetDist * 1.5;
                      if (pos.takeProfit > extendedTarget) {
                        pos.takeProfit = extendedTarget;
                        changed = true;
                      }

                      // Trail behind lowest trough at 1.5 ATR distance, never rising above targetLockPrice
                      const runnerTrailStop = Math.min(targetLockPrice, pos.lowestPrice + (atr * 1.5));
                      if (runnerTrailStop < pos.stopLoss) {
                        pos.stopLoss = runnerTrailStop;
                        changed = true;
                      }
                    } else {
                      // Pre-target phase: Breathing room for structural trend pullbacks
                      const breakevenCeiling = pos.entryPrice * 0.998;
                      const structuralTrail = pos.lowestPrice + (atr * 1.5);
                      const dynamicStop = Math.min(breakevenCeiling, structuralTrail);

                      if (dynamicStop < pos.stopLoss) {
                        pos.stopLoss = dynamicStop;
                        changed = true;
                      }
                    }
                  }

                  // Exit Evaluation for Short Trend Runner
                  if (realINRPrice <= pos.takeProfit) {
                    hitExit = true;
                    exitReason = "TAKE_PROFIT";
                    exitFillPrice = realINRPrice;
                  } else if (realINRPrice >= pos.stopLoss) {
                    hitExit = true;
                    if (pos.trailActive || pos.stopLoss <= pos.entryPrice) {
                      exitReason = "TRAILING_STOP";
                      exitFillPrice = realINRPrice;
                    } else {
                      exitReason = "STOP_LOSS";
                      exitFillPrice = realINRPrice;
                    }
                  }
                } else {
                  // --- SCALP MODE (SHORT) ---
                  // Require meaningful progress: at least 0.60% profit, 1.0 ATR, or 40% towards TP
                  // to prevent closing short positions on micro 0.05-paise noise.
                  if (!pos.trailActive && (profitPct >= 0.60 || profitInATR >= 1.0 || targetProgress >= 0.40)) {
                    pos.trailActive = true;
                  }

                  if (pos.trailActive) {
                    // Pre-target scalp breakeven ceiling: -0.18% covers 0.10% CoinDCX round-trip fees + micro spread
                    const breakevenCeiling = pos.entryPrice * 0.9982;
                    let ratchetGain = pos.entryPrice * 0.0018;
                    if (profitInATR >= 1.8 || targetProgress >= 0.75) {
                      ratchetGain = Math.max(ratchetGain, peakGain * 0.70);
                    } else if (profitInATR >= 1.0 || targetProgress >= 0.50) {
                      ratchetGain = Math.max(ratchetGain, peakGain * 0.50);
                    }

                    const dynamicStop = Math.min(breakevenCeiling, pos.entryPrice - ratchetGain);
                    if (dynamicStop < pos.stopLoss) {
                      pos.stopLoss = dynamicStop;
                      changed = true;
                    }
                  }

                  // Exit Evaluation for Short Scalpers
                  if (realINRPrice <= pos.takeProfit) {
                    hitExit = true;
                    exitReason = "TAKE_PROFIT";
                    exitFillPrice = realINRPrice;
                  } else if (realINRPrice >= pos.stopLoss) {
                    hitExit = true;
                    if (pos.trailActive || pos.stopLoss <= pos.entryPrice) {
                      exitReason = "TRAILING_STOP";
                      exitFillPrice = realINRPrice;
                    } else {
                      exitReason = "STOP_LOSS";
                      exitFillPrice = realINRPrice;
                    }
                  }
                }
              }

              if (hitExit && exitReason) {
                const finalExitPrice = exitFillPrice;
                const finalExitReason = exitReason;
                setTimeout(() => {
                  closePositionWithAutopsy(pos, finalExitPrice, finalExitReason);
                }, 10);
                changed = true;
                continue; // Position is being closed
              }

              const pnl = (realINRPrice - pos.entryPrice) * pos.quantity * (isLong ? 1 : -1);
              const moneyPlaced = pos.entryPrice * pos.quantity;
              const pnlPercent = (pnl / moneyPlaced) * 100;

              if (Math.abs(realINRPrice - pos.currentPrice) > 0.0001) {
                changed = true;
              }

              nextPositions.push({
                ...pos,
                currentPrice: realINRPrice,
                unrealizedPnl: pnl,
                unrealizedPnlPercent: pnlPercent,
              });
            }
  return { pushed: nextPositions, exits, changed };
}
