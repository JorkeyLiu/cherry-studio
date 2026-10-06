/**
 * Boot integrity with the REAL assistantTopicIntegrity service (not a mock).
 *
 * Regression for the E2E-found wiring fault: the boot finalizer runs BEFORE
 * ImportProjectionGate READY settles, so the default `isImportProjectionReady`
 * guard would no-op the entire sweep. The finalizer therefore passes the
 * scoped boot override (`importReady: () => true` — capability loaded, UI not
 * yet ready). This test proves the actual production call chain against the
 * real store module:
 *
 * - the real sweep invokes the Main IPC while the global UI gate is still
 *   pending and BEFORE readiness settles;
 * - while the Main promise is held the gate stays pending;
 * - on resolve the wire is dispatched, flushed, and READY settles;
 * - a replay against the same Main state reuses the same topic id with no
 *   duplicate (stable reuse, zero new creates).
 *
 * Only the import-apply outcome, the fresh-bootstrap ensure, and the Main
 * IPC are controlled fakes; the sweep, reader, dispatch, flush, and gate
 * are production code. No E2E control input, no manual topic dispatch.
 */

import { IpcChannel } from '@shared/IpcChannel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as TopicTrashLifecycle from '../../services/db/topicTrashLifecycle'

const { mockApplyProjection, mockEnsureOrdinaryTopicOwnership, mockEnsureMain } = vi.hoisted(() => ({
  mockApplyProjection: vi.fn(),
  mockEnsureOrdinaryTopicOwnership: vi.fn(),
  mockEnsureMain: vi.fn()
}))

vi.mock('../../services/importProjection', () => ({
  applyPendingImportProjection: (...args: unknown[]) => mockApplyProjection(...args)
}))

vi.mock('../../services/db/topicTrashLifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof TopicTrashLifecycle>()
  return {
    ...actual,
    ensureOrdinaryTopicOwnership: (...args: unknown[]) => mockEnsureOrdinaryTopicOwnership(...args)
  }
})

vi.mock('../../services/db', () => ({
  dbService: {
    ensureAssistantTopics: (...args: unknown[]) => mockEnsureMain(...args)
  }
}))

function installFreshLocalStorage(): void {
  const backing = new Map<string, string>()
  const mock = {
    getItem: (key: string): string | null => (backing.has(key) ? (backing.get(key) as string) : null),
    setItem: (key: string, value: string): void => {
      backing.set(key, String(value))
    },
    removeItem: (key: string): void => {
      backing.delete(key)
    },
    clear: (): void => {
      backing.clear()
    },
    key: (index: number): string | null => [...backing.keys()][index] ?? null,
    get length(): number {
      return backing.size
    }
  }
  vi.stubGlobal('localStorage', mock)
  try {
    Object.defineProperty(window, 'localStorage', { value: mock, configurable: true, writable: true })
  } catch {}
}

describe('store boot integrity with the live normalizer service', () => {
  let invokeSpy: ReturnType<typeof vi.fn>
  let createdPersistors: Array<{ pause: () => void }> = []
  let resolveApply!: (value: boolean) => void
  let resolveMain!: (value: { topics: Array<Record<string, unknown>>; created: boolean }) => void
  const mainCalls: string[][] = []

  beforeEach(() => {
    vi.resetModules()
    installFreshLocalStorage()
    mainCalls.length = 0
    mockApplyProjection.mockReset()
    mockApplyProjection.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveApply = resolve
        })
    )
    mockEnsureOrdinaryTopicOwnership.mockReset()
    mockEnsureOrdinaryTopicOwnership.mockResolvedValue(undefined)
    mockEnsureMain.mockReset()
    mockEnsureMain.mockImplementation(
      (assistantId: string, candidateTopicId: string, candidateName?: string | null) =>
        new Promise((resolve) => {
          mainCalls.push([assistantId, candidateTopicId, String(candidateName)])
          resolveMain = resolve as (value: { topics: Array<Record<string, unknown>>; created: boolean }) => void
        })
    )
    ;(window.api as { getAppInfo?: unknown }).getAppInfo = vi.fn().mockResolvedValue({ notesPath: '/mock/notes' })
    invokeSpy = vi.mocked(window.electron.ipcRenderer.invoke)
    invokeSpy.mockClear()
  })

  afterEach(() => {
    for (const persistor of createdPersistors) {
      try {
        persistor.pause()
      } catch {}
    }
    createdPersistors = []
    localStorage.clear()
  })

  it('real sweep calls Main while the UI gate is pending and flushes the repair before READY', async () => {
    const storeModule = await import('../index')
    createdPersistors.push(storeModule.persistor)
    const { updateTopics } = await import('../assistants')
    const { getImportProjectionReadinessState, isImportProjectionReady } = await import(
      '../../services/importProjectionReadiness'
    )

    // Notify fires immediately at rehydration; the apply is still deferred.
    await vi.waitFor(() => {
      expect(invokeSpy).toHaveBeenCalledWith(IpcChannel.ReduxStoreReady)
    })
    expect(mockApplyProjection).toHaveBeenCalledTimes(1)

    // Empty the fresh default assistant's topics while the apply is pending —
    // the verified post-apply fixture (import left zero live topics).
    const before = storeModule.default.getState().assistants?.assistants ?? []
    expect(before.length).toBeGreaterThan(0)
    const targetId = before[0].id
    storeModule.default.dispatch(updateTopics({ assistantId: targetId, topics: [] }))

    // Settle the apply: the finalizer runs the REAL sweep.
    resolveApply(false)
    await vi.waitFor(() => {
      expect(mockEnsureMain).toHaveBeenCalledTimes(1)
    })
    // The actual Main IPC fired while the global UI gate was still pending
    // and BEFORE readiness settled — the scoped boot override, not a no-op.
    expect(isImportProjectionReady()).toBe(false)
    expect(getImportProjectionReadinessState()).toBe('pending')
    expect(mainCalls[0][0]).toBe(targetId)
    expect(mainCalls[0][1].length).toBeGreaterThan(0)

    // While the Main promise is held the gate stays pending (Chat unavailable).
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(getImportProjectionReadinessState()).toBe('pending')

    // Resolve with ONE authoritative wire: dispatched, flushed, then READY.
    const now = new Date().toISOString()
    const wireId = mainCalls[0][1]
    await (async () => {
      const readyWait = vi.waitFor(() => {
        expect(getImportProjectionReadinessState()).toBe('ready')
      })
      resolveMain({
        topics: [
          {
            id: wireId,
            assistantId: targetId,
            name: 'Default Topic',
            createdAt: now,
            updatedAt: now
          }
        ],
        created: true
      })
      await readyWait
    })()
    const topics = (storeModule.default.getState().assistants?.assistants ?? []).find(
      (a: { id: string }) => a.id === targetId
    )?.topics as Array<{ id: string }>
    expect(topics?.map((t) => t.id)).toEqual([wireId])
    expect(invokeSpy).toHaveBeenCalledTimes(1)

    // Replay: same profile, store emptied again, Main already owns the row —
    // the live sweep reuses the SAME id with zero new creates and no dup.
    storeModule.default.dispatch(updateTopics({ assistantId: targetId, topics: [] }))
    const { ensureAllEmptyAssistantsTopics } = await import('../../services/assistantTopicIntegrity')
    const { addTopic } = await import('../assistants')
    mockEnsureMain.mockImplementation(async (assistantId: string) => ({
      topics: [{ id: wireId, assistantId, name: 'Default Topic', createdAt: now, updatedAt: now }],
      created: false
    }))
    const { repaired } = await ensureAllEmptyAssistantsTopics({
      reader: {
        findAssistant: (id: string) =>
          (storeModule.default.getState().assistants?.assistants ?? []).find((a: { id: string }) => a.id === id),
        listAssistants: () => storeModule.default.getState().assistants?.assistants ?? []
      },
      ensure: (assistantId, candidateTopicId, candidateName) =>
        mockEnsureMain(assistantId, candidateTopicId, candidateName) as Promise<{
          topics: Array<{
            id: string
            assistantId?: string | null
            name?: string | null
          }>
          created: boolean
        }>,
      dispatchAddTopic: (assistantId, topic) => {
        storeModule.default.dispatch(addTopic({ assistantId, topic: topic as never }))
      }
    })
    expect(repaired).toEqual([targetId])
    expect(mockEnsureMain).toHaveBeenCalledTimes(2)
    // Different candidate on replay, same authoritative id back, still 1 row.
    const replayCandidate = mockEnsureMain.mock.calls[1][1] as string
    expect(replayCandidate).toBeTruthy()
    expect(replayCandidate).not.toBe(wireId)
    const replayed = (storeModule.default.getState().assistants?.assistants ?? []).find(
      (a: { id: string }) => a.id === targetId
    )?.topics as Array<{ id: string }>
    expect(replayed?.map((t) => t.id)).toEqual([wireId])
  })
})
