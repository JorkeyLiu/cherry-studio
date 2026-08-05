/**
 * catalogApplyIpc — L2 files catalog boundary tests (LOCK-CAT-1/3/4/7).
 *
 * Covers:
 * - register/dispose lifecycle (handler registration, removal, re-registration
 *   idempotency — never double-registers).
 * - Authorization: only the registered main renderer's MAIN FRAME may respond;
 *   subframes, other windows, stale targets and post-disposal responders are
 *   rejected without touching Dexie.
 * - Wire hardening: duplicate/late/unknown requestIds and malformed payloads
 *   (bad requestId length, wrong inner requestId, missing/invalid facts,
 *   invalid rows) resolve to bounded INVALID_RESPONSE.
 * - Request lifecycle: bounded timeout, target loss, pending settlement on
 *   dispose/re-register.
 * - Send-side ready gate (LOCK-BRIDGE-1/F4): no catalog request is transmitted
 *   before the authenticated ready signal; a ready timeout / lost target fails
 *   closed with a bounded aggregate code and NO request is sent; dispose and
 *   re-registration reset readiness (a request awaiting ready fails with
 *   NO_TARGET); subsequent sends observe the settled ready state without
 *   another wait.
 * - High-level ops: capture-snapshot builds the durable payload, apply/restore
 *   compare post-facts against expected receipts (FACTS_MISMATCH), query-facts
 *   validates facts shape.
 * - Privacy (LOCK-CAT-7): Main-side logs carry only bounded codes/messages —
 *   never row names, paths, or raw IDs.
 */

import { createHash } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockHandle, mockRemoveHandler } = vi.hoisted(() => ({
  mockHandle: vi.fn(),
  mockRemoveHandler: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: mockHandle,
    removeHandler: mockRemoveHandler
  }
}))

vi.mock('@main/utils/file', () => ({
  getFilesDir: () => '/mock/userData/Data/Files'
}))

import { filesCatalogHashInput, type FilesCatalogSnapshotRow } from '@shared/chatImport/types'
import { IpcChannel } from '@shared/IpcChannel'

import {
  applyCandidateCatalog,
  awaitCatalogRecoveryReady,
  captureLiveCatalogSnapshot,
  disposeCatalogRecoveryIpc,
  queryCatalogFacts,
  registerCatalogRecoveryIpc,
  restoreCatalogSnapshot
} from '../catalogApplyIpc'

const ROW_A: FilesCatalogSnapshotRow = Object.freeze({
  id: 'aaa111',
  name: 'aaa111.txt',
  origin_name: 'notes.txt',
  path: 'Files/aaa111.txt',
  size: 100,
  ext: '.txt',
  type: 'text',
  created_at: '2024-01-01T00:00:00.000Z',
  count: 2
})

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

const ROW_A_HASH = sha256(filesCatalogHashInput([ROW_A]))

/** Mock webContents double mirroring the Electron surface the boundary uses. */
function createWebContents() {
  return {
    isDestroyed: vi.fn(() => false),
    mainFrame: { id: 1, url: 'file:///index.html' },
    send: vi.fn()
  }
}

type Wc = ReturnType<typeof createWebContents>

/** The last registered Respond handler (or null). */
function respondHandler() {
  const calls = mockHandle.mock.calls.filter(([channel]) => channel === IpcChannel.CherryImport_CatalogRespond)
  const last = calls[calls.length - 1]
  return last ? last[1] : null
}

/** The last registered Ready handler (or null). */
function readyHandler() {
  const calls = mockHandle.mock.calls.filter(([channel]) => channel === IpcChannel.CherryImport_CatalogReady)
  const last = calls[calls.length - 1]
  return last ? last[1] : null
}

/** Fabricate an IpcMainInvokeEvent for the given webContents. */
function eventFrom(wc: Wc, senderFrame: unknown = wc.mainFrame) {
  return { sender: wc, senderFrame, frameId: (senderFrame as { id: number }).id }
}

describe('catalogApplyIpc boundary', () => {
  let wc: Wc

  beforeEach(() => {
    vi.clearAllMocks()
    mockHandle.mockImplementation(() => undefined)
    mockRemoveHandler.mockImplementation(() => undefined)
    wc = createWebContents()
  })

  afterEach(() => {
    disposeCatalogRecoveryIpc()
  })

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  it('registers the Respond handler and removes it on dispose', () => {
    registerCatalogRecoveryIpc(wc as never)
    expect(mockHandle).toHaveBeenCalledWith(IpcChannel.CherryImport_CatalogRespond, expect.any(Function))
    expect(mockHandle).toHaveBeenCalledWith(IpcChannel.CherryImport_CatalogReady, expect.any(Function))
    expect(mockRemoveHandler).not.toHaveBeenCalled()
    disposeCatalogRecoveryIpc()
    expect(mockRemoveHandler).toHaveBeenCalledWith(IpcChannel.CherryImport_CatalogRespond)
    expect(mockRemoveHandler).toHaveBeenCalledWith(IpcChannel.CherryImport_CatalogReady)
  })

  it('re-registration is idempotent — swaps the target without double-registering', async () => {
    registerCatalogRecoveryIpc(wc as never)
    const wc2 = createWebContents()
    registerCatalogRecoveryIpc(wc2 as never)
    // The old handler is removed before the new one is registered.
    expect(mockRemoveHandler).toHaveBeenCalledWith(IpcChannel.CherryImport_CatalogRespond)
    const handlerCalls = mockHandle.mock.calls.filter(([c]) => c === IpcChannel.CherryImport_CatalogRespond)
    expect(handlerCalls.length).toBe(2)
    // The NEW target must prove its own readiness before the boundary sends.
    expect(readyHandler()(eventFrom(wc2))).toEqual({ accepted: true })
    // The old window can no longer respond.
    const promise = queryCatalogFacts()
    const req = wc2.send.mock.calls[0][1]
    const accepted = respondHandler()(eventFrom(wc), req.requestId, {
      ok: true,
      requestId: req.requestId,
      facts: { count: 0, sha256: sha256('') }
    })
    expect(accepted).toEqual({ accepted: false })
    disposeCatalogRecoveryIpc()
    await promise
  })

  it('dispose settles a pending request with a bounded NO_TARGET failure (no send before ready)', async () => {
    registerCatalogRecoveryIpc(wc as never)
    const promise = queryCatalogFacts()
    // F4: the request is gated on the ready handshake — nothing was sent yet.
    expect(wc.send).not.toHaveBeenCalled()
    disposeCatalogRecoveryIpc()
    const result = await promise
    expect(result).toMatchObject({ ok: false, code: 'NO_TARGET' })
    expect(wc.send).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Authorization (LOCK-CAT-3)
  // -------------------------------------------------------------------------

  it('rejects a response from a different webContents (stale/other window)', async () => {
    registerCatalogRecoveryIpc(wc as never)
    expect(readyHandler()(eventFrom(wc))).toEqual({ accepted: true })
    const promise = queryCatalogFacts()
    const req = wc.send.mock.calls[0][1]
    const otherWc = createWebContents()
    const accepted = respondHandler()(eventFrom(otherWc), req.requestId, {
      ok: true,
      requestId: req.requestId,
      facts: { count: 0, sha256: sha256('') }
    })
    expect(accepted).toEqual({ accepted: false })
    // The request stays pending (settled by disposal, never by the stranger).
    disposeCatalogRecoveryIpc()
    const result = await promise
    expect(result).toMatchObject({ ok: false, code: 'NO_TARGET' })
  })

  it('rejects a response from a subframe', async () => {
    registerCatalogRecoveryIpc(wc as never)
    expect(readyHandler()(eventFrom(wc))).toEqual({ accepted: true })
    const promise = queryCatalogFacts()
    const req = wc.send.mock.calls[0][1]
    const subFrame = { id: 99, url: 'file:///subframe.html' }
    const accepted = respondHandler()(eventFrom(wc, subFrame), req.requestId, {
      ok: true,
      requestId: req.requestId,
      facts: { count: 0, sha256: sha256('') }
    })
    expect(accepted).toEqual({ accepted: false })
    disposeCatalogRecoveryIpc()
    await promise
  })

  it('rejects responses after disposal (target cleared)', async () => {
    registerCatalogRecoveryIpc(wc as never)
    expect(readyHandler()(eventFrom(wc))).toEqual({ accepted: true })
    const promise = queryCatalogFacts()
    const req = wc.send.mock.calls[0][1]
    disposeCatalogRecoveryIpc()
    const accepted = respondHandler()(eventFrom(wc), req.requestId, {
      ok: true,
      requestId: req.requestId,
      facts: { count: 0, sha256: sha256('') }
    })
    expect(accepted).toEqual({ accepted: false })
    const result = await promise
    expect(result).toMatchObject({ ok: false, code: 'NO_TARGET' })
  })

  // -------------------------------------------------------------------------
  // Wire hardening (LOCK-CAT-3)
  // -------------------------------------------------------------------------

  it('rejects a duplicate (replayed) response for the same requestId', async () => {
    registerCatalogRecoveryIpc(wc as never)
    expect(readyHandler()(eventFrom(wc))).toEqual({ accepted: true })
    const promise = applyCandidateCatalog([ROW_A], { count: 1, sha256: ROW_A_HASH })
    const req = wc.send.mock.calls[0][1]
    const response = { ok: true, requestId: req.requestId, facts: { count: 1, sha256: ROW_A_HASH } }
    const first = respondHandler()(eventFrom(wc), req.requestId, response)
    expect(first).toEqual({ accepted: true })
    const second = respondHandler()(eventFrom(wc), req.requestId, response)
    expect(second).toEqual({ accepted: false })
    const result = await promise
    expect(result).toMatchObject({ ok: true })
  })

  it('rejects an unknown requestId (no pending request)', () => {
    registerCatalogRecoveryIpc(wc as never)
    const accepted = respondHandler()(eventFrom(wc), 'cat-req-unknown', {
      ok: true,
      requestId: 'cat-req-unknown',
      facts: { count: 0, sha256: sha256('') }
    })
    expect(accepted).toEqual({ accepted: false })
  })

  it('rejects malformed requestId values', async () => {
    registerCatalogRecoveryIpc(wc as never)
    const promise = queryCatalogFacts()
    expect(respondHandler()(eventFrom(wc), 42, {})).toEqual({ accepted: false })
    expect(respondHandler()(eventFrom(wc), '', {})).toEqual({ accepted: false })
    expect(respondHandler()(eventFrom(wc), 'x'.repeat(129), {})).toEqual({ accepted: false })
    disposeCatalogRecoveryIpc()
    await promise
  })

  it('resolves malformed response payloads to bounded INVALID_RESPONSE', async () => {
    registerCatalogRecoveryIpc(wc as never)
    expect(readyHandler()(eventFrom(wc))).toEqual({ accepted: true })

    const cases: Array<{ label: string; build: (reqId: string) => unknown }> = [
      { label: 'null', build: () => null },
      { label: 'string', build: () => 'string' },
      { label: 'array', build: () => [] },
      { label: 'missing-facts', build: (reqId) => ({ ok: true, requestId: reqId }) },
      {
        label: 'inner-id-mismatch',
        build: () => ({ ok: true, requestId: 'other-id', facts: { count: 0, sha256: sha256('') } })
      },
      {
        label: 'invalid-count',
        build: (reqId) => ({ ok: true, requestId: reqId, facts: { count: -1, sha256: sha256('') } })
      },
      {
        label: 'invalid-sha256',
        build: (reqId) => ({ ok: true, requestId: reqId, facts: { count: 0, sha256: 'zzz' } })
      },
      {
        label: 'rows-null-entry',
        build: (reqId) => ({ ok: true, requestId: reqId, facts: { count: 0, sha256: sha256('') }, rows: [null] })
      },
      {
        label: 'rows-bad-entry',
        build: (reqId) => ({ ok: true, requestId: reqId, facts: { count: 0, sha256: sha256('') }, rows: [{ id: 1 }] })
      },
      { label: 'failure-no-code', build: (reqId) => ({ ok: false, requestId: reqId }) }
    ]
    for (const { build } of cases) {
      const promise = queryCatalogFacts()
      const req = wc.send.mock.calls[wc.send.mock.calls.length - 1][1]
      const accepted = respondHandler()(eventFrom(wc), req.requestId, build(req.requestId))
      expect(accepted).toEqual({ accepted: true })
      const result = await promise
      expect(result).toMatchObject({ ok: false, code: 'RENDERER_FAILED', detail: 'INVALID_RESPONSE' })
    }
  })

  // -------------------------------------------------------------------------
  // Request lifecycle
  // -------------------------------------------------------------------------

  it('times out unanswered requests with a bounded TIMEOUT failure', async () => {
    vi.useFakeTimers()
    try {
      registerCatalogRecoveryIpc(wc as never)
      expect(readyHandler()(eventFrom(wc))).toEqual({ accepted: true })
      const promise = queryCatalogFacts()
      expect(wc.send).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(60_001)
      const result = await promise
      expect(result).toMatchObject({ ok: false, code: 'TIMEOUT' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails fast with NO_TARGET when no window is registered', async () => {
    const result = await queryCatalogFacts()
    expect(result).toMatchObject({ ok: false, code: 'NO_TARGET' })
  })

  // -------------------------------------------------------------------------
  // Ready handshake (LOCK-BRIDGE-1)
  // -------------------------------------------------------------------------

  it('awaitCatalogRecoveryReady resolves on the authorized ready signal', async () => {
    registerCatalogRecoveryIpc(wc as never)
    const promise = awaitCatalogRecoveryReady()
    const accepted = readyHandler()(eventFrom(wc))
    expect(accepted).toEqual({ accepted: true })
    await expect(promise).resolves.toEqual({ ok: true })
  })

  it('awaitCatalogRecoveryReady resolves immediately when already ready', async () => {
    registerCatalogRecoveryIpc(wc as never)
    readyHandler()(eventFrom(wc))
    await expect(awaitCatalogRecoveryReady()).resolves.toEqual({ ok: true })
  })

  it('rejects a ready signal from a different webContents (stale window)', async () => {
    registerCatalogRecoveryIpc(wc as never)
    const promise = awaitCatalogRecoveryReady()
    const otherWc = createWebContents()
    const accepted = readyHandler()(eventFrom(otherWc))
    expect(accepted).toEqual({ accepted: false })
    // The await stays pending — settle it via dispose to a bounded NO_TARGET.
    disposeCatalogRecoveryIpc()
    await expect(promise).resolves.toEqual({ ok: false, code: 'NO_TARGET' })
  })

  it('rejects a ready signal from a subframe', async () => {
    registerCatalogRecoveryIpc(wc as never)
    const promise = awaitCatalogRecoveryReady()
    const subFrame = { id: 99, url: 'file:///subframe.html' }
    const accepted = readyHandler()(eventFrom(wc, subFrame))
    expect(accepted).toEqual({ accepted: false })
    disposeCatalogRecoveryIpc()
    await expect(promise).resolves.toEqual({ ok: false, code: 'NO_TARGET' })
  })

  it('rejects a duplicate ready signal (bounded no-op, first signal owns the handshake)', async () => {
    registerCatalogRecoveryIpc(wc as never)
    const promise = awaitCatalogRecoveryReady()
    expect(readyHandler()(eventFrom(wc))).toEqual({ accepted: true })
    expect(readyHandler()(eventFrom(wc))).toEqual({ accepted: false })
    await expect(promise).resolves.toEqual({ ok: true })
  })

  it('rejects ready after disposal (target cleared) and fails the awaiter with NO_TARGET', async () => {
    registerCatalogRecoveryIpc(wc as never)
    const promise = awaitCatalogRecoveryReady()
    disposeCatalogRecoveryIpc()
    const accepted = readyHandler()(eventFrom(wc))
    expect(accepted).toEqual({ accepted: false })
    await expect(promise).resolves.toEqual({ ok: false, code: 'NO_TARGET' })
  })

  it('fails fast with NO_TARGET when awaiting ready with no registered window', async () => {
    await expect(awaitCatalogRecoveryReady()).resolves.toEqual({ ok: false, code: 'NO_TARGET' })
  })

  it('times out unanswered ready signals with a bounded READY_TIMEOUT', async () => {
    vi.useFakeTimers()
    try {
      registerCatalogRecoveryIpc(wc as never)
      const promise = awaitCatalogRecoveryReady()
      vi.advanceTimersByTime(30_001)
      await expect(promise).resolves.toEqual({ ok: false, code: 'READY_TIMEOUT' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-registration resets the ready state — a stale ready must not satisfy the new target', async () => {
    registerCatalogRecoveryIpc(wc as never)
    // The OLD target signals ready — accepted against its own registration.
    expect(readyHandler()(eventFrom(wc))).toEqual({ accepted: true })
    const wc2 = createWebContents()
    registerCatalogRecoveryIpc(wc2 as never)
    // A fresh await against the NEW target must NOT resolve from the old
    // target's ready (the ready state was reset).
    const promise = awaitCatalogRecoveryReady()
    const accepted = readyHandler()(eventFrom(wc2))
    expect(accepted).toEqual({ accepted: true })
    await expect(promise).resolves.toEqual({ ok: true })
    // And the OLD target's ready is now rejected (target swapped).
    expect(readyHandler()(eventFrom(wc))).toEqual({ accepted: false })
  })

  // -------------------------------------------------------------------------
  // Send-side ready gate (LOCK-BRIDGE-1/F4): no request before ready
  // -------------------------------------------------------------------------

  it('waits for the authenticated ready signal before sending the first request', async () => {
    registerCatalogRecoveryIpc(wc as never)
    const promise = queryCatalogFacts()
    // F4: the request is gated on the ready handshake — nothing transmitted.
    expect(wc.send).not.toHaveBeenCalled()
    expect(readyHandler()(eventFrom(wc))).toEqual({ accepted: true })
    // The gated send proceeds on the ready resolution (microtask continuation).
    await Promise.resolve()
    await Promise.resolve()
    expect(wc.send).toHaveBeenCalledTimes(1)
    const req = wc.send.mock.calls[0][1]
    expect(req.kind).toBe('query-facts')
    respondHandler()(eventFrom(wc), req.requestId, {
      ok: true,
      requestId: req.requestId,
      facts: { count: 0, sha256: sha256('') }
    })
    await expect(promise).resolves.toMatchObject({ ok: true })
  })

  it('fails closed with a bounded aggregate code when ready never arrives (no request is sent)', async () => {
    vi.useFakeTimers()
    try {
      registerCatalogRecoveryIpc(wc as never)
      const promise = queryCatalogFacts()
      expect(wc.send).not.toHaveBeenCalled()
      vi.advanceTimersByTime(30_001)
      const result = await promise
      // The ready timeout maps through the bounded RENDERER_FAILED aggregate
      // with the bounded READY_TIMEOUT detail — the request was never sent.
      expect(result).toMatchObject({ ok: false, code: 'RENDERER_FAILED', detail: 'READY_TIMEOUT' })
      expect(wc.send).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails closed with NO_TARGET and never sends when the target is disposed while awaiting ready', async () => {
    registerCatalogRecoveryIpc(wc as never)
    const promise = queryCatalogFacts()
    expect(wc.send).not.toHaveBeenCalled()
    disposeCatalogRecoveryIpc()
    const result = await promise
    expect(result).toMatchObject({ ok: false, code: 'NO_TARGET' })
    expect(wc.send).not.toHaveBeenCalled()
  })

  it('fails closed with NO_TARGET and never sends when the target is re-registered while awaiting ready', async () => {
    registerCatalogRecoveryIpc(wc as never)
    const promise = queryCatalogFacts()
    expect(wc.send).not.toHaveBeenCalled()
    const wc2 = createWebContents()
    registerCatalogRecoveryIpc(wc2 as never)
    // The ready waiter is dropped with a bounded NO_TARGET; neither the old
    // nor the new target ever received the request.
    const result = await promise
    expect(result).toMatchObject({ ok: false, code: 'NO_TARGET' })
    expect(wc.send).not.toHaveBeenCalled()
    expect(wc2.send).not.toHaveBeenCalled()
  })

  it('subsequent requests after ready send immediately without another wait', async () => {
    registerCatalogRecoveryIpc(wc as never)
    expect(readyHandler()(eventFrom(wc))).toEqual({ accepted: true })
    const first = queryCatalogFacts()
    const second = queryCatalogFacts()
    // Both sends fire synchronously — the settled ready state is reused.
    expect(wc.send).toHaveBeenCalledTimes(2)
    const req1 = wc.send.mock.calls[0][1]
    const req2 = wc.send.mock.calls[1][1]
    expect(req1.requestId).not.toBe(req2.requestId)
    respondHandler()(eventFrom(wc), req1.requestId, {
      ok: true,
      requestId: req1.requestId,
      facts: { count: 0, sha256: sha256('') }
    })
    respondHandler()(eventFrom(wc), req2.requestId, {
      ok: true,
      requestId: req2.requestId,
      facts: { count: 0, sha256: sha256('') }
    })
    await expect(first).resolves.toMatchObject({ ok: true })
    await expect(second).resolves.toMatchObject({ ok: true })
  })

  it('re-registration resets the send gate — a request waits for the NEW target ready', async () => {
    registerCatalogRecoveryIpc(wc as never)
    // The OLD target signals ready — accepted against its own registration.
    expect(readyHandler()(eventFrom(wc))).toEqual({ accepted: true })
    const wc2 = createWebContents()
    registerCatalogRecoveryIpc(wc2 as never)
    // The old ready must NOT satisfy a request against the new target.
    const promise = queryCatalogFacts()
    expect(wc2.send).not.toHaveBeenCalled()
    expect(readyHandler()(eventFrom(wc2))).toEqual({ accepted: true })
    await Promise.resolve()
    expect(wc2.send).toHaveBeenCalledTimes(1)
    const req = wc2.send.mock.calls[0][1]
    respondHandler()(eventFrom(wc2), req.requestId, {
      ok: true,
      requestId: req.requestId,
      facts: { count: 0, sha256: sha256('') }
    })
    await expect(promise).resolves.toMatchObject({ ok: true })
    // The OLD target's ready signal remains rejected (target swapped).
    expect(readyHandler()(eventFrom(wc))).toEqual({ accepted: false })
  })

  // -------------------------------------------------------------------------
  // High-level operations
  // -------------------------------------------------------------------------

  it('captures a durable snapshot from the renderer response', async () => {
    registerCatalogRecoveryIpc(wc as never)
    expect(readyHandler()(eventFrom(wc))).toEqual({ accepted: true })
    const promise = captureLiveCatalogSnapshot()
    const req = wc.send.mock.calls[0][1]
    expect(req.kind).toBe('capture-snapshot')
    // LOCK-BRIDGE-2: the capture carries the authoritative target files root
    // (same as apply/restore) so the renderer can normalize captured paths
    // against the CURRENT root — the retained snapshot is always restorable.
    expect(req.filesPath).toBe('/mock/userData/Data/Files')
    const accepted = respondHandler()(eventFrom(wc), req.requestId, {
      ok: true,
      requestId: req.requestId,
      rows: [ROW_A],
      facts: { count: 1, sha256: ROW_A_HASH }
    })
    expect(accepted).toEqual({ accepted: true })
    const result = await promise
    expect(result.ok).toBe(true)
    expect(result.snapshot).toMatchObject({
      version: 1,
      rows: [ROW_A],
      integrity: { count: 1, sha256: ROW_A_HASH }
    })
    expect(typeof result.snapshot?.capturedAt).toBe('string')
  })

  it('rejects a capture whose row count diverges from the facts', async () => {
    registerCatalogRecoveryIpc(wc as never)
    expect(readyHandler()(eventFrom(wc))).toEqual({ accepted: true })
    const promise = captureLiveCatalogSnapshot()
    const req = wc.send.mock.calls[0][1]
    respondHandler()(eventFrom(wc), req.requestId, {
      ok: true,
      requestId: req.requestId,
      rows: [],
      facts: { count: 1, sha256: ROW_A_HASH }
    })
    const result = await promise
    expect(result).toMatchObject({ ok: false, code: 'PAYLOAD_INVALID', detail: 'ROWS_MISSING' })
  })

  it('applies the candidate catalog when post-facts match the expected receipt', async () => {
    registerCatalogRecoveryIpc(wc as never)
    expect(readyHandler()(eventFrom(wc))).toEqual({ accepted: true })
    const promise = applyCandidateCatalog([ROW_A], { count: 1, sha256: ROW_A_HASH })
    const req = wc.send.mock.calls[0][1]
    expect(req.kind).toBe('apply-candidate')
    expect(req.catalogRows).toEqual([ROW_A])
    expect(req.expected).toEqual({ count: 1, sha256: ROW_A_HASH })
    // The boundary carries the canonical target files root (LOCK-CAT-4).
    expect(req.filesPath).toBe('/mock/userData/Data/Files')
    respondHandler()(eventFrom(wc), req.requestId, {
      ok: true,
      requestId: req.requestId,
      facts: { count: 1, sha256: ROW_A_HASH }
    })
    const result = await promise
    expect(result).toMatchObject({ ok: true, facts: { count: 1, sha256: ROW_A_HASH } })
  })

  it('fails with FACTS_MISMATCH when the renderer reports diverged post-facts', async () => {
    registerCatalogRecoveryIpc(wc as never)
    expect(readyHandler()(eventFrom(wc))).toEqual({ accepted: true })
    const promise = applyCandidateCatalog([ROW_A], { count: 1, sha256: ROW_A_HASH })
    const req = wc.send.mock.calls[0][1]
    respondHandler()(eventFrom(wc), req.requestId, {
      ok: true,
      requestId: req.requestId,
      facts: { count: 2, sha256: sha256('different') }
    })
    const result = await promise
    expect(result).toMatchObject({ ok: false, code: 'FACTS_MISMATCH' })
  })

  it('restores the old snapshot when facts match the snapshot integrity', async () => {
    registerCatalogRecoveryIpc(wc as never)
    expect(readyHandler()(eventFrom(wc))).toEqual({ accepted: true })
    const snapshot = {
      version: 1 as const,
      capturedAt: '2024-01-01T00:00:00.000Z',
      rows: [ROW_A],
      integrity: { count: 1, sha256: ROW_A_HASH }
    }
    const promise = restoreCatalogSnapshot(snapshot)
    const req = wc.send.mock.calls[0][1]
    expect(req.kind).toBe('restore-snapshot')
    expect(req.snapshot).toEqual(snapshot)
    respondHandler()(eventFrom(wc), req.requestId, {
      ok: true,
      requestId: req.requestId,
      facts: { count: 1, sha256: ROW_A_HASH }
    })
    const result = await promise
    expect(result).toMatchObject({ ok: true })
  })

  it('restore fails with FACTS_MISMATCH on receipt divergence', async () => {
    registerCatalogRecoveryIpc(wc as never)
    expect(readyHandler()(eventFrom(wc))).toEqual({ accepted: true })
    const snapshot = {
      version: 1 as const,
      capturedAt: '2024-01-01T00:00:00.000Z',
      rows: [ROW_A],
      integrity: { count: 1, sha256: ROW_A_HASH }
    }
    const promise = restoreCatalogSnapshot(snapshot)
    const req = wc.send.mock.calls[0][1]
    respondHandler()(eventFrom(wc), req.requestId, {
      ok: true,
      requestId: req.requestId,
      facts: { count: 0, sha256: sha256('') }
    })
    const result = await promise
    expect(result).toMatchObject({ ok: false, code: 'FACTS_MISMATCH' })
  })

  it('query-facts maps a renderer failure to RENDERER_FAILED with the bounded code', async () => {
    registerCatalogRecoveryIpc(wc as never)
    expect(readyHandler()(eventFrom(wc))).toEqual({ accepted: true })
    const promise = queryCatalogFacts()
    const req = wc.send.mock.calls[0][1]
    respondHandler()(eventFrom(wc), req.requestId, { ok: false, requestId: req.requestId, code: 'DEXIE_FAILED' })
    const result = await promise
    expect(result).toMatchObject({ ok: false, code: 'RENDERER_FAILED', detail: 'DEXIE_FAILED' })
  })

  // -------------------------------------------------------------------------
  // Privacy (LOCK-CAT-7)
  // -------------------------------------------------------------------------

  it('never logs row names, paths, or raw IDs (aggregate-only boundary logging)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      registerCatalogRecoveryIpc(wc as never)
      expect(readyHandler()(eventFrom(wc))).toEqual({ accepted: true })
      const secretRow: FilesCatalogSnapshotRow = {
        id: 'supersecret-id-987',
        name: 'supersecret-id-987.png',
        origin_name: 'private-bank-statement.png',
        path: 'Files/supersecret-id-987.png',
        size: 123,
        ext: '.png',
        type: 'image',
        created_at: '2024-01-01T00:00:00.000Z',
        count: 1
      }
      const secretHash = sha256(filesCatalogHashInput([secretRow]))
      // Trigger the apply path (request wire) + an unauthorized responder.
      const promise = applyCandidateCatalog([secretRow], { count: 1, sha256: secretHash })
      const req = wc.send.mock.calls[0][1]
      const stranger = createWebContents()
      respondHandler()(eventFrom(stranger), req.requestId, {
        ok: true,
        requestId: req.requestId,
        facts: { count: 1, sha256: secretHash }
      })
      disposeCatalogRecoveryIpc()
      await promise
      const allCalls = [...warnSpy.mock.calls, ...errorSpy.mock.calls].map((c) => String(c[0] ?? ''))
      const joined = allCalls.join('\n')
      expect(joined).not.toContain('supersecret-id-987')
      expect(joined).not.toContain('private-bank-statement')
      expect(joined).not.toContain('Files/supersecret')
    } finally {
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })
})
