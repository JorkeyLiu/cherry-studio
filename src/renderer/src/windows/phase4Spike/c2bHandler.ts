/**
 * Phase 4.0-C2b — Renderer Local Storage Check Handler
 *
 * Handles the LS_CHECK operation: reads localStorage for known Phase 4
 * control markers (phase4:marker, phase4:fixtureId) and reports their
 * presence/absence.
 *
 * Used to prove that Local Storage is unnecessary for CherryStudio
 * IndexedDB discovery/read — the full-profile session has LS markers,
 * while the IDB-only session does not, but both produce identical
 * IndexedDB results.
 *
 * Does NOT import production Dexie or open any IndexedDB.
 * Only reads from localStorage.
 */
import type { SpikeRequest, SpikeResult } from '@shared/phase4SpikeContract'
import { SPIKE_OPERATIONS } from '@shared/phase4SpikeContract'

/* ── Constants ── */

const LS_MARKER_KEYS = ['phase4:marker', 'phase4:fixtureId']

/* ── Logging ── */

function log(msg: string): void {
  const el = document.getElementById('log')
  if (el) el.textContent += `[${new Date().toISOString()}] ${msg}\n`
  console.log(`[Phase4C2b] ${msg}`)
}

/* ── LS_CHECK ── */

/**
 * Check localStorage for known Phase 4 control markers.
 *
 * Reads all localStorage keys and specifically checks for
 * phase4:marker and phase4:fixtureId entries.
 *
 * Returns the full key inventory plus targeted marker presence.
 */
export async function handleLsCheck(config: SpikeRequest): Promise<void> {
  log(`LS_CHECK: checking localStorage at origin=${location.origin}`)

  try {
    /* ── Enumerate all localStorage keys ── */
    const allKeys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key !== null) allKeys.push(key)
    }

    /* ── Read targeted marker values ── */
    const markerEntries: Record<string, string | null> = {}
    for (const key of LS_MARKER_KEYS) {
      markerEntries[key] = localStorage.getItem(key)
    }

    const markerFound = markerEntries['phase4:marker'] !== null
    const markerValue = markerEntries['phase4:marker']
    const fixtureIdFound = markerEntries['phase4:fixtureId'] !== null
    const fixtureIdValue = markerEntries['phase4:fixtureId']

    log(
      `LS_CHECK: ${allKeys.length} keys found. ` +
        `marker=${markerFound ? `"${markerValue}"` : 'ABSENT'}, ` +
        `fixtureId=${fixtureIdFound ? `"${fixtureIdValue}"` : 'ABSENT'}`
    )

    const result: SpikeResult = {
      runId: config.runId,
      caseId: config.caseId,
      requestId: config.requestId,
      operation: SPIKE_OPERATIONS.LS_CHECK_DONE,
      status: 'ok',
      payload: {
        allKeys,
        markerFound,
        markerValue,
        fixtureIdFound,
        fixtureIdValue,
        origin: location.origin,
        href: location.href
      }
    }
    window.spike.reportResult(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`LS_CHECK FAILED: ${msg}`)

    const errorResult: SpikeResult = {
      runId: config.runId,
      caseId: config.caseId,
      requestId: config.requestId,
      operation: SPIKE_OPERATIONS.LS_CHECK_DONE,
      status: 'error',
      error: msg
    }
    window.spike.reportResult(errorResult)
  }
}
