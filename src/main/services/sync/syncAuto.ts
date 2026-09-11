import { loggerService } from '@logger'

import { validateEndpointUrl } from './SyncClient'
import type { BaselineAutoPublishResult } from './SyncService'
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
  /**
   * Conservative auto-publish attempt (local-triggered success only).
   * Defaults to the live `SyncService.publishBaselineIfEligible()`. Never
   * recurses into `runSync`; at most one PUT per successful sync cycle.
   */
  tryPublishBaseline: () => Promise<BaselineAutoPublishResult>
  createSubscriber: () => SyncSubscriber
  /**
   * Attachment gate (SYNC-CC-004/005): automation runs only for registered,
   * non-disconnected service. Defaults to the live service state.
   */
  isAttached: () => boolean
  /**
   * Channel-scoped SSE credentials. Defaults to the live service
   * registration (Main-internal only, never IPC/UI).
   */
  getCredentials: () => { deviceCode: string; deviceSecret: string } | null
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
  /**
   * Local publish intent (conservative auto-publish, in-memory only).
   * Set only by `notifyLocalChange()` (successful local chat outbox enqueue).
   * Remote SSE/hint, reconnect, reconcile, channel-change refresh, and manual
   * `SyncService.sync()` never set it. Consumed only after one publish attempt
   * (`published`/`skipped`/`deferred`) or an explicit ineligible skip; retained
   * across ordinary sync failures and `needs-sync` barrier contention. Cleared
   * on stop/invalidation. `localPublishSeq` guards against an older attempt
   * clearing a newer trigger that arrived during the PUT barrier.
   */
  private localPublishIntent = false
  private localPublishSeq = 0
  private generation = 0
  private enqueueUnsub: (() => void) | null = null
  private configFailureUnsub: (() => void) | null = null
  private channelChangeUnsub: (() => void) | null = null
  private lastConfigKey: string | null = null

  constructor(deps?: Partial<SyncAutoDeps>) {
    this.deps = {
      getConfig: () => syncService.getConfig(),
      runSync: () => syncService.sync(),
      tryPublishBaseline: () => syncService.publishBaselineIfEligible(),
      createSubscriber: () => new SyncSubscriber(),
      isAttached: () => syncService.isAutoSyncAllowed(),
      getCredentials: () => syncService.getAutoCredentials(),
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
    if (!this.channelChangeUnsub) {
      // Channel-identity change (SYNC-CC-016): an accept/unpair/pair-state
      // observation that moves the channel restarts the channel-bound SSE
      // subscriber immediately so the new channel notifies in realtime
      // instead of relying on the 30s reconcile fallback.
      try {
        this.channelChangeUnsub = syncService.onChannelChange(() => this.refresh())
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
    if (this.channelChangeUnsub) {
      try {
        this.channelChangeUnsub()
      } catch {}
      this.channelChangeUnsub = null
    }
    this.autoRunning = false
    this.pending = false
    this.localPublishIntent = false
  }

  stop(): void {
    this.stopSync()
  }

  /** Test-only accessor for the in-memory local publish intent (never persisted). */
  hasLocalPublishIntentForTests(): boolean {
    return this.localPublishIntent
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
    // Attachment gate (SYNC-CC-005): a disconnected or unregistered service
    // stops attachment/auto-reconnect while registration, membership, and
    // local outbox intent are preserved. Reconnect resumes via Connect.
    let attached = false
    try {
      attached = this.deps.isAttached()
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
    const configKey = `${enabled ? '1' : '0'}|${endpoint}|${token ?? ''}|${attached ? '1' : '0'}`
    const configChanged = this.lastConfigKey !== null && this.lastConfigKey !== configKey
    const becameInvalid = !enabled || !endpoint || !!validateEndpointUrl(endpoint) || !attached
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
    let credentials: { deviceCode: string; deviceSecret: string } | null = null
    try {
      credentials = this.deps.getCredentials()
    } catch (e) {
      this.handleAutoConfigFailure('refresh', e)
      return
    }
    if (!credentials) {
      this.invalidateAutoWork()
      this.stopSubscriber()
      return
    }
    // Restart the single connection so endpoint/token changes reconnect cleanly.
    this.stopSubscriber()
    const subscriber = this.deps.createSubscriber()
    this.subscriber = subscriber
    try {
      subscriber.start(
        endpoint,
        token,
        {
          onNotify: () => this.notifyRemote(),
          // SSE/relay disconnect promptly marks the observed service state
          // disconnected (SYNC-CC-006); the next successful authenticated
          // round-trip restores it via markRelayContact(true). One-directional
          // call (auto -> service) so no import cycle arises.
          onDisconnect: (err) => {
            try {
              syncService.notifyRelayDisconnect(err)
            } catch {}
            this.scheduleReconnect()
          }
        },
        credentials
      )
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
    this.localPublishIntent = true
    this.localPublishSeq += 1
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
      if (!this.deps.isAttached()) return
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
          // Conservative auto-publish: only a successful ordinary sync cycle
          // that contains an unconsumed local trigger may attempt one baseline
          // publish. Remote/reconnect/reconcile/manual cycles have no intent
          // and never PUT. At most one attempt per success; the attempt never
          // recurses into runSync and never wakes another auto cycle by itself.
          if (this.localPublishIntent) {
            const seqBefore = this.localPublishSeq
            let result: BaselineAutoPublishResult | null = null
            try {
              result = await this.deps.tryPublishBaseline()
              if (isStale()) return
            } catch (e) {
              if (isStale()) return
              if ((e as Error)?.name === 'SyncShutdownError') return
              if ((e as Error)?.name === 'SyncStaleConfigError') {
                logger.info(`[autoSync] auto-publish invalidated by config change, stop`)
                return
              }
              if ((e as Error)?.name === 'SyncConfigPreflightError') {
                try {
                  this.handleAutoConfigFailure('autoSync', e)
                } catch {}
                return
              }
              const msg = e instanceof Error ? e.message : String(e)
              logger.warn(`[autoSync] auto-publish unexpected deferred: ${msg.slice(0, 300)}`)
            }
            // Intent accounting: `needs-sync` (outbox not drained, concurrent
            // barrier block, busy) retains the intent so the next successful
            // sync cycle retries after draining. `published`/`skipped`/
            // `deferred` (incl. 409/transport, already truthfully recorded
            // without failing the op-log sync) consume the round's intent —
            // but only when no newer local trigger arrived during the attempt.
            if (result !== null && result.kind === 'needs-sync') {
              // Retain: a newer trigger already set pending via requestAutoSync
              // (or its debounce fires next), so the next cycle converges first.
            } else if (this.localPublishSeq === seqBefore) {
              this.localPublishIntent = false
            }
            if (isStale()) return
          }
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
        if (!this.deps.isAttached()) return
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
    this.localPublishIntent = false
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
