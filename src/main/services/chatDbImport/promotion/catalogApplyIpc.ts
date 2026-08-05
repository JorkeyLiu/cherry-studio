/**
 * Files catalog apply boundary — Main ↔ renderer bridge (Phase 2 L2
 * promotion, LOCK-PROMO-5/7).
 *
 * The live Dexie files catalog is owned by the renderer (IndexedDB). This
 * module is the ONLY Main-side seam that talks to it, through a minimal
 * typed request/response boundary:
 *
 *   Main → renderer:  webContents.send(CherryImport_CatalogRequest, req)
 *   Renderer → Main:  api.cherryImport.catalog.respond(requestId, res)
 *                     (ipcRenderer.invoke → CherryImport_CatalogRespond)
 *   Renderer → Main:  api.cherryImport.catalog.ready()
 *                     (ipcRenderer.invoke → CherryImport_CatalogReady)
 *
 * Ready handshake (LOCK-BRIDGE-1/F4): the renderer mounts its catalog request
 * handler only after PersistGate (App mount), so Main must NOT send requests
 * the instant a window URL loads — they would sit unanswered for the full
 * per-request timeout (the 60s startup race). The renderer invokes the ready
 * channel ONLY after its handler is installed; Main awaits it with a bounded
 * timeout (CATALOG_READY_TIMEOUT_MS). EVERY boundary send gates on readiness:
 * the recovery driver awaits it explicitly before running the executor, and
 * sendCatalogRequest awaits it implicitly before the FIRST normal-window send
 * (subsequent sends observe the settled ready state without another wait).
 * Stale (different webContents), subframe, duplicate, and post-dispose ready
 * signals are rejected; a ready timeout or lost target fails closed with a
 * bounded aggregate code and no request is sent before ready.
 *
 * Requests (LOCK-PROMO-5/7):
 * - capture-snapshot — renderer reads the live `files` table and returns
 *   canonical rows + aggregate digest; Main writes the retained snapshot.
 * - apply-candidate — renderer performs a SINGLE Dexie transaction
 *   replace-all with the candidate catalog rows and returns post-facts.
 * - restore-snapshot — renderer performs a SINGLE Dexie transaction
 *   replace-all restoring the old snapshot rows and returns post-facts.
 * - query-facts — renderer returns count + digest of the current table.
 *
 * Authorization: only the currently registered main renderer's MAIN FRAME
 * may respond (mirrors LOCK-FA1/FA2/FA3 for the projection handlers). Any
 * other sender is rejected WITHOUT touching Dexie.
 *
 * Request lifecycle: each request carries a unique requestId and a bounded
 * timeout; an unanswered request settles as a structured timeout failure
 * (the journal stays at catalog-pending; deterministic recovery retries).
 *
 * Main-only module (the renderer counterpart is the preload catalog API +
 * catalogRecoveryService in the renderer).
 */

import { loggerService } from '@logger'
import { getFilesDir } from '@main/utils/file'
import type {
  CatalogApplyOutcome,
  CatalogRecoveryFacts,
  CatalogRecoveryRequest,
  CatalogRecoveryResponse,
  FilesCatalogSnapshotRow,
  FilesCatalogSnapshotV1
} from '@shared/chatImport/types'
import { IpcChannel } from '@shared/IpcChannel'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { ipcMain } from 'electron'

const logger = loggerService.withContext('chatDbImportCatalogBoundary')

/** Bounded per-request timeout (ms). */
const CATALOG_REQUEST_TIMEOUT_MS = 60_000

/**
 * Bounded ready-handshake timeout (ms) — LOCK-BRIDGE-1. The recovery driver
 * awaits the renderer ready signal before sending ANY catalog request; the
 * signal normally arrives sub-second after load, so this bound only guards
 * against a renderer that never mounts its handler (far shorter than the
 * per-request timeout, so the startup race can never silently burn 60s).
 */
const CATALOG_READY_TIMEOUT_MS = 30_000

/** Bounded failure codes for the Main-side boundary. */
export type CatalogBoundaryFailureCode =
  | 'NO_TARGET'
  | 'TIMEOUT'
  | 'UNAUTHORIZED'
  | 'PAYLOAD_INVALID'
  | 'RENDERER_FAILED'
  | 'FACTS_MISMATCH'
  | 'DURABLE_WRITE_FAILED'
  | 'UNEXPECTED'

/** Main-side outcome of one catalog boundary operation. */
export type CatalogBoundaryResult =
  | { readonly ok: true; readonly facts: CatalogRecoveryFacts; readonly rows?: readonly FilesCatalogSnapshotRow[] }
  | { readonly ok: false; readonly code: CatalogBoundaryFailureCode; readonly detail: string | null }

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Registered main renderer webContents (idempotent re-registration). */
let targetWebContents: WebContents | null = null

/** Pending requestId → resolver map. */
const pendingRequests = new Map<string, (result: CatalogRecoveryResponse) => void>()

let requestCounter = 0

/** True once the current target's renderer signaled ready (LOCK-BRIDGE-1). */
let readyReceived = false

/** Awaiters of {@link awaitCatalogRecoveryReady}, resolved by the ready signal. */
const readyWaiters = new Set<(result: { ok: true } | { ok: false; code: 'NO_TARGET' | 'READY_TIMEOUT' }) => void>()

/** Resolve every pending request with a timeout failure (dispose/target loss). */
function failAllPending(reason: CatalogBoundaryFailureCode): void {
  for (const [requestId, resolve] of pendingRequests) {
    pendingRequests.delete(requestId)
    resolve({ ok: false, requestId, code: reason })
  }
}

/** Fail every pending ready waiter with a bounded code (re-register/dispose). */
function failReadyWaiters(reason: 'NO_TARGET' | 'READY_TIMEOUT'): void {
  for (const resolve of readyWaiters) {
    resolve({ ok: false, code: reason })
  }
  readyWaiters.clear()
}

// ---------------------------------------------------------------------------
// Response handler (renderer → Main invoke)
// ---------------------------------------------------------------------------

/** True when the sender is the registered main renderer's main frame. */
function isAuthorizedResponder(event: IpcMainInvokeEvent): boolean {
  return (
    targetWebContents !== null &&
    !targetWebContents.isDestroyed() &&
    event.sender === targetWebContents &&
    event.senderFrame === targetWebContents.mainFrame
  )
}

/** Structural guard: a bounded, valid aggregate facts receipt (LOCK-CAT-3). */
function isFactsShape(value: unknown): value is CatalogRecoveryFacts {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const facts = value as Record<string, unknown>
  return (
    typeof facts.count === 'number' &&
    Number.isSafeInteger(facts.count) &&
    facts.count >= 0 &&
    typeof facts.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(facts.sha256)
  )
}

/** Structural guard: one canonical catalog row (LOCK-CAT-5 field shape). */
function isCatalogRowShape(value: unknown): value is FilesCatalogSnapshotRow {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.id === 'string' &&
    typeof row.name === 'string' &&
    typeof row.origin_name === 'string' &&
    typeof row.path === 'string' &&
    typeof row.size === 'number' &&
    Number.isSafeInteger(row.size) &&
    row.size >= 0 &&
    typeof row.ext === 'string' &&
    (row.type === null || typeof row.type === 'string') &&
    (row.created_at === null || typeof row.created_at === 'string') &&
    typeof row.count === 'number' &&
    Number.isSafeInteger(row.count) &&
    row.count >= 0
  )
}

/**
 * Strictly validate a renderer response before it is accepted (LOCK-CAT-3:
 * malformed wire data is rejected). Returns a bounded failure code when the
 * payload is not a structurally valid {@link CatalogRecoveryResponse}.
 */
function validateResponsePayload(
  requestId: string,
  value: unknown
): { ok: true; value: CatalogRecoveryResponse } | { ok: false; code: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'INVALID_RESPONSE' }
  }
  const response = value as Record<string, unknown>
  if (response.requestId !== requestId) {
    // The response answers a different request than the one it is keyed to.
    return { ok: false, code: 'INVALID_RESPONSE' }
  }
  if (response.ok === false) {
    if (typeof response.code !== 'string' || response.code.length === 0 || response.code.length > 64) {
      return { ok: false, code: 'INVALID_RESPONSE' }
    }
    return { ok: true, value: value as CatalogRecoveryResponse }
  }
  if (response.ok !== true || !isFactsShape(response.facts)) {
    return { ok: false, code: 'INVALID_RESPONSE' }
  }
  if (response.rows !== undefined) {
    if (!Array.isArray(response.rows) || !response.rows.every(isCatalogRowShape)) {
      return { ok: false, code: 'INVALID_RESPONSE' }
    }
  }
  return { ok: true, value: value as CatalogRecoveryResponse }
}

/** True while this module owns the registered Respond/Ready handlers. */
let responderRegistered = false

/**
 * Register the catalog boundary IPC. Idempotent — re-registration swaps the
 * target webContents, drops any pending requests AND ready waiters with a
 * bounded failure, resets the ready state, and replaces the previous
 * Respond/Ready handlers (never double-registers).
 */
export function registerCatalogRecoveryIpc(webContents: WebContents): void {
  if (targetWebContents !== null) {
    failAllPending('NO_TARGET')
    failReadyWaiters('NO_TARGET')
  }
  targetWebContents = webContents
  // LOCK-BRIDGE-1: a fresh target must prove its own readiness — a stale
  // ready recorded against a previous window must never satisfy this one.
  readyReceived = false
  if (responderRegistered) {
    for (const channel of [IpcChannel.CherryImport_CatalogRespond, IpcChannel.CherryImport_CatalogReady]) {
      try {
        ipcMain.removeHandler(channel)
      } catch {
        // Best-effort — a handler may already be gone (dispose race).
      }
    }
  }
  ipcMain.handle(IpcChannel.CherryImport_CatalogRespond, (event, requestId: unknown, result: unknown) => {
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128) {
      return { accepted: false }
    }
    if (!isAuthorizedResponder(event)) {
      logger.warn('L2 catalog response rejected: sender is not the registered main renderer main frame')
      return { accepted: false }
    }
    const resolve = pendingRequests.get(requestId)
    if (!resolve) {
      // Duplicate/late/unknown response — bounded no-op.
      return { accepted: false }
    }
    pendingRequests.delete(requestId)
    const validated = validateResponsePayload(requestId, result)
    if (!validated.ok) {
      resolve({ ok: false, requestId, code: validated.code })
      return { accepted: true }
    }
    resolve(validated.value)
    return { accepted: true }
  })
  // LOCK-BRIDGE-1: ready handshake — the recovery renderer invokes this only
  // after its catalog handler is installed. Stale (other webContents),
  // subframe, duplicate, and post-dispose signals are rejected.
  ipcMain.handle(IpcChannel.CherryImport_CatalogReady, (event): { accepted: boolean } => {
    if (!isAuthorizedResponder(event)) {
      logger.warn('L2 catalog ready signal rejected: sender is not the registered main renderer main frame')
      return { accepted: false }
    }
    if (readyReceived) {
      // Duplicate ready — bounded no-op (the first signal owns the handshake).
      return { accepted: false }
    }
    readyReceived = true
    const waiters = [...readyWaiters]
    readyWaiters.clear()
    for (const resolve of waiters) {
      resolve({ ok: true })
    }
    return { accepted: true }
  })
  responderRegistered = true
}

/** Dispose the catalog boundary (clear target + fail pending + reset ready). */
export function disposeCatalogRecoveryIpc(): void {
  failAllPending('NO_TARGET')
  failReadyWaiters('NO_TARGET')
  targetWebContents = null
  readyReceived = false
  if (responderRegistered) {
    for (const channel of [IpcChannel.CherryImport_CatalogRespond, IpcChannel.CherryImport_CatalogReady]) {
      try {
        ipcMain.removeHandler(channel)
      } catch {
        // Best-effort.
      }
    }
    responderRegistered = false
  }
}

/**
 * Await the registered renderer's ready signal with a bounded timeout
 * (LOCK-BRIDGE-1). Resolves immediately when the signal already arrived;
 * fails fast with NO_TARGET when no live target is registered; fails with
 * READY_TIMEOUT when the renderer never signals within the bound. Never
 * rejects.
 */
export function awaitCatalogRecoveryReady(
  timeoutMs: number = CATALOG_READY_TIMEOUT_MS
): Promise<{ ok: true } | { ok: false; code: 'NO_TARGET' | 'READY_TIMEOUT' }> {
  const wc = targetWebContents
  if (!wc || wc.isDestroyed()) {
    return Promise.resolve({ ok: false, code: 'NO_TARGET' })
  }
  if (readyReceived) {
    return Promise.resolve({ ok: true })
  }
  return new Promise((resolve) => {
    setTimeout(() => {
      if (readyWaiters.delete(resolve)) {
        resolve({ ok: false, code: 'READY_TIMEOUT' })
      }
    }, timeoutMs)
    readyWaiters.add(resolve)
  })
}

// ---------------------------------------------------------------------------
// Request send
// ---------------------------------------------------------------------------

/**
 * Send one request and await the typed response (bounded timeout).
 *
 * LOCK-BRIDGE-1/F4 (normal-window gating): the FIRST request never races the
 * renderer handler mount. When the registered target has not yet signaled
 * ready, the send awaits the authenticated ready handshake (bounded
 * CATALOG_READY_TIMEOUT_MS) BEFORE transmitting; no request is sent before
 * ready. A ready timeout or lost/absent target fails closed with a bounded
 * aggregate code (READY_TIMEOUT / NO_TARGET) and the request is never sent.
 * Subsequent requests observe the settled ready state and transmit immediately
 * WITHOUT another wait (the readyReceived short-circuit in
 * awaitCatalogRecoveryReady — no repeated handshake). Dispose and
 * re-registration reset readiness, so a request that was awaiting ready fails
 * with NO_TARGET and is never forwarded to a target that did not prove its
 * own readiness. The recovery driver's explicit pre-executor await still
 * short-circuits here, so recovery-window behavior is unchanged.
 */
export async function sendCatalogRequest(
  request: Omit<CatalogRecoveryRequest, 'requestId'>
): Promise<CatalogRecoveryResponse> {
  const requestId = `cat-req-${++requestCounter}-${Date.now().toString(36)}`
  const wc = targetWebContents
  if (!wc || wc.isDestroyed()) {
    return { ok: false, requestId, code: 'NO_TARGET' }
  }
  if (!readyReceived) {
    // LOCK-BRIDGE-1: the renderer handler is not yet mounted — await the
    // authenticated ready signal (bounded) before the first send. This is a
    // one-time gate: once readyReceived settles, every later request sends
    // without a second wait.
    const ready = await awaitCatalogRecoveryReady()
    if (!ready.ok) {
      // Fail closed — the request is NEVER sent on an unsatisfied ready
      // handshake (READY_TIMEOUT) or a lost/absent target (NO_TARGET).
      return { ok: false, requestId, code: ready.code === 'NO_TARGET' ? 'NO_TARGET' : 'READY_TIMEOUT' }
    }
    // The target must not have been swapped while awaiting ready — dispose /
    // re-registration reset readiness, and a stale target must never receive
    // a request against a readiness it did not prove.
    if (targetWebContents !== wc || wc.isDestroyed()) {
      return { ok: false, requestId, code: 'NO_TARGET' }
    }
  }
  const full: CatalogRecoveryRequest = { requestId, ...request }
  return new Promise<CatalogRecoveryResponse>((resolve) => {
    const timer = setTimeout(() => {
      if (pendingRequests.delete(requestId)) {
        resolve({ ok: false, requestId, code: 'TIMEOUT' })
      }
    }, CATALOG_REQUEST_TIMEOUT_MS)
    pendingRequests.set(requestId, (result) => {
      clearTimeout(timer)
      resolve(result)
    })
    try {
      wc.send(IpcChannel.CherryImport_CatalogRequest, full)
    } catch (error) {
      pendingRequests.delete(requestId)
      clearTimeout(timer)
      resolve({ ok: false, requestId, code: 'NO_TARGET' })
      logger.warn('L2 catalog request send failed:', error as Error)
    }
  })
}

// ---------------------------------------------------------------------------
// High-level boundary operations (used by the executor / recovery / gate)
// ---------------------------------------------------------------------------

/** Map a renderer response to a bounded boundary result. */
function mapResponse(
  response: CatalogRecoveryResponse,
  expected?: { readonly count: number; readonly sha256: string }
): CatalogBoundaryResult {
  if (!response.ok) {
    // Transport-level failures keep their own bounded code (NO_TARGET /
    // TIMEOUT); renderer-returned failures map to RENDERER_FAILED with the
    // bounded renderer code as detail (LOCK-CAT-3/7).
    if (response.code === 'NO_TARGET' || response.code === 'TIMEOUT') {
      return { ok: false, code: response.code, detail: null }
    }
    return { ok: false, code: 'RENDERER_FAILED', detail: response.code }
  }
  const facts = response.facts
  if (!facts || !isFactsShape(facts)) {
    return { ok: false, code: 'PAYLOAD_INVALID', detail: 'FACTS_MISSING' }
  }
  if (expected) {
    if (facts.count !== expected.count || facts.sha256 !== expected.sha256) {
      return { ok: false, code: 'FACTS_MISMATCH', detail: 'COUNT_OR_DIGEST_DIVERGED' }
    }
  }
  return { ok: true, facts, rows: response.rows }
}

/** Resolve the canonical target files root for path rewriting (LOCK-CAT-4). */
function resolveTargetFilesPath(filesPath: string | undefined): string {
  if (typeof filesPath === 'string' && filesPath.length > 0) {
    return filesPath
  }
  return getFilesDir()
}

/**
 * Capture the live catalog snapshot (returns the wire payload for Main to
 * persist). LOCK-BRIDGE-2: capture/restore symmetry — the renderer validates
 * and path-normalizes every captured row against the CURRENT target files
 * root (exactly like restore), so a retained snapshot is always restorable.
 * The authoritative target root is carried on the wire (LOCK-CAT-4), same as
 * apply/restore.
 */
export async function captureLiveCatalogSnapshot(): Promise<
  CatalogBoundaryResult & { snapshot?: FilesCatalogSnapshotV1 }
> {
  const response = await sendCatalogRequest({
    kind: 'capture-snapshot',
    filesPath: resolveTargetFilesPath(undefined)
  })
  const mapped = mapResponse(response)
  if (!mapped.ok) {
    return mapped
  }
  const rows = mapped.rows
  if (!rows || rows.length !== mapped.facts.count) {
    return { ok: false, code: 'PAYLOAD_INVALID', detail: 'ROWS_MISSING' }
  }
  return {
    ok: true,
    facts: mapped.facts,
    rows,
    snapshot: {
      version: 1,
      capturedAt: new Date().toISOString(),
      rows,
      integrity: { count: mapped.facts.count, sha256: mapped.facts.sha256 }
    }
  }
}

/**
 * Apply the candidate catalog (single Dexie transaction replace-all). The
 * renderer validates every row and rewrites `path` to the current target
 * files root (LOCK-CAT-4); `filesPath` defaults to the canonical Files dir
 * when the caller does not pass one.
 */
export async function applyCandidateCatalog(
  rows: readonly FilesCatalogSnapshotRow[],
  expected: { readonly count: number; readonly sha256: string },
  filesPath?: string
): Promise<CatalogBoundaryResult> {
  const response = await sendCatalogRequest({
    kind: 'apply-candidate',
    catalogRows: rows,
    expected,
    filesPath: resolveTargetFilesPath(filesPath)
  })
  return mapResponse(response, expected)
}

/**
 * Restore the old catalog snapshot (single Dexie transaction replace-all).
 * Prior-target absolute paths are normalized to the current target files
 * root; source/foreign roots are rejected (LOCK-CAT-4).
 */
export async function restoreCatalogSnapshot(
  snapshot: FilesCatalogSnapshotV1,
  filesPath?: string
): Promise<CatalogBoundaryResult> {
  const response = await sendCatalogRequest({
    kind: 'restore-snapshot',
    snapshot,
    expected: snapshot.integrity,
    filesPath: resolveTargetFilesPath(filesPath)
  })
  return mapResponse(response, snapshot.integrity)
}

/** Query the current live catalog facts (count + digest). */
export async function queryCatalogFacts(): Promise<CatalogBoundaryResult> {
  const response = await sendCatalogRequest({ kind: 'query-facts' })
  return mapResponse(response)
}

/** A reusable CatalogBoundary result union for executor/recovery primitives. */
export type { CatalogApplyOutcome }
