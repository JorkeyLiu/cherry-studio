/**
 * Catalog recovery service — the minimal renderer/Dexie surface of the L2
 * files catalog handoff (Phase 2, LOCK-PROMO-5/7, LOCK-CAT-1/4/5).
 *
 * The live `files` catalog lives in this renderer's IndexedDB (Dexie), so
 * ONLY this renderer can snapshot it, apply the candidate catalog, restore
 * the old snapshot, or report current facts. Main drives every operation
 * through the typed catalog request/response boundary (see preload
 * `api.cherryImport.catalog` and main catalogApplyIpc.ts).
 *
 * Invariants:
 * - `apply-candidate` / `restore-snapshot` each run INSIDE ONE Dexie
 *   transaction (`rw`) that CLEARS the table and re-inserts the full row
 *   set atomically (LOCK-CAT-1: single replace-all, never a partial merge;
 *   a failed transaction leaves the table untouched).
 * - EVERY row is validated before the transaction (LOCK-CAT-5):
 *   `name === id + ext`, unique IDs / unique names / unique case-fold
 *   targets, valid size/count/timestamps/type/ext, and no path
 *   traversal/NUL. Any invalid row aborts the whole request with a bounded
 *   code — the table is never partially written.
 * - Paths are canonicalized to the current target files root (LOCK-CAT-4):
 *   candidate apply rewrites `path` to `<filesPath>/<id><ext>`; snapshot
 *   restore stays STRICT — prior-target absolute paths normalize to the
 *   current root, while relative, empty, URL, or basename-mismatched paths
 *   are REJECTED.
 * - Capture normalization (audit F3, LOCK-BRIDGE-2): `capture-snapshot`
 *   canonicalizes legacy live rows with absent/empty stored paths and
 *   relative paths whose basename equals the canonical physical name.
 *   URL/scheme paths, basename mismatches, and foreign absolute roots still
 *   fail the WHOLE capture closed, so every captured row remains restorable
 *   through the strict restore boundary.
 * - Ready handshake (LOCK-BRIDGE-1): after the request handler is installed
 *   the renderer signals Main through `api.cherryImport.catalog.ready()`;
 *   Main awaits that signal (bounded) before sending any catalog request, so
 *   the recovery window never races the handler mount (the previous 60s
 *   startup timeout race).
 * - Physical live Files existence is required before a row is created
 *   (LOCK-CAT-5). The probe runs through `window.api.file.exists`; in the
 *   recovery-only window the file IPC is not yet registered (startup runs
 *   before `registerIpc`), so an unavailable probe degrades to the Main-side
 *   disk parity attestation which runs in the same recovery flow.
 * - Every response carries the POST-operation facts (count + canonical
 *   SHA-256 over {@link filesCatalogHashInput}); Main compares them to the
 *   expected aggregate receipt before advancing the journal. The renderer
 *   also pre-checks the receipt BEFORE the transaction so a doomed apply is
 *   rejected without touching the table.
 * - Failures map to a bounded machine code — never raw messages/paths.
 *
 * The handler is registered once at renderer bootstrap (App mount). While
 * a catalog-pending apply/recovery is in flight the App renders the
 * recovery-only surface (LOCK-PROMO-7) and normal data flows stay blocked.
 */

import { loggerService } from '@logger'
import db from '@renderer/databases'
import store from '@renderer/store'
import type { FileMetadata } from '@renderer/types'
import type {
  CatalogRecoveryFacts,
  CatalogRecoveryRequest,
  CatalogRecoveryResponse,
  FilesCatalogSnapshotRow
} from '@shared/chatImport/types'
import { filesCatalogHashInput } from '@shared/chatImport/types'

const logger = loggerService.withContext('catalogRecoveryService')

/** Bounded renderer-side failure codes (never raw messages/paths). */
export type CatalogRecoveryErrorCode =
  | 'PAYLOAD_MISSING'
  | 'TARGET_PATH_UNKNOWN'
  | 'VALIDATION_FAILED'
  | 'EXPECTED_MISMATCH'
  | 'PHYSICAL_FILE_MISSING'
  | 'DEXIE_FAILED'

// ---------------------------------------------------------------------------
// Path safety (LOCK-CAT-4/5)
// ---------------------------------------------------------------------------

/**
 * True when a value is a single safe path component: non-empty, bounded
 * length, no separators, no NUL, and never `.`/`..` (no traversal).
 */
export function isSafePathComponent(value: string): boolean {
  if (value.length === 0 || value.length > 256) return false
  if (value.includes('/') || value.includes('\\') || value.includes('\x00')) return false
  return value !== '.' && value !== '..'
}

/**
 * Validate a full catalog row set before ANY Dexie mutation (LOCK-CAT-5).
 * Bounded failure code on the first violation — the caller aborts without
 * touching the table.
 */
export function validateCatalogRows(
  rows: readonly FilesCatalogSnapshotRow[]
): { ok: true } | { ok: false; code: string } {
  if (!Array.isArray(rows)) {
    return { ok: false, code: 'ROWS_NOT_ARRAY' }
  }
  const seenIds = new Set<string>()
  const seenNames = new Set<string>()
  const seenFoldedNames = new Set<string>()
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      return { ok: false, code: 'ROW_NOT_OBJECT' }
    }
    if (typeof row.id !== 'string' || !isSafePathComponent(row.id)) {
      return { ok: false, code: 'ID_UNSAFE' }
    }
    if (typeof row.ext !== 'string' || row.ext.length > 256) {
      return { ok: false, code: 'EXT_INVALID' }
    }
    if (row.ext !== '' && !isSafePathComponent(row.ext)) {
      return { ok: false, code: 'EXT_UNSAFE' }
    }
    if (typeof row.name !== 'string' || row.name.length === 0 || row.name.length > 512) {
      return { ok: false, code: 'NAME_INVALID' }
    }
    // LOCK-CAT-5: the canonical physical filename is exactly `id + ext`.
    if (row.name !== `${row.id}${row.ext}`) {
      return { ok: false, code: 'NAME_MISMATCH' }
    }
    if (seenIds.has(row.id)) {
      return { ok: false, code: 'DUP_ID' }
    }
    seenIds.add(row.id)
    if (seenNames.has(row.name)) {
      return { ok: false, code: 'DUP_NAME' }
    }
    seenNames.add(row.name)
    // LOCK-CAT-5: case-folded targets must be unique (case-insensitive FS).
    const folded = row.name.toLocaleLowerCase()
    if (seenFoldedNames.has(folded)) {
      return { ok: false, code: 'DUP_CASE_FOLD_NAME' }
    }
    seenFoldedNames.add(folded)
    if (typeof row.size !== 'number' || !Number.isSafeInteger(row.size) || row.size < 0) {
      return { ok: false, code: 'SIZE_INVALID' }
    }
    if (typeof row.count !== 'number' || !Number.isSafeInteger(row.count) || row.count < 0) {
      return { ok: false, code: 'COUNT_INVALID' }
    }
    if (row.type !== null && typeof row.type !== 'string') {
      return { ok: false, code: 'TYPE_INVALID' }
    }
    if (row.created_at !== null && (typeof row.created_at !== 'string' || Number.isNaN(Date.parse(row.created_at)))) {
      return { ok: false, code: 'TIMESTAMP_INVALID' }
    }
    if (typeof row.origin_name !== 'string' || row.origin_name.length > 4096) {
      return { ok: false, code: 'ORIGIN_NAME_INVALID' }
    }
    if (typeof row.path !== 'string' || row.path.length > 4096 || row.path.includes('\x00')) {
      return { ok: false, code: 'PATH_INVALID' }
    }
  }
  return { ok: true }
}

/** Basename of a stored path (handles '/' and '\\' separators). */
function basenameOf(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, '/')
  const slash = normalized.lastIndexOf('/')
  return slash === -1 ? normalized : normalized.slice(slash + 1)
}

/** Path normalization mode: strict (restore) vs. legacy-tolerant (capture). */
export type CatalogPathNormalizationMode = 'capture' | 'restore'

/**
 * Normalize snapshot rows' stored `path` against the current target files
 * root `<filesPath>/<id><ext>` (LOCK-CAT-4, audit F3).
 *
 * - `restore` (strict — retained snapshots): every row must carry an ABSOLUTE
 *   filesystem path whose basename equals the canonical physical name; a
 *   prior-target (or current) absolute path is rewritten to the current root.
 *   Relative paths, `file://` URLs, empty paths, and basename mismatches are
 *   source/foreign roots and REJECT the whole request (bounded code).
 * - `capture` (live Dexie — legacy rows): in addition to the restore rules, a
 *   MISSING/EMPTY stored path canonicalizes (legacy rows without a stored
 *   path) and a RELATIVE path canonicalizes ONLY when its basename equals the
 *   canonical physical name. URL/scheme paths, basename mismatches, and
 *   foreign absolute roots are still REJECTED — the retained snapshot must
 *   always be restorable through the strict restore boundary.
 */
function normalizeRows(
  rows: readonly FilesCatalogSnapshotRow[],
  filesPath: string,
  mode: CatalogPathNormalizationMode
): { ok: true; rows: FilesCatalogSnapshotRow[] } | { ok: false; code: string } {
  const normalized: FilesCatalogSnapshotRow[] = []
  for (const row of rows) {
    const pathValue = row.path
    const canonical = `${filesPath}/${row.id}${row.ext}`
    // URL/scheme and NUL paths are always source/foreign roots (LOCK-CAT-4).
    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(pathValue)
    if (hasScheme || pathValue.includes('\x00')) {
      return { ok: false, code: 'FOREIGN_ROOT_REJECTED' }
    }
    if (pathValue === '') {
      // Capture: a missing/empty stored path is a LEGACY row — canonicalize
      // to the current target. Restore: an empty path is a source/foreign
      // root and fails closed.
      if (mode === 'capture') {
        normalized.push({ ...row, path: canonical })
        continue
      }
      return { ok: false, code: 'FOREIGN_ROOT_REJECTED' }
    }
    if (!pathValue.startsWith('/')) {
      // Capture: a relative path canonicalizes ONLY when its basename equals
      // the canonical physical name (unambiguous). Restore: any relative path
      // is a source/foreign root.
      if (mode === 'capture' && basenameOf(pathValue) === row.name) {
        normalized.push({ ...row, path: canonical })
        continue
      }
      return { ok: false, code: 'FOREIGN_ROOT_REJECTED' }
    }
    // Absolute path — the basename must be exactly the canonical physical
    // name; anything else is a foreign root. Prior-target (or current)
    // absolute paths normalize to the current root: the physical file name
    // is the authority, the app recomputes path from id/ext at read time.
    if (basenameOf(pathValue) !== row.name) {
      return { ok: false, code: 'FOREIGN_ROOT_REJECTED' }
    }
    normalized.push({ ...row, path: canonical })
  }
  return { ok: true, rows: normalized }
}

/**
 * Strict restore normalization (LOCK-CAT-4) — retained snapshots only.
 * See {@link normalizeRows}.
 */
export function normalizeRestoreRows(
  rows: readonly FilesCatalogSnapshotRow[],
  filesPath: string
): { ok: true; rows: FilesCatalogSnapshotRow[] } | { ok: false; code: string } {
  return normalizeRows(rows, filesPath, 'restore')
}

/**
 * Capture normalization (audit F3, LOCK-BRIDGE-2) — live Dexie legacy rows.
 * See {@link normalizeRows}.
 */
export function normalizeCaptureRows(
  rows: readonly FilesCatalogSnapshotRow[],
  filesPath: string
): { ok: true; rows: FilesCatalogSnapshotRow[] } | { ok: false; code: string } {
  return normalizeRows(rows, filesPath, 'capture')
}

// ---------------------------------------------------------------------------
// SHA-256 facts (Web Crypto — renderer-safe)
// ---------------------------------------------------------------------------

/** SHA-256 hex over an input string (Web Crypto — renderer-safe). */
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * Normalize a live Dexie `files` row to the canonical wire shape.
 *
 * LOCK-BROWSE-1/4: `FileMetadata.type`/`created_at` are nullable at the
 * persisted boundary, so null/unknown source metadata passes through
 * untouched — nothing is fabricated here.
 */
function rowToWire(row: FileMetadata): FilesCatalogSnapshotRow {
  return {
    id: row.id,
    name: row.name,
    origin_name: row.origin_name,
    path: row.path,
    size: row.size,
    ext: row.ext,
    type: row.type,
    created_at: row.created_at,
    count: row.count
  }
}

/** Compute aggregate facts over canonical wire rows. */
export async function factsFromRows(rows: readonly FilesCatalogSnapshotRow[]): Promise<CatalogRecoveryFacts> {
  return {
    count: rows.length,
    sha256: await sha256Hex(filesCatalogHashInput(rows))
  }
}

/** Read the CURRENT live files table as canonical wire rows. */
export async function readLiveCatalogRows(): Promise<FilesCatalogSnapshotRow[]> {
  const all = await db.files.toArray()
  return all.map(rowToWire)
}

/** Compute current live catalog facts. */
export async function currentCatalogFacts(): Promise<CatalogRecoveryFacts> {
  return factsFromRows(await readLiveCatalogRows())
}

// ---------------------------------------------------------------------------
// Target files root (LOCK-CAT-4)
// ---------------------------------------------------------------------------

/**
 * Resolve the current target files root: the value Main sends on the wire
 * (authoritative — the recovery-only window has no `getAppInfo` IPC), falling
 * back to the runtime store value populated by `useAppInit` in the normal
 * window. Empty/absent both → bounded `TARGET_PATH_UNKNOWN`.
 */
export async function resolveTargetFilesPath(requestFilesPath: string | undefined): Promise<string | null> {
  if (typeof requestFilesPath === 'string' && requestFilesPath.length > 0) {
    return requestFilesPath
  }
  const fromStore = store.getState().runtime.filesPath
  if (typeof fromStore === 'string' && fromStore.length > 0) {
    return fromStore
  }
  return null
}

// ---------------------------------------------------------------------------
// Physical existence probe (LOCK-CAT-5)
// ---------------------------------------------------------------------------

/**
 * Verify every row's physical payload exists in the live Files directory
 * before the catalog transaction commits. `window.api.file.exists` is the
 * probe; when the IPC is unavailable (recovery-only window runs before
 * `registerIpc`), the probe degrades to the Main-side disk parity attestation
 * which is executed in the same recovery flow. A row whose file is reported
 * missing fails the WHOLE request (all-or-nothing, LOCK-CAT-1).
 */
export async function verifyPhysicalFilesExist(
  rows: readonly FilesCatalogSnapshotRow[]
): Promise<{ ok: true } | { ok: false; code: string }> {
  const existsProbe = (window as { api?: { file?: { exists?: (name: string) => Promise<boolean> } } }).api?.file?.exists
  if (typeof existsProbe !== 'function') {
    logger.debug('Catalog physical existence probe unavailable — Main attests Files parity (LOCK-CAT-5)')
    return { ok: true }
  }
  for (const row of rows) {
    let present: boolean
    try {
      present = await existsProbe(`${row.id}${row.ext}`)
    } catch {
      // Unavailable channel (recovery window pre-registerIpc) — same degrade.
      logger.debug('Catalog physical existence probe unavailable — Main attests Files parity (LOCK-CAT-5)')
      return { ok: true }
    }
    if (!present) {
      return { ok: false, code: 'PHYSICAL_FILE_MISSING' }
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Single-transaction replace-all (LOCK-CAT-1)
// ---------------------------------------------------------------------------

/**
 * Single Dexie transaction replace-all (LOCK-CAT-1). The transaction clears
 * the table and bulk-adds the full row set atomically; any failure rolls the
 * table back to its prior state.
 *
 * LOCK-BROWSE-4: `FilesCatalogSnapshotRow` is directly assignable to the
 * persisted `FileMetadata` boundary (type/created_at are nullable there), so
 * the rows are bulk-added WITHOUT an unsafe double cast; the spread only
 * materializes a mutable array for Dexie.
 */
export async function replaceAllCatalogRows(rows: readonly FilesCatalogSnapshotRow[]): Promise<void> {
  await db.transaction('rw', db.files, async () => {
    await db.files.clear()
    if (rows.length > 0) {
      await db.files.bulkAdd([...rows])
    }
  })
}

// ---------------------------------------------------------------------------
// Request execution
// ---------------------------------------------------------------------------

/** Execute one catalog recovery request (bounded, never throws). */
async function executeRequest(request: CatalogRecoveryRequest): Promise<CatalogRecoveryResponse> {
  const requestId = request.requestId
  try {
    switch (request.kind) {
      case 'capture-snapshot': {
        const rows = await readLiveCatalogRows()
        // LOCK-BRIDGE-2: capture/restore symmetry — every row that leaves the
        // capture boundary must be RESTORABLE through the restore boundary.
        // Validate the full canonical row contract first, then normalize the
        // path in CAPTURE mode (audit F3): legacy rows with absent/empty
        // stored paths and relative paths whose basename equals the canonical
        // physical name canonicalize to `<filesPath>/<id><ext>`; URL/scheme
        // paths, basename mismatches, and foreign absolute roots fail the
        // WHOLE capture closed — they must never persist into the retained
        // snapshot. The target root is required because the normalize step
        // rewrites paths against it.
        const validation = validateCatalogRows(rows)
        if (!validation.ok) {
          return { ok: false, requestId, code: 'VALIDATION_FAILED' }
        }
        const target = await resolveTargetFilesPath(request.filesPath)
        if (target === null) {
          return { ok: false, requestId, code: 'TARGET_PATH_UNKNOWN' }
        }
        const normalized = normalizeCaptureRows(rows, target)
        if (!normalized.ok) {
          return { ok: false, requestId, code: 'VALIDATION_FAILED' }
        }
        const facts = await factsFromRows(normalized.rows)
        return { ok: true, requestId, rows: normalized.rows, facts }
      }
      case 'apply-candidate': {
        if (!request.catalogRows) {
          return { ok: false, requestId, code: 'PAYLOAD_MISSING' }
        }
        const target = await resolveTargetFilesPath(request.filesPath)
        if (target === null) {
          return { ok: false, requestId, code: 'TARGET_PATH_UNKNOWN' }
        }
        const validation = validateCatalogRows(request.catalogRows)
        if (!validation.ok) {
          return { ok: false, requestId, code: 'VALIDATION_FAILED' }
        }
        // LOCK-CAT-4: candidate apply always rewrites path to the current
        // target root; the incoming candidate-relative path is discarded.
        const canonicalRows = request.catalogRows.map((row) => ({
          ...row,
          path: `${target}/${row.id}${row.ext}`
        }))
        const receipt = await factsFromRows(canonicalRows)
        if (
          request.expected &&
          (receipt.count !== request.expected.count || receipt.sha256 !== request.expected.sha256)
        ) {
          return { ok: false, requestId, code: 'EXPECTED_MISMATCH' }
        }
        const physical = await verifyPhysicalFilesExist(canonicalRows)
        if (!physical.ok) {
          return { ok: false, requestId, code: physical.code }
        }
        await replaceAllCatalogRows(canonicalRows)
        const facts = await currentCatalogFacts()
        return { ok: true, requestId, facts }
      }
      case 'restore-snapshot': {
        if (!request.snapshot || !Array.isArray(request.snapshot.rows)) {
          return { ok: false, requestId, code: 'PAYLOAD_MISSING' }
        }
        const target = await resolveTargetFilesPath(request.filesPath)
        if (target === null) {
          return { ok: false, requestId, code: 'TARGET_PATH_UNKNOWN' }
        }
        const validation = validateCatalogRows(request.snapshot.rows)
        if (!validation.ok) {
          return { ok: false, requestId, code: 'VALIDATION_FAILED' }
        }
        const normalized = normalizeRestoreRows(request.snapshot.rows, target)
        if (!normalized.ok) {
          return { ok: false, requestId, code: 'VALIDATION_FAILED' }
        }
        const receipt = await factsFromRows(normalized.rows)
        const expectedReceipt = request.snapshot.integrity
        if (expectedReceipt && (receipt.count !== expectedReceipt.count || receipt.sha256 !== expectedReceipt.sha256)) {
          return { ok: false, requestId, code: 'EXPECTED_MISMATCH' }
        }
        const physical = await verifyPhysicalFilesExist(normalized.rows)
        if (!physical.ok) {
          return { ok: false, requestId, code: physical.code }
        }
        await replaceAllCatalogRows(normalized.rows)
        const facts = await currentCatalogFacts()
        return { ok: true, requestId, facts }
      }
      case 'query-facts': {
        const facts = await currentCatalogFacts()
        return { ok: true, requestId, facts }
      }
    }
  } catch (error) {
    logger.warn('Catalog recovery request failed (bounded code returned)', error as Error)
    return { ok: false, requestId, code: 'DEXIE_FAILED' }
  }
}

let registered = false

/**
 * Register the catalog request handler for the current renderer. Idempotent:
 * only one subscription per window. Returns an unsubscribe function.
 */
export function registerCatalogRecoveryHandler(): () => void {
  if (registered) {
    return () => {
      // already registered — the first registration owns the subscription
    }
  }
  registered = true
  const unsubscribe = window.api.cherryImport.catalog.onRequest((request) => {
    // Fire-and-track: never block the event loop; every outcome is a
    // bounded response back to Main.
    void (async () => {
      const response = await executeRequest(request)
      try {
        await window.api.cherryImport.catalog.respond(request.requestId, response)
      } catch (error) {
        logger.warn('Catalog recovery response delivery failed (Main retries on restart)', error as Error)
      }
    })()
  })
  // LOCK-BRIDGE-1: the catalog handler is installed — signal Main that this
  // renderer is ready for catalog requests. Main awaits this (bounded) before
  // sending anything, so the recovery window never races the mount. In the
  // ordinary window Main rejects the signal (no registered target) as a
  // bounded no-op.
  const ready = (window.api.cherryImport.catalog as { ready?: () => Promise<{ accepted: boolean }> }).ready
  if (typeof ready === 'function') {
    ready().catch(() => {
      logger.debug('Catalog ready signal delivery failed (Main falls back to its bounded ready timeout)')
    })
  }
  return () => {
    registered = false
    unsubscribe()
  }
}

/**
 * True when the current window was launched in the recovery-only surface
 * mode (LOCK-PROMO-7): the main window URL carries the recovery query
 * parameter, so normal application data flows must stay blocked until Main
 * completes the catalog handoff and reloads the window.
 */
export function isCatalogRecoverySurface(): boolean {
  try {
    const params = new URLSearchParams(window.location.search)
    return params.get('cherryImportRecovery') === '1'
  } catch {
    return false
  }
}
