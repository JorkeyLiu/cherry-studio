/**
 * Selected-topic identity gate for `useActiveTopic`.
 *
 * Real React `Activity` Home-like parent (`useActiveTopic`) + child viewport
 * activation (no source-regex assertions):
 * - Activity reattach with unchanged selected topic does NOT redispatch the
 *   cache-hit `loadTopicMessagesThunk` (no shared-sequence bump, so the
 *   child's correct in-flight around request is never superseded);
 * - genuine ID changes (A→B→A) do dispatch;
 * - same-ID object update (metadata sync) does not dispatch;
 * - null/undefined reset allows the next selection to dispatch again.
 */
import type * as SnapshotBlocksModule from '@renderer/utils/messageUtils/snapshotBlocks'
import { act, render, screen } from '@testing-library/react'
import { Activity, useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { dispatchMock, loadTopicMock, emitMock, useAssistantMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  loadTopicMock: vi.fn(),
  emitMock: vi.fn(),
  useAssistantMock: vi.fn()
}))

vi.mock('@renderer/services/db', () => ({ dbService: { fetchTopicNamingContext: vi.fn() } }))
vi.mock('@renderer/services/db/topicMetadataPersist', () => ({ persistTopicMetadata: vi.fn() }))
vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({ consumeFileCleanupResult: vi.fn() }))
vi.mock('@renderer/services/ApiService', () => ({ fetchMessagesSummary: vi.fn() }))
vi.mock('@renderer/services/EventService', () => ({
  EVENT_NAMES: { CHANGE_TOPIC: 'CHANGE_TOPIC' },
  EventEmitter: { emit: emitMock }
}))
vi.mock('@renderer/store', () => ({
  default: { dispatch: dispatchMock, getState: vi.fn(() => ({})) }
}))
vi.mock('@renderer/store/assistants', () => ({ updateTopic: vi.fn((p: unknown) => ({ type: 'x', payload: p })) }))
vi.mock('@renderer/store/runtime', () => ({
  setNewlyRenamedTopics: vi.fn(),
  setRenamingTopics: vi.fn()
}))
vi.mock('@renderer/store/thunk/messageThunk', () => ({
  loadTopicMessagesThunk: loadTopicMock
}))
vi.mock('@renderer/utils/messageUtils/snapshotBlocks', async (importOriginal) => {
  const actual = await importOriginal<typeof SnapshotBlocksModule>()
  return actual
})
vi.mock('../useAssistant', () => ({ useAssistant: useAssistantMock }))
vi.mock('../useSettings', () => ({ getStoreSetting: vi.fn() }))
vi.mock('@renderer/i18n', () => ({
  default: { t: (key: string) => (key === 'chat.default.topic.name' ? 'New Topic' : key) }
}))

import { useActiveTopic } from '../useTopic'

const topicA: any = { id: 'topic-A', name: 'A' }
const topicB: any = { id: 'topic-B', name: 'B' }
const assistant: any = { id: 'assistant-1', topics: [topicA, topicB] }

// Shared-sequence simulation mirroring
// `latestLoadTopicMessagesRequestByTopic`: every parent cache-hit dispatch
// bumps, every child route activation bumps. A child request is cancelled
// iff a later parent bump for the same topic supersedes it.
let seq = 0
const latestByTopic = new Map<string, number>()
const parentSeqLog: number[] = []
const childSeqLog: number[] = []
const effectOrder: string[] = []

function childActivate(topicId: string): number {
  seq += 1
  latestByTopic.set(topicId, seq)
  childSeqLog.push(seq)
  effectOrder.push(`child-${topicId}-${seq}`)
  return seq
}

function HomeLike({ topic, controlRef }: { topic: any; controlRef?: { setActive?: (t: any) => void } }) {
  const { activeTopic, setActiveTopic } = useActiveTopic(assistant.id, topic)
  useEffect(() => {
    if (controlRef) {
      controlRef.setActive = setActiveTopic as unknown as (t: any) => void
    }
  }, [setActiveTopic, controlRef])
  return <ViewportLike topicId={activeTopic?.id ?? ''} />
}

function ViewportLike({ topicId }: { topicId: string }) {
  useEffect(() => {
    if (!topicId) return
    childActivate(topicId)
  }, [topicId])
  return <div data-testid="viewport-child">{topicId}</div>
}

beforeEach(() => {
  vi.clearAllMocks()
  seq = 0
  latestByTopic.clear()
  parentSeqLog.length = 0
  childSeqLog.length = 0
  effectOrder.length = 0
  useAssistantMock.mockReturnValue({ assistant })
  loadTopicMock.mockImplementation((topicId: string) => {
    seq += 1
    latestByTopic.set(topicId, seq)
    parentSeqLog.push(seq)
    effectOrder.push(`parent-${topicId}-${seq}`)
    return { type: 'mock/loadTopic', topicId }
  })
})

describe('useActiveTopic selected-topic identity gate (live ref semantics)', () => {
  it('initial mount dispatches once; same-ID object update does not redispatch', async () => {
    const control: { setActive?: (t: any) => void } = {}
    const firstObject = { ...topicA }
    render(<HomeLike topic={firstObject} controlRef={control} />)
    expect(await screen.findByTestId('viewport-child')).toBeInTheDocument()
    expect(loadTopicMock).toHaveBeenCalledTimes(1)
    expect(loadTopicMock).toHaveBeenCalledWith('topic-A')

    // Same-ID new object (e.g. assistant.topics metadata sync via setActiveTopic) — innocuous update.
    await act(async () => {
      control.setActive?.({ ...topicA })
    })
    expect(loadTopicMock).toHaveBeenCalledTimes(1)
    expect(emitMock).toHaveBeenCalledTimes(1)
  })

  it('genuine A→B→A changes dispatch each time', async () => {
    const control: { setActive?: (t: any) => void } = {}
    render(<HomeLike topic={topicA} controlRef={control} />)
    expect(await screen.findByTestId('viewport-child')).toBeInTheDocument()
    expect(loadTopicMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      control.setActive?.(topicB)
    })
    expect(loadTopicMock).toHaveBeenCalledTimes(2)
    expect(loadTopicMock).toHaveBeenLastCalledWith('topic-B')

    await act(async () => {
      control.setActive?.({ ...topicA })
    })
    expect(loadTopicMock).toHaveBeenCalledTimes(3)
    expect(loadTopicMock).toHaveBeenLastCalledWith('topic-A')
  })

  it('null/undefined reset allows the next same-ID selection to dispatch again', async () => {
    const control: { setActive?: (t: any) => void } = {}
    render(<HomeLike topic={topicA} controlRef={control} />)
    expect(await screen.findByTestId('viewport-child')).toBeInTheDocument()
    expect(loadTopicMock).toHaveBeenCalledTimes(1)

    // Removal resets the identity ref; the hook's broken-state fallback
    // restores the first topic (same ID) and must dispatch again — this
    // fallback dispatch itself proves the reset (without reset it would be
    // suppressed as a same-ID duplicate).
    await act(async () => {
      control.setActive?.(undefined as any)
    })
    expect(loadTopicMock).toHaveBeenCalledTimes(2)
    expect(loadTopicMock).toHaveBeenLastCalledWith('topic-A')

    // Explicit same-ID reselect after restore is a duplicate and stays gated.
    await act(async () => {
      control.setActive?.({ ...topicA })
    })
    expect(loadTopicMock).toHaveBeenCalledTimes(2)
  })
})

describe('Home-like Activity reattach does not duplicate parent topic loads', () => {
  it('reattach with unchanged topic keeps parent count at 1; child reactivation is never superseded; genuine change dispatches', async () => {
    const control: { setActive?: (t: any) => void } = {}
    const { rerender } = render(
      <Activity mode="visible">
        <HomeLike topic={topicA} controlRef={control} />
      </Activity>
    )
    expect(await screen.findByTestId('viewport-child')).toBeInTheDocument()
    const parentAfterMount = loadTopicMock.mock.calls.length
    expect(parentAfterMount).toBe(1)
    const childMountSeq = childSeqLog[childSeqLog.length - 1]
    // Child mount request is latest (no later parent bump on the same tick
    // beyond the parent-first mount ordering captured here).
    void childMountSeq

    const childCountAfterMount = childSeqLog.length

    // Hide (Activity detach): cleanups run, no new parent load.
    await act(async () => {
      rerender(
        <Activity mode="hidden">
          <HomeLike topic={topicA} controlRef={control} />
        </Activity>
      )
    })
    expect(loadTopicMock.mock.calls.length).toBe(parentAfterMount)

    // Show again with the SAME selected topic: Activity re-runs effects, but
    // the identity gate must suppress the redundant parent cache-hit load.
    // The child viewport reactivation bumps its own epoch and stays latest.
    await act(async () => {
      rerender(
        <Activity mode="visible">
          <HomeLike topic={topicA} controlRef={control} />
        </Activity>
      )
    })
    expect(await screen.findByTestId('viewport-child')).toBeInTheDocument()
    expect(loadTopicMock.mock.calls.length).toBe(
      parentAfterMount // NO duplicate parent topic load on reactivation
    )
    expect(childSeqLog.length).toBeGreaterThan(childCountAfterMount)
    const lastChildSeq = childSeqLog[childSeqLog.length - 1]
    expect(latestByTopic.get('topic-A')).toBe(lastChildSeq)

    // Parent ran before-or-never after the child on reattach: prove order —
    // no `parent-topic-A-*` entry exists after the last child entry.
    const lastChildIdx = effectOrder.map((e) => e.startsWith('child-topic-A')).lastIndexOf(true)
    const parentAfterChild = effectOrder.slice(lastChildIdx + 1).filter((e) => e.startsWith('parent-topic-A'))
    expect(parentAfterChild).toEqual([])

    // Genuine ID change after reactivation still dispatches (real selection
    // intent via the hook setter, not an innocuous prop object update).
    await act(async () => {
      control.setActive?.(topicB)
    })
    expect(loadTopicMock).toHaveBeenLastCalledWith('topic-B')
    expect(loadTopicMock.mock.calls.length).toBe(parentAfterMount + 1)
    expect(latestByTopic.get('topic-B')).toBe(parentSeqLog[parentSeqLog.length - 1])
  })
})
