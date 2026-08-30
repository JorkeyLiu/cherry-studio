/**
 * ImportProjectionGate tests (LOCK-001, LOCK-PROJECTION, LOCK-009).
 *
 * The ordinary chat tree must NOT mount — and no topic priming may run —
 * until the one-shot L2 navigation projection has safely settled. These
 * tests exercise the REAL gate against the REAL `applyPendingImportProjection`
 * + `runImportProjectionBoot` wiring with deferred IPC/flush/ack timing: the
 * gate closing is never mocked away. The ReduxStoreReady notification is not
 * part of this flow (LOCK-003): it fires at rehydration via
 * `runReduxStoreBoot`, independently of the projection.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...(actual as object),
    useTranslation: () => ({
      t: (key: string) => key,
      i18n: { language: 'en-US' }
    })
  }
})

const { fetchMessagesWindowMock } = vi.hoisted(() => ({
  fetchMessagesWindowMock: vi
    .fn()
    .mockImplementation(async (request: { kind: string; topicId: string; limit: number }) => ({
      messages: [],
      blocks: [],
      window: {
        kind: 'latest' as const,
        completeness: 'window' as const,
        topicId: request.topicId,
        anchorMessageId: null,
        requested: { limit: request.limit },
        firstMessageId: null,
        lastMessageId: null,
        returnedCount: 0,
        hasMoreBefore: false,
        hasMoreAfter: false
      }
    }))
}))

// The real store module is heavy and its persistStore callback would settle
// the readiness singleton asynchronously — mock it so the singleton is fully
// test-controlled (mirrors importProjection.test.ts).
vi.mock('@renderer/store', () => ({
  default: {
    getState: vi.fn(() => ({ assistants: { assistants: [], defaultAssistant: {} }, llm: {} })),
    dispatch: vi.fn()
  }
}))

// The IPC-bound message-load seam the race depends on: gate closed ⇒ never
// called; gate open ⇒ ordinary priming resumes (LOCK-009).
// S6.1 R-02: ordinary topic load now uses fetchMessagesWindow latest bootstrap
// with fail-closed validation and no whole-topic fallback.
vi.mock('@renderer/services/db', () => ({
  dbService: { fetchMessagesWindow: fetchMessagesWindowMock }
}))

import { applyPendingImportProjection } from '@renderer/services/importProjection'
import {
  getImportProjectionReadinessState,
  isImportProjectionReady,
  resetImportProjectionReadiness,
  retryImportProjectionReadiness,
  runImportProjectionBoot
} from '@renderer/services/importProjectionReadiness'
import { loadTopicMessagesThunk } from '@renderer/store/thunk/messageThunk'
import type { ImportNavigationProjection } from '@shared/chatImport/types'

import { ImportProjectionGate } from '../ImportProjectionGate'

function makeProjection(): ImportNavigationProjection {
  return {
    version: 1,
    sourcePersistVersion: 215,
    assistants: [{ id: 'a-1', name: 'Assistant One', emoji: '😀', order: 0 }],
    topics: [
      {
        id: 't-1',
        assistantId: 'a-1',
        name: 'Topic A',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        deletedAt: null,
        pinned: true,
        isNameManuallyEdited: true,
        order: 0
      }
    ],
    recoveredTopicIds: []
  }
}

/** Mirrors the priming behavior of useActiveTopic: dispatch the load thunk on mount. */
function TopicPrimingProbe({ topicId, dispatch }: { topicId: string; dispatch: (action: unknown) => unknown }) {
  useEffect(() => {
    const run = loadTopicMessagesThunk(topicId) as unknown as (
      d: (action: unknown) => unknown,
      g: () => unknown
    ) => Promise<void>
    void run(dispatch, () => ({ messages: { messageIdsByTopic: {} } }))
  }, [topicId, dispatch])
  return <div data-testid="priming-probe" />
}

describe('ImportProjectionGate (LOCK-001/LOCK-PROJECTION)', () => {
  const dispatch = vi.fn()
  const getProjection = vi.fn()
  const ackProjection = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    resetImportProjectionReadiness()
    fetchMessagesWindowMock
      .mockReset()
      .mockImplementation(async (request: { kind: string; topicId: string; limit: number }) => ({
        messages: [],
        blocks: [],
        window: {
          kind: 'latest' as const,
          completeness: 'window' as const,
          topicId: request.topicId,
          anchorMessageId: null,
          requested: { limit: request.limit },
          firstMessageId: null,
          lastMessageId: null,
          returnedCount: 0,
          hasMoreBefore: false,
          hasMoreAfter: false
        }
      }))
    getProjection.mockReset()
    ackProjection.mockReset().mockResolvedValue({ ok: true })
    const api = (window as unknown as { api?: Record<string, unknown> }).api ?? {}
    api.cherryImport = { getProjection, ackProjection }
    ;(window as unknown as { api: Record<string, unknown> }).api = api
  })

  afterEach(() => {
    resetImportProjectionReadiness()
    const api = (window as unknown as { api?: Record<string, unknown> }).api
    if (api) delete api.cherryImport
  })

  it('#1 no pending projection: readiness opens and children render', async () => {
    getProjection.mockResolvedValue({ ok: true, projection: null })
    const flush = vi.fn().mockResolvedValue(undefined)

    render(
      <ImportProjectionGate>
        <div data-testid="ordinary-tree" />
      </ImportProjectionGate>
    )
    // Gate closed while readiness is pending — shows localized loading, no stale tree.
    expect(screen.queryByTestId('ordinary-tree')).not.toBeInTheDocument()
    expect(screen.getByTestId('startup-readiness-loading')).toBeInTheDocument()
    expect(screen.getByTestId('startup-readiness-loading').getAttribute('aria-busy')).toBe('true')
    expect(screen.queryByTestId('startup-readiness-error')).not.toBeInTheDocument()

    await act(async () => {
      await runImportProjectionBoot({
        apply: () => applyPendingImportProjection({ dispatch, flush })
      })
    })

    expect(getProjection).toHaveBeenCalledTimes(1)
    // Genuine no-pending: nothing applied, nothing flushed, nothing acked.
    expect(dispatch).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
    expect(ackProjection).not.toHaveBeenCalled()
    expect(isImportProjectionReady()).toBe(true)

    await waitFor(() => expect(screen.getByTestId('ordinary-tree')).toBeInTheDocument())
    expect(screen.queryByTestId('startup-readiness-loading')).not.toBeInTheDocument()
    expect(screen.queryByTestId('startup-readiness-error')).not.toBeInTheDocument()
  })

  it('#2 pending projection: children stay unmounted until updateAssistants + flush + ack complete', async () => {
    let resolveProjection!: (value: unknown) => void
    let resolveFlush!: () => void
    let resolveAck!: (value: unknown) => void
    getProjection.mockImplementation(() => new Promise((resolve) => (resolveProjection = resolve)))
    const flush = vi.fn(() => new Promise<void>((resolve) => (resolveFlush = resolve)))
    ackProjection.mockImplementation(() => new Promise((resolve) => (resolveAck = resolve)))

    const boot = runImportProjectionBoot({
      apply: () => applyPendingImportProjection({ dispatch, flush })
    })

    render(
      <ImportProjectionGate>
        <div data-testid="ordinary-tree" />
      </ImportProjectionGate>
    )
    expect(screen.queryByTestId('ordinary-tree')).not.toBeInTheDocument()
    // S7.2 pending shows localized loading, not blank
    expect(screen.getByTestId('startup-readiness-loading')).toBeInTheDocument()

    // 1. Projection read resolves → replace-all dispatch runs; flush starts.
    resolveProjection({ ok: true, projection: makeProjection() })
    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'assistants/updateAssistants' }))
    })
    expect(flush).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('ordinary-tree')).not.toBeInTheDocument()
    expect(screen.getByTestId('startup-readiness-loading')).toBeInTheDocument()

    // 2. Durable flush completes → ack is issued; still gated.
    resolveFlush()
    await waitFor(() => expect(ackProjection).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('ordinary-tree')).not.toBeInTheDocument()

    // 3. Ack completes → readiness settles → the tree opens.
    resolveAck({ ok: true })
    await act(async () => {
      await boot
    })
    expect(isImportProjectionReady()).toBe(true)
    await waitFor(() => expect(screen.getByTestId('ordinary-tree')).toBeInTheDocument())
    expect(screen.queryByTestId('startup-readiness-loading')).not.toBeInTheDocument()
  })

  it('#3 projection failure/API error: children stay unmounted, ack not called, readiness not signaled', async () => {
    getProjection.mockResolvedValue({ ok: false, error: 'read failed' })
    const flush = vi.fn()

    render(
      <ImportProjectionGate>
        <div data-testid="ordinary-tree" />
      </ImportProjectionGate>
    )
    expect(screen.queryByTestId('ordinary-tree')).not.toBeInTheDocument()
    expect(screen.getByTestId('startup-readiness-loading')).toBeInTheDocument()

    const result = await runImportProjectionBoot({
      apply: () => applyPendingImportProjection({ dispatch, flush })
    })

    expect(result).toBe('failed')
    expect(isImportProjectionReady()).toBe(false)
    expect(getImportProjectionReadinessState()).toBe('failed')
    expect(dispatch).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
    expect(ackProjection).not.toHaveBeenCalled()
    // The tree stays gated — no stale navigation mounts after an API failure. S7.2 shows retry surface.
    expect(screen.queryByTestId('ordinary-tree')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('startup-readiness-error')).toBeInTheDocument())
    expect(screen.getByTestId('startup-readiness-retry')).toBeInTheDocument()
    expect(screen.queryByTestId('startup-readiness-loading')).not.toBeInTheDocument()
  })

  it('#3b IPC transport rejection: tree stays gated, no ack, readiness not signaled', async () => {
    getProjection.mockRejectedValue(new Error('ipc down'))
    const flush = vi.fn()

    render(
      <ImportProjectionGate>
        <div data-testid="ordinary-tree" />
      </ImportProjectionGate>
    )

    const result = await runImportProjectionBoot({
      apply: () => applyPendingImportProjection({ dispatch, flush })
    })

    expect(result).toBe('failed')
    expect(isImportProjectionReady()).toBe(false)
    expect(ackProjection).not.toHaveBeenCalled()
    expect(screen.queryByTestId('ordinary-tree')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('startup-readiness-error')).toBeInTheDocument())
  })

  it('#5 regression: no stale-topic message loading before the projection completes', async () => {
    let resolveProjection!: (value: unknown) => void
    getProjection.mockImplementation(() => new Promise((resolve) => (resolveProjection = resolve)))
    const flush = vi.fn().mockResolvedValue(undefined)

    const boot = runImportProjectionBoot({
      apply: () => applyPendingImportProjection({ dispatch, flush })
    })

    render(
      <ImportProjectionGate>
        <TopicPrimingProbe topicId="t-stale-pre-import" dispatch={dispatch} />
      </ImportProjectionGate>
    )
    // The gate is closed while the projection apply is in flight — the probe
    // never mounts, so the stale topic is never primed.
    await waitFor(() => expect(getProjection).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('priming-probe')).not.toBeInTheDocument()
    expect(fetchMessagesWindowMock).not.toHaveBeenCalled()

    // Projection completes (replace-all → flush → ack) → the tree opens.
    resolveProjection({ ok: true, projection: makeProjection() })
    await act(async () => {
      await boot
    })
    expect(isImportProjectionReady()).toBe(true)
    await waitFor(() => expect(screen.getByTestId('priming-probe')).toBeInTheDocument())
    // Ordinary priming resumes after the gate opens (LOCK-009) via R-02
    // latest-window bootstrap — fail-closed, no whole-topic fallback.
    await waitFor(() =>
      expect(fetchMessagesWindowMock).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'latest', topicId: 't-stale-pre-import', limit: 20 })
      )
    )
    expect(fetchMessagesWindowMock).toHaveBeenCalledTimes(1)
  })

  // S7.2 — renderer startup readiness presentation / recovery
  it('S7.2 pending shows localized accessible loading and no stale mount', async () => {
    getProjection.mockImplementation(() => new Promise(() => {}))
    const flush = vi.fn().mockResolvedValue(undefined)
    // Keep boot pending so gate stays in loading
    void runImportProjectionBoot({ apply: () => applyPendingImportProjection({ dispatch, flush }) })
    render(
      <ImportProjectionGate>
        <div data-testid="ordinary-tree" />
      </ImportProjectionGate>
    )
    const loading = screen.getByTestId('startup-readiness-loading')
    expect(loading).toBeInTheDocument()
    expect(loading.getAttribute('aria-busy')).toBe('true')
    expect(loading.getAttribute('aria-label')).toBe('startup.readiness.loading')
    expect(screen.queryByTestId('ordinary-tree')).not.toBeInTheDocument()
    expect(screen.queryByTestId('startup-readiness-error')).not.toBeInTheDocument()
  })

  it('S7.2 failed shows localized retry surface and stays gated', async () => {
    getProjection.mockResolvedValue({ ok: false, error: 'read failed' })
    const flush = vi.fn()
    render(
      <ImportProjectionGate>
        <div data-testid="ordinary-tree" />
      </ImportProjectionGate>
    )
    await runImportProjectionBoot({ apply: () => applyPendingImportProjection({ dispatch, flush }) })
    const errorSurface = await screen.findByTestId('startup-readiness-error')
    expect(errorSurface).toBeInTheDocument()
    expect(errorSurface.getAttribute('role')).toBe('alert')
    expect(screen.getByTestId('startup-readiness-retry')).toBeInTheDocument()
    expect(screen.getByText('startup.readiness.error.title')).toBeInTheDocument()
    expect(screen.getByText('startup.readiness.error.description')).toBeInTheDocument()
    expect(screen.queryByTestId('ordinary-tree')).not.toBeInTheDocument()
    expect(screen.queryByTestId('startup-readiness-loading')).not.toBeInTheDocument()
  })

  it('S7.2 retry after failure: reruns captured apply path dispatch -> flush -> ack and opens on success', async () => {
    getProjection.mockResolvedValueOnce({ ok: false, error: 'first fail' })
    getProjection.mockResolvedValueOnce({ ok: true, projection: makeProjection() })
    const flush = vi.fn().mockResolvedValue(undefined)
    ackProjection.mockResolvedValue({ ok: true })

    render(
      <ImportProjectionGate>
        <div data-testid="ordinary-tree" />
      </ImportProjectionGate>
    )
    await act(async () => {
      await runImportProjectionBoot({ apply: () => applyPendingImportProjection({ dispatch, flush }) })
    })
    await waitFor(() => expect(screen.getByTestId('startup-readiness-error')).toBeInTheDocument())
    expect(screen.queryByTestId('ordinary-tree')).not.toBeInTheDocument()

    await act(async () => {
      await retryImportProjectionReadiness()
    })
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'assistants/updateAssistants' }))
    expect(flush).toHaveBeenCalled()
    expect(ackProjection).toHaveBeenCalled()
    await waitFor(() => expect(screen.getByTestId('ordinary-tree')).toBeInTheDocument())
    expect(screen.queryByTestId('startup-readiness-error')).not.toBeInTheDocument()
  })

  it('S7.2 retry click handler via UI reruns apply and preserves ordering', async () => {
    getProjection.mockResolvedValueOnce({ ok: false, error: 'first fail' })
    getProjection.mockResolvedValueOnce({ ok: true, projection: makeProjection() })
    let resolveFlush!: () => void
    const flush = vi.fn(() => new Promise<void>((r) => (resolveFlush = r)))
    let resolveAck!: (v: unknown) => void
    ackProjection.mockImplementation(() => new Promise((r) => (resolveAck = r)))

    render(
      <ImportProjectionGate>
        <div data-testid="ordinary-tree" />
      </ImportProjectionGate>
    )
    await act(async () => {
      await runImportProjectionBoot({ apply: () => applyPendingImportProjection({ dispatch, flush }) })
    })
    await waitFor(() => expect(screen.getByTestId('startup-readiness-error')).toBeInTheDocument())

    // Click retry — gate transitions to loading while retry in flight
    fireEvent.click(screen.getByTestId('startup-readiness-retry'))
    await waitFor(() => expect(screen.getByTestId('startup-readiness-loading')).toBeInTheDocument())

    // After dispatch, flush must be called before ack (ordering)
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'assistants/updateAssistants' }))
    )
    expect(flush).toHaveBeenCalledTimes(1)
    expect(ackProjection).not.toHaveBeenCalled()

    resolveFlush()
    await waitFor(() => expect(ackProjection).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('ordinary-tree')).not.toBeInTheDocument()

    resolveAck({ ok: true })
    await waitFor(() => expect(screen.getByTestId('ordinary-tree')).toBeInTheDocument())
  })

  it('S7.2 retry failure remains gated and shows retry again (no ack before flush)', async () => {
    // First failure
    getProjection.mockResolvedValueOnce({ ok: false, error: 'first fail' })
    // Second attempt also fails before dispatch/flush
    getProjection.mockResolvedValueOnce({ ok: false, error: 'second fail' })
    const flush = vi.fn().mockResolvedValue(undefined)

    render(
      <ImportProjectionGate>
        <div data-testid="ordinary-tree" />
      </ImportProjectionGate>
    )
    await act(async () => {
      await runImportProjectionBoot({ apply: () => applyPendingImportProjection({ dispatch, flush }) })
    })
    await waitFor(() => expect(screen.getByTestId('startup-readiness-error')).toBeInTheDocument())

    await act(async () => {
      await retryImportProjectionReadiness()
    })
    expect(getImportProjectionReadinessState()).toBe('failed')
    await waitFor(() => expect(screen.getByTestId('startup-readiness-error')).toBeInTheDocument())
    expect(screen.getByTestId('startup-readiness-retry')).toBeInTheDocument()
    expect(screen.queryByTestId('ordinary-tree')).not.toBeInTheDocument()
    expect(flush).not.toHaveBeenCalled()
    expect(ackProjection).not.toHaveBeenCalled()
  })

  it('S7.2 retry flush failure remains gated (ack not called before flush)', async () => {
    getProjection.mockResolvedValue({ ok: true, projection: makeProjection() })
    let shouldFlushFail = true
    const flush = vi.fn(async () => {
      if (shouldFlushFail) throw new Error('flush down')
    })

    render(
      <ImportProjectionGate>
        <div data-testid="ordinary-tree" />
      </ImportProjectionGate>
    )
    await act(async () => {
      await runImportProjectionBoot({ apply: () => applyPendingImportProjection({ dispatch, flush }) })
    })
    expect(getImportProjectionReadinessState()).toBe('failed')
    expect(ackProjection).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByTestId('startup-readiness-error')).toBeInTheDocument())
    expect(screen.queryByTestId('ordinary-tree')).not.toBeInTheDocument()

    // Retry with same flush-failing apply stays gated, still no ack
    await act(async () => {
      await retryImportProjectionReadiness()
    })
    expect(getImportProjectionReadinessState()).toBe('failed')
    expect(ackProjection).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByTestId('startup-readiness-error')).toBeInTheDocument())

    // Now flush succeeds -> retry opens and ack is called
    shouldFlushFail = false
    ackProjection.mockResolvedValue({ ok: true })
    await act(async () => {
      await retryImportProjectionReadiness()
    })
    expect(isImportProjectionReady()).toBe(true)
    await waitFor(() => expect(screen.getByTestId('ordinary-tree')).toBeInTheDocument())
    expect(ackProjection).toHaveBeenCalled()
  })
})
