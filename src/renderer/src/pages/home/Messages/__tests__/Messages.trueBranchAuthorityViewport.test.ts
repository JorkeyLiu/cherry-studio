import type { Message } from '@renderer/types/newMessage'
import { UserMessageStatus } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import { chooseNavigationWindow } from '../messageNavigation'
import { createLatestMessageWindow } from '../messageWindow'

const message = (id: string): Message => ({
  id,
  role: 'user',
  assistantId: 'assistant',
  topicId: 'topic',
  createdAt: '2026-01-01T00:00:00.000Z',
  status: UserMessageStatus.SUCCESS,
  blocks: []
})

/**
 * NEW_TRUE_BRANCH viewport authority preservation (bounded production correction).
 *
 * The new true-branch landing loads the fresh route via a windowed `latest`
 * read whose response carries authority window flags (`hasMoreBefore/After`),
 * then publishes a latest viewport over exactly the display-limit tail. The
 * viewport must preserve those authoritative flags so genuine oldest-edge
 * load-more can fire (InfiniteScroll binds `window.hasMoreOlder`).
 */
describe('Messages NEW_TRUE_BRANCH viewport authority preservation', () => {
  it('preserves authority hasMoreBefore=true when resident equals the display limit', () => {
    const displayCount = 10
    // Ten singleton groups, exactly the bounded latest capacity.
    const loaded = Array.from({ length: 10 }, (_, i) => message(`m${i}`))

    // Bug shape: derived-only window at the exact tail reports no older pages.
    const derivedOnly = createLatestMessageWindow(loaded, displayCount)
    expect(derivedOnly.hasMoreOlder).toBe(false)

    // Fixed shape: latest authority flags ride into the viewport.
    const authoritative = { hasMoreBefore: true, hasMoreAfter: false }
    const fixed = createLatestMessageWindow(loaded, displayCount, authoritative)
    expect(fixed.displayMessages.map((m) => m.id)).toEqual(derivedOnly.displayMessages.map((m) => m.id))
    expect(fixed.hasMoreOlder).toBe(true)
    expect(fixed.hasMoreNewer).toBe(false)
    expect(fixed.authoritativeHasMoreBefore).toBe(true)
    expect(fixed.authoritativeHasMoreAfter).toBe(false)
  })

  it('exhausted authority flags do not enable extra reads', () => {
    const displayCount = 10
    const loaded = Array.from({ length: 10 }, (_, i) => message(`m${i}`))
    const exhausted = createLatestMessageWindow(loaded, displayCount, {
      hasMoreBefore: false,
      hasMoreAfter: false
    })
    expect(exhausted.hasMoreOlder).toBe(false)
    expect(exhausted.hasMoreNewer).toBe(false)
    expect(exhausted.authoritativeHasMoreBefore).toBe(false)
    expect(exhausted.authoritativeHasMoreAfter).toBe(false)
  })

  it('re-asserts authority after the generic bottom navigate (derived-only overwrite)', () => {
    const displayCount = 10
    const loaded = Array.from({ length: 10 }, (_, i) => message(`m${i}`))
    const authoritative = { hasMoreBefore: true, hasMoreAfter: false }
    const published = createLatestMessageWindow(loaded, displayCount, authoritative)
    expect(published.hasMoreOlder).toBe(true)

    // The explicit bottom positioning rebuilds via the generic navigation
    // path, which carries derived flags only and drops the authority.
    const navigated = chooseNavigationWindow(loaded, published, { kind: 'bottom' }, displayCount)
    expect(navigated).not.toBeNull()
    expect(navigated!.displayMessages.map((m) => m.id)).toEqual(published.displayMessages.map((m) => m.id))
    expect(navigated!.hasMoreOlder).toBe(false)

    // Bounded repair: re-assert the same latest authority over the same tail.
    const repaired = createLatestMessageWindow(loaded, displayCount, authoritative)
    expect(repaired.displayMessages.map((m) => m.id)).toEqual(published.displayMessages.map((m) => m.id))
    expect(repaired.hasMoreOlder).toBe(true)
    expect(repaired.hasMoreNewer).toBe(false)
  })
})
