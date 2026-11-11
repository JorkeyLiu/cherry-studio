/**
 * Real assistant slice: the topic ordering preference lives on the assistant
 * next to the ordered topic array (renderer Redux only — no Main/IPC/SQLite
 * field), and NO topic metadata write may move a topic. The authoritative
 * "by update time" position is driven exclusively by the latest message
 * instant observed at the message write seam (see topicMessageTimes tests).
 */
import assistantsReducer, {
  addTopic,
  updateAssistant,
  updateTopic,
  updateTopics,
  updateTopicUpdatedAt
} from '@renderer/store/assistants'
import type { Topic, TopicOrderMode } from '@renderer/types'
import { describe, expect, it } from 'vitest'

const topic = (id: string, createdAt: string, updatedAt: string, pinned = false): Topic =>
  ({
    id,
    name: id,
    assistantId: 'a1',
    createdAt,
    updatedAt,
    pinned,
    messages: []
  }) as unknown as Topic

const pinPinned = topic('p1', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', true)
const a = topic('a', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
const b = topic('b', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')
const c = topic('c', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')

function stateWith(topicOrderMode?: TopicOrderMode) {
  const assistant: any = {
    id: 'a1',
    name: 'A',
    prompt: '',
    type: 'assistant',
    topics: [pinPinned, a, b, c].map((item) => ({ ...item }))
  }
  if (topicOrderMode !== undefined) {
    assistant.topicOrderMode = topicOrderMode
  }
  return {
    agentDefaults: undefined,
    assistantDefaults: {},
    assistants: [assistant],
    tagsOrder: [],
    collapsedTags: {},
    presets: [],
    unifiedListOrder: []
  } as any
}

const reduce = (state: any, action: any) => assistantsReducer(state, action) as any
const topicIds = (state: any) => state.assistants[0].topics.map((item: Topic) => item.id)
const topicsOf = (state: any): Topic[] => state.assistants[0].topics

describe('legacy persisted state compatibility', () => {
  it('an assistant without a topicOrderMode reads as manual and never auto-promotes', () => {
    const state = stateWith()
    expect(state.assistants[0].topicOrderMode).toBeUndefined()

    const next = reduce(state, updateTopicUpdatedAt({ topicId: 'c' }))
    expect(topicIds(next)).toEqual(['p1', 'a', 'b', 'c'])
    // The timestamp write itself still happens.
    const updated = topicsOf(next).find((item) => item.id === 'c')!
    expect(updated.updatedAt).not.toBe(c.updatedAt)
  })
})

describe('topic metadata writes never reorder topics', () => {
  it('updateTopicUpdatedAt bumps only the write clock, under both modes', () => {
    for (const mode of [undefined, 'manual', 'updated'] as const) {
      const state = mode ? stateWith(mode) : stateWith()
      const next = reduce(state, updateTopicUpdatedAt({ topicId: 'c' }))
      expect(topicIds(next)).toEqual(['p1', 'a', 'b', 'c'])
      expect(topicsOf(next).find((item) => item.id === 'c')!.updatedAt).not.toBe(c.updatedAt)
      // Other topics keep their own timestamps and position.
      expect(topicsOf(next).find((item) => item.id === 'a')!.updatedAt).toBe(a.updatedAt)
    }
  })

  it('a rename/auto-name metadata write (updateTopic) never moves the topic', () => {
    const state = stateWith('updated')
    const next = reduce(state, updateTopic({ assistantId: 'a1', topic: { ...c, name: 'renamed' } }))
    expect(topicIds(next)).toEqual(['p1', 'a', 'b', 'c'])
    expect(topicsOf(next).find((item) => item.id === 'c')!.name).toBe('renamed')
  })

  it('a self pin flip never reorders either (the pin rule owns placement)', () => {
    const state = stateWith('updated')
    const next = reduce(state, updateTopic({ assistantId: 'a1', topic: { ...c, pinned: true } }))
    expect(topicIds(next)).toEqual(['p1', 'a', 'b', 'c'])
  })

  it('keeps the existing prepend behavior for new topics', () => {
    const state = stateWith('updated')
    const fresh = topic('new', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
    const next = reduce(state, addTopic({ assistantId: 'a1', topic: fresh }))
    expect(topicIds(next)[0]).toBe('new')
  })

  it('a manual assistant keeps the manual drag order through later no-op writes', () => {
    const state = reduce(stateWith(), updateAssistant({ id: 'a1', topicOrderMode: 'manual' }))
    const dragged = reduce(state, updateTopics({ assistantId: 'a1', topics: [pinPinned, c, a, b] }))
    expect(topicIds(dragged)).toEqual(['p1', 'c', 'a', 'b'])
    expect(topicIds(reduce(dragged, updateTopicUpdatedAt({ topicId: 'b' })))).toEqual(['p1', 'c', 'a', 'b'])
  })
})

describe('topicOrderMode persistence', () => {
  it('stores the renderer-owned preference on the assistant and keeps the topic array untouched', () => {
    const state = stateWith()
    const next = reduce(state, updateAssistant({ id: 'a1', topicOrderMode: 'updated' }))

    expect(next.assistants[0].topicOrderMode).toBe('updated')
    expect(topicIds(next)).toEqual(['p1', 'a', 'b', 'c'])
    expect(Object.keys(next.assistants[0])).toEqual(expect.arrayContaining(['topicOrderMode', 'topics']))
  })

  it('can return to manual for the one-shot creation-time order', () => {
    const enabled = reduce(stateWith(), updateAssistant({ id: 'a1', topicOrderMode: 'updated' }))
    const disabled = reduce(enabled, updateAssistant({ id: 'a1', topicOrderMode: 'manual' }))
    expect(disabled.assistants[0].topicOrderMode).toBe('manual')
    expect(topicIds(disabled)).toEqual(['p1', 'a', 'b', 'c'])
  })

  it('a manual drag does not disable the policy and its order stays authoritative', () => {
    const state = stateWith('updated')
    const dragged = reduce(state, updateTopics({ assistantId: 'a1', topics: [pinPinned, c, b, a] }))
    expect(topicIds(dragged)).toEqual(['p1', 'c', 'b', 'a'])
    expect(dragged.assistants[0].topicOrderMode).toBe('updated')
  })
})
