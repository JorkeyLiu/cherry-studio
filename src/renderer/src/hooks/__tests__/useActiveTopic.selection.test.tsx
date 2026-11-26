/**
 * Selected-topic identity gate for `useActiveTopic`.
 *
 * The hook owns SELECTION only (logical topic + metadata). Message activation
 * reads belong to the chat surface (`ChatRouteStructureProvider`), so this
 * suite asserts the remaining contract through real React `Activity`
 * Home-like parent + child selection:
 * - Activity reattach with an unchanged selected topic does NOT re-emit the
 *   selection notification;
 * - genuine ID changes (A→B→A) do emit each time;
 * - same-ID object update (metadata sync) does not emit;
 * - null/undefined reset allows the next same-ID selection to notify again;
 * - default selection skips pinned topics.
 * No content loading is the hook's duty, so nothing here asserts a thunk.
 */
import type * as SnapshotBlocksModule from '@renderer/utils/messageUtils/snapshotBlocks'
import { act, render, screen } from '@testing-library/react'
import { Activity, useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { emitMock, dispatchMock, useAssistantMock } = vi.hoisted(() => ({
  emitMock: vi.fn(),
  dispatchMock: vi.fn(),
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

const effectOrder: string[] = []

function HomeLike({ topic, controlRef }: { topic: any; controlRef?: { setActive?: (t: any) => void } }) {
  const { activeTopic, setActiveTopic } = useActiveTopic(assistant.id, topic)
  useEffect(() => {
    effectOrder.push(`parent-${activeTopic?.id ?? 'none'}`)
    return () => {
      effectOrder.push(`cleanup-${activeTopic?.id ?? 'none'}`)
    }
  }, [activeTopic])
  useEffect(() => {
    if (controlRef) {
      controlRef.setActive = setActiveTopic as unknown as (t: any) => void
    }
  }, [setActiveTopic, controlRef])
  return <ViewportLike topicId={activeTopic?.id ?? ''} />
}

function ViewportLike({ topicId }: { topicId: string }) {
  useEffect(() => {
    effectOrder.push(`child-${topicId}`)
  }, [topicId])
  return <div data-testid="viewport-child">{topicId}</div>
}

beforeEach(() => {
  vi.clearAllMocks()
  effectOrder.length = 0
  useAssistantMock.mockReturnValue({ assistant })
})

function DefaultLike({ assistantId, topic }: { assistantId: string; topic?: any }) {
  const { activeTopic } = useActiveTopic(assistantId, topic)
  return <div data-testid="default-child">{activeTopic?.id ?? ''}</div>
}

function mockAssistantTopics(assistantId: string, topics: any[]) {
  useAssistantMock.mockReturnValue({ assistant: { id: assistantId, topics } })
}

/** Selected topic ids actually notified, in emit order. */
function emittedTopicIds(): Array<string | undefined> {
  return emitMock.mock.calls.map((call) => (call[1] as { id?: string } | undefined)?.id)
}

/** The identity gate never notifies the same selected id twice in a row. */
function expectNoConsecutiveDuplicateNotifications(): void {
  const ids = emittedTopicIds()
  const duplicates = ids.slice(1).filter((id, index) => id === ids[index])
  expect(duplicates).toEqual([])
}

describe('useActiveTopic default selection skips pinned topics', () => {
  it('initial mount without an explicit topic selects the first ordinary topic', async () => {
    mockAssistantTopics('assistant-default', [
      { id: 'pinned-1', name: 'P1', pinned: true },
      { id: 'ordinary-1', name: 'O1' },
      { id: 'ordinary-2', name: 'O2' }
    ])
    render(<DefaultLike assistantId="assistant-default" />)
    expect(await screen.findByText('ordinary-1')).toBeInTheDocument()
    expect(emitMock).toHaveBeenLastCalledWith('CHANGE_TOPIC', expect.objectContaining({ id: 'ordinary-1' }))
    expectNoConsecutiveDuplicateNotifications()
  })

  it('falls back to topics[0] when every topic is pinned', async () => {
    mockAssistantTopics('assistant-all-pinned', [
      { id: 'all-pinned-1', name: 'P1', pinned: true },
      { id: 'all-pinned-2', name: 'P2', pinned: true }
    ])
    render(<DefaultLike assistantId="assistant-all-pinned" />)
    expect(await screen.findByText('all-pinned-1')).toBeInTheDocument()
    expect(emitMock).toHaveBeenLastCalledWith('CHANGE_TOPIC', expect.objectContaining({ id: 'all-pinned-1' }))
    expectNoConsecutiveDuplicateNotifications()
  })

  it('an explicit pinned topic stays selected', async () => {
    const pinned = { id: 'explicit-pinned', name: 'P', pinned: true }
    mockAssistantTopics('assistant-explicit', [pinned, { id: 'ordinary-9', name: 'O9' }])
    render(<DefaultLike assistantId="assistant-explicit" topic={pinned} />)
    expect(await screen.findByText('explicit-pinned')).toBeInTheDocument()
    expect(emitMock).toHaveBeenLastCalledWith('CHANGE_TOPIC', expect.objectContaining({ id: 'explicit-pinned' }))
    expectNoConsecutiveDuplicateNotifications()
  })

  it('a stale selection falls back to the first ordinary topic', async () => {
    mockAssistantTopics('assistant-fresh', [
      { id: 'fresh-pinned', name: 'P', pinned: true },
      { id: 'fresh-ordinary', name: 'O' }
    ])
    render(<DefaultLike assistantId="assistant-fresh" topic={{ id: 'ghost', name: 'G' }} />)
    expect(await screen.findByText('fresh-ordinary')).toBeInTheDocument()
    expect(emitMock).toHaveBeenLastCalledWith('CHANGE_TOPIC', expect.objectContaining({ id: 'fresh-ordinary' }))
    expectNoConsecutiveDuplicateNotifications()
  })
})

describe('useActiveTopic selected-topic identity gate (live ref semantics)', () => {
  it('initial mount notifies once; same-ID object update does not notify', async () => {
    const control: { setActive?: (t: any) => void } = {}
    const firstObject = { ...topicA }
    render(<HomeLike topic={firstObject} controlRef={control} />)
    expect(await screen.findByTestId('viewport-child')).toBeInTheDocument()
    expect(emitMock).toHaveBeenCalledTimes(1)
    expect(emitMock).toHaveBeenLastCalledWith('CHANGE_TOPIC', expect.objectContaining({ id: 'topic-A' }))

    // Same-ID new object (e.g. assistant.topics metadata sync via setActiveTopic) — innocuous update.
    await act(async () => {
      control.setActive?.({ ...topicA })
    })
    expect(emitMock).toHaveBeenCalledTimes(1)
  })

  it('genuine A→B→A changes notify each time', async () => {
    const control: { setActive?: (t: any) => void } = {}
    render(<HomeLike topic={topicA} controlRef={control} />)
    expect(await screen.findByTestId('viewport-child')).toBeInTheDocument()
    expect(emitMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      control.setActive?.(topicB)
    })
    expect(emitMock).toHaveBeenCalledTimes(2)
    expect(emitMock).toHaveBeenLastCalledWith('CHANGE_TOPIC', expect.objectContaining({ id: 'topic-B' }))

    await act(async () => {
      control.setActive?.({ ...topicA })
    })
    expect(emitMock).toHaveBeenCalledTimes(3)
    expect(emitMock).toHaveBeenLastCalledWith('CHANGE_TOPIC', expect.objectContaining({ id: 'topic-A' }))
    // Selection never loads content itself: no thunk reaches the store, so
    // nothing here can bump a same-topic sequence behind the surface's back.
    expect(dispatchMock.mock.calls.filter((call) => typeof call[0] === 'function')).toEqual([])
  })

  it('null/undefined reset allows the next same-ID selection to notify again', async () => {
    const control: { setActive?: (t: any) => void } = {}
    render(<HomeLike topic={topicA} controlRef={control} />)
    expect(await screen.findByTestId('viewport-child')).toBeInTheDocument()
    expect(emitMock).toHaveBeenCalledTimes(1)

    // Removal resets the identity ref; the hook's broken-state fallback
    // restores the first topic (same ID) and must notify again — this
    // fallback notification itself proves the reset (without reset it would be
    // suppressed as a same-ID duplicate).
    await act(async () => {
      control.setActive?.(undefined as any)
    })
    expect(emitMock).toHaveBeenCalledTimes(2)
    expect(emitMock).toHaveBeenLastCalledWith('CHANGE_TOPIC', expect.objectContaining({ id: 'topic-A' }))

    // Explicit same-ID reselect after restore is a duplicate and stays gated.
    await act(async () => {
      control.setActive?.({ ...topicA })
    })
    expect(emitMock).toHaveBeenCalledTimes(2)
  })
})

describe('Home-like Activity reattach does not duplicate selection notifications', () => {
  it('reattach with unchanged topic keeps notify count at 1; genuine change notifies again', async () => {
    const control: { setActive?: (t: any) => void } = {}
    const { rerender } = render(
      <Activity mode="visible">
        <HomeLike topic={topicA} controlRef={control} />
      </Activity>
    )
    expect(await screen.findByTestId('viewport-child')).toBeInTheDocument()
    const notifyAfterMount = emitMock.mock.calls.length
    expect(notifyAfterMount).toBe(1)

    // Hide (Activity detach): cleanups run, no new notification.
    await act(async () => {
      rerender(
        <Activity mode="hidden">
          <HomeLike topic={topicA} controlRef={control} />
        </Activity>
      )
    })
    expect(emitMock.mock.calls.length).toBe(notifyAfterMount)

    // Show again with the SAME selected topic: Activity re-runs effects, but
    // the identity gate must suppress the redundant notification.
    await act(async () => {
      rerender(
        <Activity mode="visible">
          <HomeLike topic={topicA} controlRef={control} />
        </Activity>
      )
    })
    expect(await screen.findByTestId('viewport-child')).toBeInTheDocument()
    expect(emitMock.mock.calls.length).toBe(notifyAfterMount)

    // Genuine ID change after reactivation still notifies (real selection
    // intent via the hook setter, not an innocuous prop object update).
    await act(async () => {
      control.setActive?.(topicB)
    })
    expect(emitMock).toHaveBeenLastCalledWith('CHANGE_TOPIC', expect.objectContaining({ id: 'topic-B' }))
    expect(emitMock.mock.calls.length).toBe(notifyAfterMount + 1)
  })
})
