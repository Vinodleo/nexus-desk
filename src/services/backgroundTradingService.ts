/**
 * Background Execution & Device-Lock Guardian Service
 *
 * Keeps Nexus Desk trading engine executing continuously even when:
 * 1. The device screen is locked (via Silent Audio Context + MediaSession Keep-Alive)
 * 2. The browser tab is in the background (via dedicated Web Worker Heartbeat)
 * 3. The device is prevented from going to sleep (via Screen Wake Lock API)
 * 4. Dispatches native lock-screen notifications for fills & exits
 * 5. Reconciles elapsed time and missed ticks upon device unlock
 */

export interface BackgroundExecutionStatus {
  isSupported: boolean;
  isWorkerActive: boolean;
  isAudioKeepAliveActive: boolean;
  isWakeLockActive: boolean;
  wakeLockError: string | null;
  notificationsPermission: NotificationPermission | 'unsupported';
  heartbeatCount: number;
  lastHeartbeatTimestamp: number | null;
  totalReconciledCycles: number;
}

export type HeartbeatCallback = (timestamp: number) => void;
export type ReconcileCallback = (missedCycles: number, elapsedMs: number) => void;

class BackgroundTradingService {
  private worker: Worker | null = null;
  private wakeLockSentinel: any = null;
  private audioContext: AudioContext | null = null;
  private silentGainNode: GainNode | null = null;
  private oscillator: OscillatorNode | null = null;
  private audioElement: HTMLAudioElement | null = null;

  private isWorkerActive = false;
  private isAudioKeepAliveActive = false;
  private isWakeLockActive = false;
  private wakeLockError: string | null = null;
  private isAutoArmSetup = false;

  private heartbeatCount = 0;
  private lastHeartbeatTimestamp: number | null = null;
  private lastRecordedTickTime: number = Date.now();
  private totalReconciledCycles = 0;

  private heartbeatCallbacks: Set<HeartbeatCallback> = new Set();
  private reconcileCallbacks: Set<ReconcileCallback> = new Set();
  private statusListeners: Set<(status: BackgroundExecutionStatus) => void> = new Set();

  constructor() {
    this.initVisibilityListener();
    this.initWebWorker();
    this.setupAutoArmGesture();
  }

  /**
   * Set up one-touch auto-arming so on the first user tap or click anywhere in the app,
   * background execution permissions (AudioContext & WakeLock) are unlocked.
   */
  public setupAutoArmGesture() {
    if (typeof window === 'undefined' || this.isAutoArmSetup) return;
    this.isAutoArmSetup = true;

    const armOnInteraction = async () => {
      // If audio keep-alive is not yet active, initialize and arm it silently
      if (!this.isAudioKeepAliveActive) {
        await this.enableAudioKeepAlive();
      }
      if (!this.isWakeLockActive) {
        await this.requestWakeLock();
      }
      // Remove listeners once armed
      window.removeEventListener('click', armOnInteraction);
      window.removeEventListener('touchstart', armOnInteraction);
      window.removeEventListener('keydown', armOnInteraction);
    };

    window.addEventListener('click', armOnInteraction, { once: true });
    window.addEventListener('touchstart', armOnInteraction, { once: true, passive: true });
    window.addEventListener('keydown', armOnInteraction, { once: true });
  }

  // -------------------------------------------------------------
  // 1. DEDICATED WEB WORKER HEARTBEAT
  // -------------------------------------------------------------
  private initWebWorker() {
    try {
      // Inline Blob Worker avoids cross-origin or bundler path issues
      const workerCode = `
        let timer = null;
        let intervalMs = 2400;

        self.onmessage = function(e) {
          const data = e.data;
          if (data === 'START' || (data && data.type === 'START')) {
            if (data && data.interval) intervalMs = data.interval;
            if (timer) clearInterval(timer);
            timer = setInterval(() => {
              self.postMessage({ type: 'TICK', timestamp: Date.now() });
            }, intervalMs);
          } else if (data === 'STOP' || (data && data.type === 'STOP')) {
            if (timer) clearInterval(timer);
            timer = null;
          } else if (data && data.type === 'SET_INTERVAL') {
            intervalMs = data.interval || 2400;
            if (timer) {
              clearInterval(timer);
              timer = setInterval(() => {
                self.postMessage({ type: 'TICK', timestamp: Date.now() });
              }, intervalMs);
            }
          }
        };
      `;

      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(blob);
      this.worker = new Worker(workerUrl);

      this.worker.onmessage = (e) => {
        if (e.data && e.data.type === 'TICK') {
          const now = e.data.timestamp || Date.now();
          this.heartbeatCount++;
          this.lastHeartbeatTimestamp = now;
          this.lastRecordedTickTime = now;

          // Dispatch to callbacks
          this.heartbeatCallbacks.forEach((cb) => {
            try {
              cb(now);
            } catch (err) {
              console.error('Error in background heartbeat callback:', err);
            }
          });

          this.notifyStatusChange();
        }
      };
    } catch (err) {
      console.warn('Web Worker initialization failed, falling back to window timers:', err);
    }
  }

  public startWorkerHeartbeat(intervalMs: number = 2400) {
    if (!this.worker) {
      this.initWebWorker();
    }
    if (this.worker) {
      this.worker.postMessage({ type: 'START', interval: intervalMs });
      this.isWorkerActive = true;
      this.lastRecordedTickTime = Date.now();
      this.notifyStatusChange();
    }
  }

  public stopWorkerHeartbeat() {
    if (this.worker) {
      this.worker.postMessage('STOP');
    }
    this.isWorkerActive = false;
    this.notifyStatusChange();
  }

  // -------------------------------------------------------------
  // 2. SCREEN WAKE LOCK API (Prevents Device Screen from Locking)
  // -------------------------------------------------------------
  public async requestWakeLock(): Promise<boolean> {
    if (!('wakeLock' in navigator)) {
      this.wakeLockError = 'Screen Wake Lock API is not supported in this browser.';
      this.isWakeLockActive = false;
      this.notifyStatusChange();
      return false;
    }

    try {
      this.wakeLockSentinel = await (navigator as any).wakeLock.request('screen');
      this.isWakeLockActive = true;
      this.wakeLockError = null;

      this.wakeLockSentinel.addEventListener('release', () => {
        this.isWakeLockActive = false;
        this.wakeLockSentinel = null;
        this.notifyStatusChange();
      });

      this.notifyStatusChange();
      return true;
    } catch (err: any) {
      this.isWakeLockActive = false;
      this.wakeLockError = err?.message || 'Failed to acquire wake lock';
      this.notifyStatusChange();
      return false;
    }
  }

  public async releaseWakeLock(): Promise<void> {
    if (this.wakeLockSentinel) {
      try {
        await this.wakeLockSentinel.release();
      } catch {
        // Ignore
      }
      this.wakeLockSentinel = null;
    }
    this.isWakeLockActive = false;
    this.notifyStatusChange();
  }

  // -------------------------------------------------------------
  // 3. DUAL SILENT AUDIO KEEP-ALIVE (Mobile Lock-Screen Guardian)
  // -------------------------------------------------------------
  /**
   * On iOS Safari and Android Chrome, the OS will suspend JavaScript within seconds
   * of the screen locking UNLESS an active Web Audio session or MediaSession is playing.
   * This uses a dual-engine approach:
   * 1. Silent HTML5 <audio loop playsinline> element (rock-solid iOS lock-screen survival)
   * 2. Inaudible (0.00001 gain) Web Audio oscillator + MediaSession metadata
   */
  public async enableAudioKeepAlive(): Promise<boolean> {
    try {
      // 1. Start Silent HTML5 Audio Element Loop (bypasses iOS screen-lock timer freezes)
      if (!this.audioElement && typeof window !== 'undefined') {
        const audio = document.createElement('audio');
        // Valid 1-second silent stereo WAV
        audio.src = 'data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBIAAAABAAEAQB8AAEAfAAABAAgAAABmYWN0BAAAAAAAAABkYXRhAAAAAA==';
        audio.loop = true;
        audio.volume = 0.001; // Inaudible
        audio.setAttribute('playsinline', 'true');
        audio.setAttribute('webkit-playsinline', 'true');
        this.audioElement = audio;
      }

      if (this.audioElement) {
        try {
          await this.audioElement.play();
        } catch {
          // May require gesture, handled by autoArmOnUserGesture
        }
      }

      // 2. Start Web Audio Oscillator
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        if (!this.audioContext || this.audioContext.state === 'closed') {
          this.audioContext = new AudioCtx();
        }

        if (this.audioContext.state === 'suspended') {
          await this.audioContext.resume();
        }

        if (!this.oscillator) {
          this.oscillator = this.audioContext.createOscillator();
          this.silentGainNode = this.audioContext.createGain();

          // Effectively zero volume
          this.silentGainNode.gain.setValueAtTime(0.00001, this.audioContext.currentTime);

          this.oscillator.type = 'sine';
          this.oscillator.frequency.setValueAtTime(440, this.audioContext.currentTime);

          this.oscillator.connect(this.silentGainNode);
          this.silentGainNode.connect(this.audioContext.destination);

          this.oscillator.start();
        }
      }

      // 3. Register MediaSession metadata so mobile OS lock-screen shows background trading active
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: 'Nexus Desk Trading Swarm',
          artist: 'Autonomous Paper Execution Active',
          album: 'Fail-Closed Risk Engine (INR)',
        });
        navigator.mediaSession.playbackState = 'playing';

        navigator.mediaSession.setActionHandler('play', () => {
          if (this.audioElement) this.audioElement.play().catch(() => {});
          navigator.mediaSession.playbackState = 'playing';
        });
        navigator.mediaSession.setActionHandler('pause', () => {
          // Prevent accidental pause from killing trading
          navigator.mediaSession.playbackState = 'playing';
        });
      }

      this.isAudioKeepAliveActive = true;
      this.notifyStatusChange();
      return true;
    } catch (err) {
      console.warn('Audio keep-alive initialization failed:', err);
      this.isAudioKeepAliveActive = false;
      this.notifyStatusChange();
      return false;
    }
  }

  public disableAudioKeepAlive() {
    try {
      if (this.audioElement) {
        this.audioElement.pause();
        this.audioElement.src = '';
        this.audioElement = null;
      }
      if (this.oscillator) {
        this.oscillator.stop();
        this.oscillator.disconnect();
        this.oscillator = null;
      }
      if (this.silentGainNode) {
        this.silentGainNode.disconnect();
        this.silentGainNode = null;
      }
      if (this.audioContext && this.audioContext.state !== 'closed') {
        this.audioContext.close();
        this.audioContext = null;
      }
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'none';
      }
    } catch (err) {
      console.warn('Error disabling audio keep alive:', err);
    }
    this.isAudioKeepAliveActive = false;
    this.notifyStatusChange();
  }

  /**
   * One-touch activator for continuous 24/7 locked-device execution.
   * Enables both Audio Guardian (for mobile lock-screen) and Screen Wake Lock (for desktop/kiosk).
   */
  public async enableLockGuardianMode(): Promise<boolean> {
    const audioOk = await this.enableAudioKeepAlive();
    await this.requestWakeLock();
    if ('Notification' in window && Notification.permission === 'default') {
      this.requestNotificationPermission().catch(() => {});
    }
    return audioOk;
  }

  // -------------------------------------------------------------
  // 4. HTML5 NOTIFICATIONS (Lock-Screen & Background Alerts)
  // -------------------------------------------------------------
  public async requestNotificationPermission(): Promise<NotificationPermission> {
    if (!('Notification' in window)) {
      return 'denied';
    }
    if (Notification.permission === 'granted') {
      return 'granted';
    }
    const permission = await Notification.requestPermission();
    this.notifyStatusChange();
    return permission;
  }

  public sendNotification(title: string, options?: NotificationOptions) {
    if (!('Notification' in window) || Notification.permission !== 'granted') {
      return;
    }

    try {
      const defaultIcon = '/pwa-192x192.png';
      new Notification(title, {
        icon: defaultIcon,
        badge: defaultIcon,
        ...options,
      });
    } catch {
      // Fallback for service worker notification
      if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.ready.then((registration) => {
          registration.showNotification(title, options);
        });
      }
    }
  }

  // -------------------------------------------------------------
  // 5. VISIBILITY CHANGE & SCREEN-UNLOCK FAST-FORWARD RECONCILIATION
  // -------------------------------------------------------------
  private initVisibilityListener() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        // Re-acquire screen wake lock if it was released when minimized
        if (this.isWakeLockActive && !this.wakeLockSentinel) {
          this.requestWakeLock();
        }

        // Check if phone was locked / asleep and how much time elapsed
        const now = Date.now();
        const elapsedMs = now - this.lastRecordedTickTime;

        // If elapsed time is greater than 4500ms (more than ~2 ticks missed)
        if (elapsedMs > 4500) {
          const missedCycles = Math.min(50, Math.floor(elapsedMs / 2400));
          if (missedCycles > 0) {
            this.totalReconciledCycles += missedCycles;
            this.reconcileCallbacks.forEach((cb) => {
              try {
                cb(missedCycles, elapsedMs);
              } catch (err) {
                console.error('Error in reconcile callback:', err);
              }
            });
          }
        }

        this.lastRecordedTickTime = now;
      } else {
        // Tab went into background
        this.lastRecordedTickTime = Date.now();
      }
    });

    window.addEventListener('focus', () => {
      const now = Date.now();
      const elapsedMs = now - this.lastRecordedTickTime;
      if (elapsedMs > 5000) {
        const missedCycles = Math.min(50, Math.floor(elapsedMs / 2400));
        if (missedCycles > 0) {
          this.totalReconciledCycles += missedCycles;
          this.reconcileCallbacks.forEach((cb) => cb(missedCycles, elapsedMs));
        }
      }
      this.lastRecordedTickTime = now;
    });
  }

  // -------------------------------------------------------------
  // SUBSCRIPTIONS & OBSERVERS
  // -------------------------------------------------------------
  public onHeartbeat(cb: HeartbeatCallback): () => void {
    this.heartbeatCallbacks.add(cb);
    return () => this.heartbeatCallbacks.delete(cb);
  }

  public onReconcile(cb: ReconcileCallback): () => void {
    this.reconcileCallbacks.add(cb);
    return () => this.reconcileCallbacks.delete(cb);
  }

  public subscribeStatus(listener: (status: BackgroundExecutionStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.getStatus());
    return () => this.statusListeners.delete(listener);
  }

  private notifyStatusChange() {
    const status = this.getStatus();
    this.statusListeners.forEach((l) => l(status));
  }

  public getStatus(): BackgroundExecutionStatus {
    return {
      isSupported: typeof window !== 'undefined' && 'Worker' in window,
      isWorkerActive: this.isWorkerActive,
      isAudioKeepAliveActive: this.isAudioKeepAliveActive,
      isWakeLockActive: this.isWakeLockActive,
      wakeLockError: this.wakeLockError,
      notificationsPermission:
        typeof window !== 'undefined' && 'Notification' in window
          ? Notification.permission
          : 'unsupported',
      heartbeatCount: this.heartbeatCount,
      lastHeartbeatTimestamp: this.lastHeartbeatTimestamp,
      totalReconciledCycles: this.totalReconciledCycles,
    };
  }
}

export const backgroundTradingService = new BackgroundTradingService();
