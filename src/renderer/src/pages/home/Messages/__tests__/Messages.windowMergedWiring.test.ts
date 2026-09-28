import * as fs from 'node:fs'

import reducer, { newMessagesActions } from '@renderer/store/newMessage'
import type { Message } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

function msg(id: string): Message {
  return { id, topicId: 't1' } as unknown as Message
}

/**
 * Production wiring for atomic pagination capability (A).
 *
 * Older/newer `fetchMessagesWindow` merges plus the navigation around-merge
 * must publish via the single-commit `messagesWindowMerged` action (merged
 * messages + route + response-window capability). A bare
 * `messagesReceived(merged)` would clear the mutable capability and publish
 * an intermediate all-immutable frame.
 */
describe('Messages window-merge wiring (atomic capability)', () => {
  const source = fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')

  it('older pagination publishes merged messages + route + capability atomically', () => {
    const idx = source.indexOf('const startOlderWindowLoad')
    expect(idx).toBeGreaterThanOrEqual(0)
    const slice = source.slice(idx, idx + 26000)
    expect(slice).toMatch(/fetchMessagesWindow/)
    expect(slice).toMatch(/mergeWindowIntoTopic/)
    expect(slice).toMatch(/messagesWindowMerged/)
    expect(slice).toMatch(/mutableMessageIds/)
    expect(slice).toMatch(/route:\s*routeAtStart/)
    const code = slice
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
    expect(code).not.toMatch(/messagesReceived\(\{\s*topicId:\s*topicIdAtStart,\s*messages:\s*merged/)
  })

  it('newer pagination publishes merged messages + route + capability atomically', () => {
    const idx = source.indexOf('const loadNewerMessages')
    expect(idx).toBeGreaterThanOrEqual(0)
    const slice = source.slice(idx, idx + 22000)
    expect(slice).toMatch(/fetchMessagesWindow/)
    expect(slice).toMatch(/mergeWindowIntoTopic/)
    expect(slice).toMatch(/messagesWindowMerged/)
    expect(slice).toMatch(/mutableMessageIds/)
    expect(slice).toMatch(/route:\s*routeAtStart/)
    const code = slice
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
    expect(code).not.toMatch(/messagesReceived\(\{\s*topicId:\s*topicIdAtStart,\s*messages:\s*merged/)
  })

  it('navigation around-merge publishes via the same atomic action', () => {
    const idx = source.indexOf('Atomic staged publication (blocks then merged')
    expect(idx).toBeGreaterThanOrEqual(0)
    const slice = source.slice(idx, idx + 4000)
    expect(slice).toMatch(/messagesWindowMerged/)
    expect(slice).toMatch(/ensured\.mutableMessageIds/)
    expect(slice).toMatch(/route:\s*routeAtStart/)
  })

  it('single commit installs merged order and merged capability together (no intermediate clear)', () => {
    let s = reducer(undefined, { type: '@@init' } as never)
    s = reducer(s, newMessagesActions.messagesReceived({ topicId: 't1', messages: [msg('m2'), msg('m3')] }))
    s = reducer(
      s,
      newMessagesActions.rebaseRouteMessages({
        topicId: 't1',
        messages: [msg('m2'), msg('m3')],
        route: null,
        mutableMessageIds: ['m2']
      })
    )
    const beforeCap = [...(s.mutableMessageIdsByTopic['t1'] ?? [])]
    expect(beforeCap).toEqual(['m2'])
    // The production older/newer/navigate path dispatches exactly ONE action.
    s = reducer(
      s,
      newMessagesActions.messagesWindowMerged({
        topicId: 't1',
        messages: [msg('m0'), msg('m1'), msg('m2'), msg('m3')],
        route: null,
        mutableMessageIds: ['m0']
      })
    )
    expect(s.messageIdsByTopic['t1']).toEqual(['m0', 'm1', 'm2', 'm3'])
    expect(new Set(s.mutableMessageIdsByTopic['t1'])).toEqual(new Set(['m2', 'm0']))
  })
})
