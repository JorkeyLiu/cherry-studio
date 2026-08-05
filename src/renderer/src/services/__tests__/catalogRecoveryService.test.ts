/**
 * catalogRecoveryService — renderer/Dexie catalog boundary tests
 * (LOCK-CAT-1/4/5/7).
 *
 * Covers:
 * - Single-transaction all-or-nothing replace-all: a throwing bulk-add rolls
 *   the table back to its prior state; no partial catalog ever lands.
 * - Row validation before ANY mutation (LOCK-CAT-5): name === id+ext, unique
 *   ids/names/case-fold targets, valid size/count/timestamps/type/ext, no
 *   path traversal/NUL. Any invalid row aborts the whole request.
 * - Path canonicalization (LOCK-CAT-4): candidate apply rewrites `path` to
 *   `<filesPath>/<id><ext>`; snapshot restore stays strict — prior-target
 *   absolute paths normalize to the current root, while relative/empty/URL/
 *   basename-mismatched paths REJECT.
 * - Capture normalization (audit F3, LOCK-BRIDGE-2): capture-snapshot
 *   canonicalizes legacy live rows with missing/empty stored paths and
 *   relative paths whose basename equals the canonical name; URL/scheme,
 *   basename mismatch, and foreign absolute roots still REJECT.
 * - Pre-transaction receipt check (EXPECTED_MISMATCH) — a doomed apply is
 *   rejected without touching the table.
 * - Physical live Files existence probe (LOCK-CAT-5): missing physical file
 *   fails the request; an unavailable probe (recovery window pre-IPC)
 *   degrades to the Main-side attestation.
 * - Bounded failure codes — never raw messages/paths (LOCK-CAT-7).
 */

import {
  type CatalogRecoveryRequest,
  filesCatalogHashInput,
  type FilesCatalogSnapshotRow
} from '@shared/chatImport/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { fileStore, mockStoreGetState, mockExists, db } = vi.hoisted(() => {
  const fileStore = new Map<string, FilesCatalogSnapshotRow>()

  // Dexie double with real transaction rollback semantics (LOCK-CAT-1).
  // `transaction` lives on the Dexie instance (top level), mirroring the
  // real `db.transaction('rw', db.files, fn)` call in the service.
  const db = {
    files: {
      get: vi.fn(async (id: string) => fileStore.get(id)),
      toArray: vi.fn(async () => Array.from(fileStore.values())),
      clear: vi.fn(async () => {
        fileStore.clear()
      }),
      bulkAdd: vi.fn(async (rows: FilesCatalogSnapshotRow[]) => {
        for (const row of rows) {
          if (fileStore.has(row.id)) {
            throw new Error(`ConstraintError: key already exists ${row.id}`)
          }
          fileStore.set(row.id, row)
        }
      })
    },
    transaction: vi.fn(async (_mode: string, _table: unknown, fn: () => Promise<void>) => {
      const snapshot = new Map(fileStore)
      try {
        await fn()
      } catch (error) {
        fileStore.clear()
        for (const [k, v] of snapshot) fileStore.set(k, v)
        throw error
      }
    })
  }

  return {
    fileStore,
    mockStoreGetState: vi.fn(() => ({ runtime: { filesPath: '/mock/files' } })),
    mockExists: vi.fn(async () => true),
    db
  }
})

vi.mock('@renderer/databases', () => ({ default: db, db }))

vi.mock('@renderer/store', () => ({
  default: { getState: mockStoreGetState }
}))

import {
  isCatalogRecoverySurface,
  isSafePathComponent,
  normalizeCaptureRows,
  normalizeRestoreRows,
  registerCatalogRecoveryHandler,
  validateCatalogRows
} from '@renderer/services/catalogRecoveryService'

function makeRow(overrides: Partial<FilesCatalogSnapshotRow> = {}): FilesCatalogSnapshotRow {
  return {
    id: 'aaa111',
    name: 'aaa111.txt',
    origin_name: 'notes.txt',
    path: 'Files/aaa111.txt',
    size: 100,
    ext: '.txt',
    type: 'text',
    created_at: '2024-01-01T00:00:00.000Z',
    count: 2,
    ...overrides
  }
}

async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Drive one request through the registered handler and capture the response. */
async function executeRequest(request: CatalogRecoveryRequest): Promise<unknown> {
  const handlers: { request?: (req: CatalogRecoveryRequest) => void } = {}
  const respond = vi.fn(async (_requestId: string, _response: unknown) => {
    void _requestId
    void _response
    return { accepted: true }
  })
  ;(window as unknown as { api: unknown }).api = {
    cherryImport: {
      catalog: {
        onRequest: vi.fn((cb: (req: CatalogRecoveryRequest) => void) => {
          handlers.request = cb
          return () => undefined
        }),
        respond,
        ready: vi.fn(async () => ({ accepted: true }))
      }
    },
    file: { exists: mockExists }
  }
  const unsubscribe = registerCatalogRecoveryHandler()
  try {
    if (!handlers.request) throw new Error('handler not registered')
    handlers.request(request)
    await vi.waitFor(() => expect(respond).toHaveBeenCalled())
    return respond.mock.calls[0][1]
  } finally {
    unsubscribe()
  }
}

function applyRequest(overrides: Partial<CatalogRecoveryRequest> = {}, rows = [makeRow()]): CatalogRecoveryRequest {
  return {
    requestId: 'req-1',
    kind: 'apply-candidate',
    catalogRows: rows,
    expected: undefined,
    filesPath: '/mock/files',
    ...overrides
  } as CatalogRecoveryRequest
}

describe('validateCatalogRows (LOCK-CAT-5)', () => {
  it('accepts a fully valid row set', () => {
    expect(validateCatalogRows([makeRow(), makeRow({ id: 'bbb222', name: 'bbb222.txt' })])).toEqual({ ok: true })
  })

  it('rejects name !== id+ext', () => {
    expect(validateCatalogRows([makeRow({ name: 'other.txt' })])).toMatchObject({ ok: false, code: 'NAME_MISMATCH' })
  })

  it('rejects duplicate ids', () => {
    expect(validateCatalogRows([makeRow(), makeRow({ id: 'aaa111', name: 'aaa111.txt' })])).toMatchObject({
      ok: false,
      code: 'DUP_ID'
    })
  })

  it('rejects duplicate names', () => {
    expect(
      validateCatalogRows([makeRow({ id: 'aaa', name: 'aaa', ext: '' }), makeRow({ id: 'aa', name: 'aaa', ext: 'a' })])
    ).toMatchObject({ ok: false, code: 'DUP_NAME' })
  })

  it('rejects case-fold duplicate targets (case-insensitive filesystem)', () => {
    expect(
      validateCatalogRows([makeRow({ id: 'aaa', name: 'aaa', ext: '' }), makeRow({ id: 'AAA', name: 'AAA', ext: '' })])
    ).toMatchObject({ ok: false, code: 'DUP_CASE_FOLD_NAME' })
  })

  it('rejects ids/exts with path traversal or NUL', () => {
    expect(validateCatalogRows([makeRow({ id: '../escape', name: '../escape.txt' })])).toMatchObject({
      ok: false,
      code: 'ID_UNSAFE'
    })
    expect(validateCatalogRows([makeRow({ id: 'a/b', name: 'a/b.txt' })])).toMatchObject({
      ok: false,
      code: 'ID_UNSAFE'
    })
    expect(validateCatalogRows([makeRow({ id: 'a\x00b', name: 'a\x00b.txt' })])).toMatchObject({
      ok: false,
      code: 'ID_UNSAFE'
    })
    expect(validateCatalogRows([makeRow({ ext: '.txt/..' })])).toMatchObject({ ok: false, code: 'EXT_UNSAFE' })
  })

  it('rejects negative / non-integer size and count', () => {
    expect(validateCatalogRows([makeRow({ size: -1 })])).toMatchObject({ ok: false, code: 'SIZE_INVALID' })
    expect(validateCatalogRows([makeRow({ size: 1.5 })])).toMatchObject({ ok: false, code: 'SIZE_INVALID' })
    expect(validateCatalogRows([makeRow({ count: -1 })])).toMatchObject({ ok: false, code: 'COUNT_INVALID' })
  })

  it('rejects invalid type and timestamp values', () => {
    expect(validateCatalogRows([makeRow({ type: 'image' } as never)])).toEqual({ ok: true })
    expect(validateCatalogRows([makeRow({ type: 42 as never })])).toMatchObject({ ok: false, code: 'TYPE_INVALID' })
    expect(validateCatalogRows([makeRow({ created_at: 'not-a-date' })])).toMatchObject({
      ok: false,
      code: 'TIMESTAMP_INVALID'
    })
  })

  it('rejects path values with NUL or excessive length', () => {
    expect(validateCatalogRows([makeRow({ path: '/x\x00y' })])).toMatchObject({ ok: false, code: 'PATH_INVALID' })
    expect(validateCatalogRows([makeRow({ path: 'x'.repeat(5000) })])).toMatchObject({
      ok: false,
      code: 'PATH_INVALID'
    })
  })
})

describe('isSafePathComponent (LOCK-CAT-5)', () => {
  it('rejects separators, NUL, dot components, and empty strings', () => {
    expect(isSafePathComponent('abc')).toBe(true)
    expect(isSafePathComponent('.')).toBe(false)
    expect(isSafePathComponent('..')).toBe(false)
    expect(isSafePathComponent('a/b')).toBe(false)
    expect(isSafePathComponent('a\\b')).toBe(false)
    expect(isSafePathComponent('a\x00b')).toBe(false)
    expect(isSafePathComponent('')).toBe(false)
  })
})

describe('normalizeRestoreRows (LOCK-CAT-4)', () => {
  it('normalizes a prior-target absolute path to the current root', () => {
    const row = makeRow({ path: '/old/profile/userData/Data/Files/aaa111.txt' })
    const result = normalizeRestoreRows([row], '/mock/files')
    expect(result).toMatchObject({ ok: true })
    if (result.ok) {
      expect(result.rows[0].path).toBe('/mock/files/aaa111.txt')
    }
  })

  it('keeps the canonical current-target path unchanged', () => {
    const row = makeRow({ path: '/mock/files/aaa111.txt' })
    const result = normalizeRestoreRows([row], '/mock/files')
    if (result.ok) {
      expect(result.rows[0].path).toBe('/mock/files/aaa111.txt')
    }
  })

  it('rejects candidate-relative (source/foreign) roots', () => {
    const result = normalizeRestoreRows([makeRow({ path: 'Files/aaa111.txt' })], '/mock/files')
    expect(result).toMatchObject({ ok: false, code: 'FOREIGN_ROOT_REJECTED' })
  })

  it('rejects empty, URL, and basename-mismatched paths', () => {
    expect(normalizeRestoreRows([makeRow({ path: '' })], '/mock/files')).toMatchObject({
      ok: false,
      code: 'FOREIGN_ROOT_REJECTED'
    })
    expect(normalizeRestoreRows([makeRow({ path: 'file:///x/aaa111.txt' })], '/mock/files')).toMatchObject({
      ok: false,
      code: 'FOREIGN_ROOT_REJECTED'
    })
    expect(normalizeRestoreRows([makeRow({ path: '/tmp/some-other.txt' })], '/mock/files')).toMatchObject({
      ok: false,
      code: 'FOREIGN_ROOT_REJECTED'
    })
  })
})

describe('normalizeCaptureRows (audit F3, LOCK-BRIDGE-2)', () => {
  it('canonicalizes a missing/empty stored path (legacy row)', () => {
    const result = normalizeCaptureRows([makeRow({ path: '' })], '/mock/files')
    expect(result).toMatchObject({ ok: true })
    if (result.ok) {
      expect(result.rows[0].path).toBe('/mock/files/aaa111.txt')
    }
  })

  it('canonicalizes a relative path whose basename equals the canonical name', () => {
    const result = normalizeCaptureRows([makeRow({ path: 'Files/aaa111.txt' })], '/mock/files')
    expect(result).toMatchObject({ ok: true })
    if (result.ok) {
      expect(result.rows[0].path).toBe('/mock/files/aaa111.txt')
    }
  })

  it('rejects a relative path whose basename does not equal the canonical name (ambiguous)', () => {
    const result = normalizeCaptureRows([makeRow({ path: 'Files/some-other.txt' })], '/mock/files')
    expect(result).toMatchObject({ ok: false, code: 'FOREIGN_ROOT_REJECTED' })
  })

  it('rejects a foreign absolute root (basename mismatch)', () => {
    const result = normalizeCaptureRows([makeRow({ path: '/tmp/some-other.txt' })], '/mock/files')
    expect(result).toMatchObject({ ok: false, code: 'FOREIGN_ROOT_REJECTED' })
  })

  it('rejects URL/scheme paths', () => {
    expect(normalizeCaptureRows([makeRow({ path: 'file:///x/aaa111.txt' })], '/mock/files')).toMatchObject({
      ok: false,
      code: 'FOREIGN_ROOT_REJECTED'
    })
  })

  it('normalizes a prior-target absolute path to the current root', () => {
    const result = normalizeCaptureRows(
      [makeRow({ path: '/old/profile/userData/Data/Files/aaa111.txt' })],
      '/mock/files'
    )
    expect(result).toMatchObject({ ok: true })
    if (result.ok) {
      expect(result.rows[0].path).toBe('/mock/files/aaa111.txt')
    }
  })

  it('keeps the canonical current-target path unchanged', () => {
    const result = normalizeCaptureRows([makeRow({ path: '/mock/files/aaa111.txt' })], '/mock/files')
    expect(result).toMatchObject({ ok: true })
    if (result.ok) {
      expect(result.rows[0].path).toBe('/mock/files/aaa111.txt')
    }
  })

  it('restore stays strict: empty and matching-basename relative paths still REJECT', () => {
    // The strict restore boundary is intentionally unchanged by audit F3 —
    // only capture accepts these legacy shapes.
    expect(normalizeRestoreRows([makeRow({ path: '' })], '/mock/files')).toMatchObject({
      ok: false,
      code: 'FOREIGN_ROOT_REJECTED'
    })
    expect(normalizeRestoreRows([makeRow({ path: 'Files/aaa111.txt' })], '/mock/files')).toMatchObject({
      ok: false,
      code: 'FOREIGN_ROOT_REJECTED'
    })
  })
})

describe('catalog request execution', () => {
  beforeEach(() => {
    fileStore.clear()
    vi.clearAllMocks()
    mockStoreGetState.mockReturnValue({ runtime: { filesPath: '/mock/files' } })
    mockExists.mockResolvedValue(true)
  })

  it('apply-candidate rewrites paths to the current target root and returns post-facts', async () => {
    const rows = [makeRow({ path: 'Files/aaa111.txt' })]
    const response = await executeRequest(
      applyRequest({ expected: { count: 1, sha256: await sha256(filesCatalogHashInput(rows)) } }, rows)
    )
    expect(response).toMatchObject({ ok: true })
    const stored = fileStore.get('aaa111')
    expect(stored).toMatchObject({ id: 'aaa111', path: '/mock/files/aaa111.txt' })
    const facts = (response as { facts: { count: number; sha256: string } }).facts
    expect(facts.count).toBe(1)
    expect(facts.sha256).toBe(await sha256(filesCatalogHashInput([{ ...rows[0], path: '/mock/files/aaa111.txt' }])))
  })

  it('apply-candidate fails closed on an invalid row — the table stays untouched', async () => {
    const response = await executeRequest(applyRequest({}, [makeRow({ id: '../escape', name: '../escape.txt' })]))
    expect(response).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(fileStore.size).toBe(0)
  })

  it('apply-candidate rejects a receipt mismatch BEFORE the transaction', async () => {
    const response = await executeRequest(applyRequest({ expected: { count: 99, sha256: '0'.repeat(64) } }))
    expect(response).toMatchObject({ ok: false, code: 'EXPECTED_MISMATCH' })
    expect(fileStore.size).toBe(0)
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('apply-candidate fails with PHYSICAL_FILE_MISSING and leaves the table untouched', async () => {
    mockExists.mockResolvedValue(false)
    const response = await executeRequest(applyRequest())
    expect(response).toMatchObject({ ok: false, code: 'PHYSICAL_FILE_MISSING' })
    expect(fileStore.size).toBe(0)
  })

  it('apply-candidate degrades gracefully when the physical probe IPC is unavailable (recovery window pre-registerIpc)', async () => {
    mockExists.mockRejectedValue(new Error('No handler registered for file-exists'))
    const rows = [makeRow()]
    const response = await executeRequest(
      applyRequest({ expected: { count: 1, sha256: await sha256(filesCatalogHashInput(rows)) } }, rows)
    )
    expect(response).toMatchObject({ ok: true })
    expect(fileStore.size).toBe(1)
  })

  it('restore-snapshot normalizes prior-target paths and commits atomically', async () => {
    const row = makeRow({ path: '/old/profile/userData/Data/Files/aaa111.txt' })
    const rows = [{ ...row, path: '/mock/files/aaa111.txt' }]
    const response = await executeRequest({
      requestId: 'req-r',
      kind: 'restore-snapshot',
      filesPath: '/mock/files',
      snapshot: {
        version: 1,
        capturedAt: '2024-01-01T00:00:00.000Z',
        rows: [row],
        integrity: { count: 1, sha256: await sha256(filesCatalogHashInput(rows)) }
      }
    })
    expect(response).toMatchObject({ ok: true })
    expect(fileStore.get('aaa111')?.path).toBe('/mock/files/aaa111.txt')
  })

  it('restore-snapshot rejects a foreign-root row (whole request fails, table untouched)', async () => {
    const response = await executeRequest({
      requestId: 'req-r2',
      kind: 'restore-snapshot',
      filesPath: '/mock/files',
      snapshot: {
        version: 1,
        capturedAt: '2024-01-01T00:00:00.000Z',
        rows: [makeRow({ path: 'Files/aaa111.txt' })],
        integrity: { count: 1, sha256: '0'.repeat(64) }
      }
    })
    expect(response).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(fileStore.size).toBe(0)
  })

  it('restore-snapshot rejects an integrity mismatch', async () => {
    const response = await executeRequest({
      requestId: 'req-r3',
      kind: 'restore-snapshot',
      filesPath: '/mock/files',
      snapshot: {
        version: 1,
        capturedAt: '2024-01-01T00:00:00.000Z',
        rows: [makeRow({ path: '/mock/files/aaa111.txt' })],
        integrity: { count: 1, sha256: '0'.repeat(64) }
      }
    })
    expect(response).toMatchObject({ ok: false, code: 'EXPECTED_MISMATCH' })
    expect(fileStore.size).toBe(0)
  })

  it('rolls back the whole table when the transaction throws mid-write (LOCK-CAT-1)', async () => {
    // Pre-existing live rows must survive a failed replace-all.
    fileStore.set('keep1', makeRow({ id: 'keep1', name: 'keep1.txt' }))
    // Force bulkAdd to throw on the second row.
    db.files.bulkAdd.mockImplementationOnce(async (rows: FilesCatalogSnapshotRow[]) => {
      for (const row of rows) {
        fileStore.set(row.id, row)
        throw new Error('transaction aborted mid-write')
      }
    })
    const response = await executeRequest(applyRequest({}, [makeRow(), makeRow({ id: 'bbb222', name: 'bbb222.txt' })]))
    expect(response).toMatchObject({ ok: false, code: 'DEXIE_FAILED' })
    // The prior live catalog is fully intact (no partial apply).
    expect(fileStore.size).toBe(1)
    expect(fileStore.get('keep1')).toBeDefined()
    expect(fileStore.get('aaa111')).toBeUndefined()
    db.files.bulkAdd.mockClear()
  })

  it('query-facts reports count + digest of the current table', async () => {
    fileStore.set('aaa111', makeRow())
    const response = await executeRequest({ requestId: 'req-q', kind: 'query-facts' })
    const facts = (response as { facts: { count: number; sha256: string } }).facts
    expect(facts.count).toBe(1)
    expect(facts.sha256).toBe(await sha256(filesCatalogHashInput([makeRow()])))
  })

  it('capture-snapshot returns canonical rows + facts', async () => {
    fileStore.set('aaa111', makeRow({ path: '/mock/files/aaa111.txt' }))
    const response = await executeRequest({ requestId: 'req-c', kind: 'capture-snapshot' })
    expect(response).toMatchObject({
      ok: true,
      rows: [expect.objectContaining({ id: 'aaa111', path: '/mock/files/aaa111.txt' })]
    })
    expect((response as { facts: { count: number } }).facts.count).toBe(1)
  })

  it('capture-snapshot normalizes a prior-target absolute path to the current root (LOCK-BRIDGE-2)', async () => {
    fileStore.set('aaa111', makeRow({ path: '/old/profile/userData/Data/Files/aaa111.txt' }))
    const response = await executeRequest({ requestId: 'req-c2', kind: 'capture-snapshot' })
    expect(response).toMatchObject({
      ok: true,
      rows: [expect.objectContaining({ id: 'aaa111', path: '/mock/files/aaa111.txt' })]
    })
  })

  it('capture-snapshot canonicalizes a relative path whose basename equals the canonical name (audit F3)', async () => {
    fileStore.set('aaa111', makeRow({ path: 'Files/aaa111.txt' }))
    const response = await executeRequest({ requestId: 'req-c3', kind: 'capture-snapshot' })
    expect(response).toMatchObject({
      ok: true,
      rows: [expect.objectContaining({ id: 'aaa111', path: '/mock/files/aaa111.txt' })]
    })
  })

  it('capture-snapshot canonicalizes a missing/empty stored path (legacy row, audit F3)', async () => {
    fileStore.set('aaa111', makeRow({ path: '' }))
    const response = await executeRequest({ requestId: 'req-c6', kind: 'capture-snapshot' })
    expect(response).toMatchObject({
      ok: true,
      rows: [expect.objectContaining({ id: 'aaa111', path: '/mock/files/aaa111.txt' })]
    })
  })

  it('capture-snapshot REJECTS an ambiguous relative path whose basename does not match (audit F3)', async () => {
    fileStore.set('aaa111', makeRow({ path: 'Files/some-other.txt' }))
    const response = await executeRequest({ requestId: 'req-c7', kind: 'capture-snapshot' })
    expect(response).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
  })

  it('capture-snapshot REJECTS a basename-mismatched path (LOCK-BRIDGE-2)', async () => {
    fileStore.set('aaa111', makeRow({ path: '/tmp/some-other.txt' }))
    const response = await executeRequest({ requestId: 'req-c4', kind: 'capture-snapshot' })
    expect(response).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
  })

  it('capture-snapshot fails closed with TARGET_PATH_UNKNOWN when no target root is resolvable (LOCK-BRIDGE-2)', async () => {
    mockStoreGetState.mockReturnValue({ runtime: { filesPath: '' } })
    fileStore.set('aaa111', makeRow({ path: '/mock/files/aaa111.txt' }))
    const response = await executeRequest({ requestId: 'req-c5', kind: 'capture-snapshot' })
    expect(response).toMatchObject({ ok: false, code: 'TARGET_PATH_UNKNOWN' })
  })

  it('signals ready only after the catalog handler is installed (LOCK-BRIDGE-1)', async () => {
    const handlers: { request?: (req: CatalogRecoveryRequest) => void } = {}
    const ready = vi.fn(async () => ({ accepted: true }))
    ;(window as unknown as { api: unknown }).api = {
      cherryImport: {
        catalog: {
          onRequest: vi.fn((cb: (req: CatalogRecoveryRequest) => void) => {
            handlers.request = cb
            return () => undefined
          }),
          respond: vi.fn(async () => ({ accepted: true })),
          ready
        }
      },
      file: { exists: mockExists }
    }
    const unsubscribe = registerCatalogRecoveryHandler()
    try {
      // The ready signal is delivered after the request subscription exists.
      expect(ready).toHaveBeenCalledTimes(1)
      expect(handlers.request).toBeDefined()
    } finally {
      unsubscribe()
    }
  })

  it('fails with TARGET_PATH_UNKNOWN when no target root is resolvable', async () => {
    mockStoreGetState.mockReturnValue({ runtime: { filesPath: '' } })
    const response = await executeRequest({ requestId: 'req-t', kind: 'apply-candidate', catalogRows: [makeRow()] })
    expect(response).toMatchObject({ ok: false, code: 'TARGET_PATH_UNKNOWN' })
    expect(fileStore.size).toBe(0)
  })
})

describe('null source metadata boundary (LOCK-BROWSE-1/4)', () => {
  beforeEach(() => {
    fileStore.clear()
    vi.clearAllMocks()
    mockStoreGetState.mockReturnValue({ runtime: { filesPath: '/mock/files' } })
    mockExists.mockResolvedValue(true)
  })

  it('validateCatalogRows accepts null type and null created_at', () => {
    expect(validateCatalogRows([makeRow({ type: null, created_at: null })])).toEqual({ ok: true })
  })

  it('apply-candidate persists null type/created_at without fabricating values', async () => {
    const rows = [makeRow({ type: null, created_at: null, path: 'Files/aaa111.txt' })]
    const response = await executeRequest(applyRequest({}, rows))
    expect(response).toMatchObject({ ok: true })
    const stored = fileStore.get('aaa111')
    expect(stored).toBeDefined()
    expect(stored).toMatchObject({
      id: 'aaa111',
      origin_name: 'notes.txt',
      path: '/mock/files/aaa111.txt',
      size: 100,
      ext: '.txt',
      count: 2,
      type: null,
      created_at: null
    })
  })

  it('apply-candidate retains source string type values where the wire permits', async () => {
    const rows = [makeRow({ type: 'image/png', created_at: null })]
    const response = await executeRequest(applyRequest({}, rows))
    expect(response).toMatchObject({ ok: true })
    expect(fileStore.get('aaa111')).toMatchObject({ type: 'image/png', created_at: null })
  })

  it('capture-snapshot round-trips null type/created_at unchanged', async () => {
    fileStore.set('aaa111', makeRow({ type: null, created_at: null, path: '/mock/files/aaa111.txt' }))
    const response = await executeRequest({ requestId: 'req-n', kind: 'capture-snapshot' })
    expect(response).toMatchObject({
      ok: true,
      rows: [expect.objectContaining({ id: 'aaa111', type: null, created_at: null })]
    })
  })
})

describe('isCatalogRecoverySurface (LOCK-CAT-2)', () => {
  afterEach(() => {
    window.history.replaceState({}, '', '/')
  })

  it('returns true when the URL carries the recovery query parameter', () => {
    window.history.replaceState({}, '', '/?cherryImportRecovery=1')
    expect(isCatalogRecoverySurface()).toBe(true)
  })

  it('returns false for the ordinary window URL', () => {
    window.history.replaceState({}, '', '/')
    expect(isCatalogRecoverySurface()).toBe(false)
  })
})
