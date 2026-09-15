import { useState, useEffect, useCallback } from 'react';
import {
  backgroundTradingService,
  BackgroundExecutionStatus,
} from '../services/backgroundTradingService';

interface UseBackgroundExecutionOptions {
  onBackgroundTick?: () => void;
  onReconcileMissedTicks?: (missedCycles: number, elapsedMs: number) => void;
  isPlaying?: boolean;
}

export function useBackgroundExecution({
  onBackgroundTick,
  onReconcileMissedTicks,
  isPlaying = false,
}: UseBackgroundExecutionOptions = {}) {
  const [status, setStatus] = useState<BackgroundExecutionStatus>(
    backgroundTradingService.getStatus()
  );

  useEffect(() => {
    const unsubscribe = backgroundTradingService.subscribeStatus(setStatus);
    return unsubscribe;
  }, []);

  // Sync worker heartbeat state with isPlaying
  useEffect(() => {
    if (isPlaying) {
      backgroundTradingService.startWorkerHeartbeat(2400);
    } else {
      backgroundTradingService.stopWorkerHeartbeat();
    }
  }, [isPlaying]);

  // Register heartbeat tick
  useEffect(() => {
    if (!onBackgroundTick) return;
    const unsubscribe = backgroundTradingService.onHeartbeat(() => {
      onBackgroundTick();
    });
    return unsubscribe;
  }, [onBackgroundTick]);

  // Register reconcile callback
  useEffect(() => {
    if (!onReconcileMissedTicks) return;
    const unsubscribe = backgroundTradingService.onReconcile((missedCycles, elapsedMs) => {
      onReconcileMissedTicks(missedCycles, elapsedMs);
    });
    return unsubscribe;
  }, [onReconcileMissedTicks]);

  const toggleWakeLock = useCallback(async () => {
    if (status.isWakeLockActive) {
      await backgroundTradingService.releaseWakeLock();
    } else {
      await backgroundTradingService.requestWakeLock();
    }
  }, [status.isWakeLockActive]);

  const toggleAudioKeepAlive = useCallback(async () => {
    if (status.isAudioKeepAliveActive) {
      backgroundTradingService.disableAudioKeepAlive();
    } else {
      await backgroundTradingService.enableAudioKeepAlive();
    }
  }, [status.isAudioKeepAliveActive]);

  const requestNotifications = useCallback(async () => {
    return await backgroundTradingService.requestNotificationPermission();
  }, []);

  const sendAlertNotification = useCallback((title: string, options?: NotificationOptions) => {
    backgroundTradingService.sendNotification(title, options);
  }, []);

  const enableLockGuardianMode = useCallback(async () => {
    return await backgroundTradingService.enableLockGuardianMode();
  }, []);

  return {
    status,
    toggleWakeLock,
    toggleAudioKeepAlive,
    enableLockGuardianMode,
    requestNotifications,
    sendAlertNotification,
    isBackgroundActive: status.isWorkerActive || status.isAudioKeepAliveActive,
  };
}
