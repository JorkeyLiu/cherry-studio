/**
 * ImportProjectionGate tests (LOCK-001, LOCK-PROJECTION, LOCK-009).
 *
 * The ordinary chat tree must NOT mount — and no topic priming may run —
 * until the one-shot L2 navigation projection has safely settled. These
 * tests exercise the REAL gate against the REAL `applyPendingImportProjection`
 * + `runImportProjectionBoot` wiring with deferred IPC/flush/ack timing: the
 * gate closing is never mocked away.
 */

import { act, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchMessagesMock } = vi.hoisted(() => ({
  fetchMessagesMock: vi.fn().mockResolvedValue({ messages: [], blocks: [] })
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
vi.mock('@renderer/services/db', () => ({
  dbService: { fetchMessages: fetchMessagesMock }
}))

import { applyPendingImportProjection } from '@renderer/services/importProjection'
import {
  getImportProjectionReadinessState,
  isImportProjectionReady,
  resetImportProjectionReadiness,
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
    fetchMessagesMock.mockReset().mockResolvedValue({ messages: [], blocks: [] })
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
    const notifyMain = vi.fn()

    render(
      <ImportProjectionGate>
        <div data-testid="ordinary-tree" />
      </ImportProjectionGate>
    )
    // Gate closed while readiness is pending.
    expect(screen.queryByTestId('ordinary-tree')).not.toBeInTheDocument()

    await act(async () => {
      await runImportProjectionBoot({
        apply: () => applyPendingImportProjection({ dispatch, flush }),
        notifyMain
      })
    })

    expect(getProjection).toHaveBeenCalledTimes(1)
    // Genuine no-pending: nothing applied, nothing flushed, nothing acked.
    expect(dispatch).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
    expect(ackProjection).not.toHaveBeenCalled()
    expect(notifyMain).toHaveBeenCalledTimes(1)
    expect(isImportProjectionReady()).toBe(true)

    await waitFor(() => expect(screen.getByTestId('ordinary-tree')).toBeInTheDocument())
  })

  it('#2 pending projection: children stay unmounted until updateAssistants + flush + ack complete', async () => {
    let resolveProjection!: (value: unknown) => void
    let resolveFlush!: () => void
    let resolveAck!: (value: unknown) => void
    getProjection.mockImplementation(() => new Promise((resolve) => (resolveProjection = resolve)))
    const flush = vi.fn(() => new Promise<void>((resolve) => (resolveFlush = resolve)))
    ackProjection.mockImplementation(() => new Promise((resolve) => (resolveAck = resolve)))

    const boot = runImportProjectionBoot({
      apply: () => applyPendingImportProjection({ dispatch, flush }),
      notifyMain: vi.fn()
    })

    render(
      <ImportProjectionGate>
        <div data-testid="ordinary-tree" />
      </ImportProjectionGate>
    )
    expect(screen.queryByTestId('ordinary-tree')).not.toBeInTheDocument()

    // 1. Projection read resolves → replace-all dispatch runs; flush starts.
    resolveProjection({ ok: true, projection: makeProjection() })
    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'assistants/updateAssistants' }))
    })
    expect(flush).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('ordinary-tree')).not.toBeInTheDocument()

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

    const result = await runImportProjectionBoot({
      apply: () => applyPendingImportProjection({ dispatch, flush }),
      notifyMain: vi.fn()
    })

    expect(result).toBe('failed')
    expect(isImportProjectionReady()).toBe(false)
    expect(getImportProjectionReadinessState()).toBe('failed')
    expect(dispatch).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
    expect(ackProjection).not.toHaveBeenCalled()
    // The tree stays gated — no stale navigation mounts after an API failure.
    expect(screen.queryByTestId('ordinary-tree')).not.toBeInTheDocument()
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
      apply: () => applyPendingImportProjection({ dispatch, flush }),
      notifyMain: vi.fn()
    })

    expect(result).toBe('failed')
    expect(isImportProjectionReady()).toBe(false)
    expect(ackProjection).not.toHaveBeenCalled()
    expect(screen.queryByTestId('ordinary-tree')).not.toBeInTheDocument()
  })

  it('#5 regression: no stale-topic message loading before the projection completes', async () => {
    let resolveProjection!: (value: unknown) => void
    getProjection.mockImplementation(() => new Promise((resolve) => (resolveProjection = resolve)))
    const flush = vi.fn().mockResolvedValue(undefined)

    const boot = runImportProjectionBoot({
      apply: () => applyPendingImportProjection({ dispatch, flush }),
      notifyMain: vi.fn()
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
    expect(fetchMessagesMock).not.toHaveBeenCalled()

    // Projection completes (replace-all → flush → ack) → the tree opens.
    resolveProjection({ ok: true, projection: makeProjection() })
    await act(async () => {
      await boot
    })
    expect(isImportProjectionReady()).toBe(true)
    await waitFor(() => expect(screen.getByTestId('priming-probe')).toBeInTheDocument())
    // Ordinary priming resumes after the gate opens (LOCK-009).
    await waitFor(() => expect(fetchMessagesMock).toHaveBeenCalledWith('t-stale-pre-import'))
  })
})
