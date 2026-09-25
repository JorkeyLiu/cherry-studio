import * as fs from 'node:fs'

import type { TopicBranchWire } from '@renderer/services/db/types'
import { describe, expect, it } from 'vitest'

import reducer, {
  activeBranchReset,
  activeBranchSet,
  branchesReceived,
  branchesRemoved,
  selectActiveBranchId,
  selectBranchPath
} from '../topicBranch'

const wire = (id: string, anchorMessageId: string, parentBranchId: string | null, name: string): TopicBranchWire =>
  ({
    id,
    topicId: 't-1',
    parentBranchId,
    anchorMessageId,
    name,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }) as TopicBranchWire

function stateWith(overrides: Record<string, unknown> = {}): Parameters<typeof reducer>[0] {
  return {
    branchesByTopic: {},
    activeBranchIdByTopic: {},
    routeGenerationByTopic: {},
    ...overrides
  } as Parameters<typeof reducer>[0]
}

const rootWith = (s: Parameters<typeof reducer>[0]): unknown => ({ topicBranch: s })

describe('per-topic selected branch restore', () => {
  it('switching branches on one topic never touches another topic selection', () => {
    let s = stateWith()
    s = reducer(s, branchesReceived({ topicId: 't-1', branches: [wire('b-1', 'm1', null, 'B1')] }))
    s = reducer(s, activeBranchSet({ topicId: 't-1', branchId: 'b-1' }))
    s = reducer(s, branchesReceived({ topicId: 't-2', branches: [wire('c-1', 'm9', null, 'C1')] }))
    // t-2 starts on main; t-1 keeps its stored branch (no reset on switch).
    expect(selectActiveBranchId(rootWith(s) as never, 't-1')).toBe('b-1')
    expect(selectActiveBranchId(rootWith(s) as never, 't-2')).toBeNull()
    s = reducer(s, activeBranchSet({ topicId: 't-2', branchId: 'c-1' }))
    expect(selectActiveBranchId(rootWith(s) as never, 't-1')).toBe('b-1')
    expect(selectActiveBranchId(rootWith(s) as never, 't-2')).toBe('c-1')
  })

  it('restores the stored branch when it still exists, otherwise main (catalog refresh)', () => {
    let s = stateWith({ activeBranchIdByTopic: { 't-1': 'b-1' } })
    s = reducer(s, branchesReceived({ topicId: 't-1', branches: [wire('b-1', 'm1', null, 'B1')] }))
    expect(selectActiveBranchId(rootWith(s) as never, 't-1')).toBe('b-1')
    // Stale deletion fallback: catalog without the stored branch prunes to main.
    s = reducer(s, branchesReceived({ topicId: 't-1', branches: [] }))
    expect(selectActiveBranchId(rootWith(s) as never, 't-1')).toBeNull()
  })

  it('rehydrated selection restores a valid branch and drops a stale one on catalog load', () => {
    // Same-profile relaunch: persisted activeBranchIdByTopic rehydrates, then
    // the first catalog load validates it.
    const rehydrated = stateWith({ activeBranchIdByTopic: { 't-1': 'b-9' } })
    let s = reducer(rehydrated, branchesReceived({ topicId: 't-1', branches: [wire('b-9', 'm1', null, 'B9')] }))
    expect(selectActiveBranchId(rootWith(s) as never, 't-1')).toBe('b-9')
    expect(selectBranchPath(rootWith(s) as never, 't-1', 'b-9').map((b) => b.id)).toEqual(['b-9'])
    s = reducer(rehydrated, branchesReceived({ topicId: 't-1', branches: [wire('b-1', 'm1', null, 'B1')] }))
    expect(selectActiveBranchId(rootWith(s) as never, 't-1')).toBeNull()
  })

  it('topic deletion invalidates catalog + selection + generation', () => {
    let s = stateWith({
      branchesByTopic: { 't-1': [wire('b-1', 'm1', null, 'B1')] },
      activeBranchIdByTopic: { 't-1': 'b-1' },
      routeGenerationByTopic: { 't-1': 3 }
    })
    s = reducer(s, branchesRemoved({ topicIds: ['t-1'] }))
    expect(selectActiveBranchId(rootWith(s) as never, 't-1')).toBeNull()
    expect((s.branchesByTopic as Record<string, unknown>)['t-1']).toBeUndefined()
  })

  it('useTopic no longer resets the stored branch on topic switch (source check)', () => {
    const source = fs.readFileSync('src/renderer/src/hooks/useTopic.ts', 'utf8')
    expect(source).not.toMatch(/activeBranchReset/)
    expect(source).toMatch(/loadTopicMessagesThunk/)
  })

  it('topicBranch slice stays persisted (not blacklisted) for relaunch restore', () => {
    const source = fs.readFileSync('src/renderer/src/store/index.ts', 'utf8')
    const blacklistStart = source.indexOf('blacklist:')
    expect(blacklistStart).toBeGreaterThanOrEqual(0)
    const blacklist = source.slice(blacklistStart, blacklistStart + 800)
    expect(blacklist).not.toMatch(/topicBranch/)
  })

  it('explicit reset still returns a topic to main (delete-last-branch path)', () => {
    let s = stateWith({ activeBranchIdByTopic: { 't-1': 'b-1' } })
    s = reducer(s, activeBranchReset({ topicId: 't-1' }))
    expect(selectActiveBranchId(rootWith(s) as never, 't-1')).toBeNull()
  })
})
