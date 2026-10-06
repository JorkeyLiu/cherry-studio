/**
 * assistantTopicIntegrity — application-layer normalizer (spec B/D).
 * No store/SQLite imports: pure injected deps.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  ensureAllEmptyAssistantsTopics,
  ensureAssistantTopicsIntegrity,
  isRealEmptyTopicList
} from '../assistantTopicIntegrity'

function readerOf(assistants: Array<{ id: string; topics?: unknown; model?: unknown }>) {
  const list = assistants.map((a) => ({ ...a }))
  return {
    findAssistant: (id: string) => list.find((a) => a.id === id),
    listAssistants: () => list.map((a) => ({ id: a.id, topics: a.topics }))
  }
}

describe('isRealEmptyTopicList', () => {
  it('detects [] but never undefined loading as empty', () => {
    expect(isRealEmptyTopicList([])).toBe(true)
    expect(isRealEmptyTopicList(undefined)).toBe(false)
    expect(isRealEmptyTopicList([{ id: 't-1' }])).toBe(false)
  })
})

describe('ensureAssistantTopicsIntegrity', () => {
  it('repairs a really-empty list via Main and merges without touching model/config', async () => {
    const dispatched: Array<{ assistantId: string; topic: { id: string; name: string } }> = []
    const reader = readerOf([{ id: 'a-1', topics: [] }])
    const ensure = vi.fn(async () => ({
      topics: [{ id: 't-new', assistantId: 'a-1', name: 'Default Topic' }],
      created: true
    }))
    const merged = await ensureAssistantTopicsIntegrity('a-1', {
      reader,
      ensure,
      dispatchAddTopic: (assistantId, topic) =>
        dispatched.push({ assistantId, topic: topic as { id: string; name: string } }),
      candidateFactory: () => ({ id: 't-new', name: 'Default Topic' }),
      importReady: () => true
    })
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(ensure).toHaveBeenCalledWith('a-1', 't-new', 'Default Topic')
    expect(dispatched).toHaveLength(1)
    expect(merged.map((m) => m.id)).toEqual(['t-new'])
  })

  it('does not call Main when topics are undefined (unloaded)', async () => {
    const reader = readerOf([{ id: 'a-2' }])
    const ensure = vi.fn()
    const merged = await ensureAssistantTopicsIntegrity('a-2', {
      reader,
      ensure,
      dispatchAddTopic: () => {},
      importReady: () => true
    })
    expect(ensure).not.toHaveBeenCalled()
    expect(merged).toEqual([])
  })

  it('does not call Main when import gate is not ready', async () => {
    const reader = readerOf([{ id: 'a-3', topics: [] }])
    const ensure = vi.fn()
    const merged = await ensureAssistantTopicsIntegrity('a-3', {
      reader,
      ensure,
      dispatchAddTopic: () => {},
      importReady: () => false
    })
    expect(ensure).not.toHaveBeenCalled()
    expect(merged).toEqual([])
  })

  it('recovers existing Main topics verbatim without fabrication', async () => {
    const dispatched: unknown[] = []
    const reader = readerOf([{ id: 'a-4', topics: [] }])
    const ensure = vi.fn(async () => ({
      topics: [
        { id: 't-kept', assistantId: 'a-4', name: 'Kept', pinned: true },
        { id: 't-kept-2', assistantId: 'a-4', name: 'Kept 2' }
      ],
      created: false
    }))
    const merged = await ensureAssistantTopicsIntegrity('a-4', {
      reader,
      ensure,
      dispatchAddTopic: (_id, topic) => dispatched.push(topic),
      candidateFactory: () => ({ id: 't-ignored', name: 'Ignored' }),
      importReady: () => true
    })
    expect(merged.map((m) => m.id).sort()).toEqual(['t-kept', 't-kept-2'])
    expect(dispatched).toHaveLength(2)
  })

  it('stale deleted assistant result is ignored, never resurrected', async () => {
    const live = new Map<string, { id: string; topics?: unknown }>()
    live.set('a-5', { id: 'a-5', topics: [] })
    const dispatched: unknown[] = []
    const ensure = vi.fn(async () => {
      live.delete('a-5')
      return { topics: [{ id: 't-stale', assistantId: 'a-5', name: 'Stale' }], created: true }
    })
    const merged = await ensureAssistantTopicsIntegrity('a-5', {
      reader: {
        findAssistant: (id: string) => live.get(id),
        listAssistants: () => [...live.values()].map((a) => ({ id: a.id, topics: a.topics }))
      },
      ensure,
      dispatchAddTopic: (_id, topic) => dispatched.push(topic),
      candidateFactory: () => ({ id: 't-stale', name: 'Stale' }),
      importReady: () => true
    })
    expect(merged).toEqual([])
    expect(dispatched).toEqual([])
  })

  it('a topic arriving during the Main call is kept, Main wires merged by stable id', async () => {
    const current: { id: string; topics: unknown } = { id: 'a-6', topics: [] }
    const dispatched: Array<{ id: string }> = []
    const ensure = vi.fn(async () => {
      current.topics = [{ id: 't-arrived' }]
      return { topics: [{ id: 't-main', assistantId: 'a-6', name: 'Main' }], created: true }
    })
    await ensureAssistantTopicsIntegrity('a-6', {
      reader: {
        findAssistant: () => current,
        listAssistants: () => [{ id: current.id, topics: current.topics }]
      },
      ensure,
      dispatchAddTopic: (_id, topic) => dispatched.push(topic as { id: string }),
      candidateFactory: () => ({ id: 't-main', name: 'Main' }),
      importReady: () => true
    })
    // The arrived topic is preserved (still present); the Main wire is added.
    expect(current.topics).toEqual([{ id: 't-arrived' }])
    expect(dispatched.map((t) => t.id)).toEqual(['t-main'])
  })

  it('candidate collision retries once with a fresh candidate', async () => {
    const dispatched: unknown[] = []
    const reader = readerOf([{ id: 'a-7', topics: [] }])
    const ensure = vi
      .fn()
      .mockRejectedValueOnce(new Error('candidate topic t-bad is owned by another assistant'))
      .mockResolvedValueOnce({
        topics: [{ id: 't-good', assistantId: 'a-7', name: 'Good' }],
        created: true
      })
    let n = 0
    const merged = await ensureAssistantTopicsIntegrity('a-7', {
      reader,
      ensure,
      dispatchAddTopic: (_id, topic) => dispatched.push(topic),
      candidateFactory: () => ({ id: `t-try-${++n}`, name: `Try ${n}` }),
      importReady: () => true
    })
    expect(ensure).toHaveBeenCalledTimes(2)
    expect(merged.map((m) => m.id).sort()).toEqual(['t-good'])
  })
})

describe('ensureAllEmptyAssistantsTopics', () => {
  it('repairs every really-empty assistant and skips valid/undefined ones', async () => {
    const dispatched: Array<{ assistantId: string }> = []
    const reader = readerOf([
      { id: 'a-empty-1', topics: [] },
      { id: 'a-valid', topics: [{ id: 't-keep' }] },
      { id: 'a-unloaded' },
      { id: 'a-empty-2', topics: [] }
    ])
    const ensure = vi.fn(async (assistantId: string, cid: string, name?: string | null) => ({
      topics: [{ id: cid, assistantId, name: name ?? 'D' }],
      created: true
    }))
    const { repaired } = await ensureAllEmptyAssistantsTopics({
      reader,
      ensure,
      dispatchAddTopic: (assistantId) => dispatched.push({ assistantId }),
      candidateFactory: (aid) => ({ id: `t-${aid}`, name: 'D' }),
      importReady: () => true
    })
    expect(ensure).toHaveBeenCalledTimes(2)
    expect(repaired.sort()).toEqual(['a-empty-1', 'a-empty-2'])
  })

  it('importReady override repairs after verified load while the UI gate is still pending', async () => {
    const { isImportProjectionReady, resetImportProjectionReadiness } = await import('../importProjectionReadiness')
    resetImportProjectionReadiness()
    expect(isImportProjectionReady()).toBe(false)
    try {
      // Default guard: pending UI gate means no-op (runtime/Home behavior).
      const idleEnsure = vi.fn()
      const idle = await ensureAllEmptyAssistantsTopics({
        reader: readerOf([{ id: 'a-boot', topics: [] }]),
        ensure: idleEnsure,
        dispatchAddTopic: () => {}
      })
      expect(idleEnsure).not.toHaveBeenCalled()
      expect(idle).toEqual({ repaired: [] })

      // Scoped boot override (verified projection loaded, UI READY pending):
      // repairs through the same production path.
      const dispatched: unknown[] = []
      const ensure = vi.fn(async (assistantId: string, cid: string, name?: string | null) => ({
        topics: [{ id: cid, assistantId, name: name ?? 'D' }],
        created: true
      }))
      const { repaired } = await ensureAllEmptyAssistantsTopics({
        reader: readerOf([{ id: 'a-boot', topics: [] }]),
        ensure,
        dispatchAddTopic: (_id, topic) => dispatched.push(topic),
        candidateFactory: (aid) => ({ id: `t-${aid}`, name: 'D' }),
        importReady: () => true
      })
      expect(ensure).toHaveBeenCalledTimes(1)
      expect(ensure).toHaveBeenCalledWith('a-boot', 't-a-boot', 'D')
      expect(repaired).toEqual(['a-boot'])
      expect(dispatched).toHaveLength(1)
      // The global UI gate is untouched — still pending.
      expect(isImportProjectionReady()).toBe(false)
    } finally {
      resetImportProjectionReadiness()
    }
  })
})
