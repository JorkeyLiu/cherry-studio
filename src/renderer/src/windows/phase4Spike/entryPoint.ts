/**
 * Phase 4.0-A/B/C1/C2a/C2b Spike — Renderer Entry Point
 *
 * TEST/FEASIBILITY-ONLY. Not used by any production build.
 * Excluded from normal builds by PHASE4_SPIKE gating in electron.vite.config.ts.
 * Retained through Phase 4.1 as reproducibility harness.
 *
 * Minimal renderer that:
 *  1. Registers a config listener
 *  2. Sends READY signal
 *  3. Handles CONFIG requests:
 *     - PING → PONG (Phase A)
 *     - FIXTURE_GENERATE → FIXTURE_DONE (Phase B)
 *     - VERIFY → VERIFY_DONE (Phase C1)
 *     - ISOLATION_SETUP → ISOLATION_SETUP_DONE (Phase C2a)
 *     - ORIGIN_PROBE → ORIGIN_PROBE_DONE (Phase C2a)
 *     - LS_CHECK → LS_CHECK_DONE (Phase C2b)
 *
 * Phase A behavior is fully preserved.
 */
import type { SpikeRequest, SpikeResult } from '@shared/phase4SpikeContract'
import { SPIKE_OPERATIONS } from '@shared/phase4SpikeContract'

import { handleIsolationSetup, handleOriginProbe } from './c2aHandler'
import { handleLsCheck } from './c2bHandler'
import { generateFixture } from './fixtureGenerators'
import { handleVerify } from './verifyHandler'

/* ── Spike preload API (narrow, fixed channels) ── */

declare global {
  interface Window {
    spike: {
      ready: () => void
      onConfig: (callback: (config: SpikeRequest) => void) => void
      reportResult: (data: SpikeResult) => void
    }
  }
}

/* ── Logging ── */

function log(msg: string): void {
  const el = document.getElementById('log')
  if (el) el.textContent += `[${new Date().toISOString()}] ${msg}\n`
  console.log(`[Phase4Spike] ${msg}`)
}

/* ── Handlers ── */

function handlePing(config: SpikeRequest): void {
  const now = Date.now()
  const result: SpikeResult = {
    runId: config.runId,
    caseId: config.caseId,
    requestId: config.requestId,
    operation: SPIKE_OPERATIONS.PONG,
    status: 'ok',
    payload: {
      receivedAt: now,
      pongMessage: 'Phase 4.0-A PONG',
      requestPayload: config.payload ?? null
    }
  }

  log(`Sending RESULT: status=${result.status}, operation=${result.operation}`)
  window.spike.reportResult(result)
  log('Result sent. Renderer done.')
}

async function handleFixtureGenerate(config: SpikeRequest): Promise<void> {
  const fixtureId = config.payload?.fixtureId as string | undefined
  if (!fixtureId) {
    log('ERROR: FIXTURE_GENERATE payload missing fixtureId')
    const errorResult: SpikeResult = {
      runId: config.runId,
      caseId: config.caseId,
      requestId: config.requestId,
      operation: SPIKE_OPERATIONS.FIXTURE_DONE,
      status: 'error',
      error: 'Missing fixtureId in payload'
    }
    window.spike.reportResult(errorResult)
    return
  }

  log(`Generating fixture: ${fixtureId}`)

  try {
    const payload = await generateFixture(fixtureId as Parameters<typeof generateFixture>[0])
    log(`Fixture ${fixtureId} generated. Tables: ${payload.tables.join(', ')}`)
    log(`Record counts: ${JSON.stringify(payload.recordCounts)}`)
    log(`Observed native version: ${payload.observedNativeVersion}`)

    const result: SpikeResult = {
      runId: config.runId,
      caseId: config.caseId,
      requestId: config.requestId,
      operation: SPIKE_OPERATIONS.FIXTURE_DONE,
      status: 'ok',
      payload: payload as unknown as Record<string, unknown>
    }

    log(`Sending FIXTURE_DONE: status=ok, fixtureId=${fixtureId}`)
    window.spike.reportResult(result)
    log('Fixture result sent. Renderer done.')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`ERROR generating fixture ${fixtureId}: ${msg}`)

    const errorResult: SpikeResult = {
      runId: config.runId,
      caseId: config.caseId,
      requestId: config.requestId,
      operation: SPIKE_OPERATIONS.FIXTURE_DONE,
      status: 'error',
      error: msg
    }
    window.spike.reportResult(errorResult)
  }
}

/* ── Entry point ── */

log('Renderer module loaded. Registering config listener...')

// Register config listener BEFORE sending ready
window.spike.onConfig((config: SpikeRequest) => {
  log(`CONFIG received: operation=${config.operation}, requestId=${config.requestId}`)

  switch (config.operation) {
    case SPIKE_OPERATIONS.PING:
      handlePing(config)
      break

    case SPIKE_OPERATIONS.FIXTURE_GENERATE:
      void handleFixtureGenerate(config)
      break

    case SPIKE_OPERATIONS.VERIFY:
      void handleVerify(config)
      break

    case SPIKE_OPERATIONS.ISOLATION_SETUP:
      void handleIsolationSetup(config)
      break

    case SPIKE_OPERATIONS.ORIGIN_PROBE:
      void handleOriginProbe(config)
      break

    case SPIKE_OPERATIONS.LS_CHECK:
      void handleLsCheck(config)
      break

    default: {
      log(`ERROR: Unhandled operation: ${config.operation}`)
      const errorResult: SpikeResult = {
        runId: config.runId,
        caseId: config.caseId,
        requestId: config.requestId,
        operation: config.operation,
        status: 'error',
        error: `Unhandled operation: ${config.operation}`
      }
      window.spike.reportResult(errorResult)
    }
  }
})

// Send READY AFTER the config listener is registered
window.spike.ready()
log('READY signal sent.')
