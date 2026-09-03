import { loggerService } from '@logger'

import { validateEndpointUrl } from './SyncClient'
import { syncService } from './SyncService'
import { SyncSubscriber } from './syncSubscriber'

const logger = loggerService.withContext('SyncAuto')

export const SYNC_AUTO_LOCAL_DEBOUNCE_MS = 800
export const SYNC_AUTO_REMOTE_DEBOUNCE_MS = 200
export const SYNC_AUTO_RECONNECT_BASE_MS = 1000
export const SYNC_AUTO_RECONNECT_MAX_MS = 15000
export const SYNC_AUTO_BUSY_RETRY_MS = 400
export const SYNC_AUTO_RETRY_BASE_MS = 1000
export const SYNC_AUTO_RETRY_MAX_MS = 8000
export const SYNC_AUTO_RETRY_MAX_ATTEMPTS = 3
export const SYNC_AUTO_RECONCILE_MS = 30000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function computeAutoRetryDelay(attempt: number): number {
  const exp = SYNC_AUTO_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1)
  return Math.min(exp, SYNC_AUTO_RETRY_MAX_MS)
}

export interface SyncAutoDeps {
  getConfig: () => { endpoint: string; token?: string; enabled: boolean }
  runSync: () => Promise<unknown>
  createSubscriber: () => SyncSubscriber
}

/**
 * Main-owned realtime closure for the operation-log + HTTP relay route.
 * - Debounced local auto sync after successful local outbox enqueue.
 * - Strict existing push/pull (SyncService.sync) on SSE notifications and
 *   on reconnect, using only existing authenticated HTTP + validation.
 * - Serialized/coalesced: concurrent triggers never surface
 *   `already in progress`; manual SyncService.sync semantics are untouched.
 * - Bounded retry: ordinary automatic failures retry with backoff while the
 *   subscriber stays connected (liveness), capped at MAX_ATTEMPTS per cycle.
 * - Reconciliation: low-frequency timer re-triggers the strict cycle as a
 *   liveness fallback for missed/half-open SSE notifications (hint only).
 * - Cancellation: a generation counter invalidates in-flight automatic work
 *   so stopSync prevents any post-stop continuation before DB close.
 */
export class SyncAutoService {
  private deps: SyncAutoDeps
  private started = false
  private subscriber: SyncSubscriber | null = null
  private localTimer: ReturnType<typeof setTimeout> | null = null
  private remoteTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconcileTimer: ReturnType<typeof setInterval> | null = null
  private reconnectAttempts = 0
  private autoRunning = false
  private pending = false
  private generation = 0
  private enqueueUnsub: (() => void) | null = null
  private configFailureUnsub: (() => void) | null = null
  private lastConfigKey: string | null = null

  constructor(deps?: Partial<SyncAutoDeps>) {
    this.deps = {
      getConfig: () => syncService.getConfig(),
      runSync: () => syncService.sync(),
      createSubscriber: () => new SyncSubscriber(),
      ...deps
    }
  }

  isStarted(): boolean {
    return this.started
  }

  isAutoRunning(): boolean {
    return this.autoRunning
  }

  start(): void {
    if (this.started) {
      this.refresh()
      return
    }
    this.started = true
    this.reconnectAttempts = 0
    if (!this.enqueueUnsub) {
      try {
        this.enqueueUnsub = syncService.onEnqueue(() => this.notifyLocalChange())
      } catch {}
    }
    if (!this.configFailureUnsub) {
      try {
        this.configFailureUnsub = syncService.onConfigFailure((err) => this.notifyExternalConfigFailure(err))
      } catch {}
    }
    this.refresh()
  }

  /** Synchronous stop for will-quit: abort SSE, clear timers, no awaits. */
  stopSync(): void {
    // Invalidate any in-flight automatic cycle first so a pending await
    // continuation observes the new generation and returns without further
    // database work or rescheduling. Also invalidate in-flight SyncService.sync
    // network/database loops synchronously (no await) so no post-close DB
    // access occurs after ChatDb close.
    try {
      syncService.beginShutdown()
    } catch {}
    this.generation += 1
    this.started = false
    this.clearTimers()
    if (this.subscriber) {
      try {
        this.subscriber.stop()
      } catch {}
      this.subscriber = null
    }
    if (this.enqueueUnsub) {
      try {
        this.enqueueUnsub()
      } catch {}
      this.enqueueUnsub = null
    }
    if (this.configFailureUnsub) {
      try {
        this.configFailureUnsub()
      } catch {}
      this.configFailureUnsub = null
    }
    this.autoRunning = false
    this.pending = false
  }

  stop(): void {
    this.stopSync()
  }

  /**
   * Shared automatic config-read failure handler (LOCK-PERSONAL-001/006/009):
   * scoped log + best-effort durable error + invalidate auto work and
   * SyncService config generation + stop subscriber/timers. Never silently
   * returns: success stays durably visible and stops stale work; damaged
   * sync_state (durable persistence failure) is logged and rethrown with the
   * original error preserved via the SyncCaptureError chain.
   */
  /**
   * External setConfig failure entry (decoupled seam): SyncService emits here
   * even when setConfig throws, so a stale subscriber/timers never survive a
   * post-write-read failure that syncIpc cannot refresh. Secondary
   * persistence damage is scoped-logged inside the shared handler; emit path
   * never propagates (SyncService already chains its own durable failure).
   */
  notifyExternalConfigFailure(error: unknown): void {
    try {
      this.handleAutoConfigFailure('setConfig', error)
    } catch {}
  }

  private handleAutoConfigFailure(
    context: 'refresh' | 'requestAutoSync' | 'reconcile' | 'setConfig' | 'autoSync',
    error: unknown
  ): void {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error(`[${context}] config read failed: ${msg.slice(0, 300)}`)
    // Durable visibility where DB is available: a config-read failure must
    // never become an invisible success. Persistence failure stays observable
    // via scoped logging plus rethrow.
    try {
      syncService.recordCaptureFailure(`syncAuto:${context}`, error)
    } catch (secondary) {
      const detail = secondary instanceof Error ? secondary.message : String(secondary)
      logger.error(`[${context}] capture-error persistence failed: ${detail.slice(0, 300)}`)
      this.invalidateAutoWork()
      try {
        syncService.invalidateForConfigChange()
      } catch {}
      this.stopSubscriber()
      throw secondary instanceof Error ? secondary : new Error(String(secondary))
    }
    this.invalidateAutoWork()
    try {
      syncService.invalidateForConfigChange()
    } catch {}
    this.stopSubscriber()
  }

  /** Restart/stop the subscriber to match current saved configuration. */
  refresh(): void {
    if (!this.started) return
    this.clearReconnectTimer()
    let endpoint = ''
    let token: string | undefined
    let enabled = false
    try {
      const cfg = this.deps.getConfig()
      endpoint = cfg.endpoint ?? ''
      token = cfg.token
      enabled = !!cfg.enabled
    } catch (e) {
      this.handleAutoConfigFailure('refresh', e)
      return
    }
    // Config-lifecycle invalidation: any disabled/endpoint/token transition
    // cancels pending automatic work so stale debounced cycles never run
    // against the new config. The generation bump invalidates in-flight
    // drain continuations; timers/pending are cleared before new work. An
    // in-flight SyncService.sync() carries its own config-generation token
    // (snapshotted at start): a detected transition also invalidates it so
    // the stale cycle aborts before further stale transport or
    // post-transition database/status effects (LOCK-PERSONAL-001).
    const configKey = `${enabled ? '1' : '0'}|${endpoint}|${token ?? ''}`
    const configChanged = this.lastConfigKey !== null && this.lastConfigKey !== configKey
    const becameInvalid = !enabled || !endpoint || !!validateEndpointUrl(endpoint)
    if (configChanged) {
      this.invalidateAutoWork()
      try {
        syncService.invalidateForConfigChange()
      } catch {}
    } else if (becameInvalid) {
      this.invalidateAutoWork()
    }
    this.lastConfigKey = configKey
    if (becameInvalid) {
      this.stopSubscriber()
      return
    }
    // Restart the single connection so endpoint/token changes reconnect cleanly.
    this.stopSubscriber()
    const subscriber = this.deps.createSubscriber()
    this.subscriber = subscriber
    try {
      subscriber.start(endpoint, token, {
        onNotify: () => this.notifyRemote(),
        onDisconnect: () => this.scheduleReconnect()
      })
    } catch (e) {
      logger.warn(`[refresh] subscriber start failed: ${(e as Error).message.slice(0, 200)}`)
      this.subscriber = null
      this.scheduleReconnect()
      return
    }
    this.startReconcileTimer()
    // (Re)connect uses the strict existing cursor pull path: a fresh or
    // restarted subscription always triggers one standard sync cycle so a
    // client that was offline/disabled converges without manual action.
    this.requestAutoSync()
  }

  /** Debounced local trigger after a successful local operation enqueue. */
  notifyLocalChange(): void {
    if (!this.started) return
    if (this.localTimer) clearTimeout(this.localTimer)
    const gen = this.generation
    this.localTimer = setTimeout(() => {
      this.localTimer = null
      if (gen !== this.generation || !this.started) return
      this.requestAutoSync()
    }, SYNC_AUTO_LOCAL_DEBOUNCE_MS)
  }

  /** Coalesced remote trigger on SSE notification (hint only, never applied). */
  notifyRemote(): void {
    if (!this.started) return
    this.reconnectAttempts = 0
    if (this.remoteTimer) return
    const gen = this.generation
    this.remoteTimer = setTimeout(() => {
      this.remoteTimer = null
      if (gen !== this.generation || !this.started) return
      this.requestAutoSync()
    }, SYNC_AUTO_REMOTE_DEBOUNCE_MS)
  }

  private scheduleReconnect(): void {
    if (!this.started) return
    if (this.reconnectTimer) return
    const gen = this.generation
    const delay = Math.min(
      SYNC_AUTO_RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempts, 4),
      SYNC_AUTO_RECONNECT_MAX_MS
    )
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (gen !== this.generation || !this.started) return
      // Reconnect uses the strict existing cursor pull path: restart the
      // subscriber on current config, then run the standard sync cycle.
      this.refresh()
      this.requestAutoSync()
    }, delay)
  }

  private requestAutoSync(): void {
    if (!this.started) return
    try {
      const cfg = this.deps.getConfig()
      if (!cfg.enabled || !cfg.endpoint || validateEndpointUrl(cfg.endpoint)) return
    } catch (e) {
      this.handleAutoConfigFailure('requestAutoSync', e)
      return
    }
    if (this.autoRunning) {
      this.pending = true
      return
    }
    void this.drain(this.generation)
  }

  private async drain(gen: number): Promise<void> {
    if (this.autoRunning) {
      this.pending = true
      return
    }
    const isStale = (): boolean => gen !== this.generation || !this.started
    this.autoRunning = true
    let consecutiveFailures = 0
    try {
      for (;;) {
        if (isStale()) return
        this.pending = false
        try {
          await this.deps.runSync()
          if (isStale()) return
          consecutiveFailures = 0
        } catch (e) {
          if (isStale()) return
          const msg = e instanceof Error ? e.message : String(e)
          // Stale-config abort (LOCK-PERSONAL-001): the active cycle was
          // invalidated by a disable/endpoint/token transition. Exit without
          // retry — a fresh cycle on the new config follows via refresh.
          if ((e as Error)?.name === 'SyncStaleConfigError') {
            logger.info(`[autoSync] cycle invalidated by config change, stop`)
            return
          }
          // Distinguishable nested config preflight (LOCK-PERSONAL-001/006):
          // SyncService.sync() wraps its internal config preflight in
          // SyncConfigPreflightError. Route through the shared config failure
          // handler (durable visibility + lifecycle invalidation, no retry).
          // Genuine transport/apply errors below keep bounded retry behavior.
          if ((e as Error)?.name === 'SyncConfigPreflightError') {
            try {
              this.handleAutoConfigFailure('autoSync', e)
            } catch {
              // Secondary persistence damage already scoped-logged inside the
              // shared handler; exit without retry either way.
            }
            return
          }
          // Serialize against a concurrent manual sync instead of failing:
          // the lock holder always releases (SyncService.sync resets in a
          // finally), so wait and retry the same cycle until it runs.
          if (msg.includes('already in progress')) {
            await sleep(SYNC_AUTO_BUSY_RETRY_MS)
            if (isStale()) return
            continue
          }
          // Bounded retry for ordinary transient failures (network/pull/push)
          // so liveness does not depend on a fresh SSE notification. Already
          // recorded durably by SyncService (lastError); stay truthful.
          consecutiveFailures += 1
          logger.warn(`[autoSync] cycle failed (attempt ${consecutiveFailures}): ${msg.slice(0, 300)}`)
          if (this.pending) {
            consecutiveFailures = 0
            continue
          }
          if (consecutiveFailures <= SYNC_AUTO_RETRY_MAX_ATTEMPTS) {
            await sleep(computeAutoRetryDelay(consecutiveFailures))
            if (isStale()) return
            continue
          }
          consecutiveFailures = 0
          return
        }
        if (isStale()) return
        if (!this.pending) return
      }
    } finally {
      this.autoRunning = false
      if (!isStale() && this.pending) {
        this.pending = false
        // Defer one tick so synchronous trigger bursts coalesce.
        const captured = gen
        await sleep(0)
        if (captured === this.generation && this.started) void this.drain(captured)
      } else {
        this.pending = false
      }
    }
  }

  private startReconcileTimer(): void {
    this.clearReconcileTimer()
    const gen = this.generation
    this.reconcileTimer = setInterval(() => {
      if (gen !== this.generation || !this.started) return
      try {
        const cfg = this.deps.getConfig()
        if (!cfg.enabled || !cfg.endpoint || validateEndpointUrl(cfg.endpoint)) return
      } catch (e) {
        this.handleAutoConfigFailure('reconcile', e)
        return
      }
      this.requestAutoSync()
    }, SYNC_AUTO_RECONCILE_MS)
  }

  private clearReconcileTimer(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer)
      this.reconcileTimer = null
    }
  }

  private stopSubscriber(): void {
    if (this.subscriber) {
      try {
        this.subscriber.stop()
      } catch {}
      this.subscriber = null
    }
    this.clearReconcileTimer()
  }

  /**
   * Invalidate pending/in-flight automatic work on disabled/endpoint/token
   * transitions. Bumps the generation so drain continuations exit without
   * further DB work, and clears debounced/pending triggers. Does not touch
   * the subscriber itself (callers restart/stop it separately).
   */
  private invalidateAutoWork(): void {
    this.generation += 1
    if (this.localTimer) {
      clearTimeout(this.localTimer)
      this.localTimer = null
    }
    if (this.remoteTimer) {
      clearTimeout(this.remoteTimer)
      this.remoteTimer = null
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.pending = false
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private clearTimers(): void {
    if (this.localTimer) {
      clearTimeout(this.localTimer)
      this.localTimer = null
    }
    if (this.remoteTimer) {
      clearTimeout(this.remoteTimer)
      this.remoteTimer = null
    }
    this.clearReconnectTimer()
    this.clearReconcileTimer()
  }
}

export const syncAutoService = new SyncAutoService()
