import {
  __testSetPendingNavigate,
  clearPendingNavigate,
  getPendingNavigate,
  setPendingAnchorNavigate
} from '@renderer/services/MessagesService'
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * Pending-anchor bootstrap path (behavioral companion to the
 * Messages.trueBranchListener contract-grep suite).
 *
 * Topic bootstrap in Messages.tsx performs: savePosition(),
 * setPendingAnchorNavigate({ messageId: anchor, topicId }) with the SAME
 * logical topicId, then NAVIGATE_TO_MESSAGE(anchor) for anchor-vicinity
 * scroll (never bottom). Divider route switches preserve the visual
 * reference directly (no pending navigate); these tests pin the observable
 * behavior of the remaining pending mechanism: the anchor pending is set
 * for the logical topic, survives until the consumer clears it, and a newer
 * request overwrites a stale pending from another anchor.
 */
describe('branch divider switch pending-anchor path', () => {
  beforeEach(() => {
    __testSetPendingNavigate(null)
  })

  it('sets a pending anchor navigation for the same logical topic and shared anchor', () => {
    // Same call handleSelectRoute makes on divider switch.
    setPendingAnchorNavigate({ messageId: 'm1', topicId: 't-1' })
    expect(getPendingNavigate()).toEqual({ messageId: 'm1', topicId: 't-1' })
  })

  it('the route consumer clears only its own anchor (stale-anchor safety)', () => {
    setPendingAnchorNavigate({ messageId: 'm1', topicId: 't-1' })
    // A stale listener for another anchor cannot consume it.
    expect(clearPendingNavigate({ messageId: 'm1', topicId: 't-1' })).toBe(true)
    expect(getPendingNavigate()).toBeNull()
  })

  it('a newer route switch overwrites a stale pending (no cross-switch leak)', () => {
    setPendingAnchorNavigate({ messageId: 'm1', topicId: 't-1' })
    setPendingAnchorNavigate({ messageId: 'm2', topicId: 't-1' })
    expect(getPendingNavigate()).toEqual({ messageId: 'm2', topicId: 't-1' })
    expect(clearPendingNavigate({ messageId: 'm1', topicId: 't-1' })).toBe(false)
    expect(getPendingNavigate()).toEqual({ messageId: 'm2', topicId: 't-1' })
  })
})
