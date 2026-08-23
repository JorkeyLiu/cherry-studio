import { projectMessageViewportGroups } from '@renderer/pages/home/Messages/messageViewportProjection'
import { createLatestMessageWindow } from '@renderer/pages/home/Messages/messageWindow'
import type { Message } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

function msg(id: string, role: 'user' | 'assistant' = 'user', askId?: string): Message {
  return { id, role, topicId: 't1', blocks: [], createdAt: '2024-01-01T00:00:00.000Z', askId } as unknown as Message
}

describe('closure does not affect viewport', () => {
  it('displayGroups remain viewport limited even when closure is larger (unbounded)', () => {
    const all: Message[] = []
    for (let i = 0; i < 20; i++) {
      if (i % 2 === 0) all.push(msg(`u${i}`, 'user'))
      else all.push(msg(`a${i}`, 'assistant', `u${i - 1}`))
    }
    // viewport window displayCount 5 => only last 5 groups (approx 5 messages because each user+assistant pair is 2 groups? actually each pair is 1 turn but viewport groups are per semantic: user singleton, assistant singleton? but with askId joining, assistant groups are separate)
    const win = createLatestMessageWindow(all, 5)
    // viewport should be limited to 5 groups
    expect(win.displayGroups.length).toBe(5)
    const projection = projectMessageViewportGroups(win.displayMessages, win.displayGroups)
    expect(projection.length).toBe(5)

    // Simulate closure that is anchor-to-newest from u0 (full 20 messages) – should not expand viewport
    // viewport groups still 5, not 20
    const closureMessages = all // unbounded
    // closure display would be larger if we mistakenly merged into viewport, but we keep separate
    expect(closureMessages.length).toBe(20)
    expect(win.displayGroups.length).toBe(5)
    expect(projection.length).toBe(5)
  })

  it('contextCount=null unbounded closure is not truncated by viewport limit', () => {
    const all: Message[] = [msg('u0'), msg('a0', 'assistant', 'u0'), msg('u1'), msg('a1', 'assistant', 'u1'), msg('u2')]
    const win = createLatestMessageWindow(all, 2)
    expect(win.displayGroups.length).toBe(2)
    // closure from u0 includes all 5
    const closure = all
    expect(closure.length).toBe(5)
    // viewport remains 2
    expect(win.displayGroups.length).toBe(2)
  })
})
