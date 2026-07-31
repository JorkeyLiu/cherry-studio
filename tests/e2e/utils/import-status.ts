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
 * state, LOCK-6016). Both sources are deduplicated into one ordered list.
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

export interface ImportStatusObserver {
  /** Bind the started session id so getStatus polling can run. */
  setSessionId(sessionId: string): void
  /** Ordered, deduplicated observed states (events + getStatus polling). */
  getStates(): Promise<RecordedStatus[]>
  /**
   * Wait until `state` is observed. Fails fast if a failure-terminal state
   * arrives first. Resolves with the recorded status.
   */
  waitForState(state: string, timeoutMs?: number): Promise<RecordedStatus>
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
const CONSOLE_MARKER = '__CHERRY_E2E_IMPORT_STATUS__'
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
 * Install the page-side event collector and return an observer handle.
 * The collector captures EVERY status-changed event as it arrives; the
 * observer supplements with getStatus polling once a session id is bound and
 * with a console-message mirror (the successful path exits the app within a
 * few hundred ms of `start`, so the collector array is read at a fast cadence
 * and mirrored to console so events delivered just before the relaunch exit
 * are not lost to slow polling).
 */
export async function observeImportStatuses(page: Page): Promise<ImportStatusObserver> {
  await page.evaluate(
    ({ statesKey, installedKey, disposeKey, consoleMarker }) => {
      const w = window as any
      if (w[installedKey]) return
      w[statesKey] = []
      w[disposeKey] = w.api.cherryImport.onStatusChanged((event: any) => {
        const record = {
          state: event.state,
          at: Date.now(),
          error: event.error ?? null,
          stats: event.stats ?? null
        }
        w[statesKey].push(record)
        // Event-driven mirror: delivered to the node side even when the
        // process exits moments after the event (fast relaunch path).
        console.log(consoleMarker, JSON.stringify(record))
      })
      w[installedKey] = true
    },
    {
      statesKey: PAGE_STATES_KEY,
      installedKey: PAGE_INSTALLED_KEY,
      disposeKey: PAGE_DISPOSE_KEY,
      consoleMarker: CONSOLE_MARKER
    }
  )

  let sessionId: string | null = null
  let lastKnown: RecordedStatus[] = []

  // Node-side console capture (supplemental, event-driven). Status events
  // that arrive in the renderer's final moments before the relaunch exit are
  // mirrored to console; Playwright delivers console messages to this listener
  // without a polling race.
  const consoleStates: RecordedStatus[] = []
  const consoleHandler = (msg: { text(): string }): void => {
    const text = msg.text()
    if (!text.startsWith(CONSOLE_MARKER)) return
    try {
      const payload = JSON.parse(text.slice(CONSOLE_MARKER.length).trim()) as RecordedStatus
      if (typeof payload?.state === 'string' && typeof payload?.at === 'number') {
        consoleStates.push(payload)
      }
    } catch {
      // Ignore malformed mirror lines.
    }
  }
  page.on('console', consoleHandler)

  /** Merge page-side collector array + console mirror, order-preserving and deduplicated. */
  const mergeStates = (events: RecordedStatus[]): RecordedStatus[] => {
    const seen = new Set<string>()
    const merged: RecordedStatus[] = []
    for (const record of [...consoleStates, ...events]) {
      const key = `${record.state}@${record.at}`
      if (!seen.has(key)) {
        seen.add(key)
        merged.push(record)
      }
    }
    return merged
  }

  const readPageStates = async (): Promise<RecordedStatus[]> => {
    try {
      const events = (await page.evaluate((key) => (window as any)[key] ?? [], PAGE_STATES_KEY)) as RecordedStatus[]
      lastKnown = mergeStates(events)
      return lastKnown
    } catch {
      // Page may already be gone after the target process exited.
      lastKnown = mergeStates(lastKnown)
      return lastKnown
    }
  }

  const withPolledStatus = async (events: RecordedStatus[]): Promise<RecordedStatus[]> => {
    if (!sessionId) return events
    try {
      const current = (await page.evaluate((sid) => (window as any).api.cherryImport.getStatus(sid), sessionId)) as {
        state: string
        error?: string
      } | null
      if (current && typeof current.state === 'string') {
        const last = events.length > 0 ? events[events.length - 1] : null
        if (!last || last.state !== current.state) {
          const merged = [
            ...events,
            { state: current.state, at: Date.now(), error: current.error ?? null, stats: null }
          ]
          lastKnown = merged
          return merged
        }
      }
    } catch {
      // Page gone after process exit — events already captured are authoritative.
    }
    return events
  }

  return {
    setSessionId(id: string) {
      sessionId = id
    },
    async getStates(): Promise<RecordedStatus[]> {
      return withPolledStatus(await readPageStates())
    },
    async waitForState(state: string, timeoutMs = 120000): Promise<RecordedStatus> {
      const start = Date.now()
      for (;;) {
        const states = await withPolledStatus(await readPageStates())
        const hit = states.find((s) => s.state === state)
        if (hit) return hit

        const failure = states.find((s) => FAILURE_TERMINAL_STATES.has(s.state))
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
        await page.evaluate(
          ({ installedKey, disposeKey }) => {
            const w = window as any
            if (typeof w[disposeKey] === 'function') {
              w[disposeKey]()
              w[disposeKey] = null
            }
            w[installedKey] = false
          },
          { installedKey: PAGE_INSTALLED_KEY, disposeKey: PAGE_DISPOSE_KEY }
        )
      } catch {
        // Page already closed — nothing to detach.
      }
    }
  }
}
