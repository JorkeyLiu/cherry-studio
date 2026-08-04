/**
 * Import status observation for the L2 Cherry Studio import E2E (LOCK-622).
 *
 * Hard terminal evidence is the observed status sequence THROUGH `finalizing`
 * plus the original target process exit plus post-exit chat.db contents. The
 * `promoted` event is best-effort only (it races `app.exit(0)` inside the
 * recovery executor) — the observer records it but callers must not require
 * it (LOCK-622).
 *
 * The observer installs a page-side `cherryImport.onStatusChanged` listener
 * (primary, lossless for events that already arrived) and supplements it with
 * `cherryImport.getStatus(sessionId)` polling (authoritative last emitted
 * state, LOCK-6016). Both sources merge into ONE append-only, ordered,
 * source-aware history (LOCK-OBS-2):
 *
 * - Events (page collector + console mirror) are authoritative and carry the
 *   full payload (sanitized error, CandidateImportStats). A later event for a
 *   state that was only poll-observed replaces/enriches that poll record IN
 *   PLACE, so state order is never lost and a stats-bearing candidate-ready is
 *   always what `.find()` / `waitForState` sees (LOCK-OBS-3).
 * - Poll observations are a fallback for lifecycle/terminal detection; they
 *   never overwrite a richer event and are retained across reads/reload/close
 *   (LOCK-OBS-2/3/5).
 * - Only EXACT mirror duplicates (same state, at, error and canonical stats)
 *   are deduplicated — same-state observations with differing payloads stay
 *   distinct (LOCK-OBS-4).
 */
import type { Page } from '@playwright/test'

import { sleep } from './wait-helpers'

/** Canonical import state order (CherryImportUIState semantic order). */
export const IMPORT_STATE_ORDER = [
  'idle',
  'intake',
  'discovering',
  'reading',
  'candidate-ready',
  'verifying',
  'verified-candidate',
  'promoting',
  'finalizing',
  'promoted'
] as const

/** States that end the import without reaching finalizing/promoted. */
export const FAILURE_TERMINAL_STATES = new Set(['error', 'verification-failed', 'promotion-failed', 'cancelled'])

/**
 * Milestone states that MUST be observed in order for a genuine full-flow
 * import (emitted by the control layer, never deduplicated away).
 */
export const REQUIRED_STATE_CHAIN = ['candidate-ready', 'verified-candidate', 'promoting', 'finalizing'] as const

export interface RecordedStatus {
  state: string
  /** Epoch ms when the event/observation was recorded. */
  at: number
  /** Sanitized error carried by the event, if any. */
  error: string | null
  /** CandidateImportStats payload (only on candidate-ready events). */
  stats: Record<string, unknown> | null
}

/**
 * Optional payload-dependent wait predicate (LOCK-OBS-1). A stats-dependent
 * candidate-ready wait resolves only when the predicate passes; failure
 * fast-fail and timeout behavior are unchanged.
 */
export type WaitStatePredicate = (record: RecordedStatus) => boolean

export interface ImportStatusObserver {
  /** Bind the started session id so getStatus polling can run. */
  setSessionId(sessionId: string): void
  /** Ordered, deduplicated observed states (events + getStatus polling). */
  getStates(): Promise<RecordedStatus[]>
  /**
   * Wait until `state` is observed. Fails fast if a failure-terminal state
   * arrives first. Resolves with the recorded status. When `predicate` is
   * given, a record only counts once it also satisfies the predicate
   * (LOCK-OBS-1).
   */
  waitForState(state: string, timeoutMs?: number, predicate?: WaitStatePredicate): Promise<RecordedStatus>
  /** Detach the page-side listener (safe after process exit). */
  stop(): Promise<void>
}

/**
 * Pure subsequence check: true when `observed` contains every entry of
 * `required` in order (not necessarily contiguously). Returns null when the
 * chain holds, otherwise a human-readable mismatch description.
 */
export function assertStateSubsequence(observed: readonly string[], required: readonly string[]): string | null {
  let cursor = 0
  for (const state of observed) {
    if (cursor < required.length && state === required[cursor]) cursor += 1
  }
  if (cursor === required.length) return null
  return `expected states [${required.join(' -> ')}] as a subsequence of observed [${observed.join(', ')}]`
}

const PAGE_STATES_KEY = '__cherryE2EImportStatuses'
const PAGE_INSTALLED_KEY = '__cherryE2EImportObserverInstalled'
const PAGE_DISPOSE_KEY = '__cherryE2EImportObserverDispose'
/** Console marker emitted by the page-side collector for each status event. */
export const CONSOLE_MARKER = '__CHERRY_E2E_IMPORT_STATUS__'
/**
 * Poll cadence for reading the page-side collector. The successful promotion
 * path relaunches the app (original process exits) within a few hundred ms of
 * the first `discovering` event, so a slow poll (e.g. 300 ms) can miss every
 * intermediate event. The collector array is read at ~10 ms cadence plus the
 * `getStatus` IPC supplement; the console-message mirror is a second,
 * event-driven source that survives the brief pre-exit delivery window.
 */
const POLL_INTERVAL_MS = 10

/**
 * CandidateImportStats is a fixed numeric DTO (LOCK-OBS-4). Only these bounded
 * fields are ever canonicalized for dedup — arbitrary/unbounded payload
 * content is never serialized.
 */
const CANDIDATE_STATS_FIELDS = [
  'topicCount',
  'messageCount',
  'blockCount',
  'segmentCount',
  'segmentMembershipCount',
  'fileReferenceCount',
  'pageCount',
  'elapsedMs'
] as const

/** Source of an internal history entry (LOCK-OBS-2/3). */
export type StatusSource = 'event' | 'poll'

/** Internal source-aware history entry. The public RecordedStatus shape is unchanged. */
export interface InternalStatusEntry {
  record: RecordedStatus
  source: StatusSource
  /** Monotonic arrival order; `getRecords()` is already ordered by it. */
  seq: number
}

const STATE_ORDER_INDEX = new Map<string, number>(IMPORT_STATE_ORDER.map((state, index) => [state, index]))

/** True when `candidate` sits strictly earlier than `last` in the canonical order. */
function isBehindInOrder(last: string, candidate: string): boolean {
  const lastIndex = STATE_ORDER_INDEX.get(last)
  const candidateIndex = STATE_ORDER_INDEX.get(candidate)
  if (lastIndex === undefined || candidateIndex === undefined) return false
  return candidateIndex < lastIndex
}

/**
 * Stable, bounded payload key for exact-mirror dedup: state, at, error and the
 * canonical CandidateImportStats numeric fields. Same-state events with
 * differing error/stats produce distinct keys and are kept (LOCK-OBS-4).
 */
export function canonicalRecordPayload(record: RecordedStatus): string {
  const stats =
    record.stats && typeof record.stats === 'object' && !Array.isArray(record.stats)
      ? CANDIDATE_STATS_FIELDS.map(
          (field) => `${field}=${String((record.stats as Record<string, unknown>)[field])}`
        ).join(',')
      : 'null'
  return JSON.stringify([record.state, record.at, record.error ?? null, stats])
}

/**
 * Append-only, source-aware merge history (LOCK-OBS-2/3/4/5). Event records
 * are authoritative; a later event enriches a prior poll-only record of the
 * same state in place (order preserved); polls are fallback-only and never
 * fabricate or duplicate records.
 */
export class ImportStatusHistory {
  private entries: InternalStatusEntry[] = []
  private nextSeq = 0

  /** Ordered source-aware history (test surface — do not mutate). */
  getEntries(): readonly InternalStatusEntry[] {
    return this.entries
  }

  /** Public ordered records in arrival order (retained across reads/reload/close). */
  getRecords(): RecordedStatus[] {
    return this.entries.map((entry) => entry.record)
  }

  last(): InternalStatusEntry | null {
    return this.entries.length > 0 ? this.entries[this.entries.length - 1] : null
  }

  /**
   * Ingest a page/console EVENT record. Skips exact mirror duplicates, then
   * enriches a prior poll-only record of the same state in place, or appends.
   */
  ingestEvent(record: RecordedStatus): boolean {
    const payloadKey = canonicalRecordPayload(record)
    for (const entry of this.entries) {
      if (entry.source === 'event' && canonicalRecordPayload(entry.record) === payloadKey) return false
    }
    for (let index = this.entries.length - 1; index >= 0; index--) {
      if (this.entries[index].record.state === record.state) {
        if (this.entries[index].source === 'poll') {
          this.entries[index] = { record, source: 'event', seq: this.entries[index].seq }
          return true
        }
        break
      }
    }
    this.entries.push({ record, source: 'event', seq: this.nextSeq++ })
    return true
  }

  /**
   * Ingest a getStatus poll observation (fallback only, LOCK-OBS-5). Skips
   * unchanged/stale states, states already observed via a richer event, and
   * anything after a failure-terminal state — polls never fabricate records.
   */
  ingestPoll(state: string, error: string | null): boolean {
    if (typeof state !== 'string' || state.length === 0) return false
    if (this.entries.length === 0) {
      this.entries.push({ record: { state, at: Date.now(), error, stats: null }, source: 'poll', seq: this.nextSeq++ })
      return true
    }
    const last = this.entries[this.entries.length - 1]
    if (last.record.state === state) return false
    if (FAILURE_TERMINAL_STATES.has(last.record.state)) return false
    if (isBehindInOrder(last.record.state, state)) return false
    if (this.entries.some((entry) => entry.record.state === state)) return false
    this.entries.push({ record: { state, at: Date.now(), error, stats: null }, source: 'poll', seq: this.nextSeq++ })
    return true
  }
}

// ---------------------------------------------------------------------------
// Page-side collector functions. They are module-level NAMED functions so the
// node-side observer can pass them to `page.evaluate` AND deterministic unit
// tests can drive a fake page by function name. Each is self-contained (only
// `window`, `console`, `Date`, `JSON` and its argument).
// ---------------------------------------------------------------------------

function installCollector(args: {
  statesKey: string
  installedKey: string
  disposeKey: string
  consoleMarker: string
}): void {
  const w = window as any
  if (w[args.installedKey]) return
  w[args.statesKey] = []
  w[args.disposeKey] = w.api.cherryImport.onStatusChanged((event: any) => {
    const record = {
      state: event.state,
      at: Date.now(),
      error: event.error ?? null,
      stats: event.stats ?? null
    }
    w[args.statesKey].push(record)
    // Event-driven mirror: delivered to the node side even when the process
    // exits moments after the event (fast relaunch path).
    console.log(args.consoleMarker, JSON.stringify(record))
  })
  w[args.installedKey] = true
}

function readCollector(key: string): RecordedStatus[] {
  return (window as any)[key] ?? []
}

function pollStatus(sid: string): { state: string; error?: string } | null {
  return (window as any).api.cherryImport.getStatus(sid)
}

function disposeCollector(args: { installedKey: string; disposeKey: string }): void {
  const w = window as any
  if (typeof w[args.disposeKey] === 'function') {
    w[args.disposeKey]()
    w[args.disposeKey] = null
  }
  w[args.installedKey] = false
}

/**
 * Install the page-side event collector and return an observer handle.
 * The collector captures EVERY status-changed event as it arrives; the
 * observer supplements with getStatus polling once a session id is bound and
 * with a console-message mirror (the successful path exits the app within a
 * few hundred ms of `start`, so the collector array is read at a fast cadence
 * and mirrored to console so events delivered just before the relaunch exit
 * are not lost to slow polling).
 */
export async function observeImportStatuses(page: Page): Promise<ImportStatusObserver> {
  await page.evaluate(installCollector, {
    statesKey: PAGE_STATES_KEY,
    installedKey: PAGE_INSTALLED_KEY,
    disposeKey: PAGE_DISPOSE_KEY,
    consoleMarker: CONSOLE_MARKER
  })

  const history = new ImportStatusHistory()
  let sessionId: string | null = null
  /** Page-collector records already ingested; reset when the collector is reset by a reload. */
  let pageEventCount = 0

  // Node-side console capture (supplemental, event-driven). Status events that
  // arrive in the renderer's final moments before the relaunch exit are
  // mirrored to console; Playwright delivers console messages to this listener
  // without a polling race. Mirror records are ingested immediately and later
  // deduplicated against the page collector (exact payload match).
  const consoleHandler = (msg: { text(): string }): void => {
    const text = msg.text()
    if (!text.startsWith(CONSOLE_MARKER)) return
    try {
      const payload = JSON.parse(text.slice(CONSOLE_MARKER.length).trim()) as RecordedStatus
      if (typeof payload?.state === 'string' && typeof payload?.at === 'number') {
        history.ingestEvent(payload)
      }
    } catch {
      // Ignore malformed mirror lines.
    }
  }
  page.on('console', consoleHandler)

  const readPageStates = async (): Promise<void> => {
    try {
      const events = (await page.evaluate(readCollector, PAGE_STATES_KEY)) as RecordedStatus[]
      if (events.length < pageEventCount) pageEventCount = 0 // collector was reset (in-process reload)
      const fresh = events.slice(pageEventCount)
      pageEventCount = events.length
      for (const record of fresh) history.ingestEvent(record)
    } catch {
      // Page may already be gone after the target process exited — retained
      // history is authoritative.
    }
  }

  const withPolledStatus = async (): Promise<void> => {
    if (!sessionId) return
    try {
      const current = (await page.evaluate(pollStatus, sessionId)) as { state: string; error?: string } | null
      if (current && typeof current.state === 'string') {
        history.ingestPoll(current.state, current.error ?? null)
      }
    } catch {
      // Page gone after process exit — events already captured are authoritative.
    }
  }

  const refresh = async (): Promise<void> => {
    await readPageStates()
    await withPolledStatus()
  }

  return {
    setSessionId(id: string) {
      sessionId = id
    },
    async getStates(): Promise<RecordedStatus[]> {
      await refresh()
      return history.getRecords()
    },
    async waitForState(state: string, timeoutMs = 120000, predicate?: WaitStatePredicate): Promise<RecordedStatus> {
      const start = Date.now()
      for (;;) {
        await refresh()
        const states = history.getRecords()
        const hit = states.find((record) => record.state === state && (!predicate || predicate(record)))
        if (hit) return hit

        const failure = states.find((record) => FAILURE_TERMINAL_STATES.has(record.state))
        if (failure && failure.state !== state) {
          throw new Error(
            `Import reached failure-terminal state "${failure.state}"` +
              `${failure.error ? ` (${failure.error})` : ''} before "${state}". ` +
              `Observed: [${states.map((s) => s.state).join(', ')}]`
          )
        }

        if (Date.now() - start > timeoutMs) {
          throw new Error(
            `Timed out waiting for import state "${state}". ` + `Observed: [${states.map((s) => s.state).join(', ')}]`
          )
        }
        await sleep(POLL_INTERVAL_MS)
      }
    },
    async stop(): Promise<void> {
      page.off('console', consoleHandler)
      try {
        await page.evaluate(disposeCollector, { installedKey: PAGE_INSTALLED_KEY, disposeKey: PAGE_DISPOSE_KEY })
      } catch {
        // Page already closed — nothing to detach.
      }
    }
  }
}
