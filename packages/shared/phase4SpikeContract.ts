/**
 * Phase 4.0-A/B/C1 Spike IPC Contract
 *
 * TEST/FEASIBILITY-ONLY infrastructure. Not imported by any production
 * entry point. Retained through Phase 4.1 as reproducibility harness.
 * Excluded from normal builds by PHASE4_SPIKE gating in electron.vite.config.ts.
 *
 * Fixed channels and typed envelopes for the spike harness.
 * Importable by main, preload, and renderer without pulling in
 * renderer-specific types.
 *
 * Phase A scope: single READY → CONFIG/PING → RESULT round trip only.
 * Phase B extension: adds FIXTURE_GENERATE / FIXTURE_DONE operations
 * for deterministic synthetic IndexedDB fixture generation.
 * Phase C1 extension: adds VERIFY / VERIFY_DONE operations for
 * production-Dexie source reader and upgrade verification against
 * staged pre-populated fixture profiles.
 */

/* ── Fixed IPC channel names — renderer cannot choose channels ── */

export const SPIKE_CHANNELS = {
  READY: 'spike:ready',
  CONFIG: 'spike:config',
  RESULT: 'spike:result'
} as const

export type SpikeChannel = (typeof SPIKE_CHANNELS)[keyof typeof SPIKE_CHANNELS]

/* ── Bounded operation enum ── */

export const SPIKE_OPERATIONS = {
  PING: 'PING',
  PONG: 'PONG',
  FIXTURE_GENERATE: 'FIXTURE_GENERATE',
  FIXTURE_DONE: 'FIXTURE_DONE',
  VERIFY: 'VERIFY',
  VERIFY_DONE: 'VERIFY_DONE',
  /* Phase C2a: retained-session isolation */
  ISOLATION_SETUP: 'ISOLATION_SETUP',
  ISOLATION_SETUP_DONE: 'ISOLATION_SETUP_DONE',
  ORIGIN_PROBE: 'ORIGIN_PROBE',
  ORIGIN_PROBE_DONE: 'ORIGIN_PROBE_DONE',
  /* Phase C2b: Local Storage necessity verification */
  LS_CHECK: 'LS_CHECK',
  LS_CHECK_DONE: 'LS_CHECK_DONE'
} as const

export type SpikeOperation = (typeof SPIKE_OPERATIONS)[keyof typeof SPIKE_OPERATIONS]

const VALID_OPERATIONS: ReadonlySet<string> = new Set(Object.values(SPIKE_OPERATIONS))

/**
 * Explicit request→response operation mapping.
 * Each request operation has exactly one expected response operation.
 * Used by the main-process multiplexer to reject mismatched results.
 */
export const REQUEST_TO_RESPONSE_OPERATION: ReadonlyMap<SpikeOperation, SpikeOperation> = new Map<
  SpikeOperation,
  SpikeOperation
>([
  [SPIKE_OPERATIONS.PING, SPIKE_OPERATIONS.PONG],
  [SPIKE_OPERATIONS.FIXTURE_GENERATE, SPIKE_OPERATIONS.FIXTURE_DONE],
  [SPIKE_OPERATIONS.VERIFY, SPIKE_OPERATIONS.VERIFY_DONE],
  [SPIKE_OPERATIONS.ISOLATION_SETUP, SPIKE_OPERATIONS.ISOLATION_SETUP_DONE],
  [SPIKE_OPERATIONS.ORIGIN_PROBE, SPIKE_OPERATIONS.ORIGIN_PROBE_DONE],
  [SPIKE_OPERATIONS.LS_CHECK, SPIKE_OPERATIONS.LS_CHECK_DONE]
])

/**
 * Return the expected response operation for a given request operation.
 * Returns undefined if the request operation is not a valid request.
 */
export function getExpectedResponseOperation(requestOperation: SpikeOperation): SpikeOperation | undefined {
  return REQUEST_TO_RESPONSE_OPERATION.get(requestOperation)
}

/* ── Envelope types ── */

/** Request envelope — main → renderer via CONFIG channel */
export interface SpikeRequest {
  runId: string
  caseId: string
  requestId: string
  operation: SpikeOperation
  payload?: Record<string, unknown>
}

/** Result envelope — renderer → main via RESULT channel */
export interface SpikeResult {
  runId: string
  caseId: string
  requestId: string
  operation: SpikeOperation
  status: 'ok' | 'error' | 'rejected'
  payload?: Record<string, unknown>
  error?: string
}

/* ── Validation ── */

export interface ValidationResult {
  valid: boolean
  error?: string
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/** Validate a SpikeRequest (CONFIG message from main). */
export function validateSpikeRequest(data: unknown): ValidationResult {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Request must be a non-null object' }
  }
  const req = data as Record<string, unknown>
  if (!isNonEmptyString(req.runId)) return { valid: false, error: 'Missing or invalid runId' }
  if (!isNonEmptyString(req.caseId)) return { valid: false, error: 'Missing or invalid caseId' }
  if (!isNonEmptyString(req.requestId)) return { valid: false, error: 'Missing or invalid requestId' }
  if (!isNonEmptyString(req.operation)) return { valid: false, error: 'Missing or invalid operation' }
  if (!VALID_OPERATIONS.has(req.operation)) return { valid: false, error: `Unknown operation: ${req.operation}` }
  return { valid: true }
}

/** Validate a SpikeResult (RESULT message from renderer). */
export function validateSpikeResult(data: unknown): ValidationResult {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Result must be a non-null object' }
  }
  const res = data as Record<string, unknown>
  if (!isNonEmptyString(res.runId)) return { valid: false, error: 'Missing or invalid runId' }
  if (!isNonEmptyString(res.caseId)) return { valid: false, error: 'Missing or invalid caseId' }
  if (!isNonEmptyString(res.requestId)) return { valid: false, error: 'Missing or invalid requestId' }
  if (!isNonEmptyString(res.operation)) return { valid: false, error: 'Missing or invalid operation' }
  if (!VALID_OPERATIONS.has(res.operation)) return { valid: false, error: `Unknown operation: ${res.operation}` }
  if (!isNonEmptyString(res.status)) return { valid: false, error: 'Missing or invalid status' }
  if (!['ok', 'error', 'rejected'].includes(res.status)) {
    return { valid: false, error: `Invalid status: ${res.status}` }
  }
  return { valid: true }
}

/* ── ID generators ── */

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10)
}

export function generateRunId(): string {
  return `run-${Date.now()}-${randomSuffix()}`
}

export function generateCaseId(): string {
  return `case-${Date.now()}-${randomSuffix()}`
}

export function generateRequestId(): string {
  return `req-${Date.now()}-${randomSuffix()}`
}
