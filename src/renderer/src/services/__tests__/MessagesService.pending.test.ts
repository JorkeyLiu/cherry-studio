import { describe, expect, it } from 'vitest'

import { __testSetPendingNavigate, clearPendingNavigate, getPendingNavigate } from '../MessagesService'

// Reset pending before each test to ensure isolation
const resetPending = () => __testSetPendingNavigate(null)

describe('clearPendingNavigate — compare-and-clear semantics', () => {
  it('returns false when no pending exists', () => {
    resetPending()
    expect(getPendingNavigate()).toBeNull()
    expect(clearPendingNavigate({ topicId: 't1', messageId: 'm1' })).toBe(false)
    expect(getPendingNavigate()).toBeNull()
  })

  it('clears and returns true when expected identity matches exactly', () => {
    resetPending()
    __testSetPendingNavigate({ topicId: 't1', messageId: 'm1' })

    const result = clearPendingNavigate({ topicId: 't1', messageId: 'm1' })

    expect(result).toBe(true)
    expect(getPendingNavigate()).toBeNull()
  })

  it('does NOT clear and returns false when topicId mismatches', () => {
    resetPending()
    __testSetPendingNavigate({ topicId: 't1', messageId: 'm1' })

    const result = clearPendingNavigate({ topicId: 'wrong-topic', messageId: 'm1' })

    expect(result).toBe(false)
    expect(getPendingNavigate()).toEqual({ topicId: 't1', messageId: 'm1' })
  })

  it('does NOT clear and returns false when messageId mismatches', () => {
    resetPending()
    __testSetPendingNavigate({ topicId: 't1', messageId: 'm1' })

    const result = clearPendingNavigate({ topicId: 't1', messageId: 'wrong-msg' })

    expect(result).toBe(false)
    expect(getPendingNavigate()).toEqual({ topicId: 't1', messageId: 'm1' })
  })

  it('does NOT clear and returns false when both topicId and messageId mismatch', () => {
    resetPending()
    __testSetPendingNavigate({ topicId: 't1', messageId: 'm1' })

    const result = clearPendingNavigate({ topicId: 't2', messageId: 'm2' })

    expect(result).toBe(false)
    expect(getPendingNavigate()).toEqual({ topicId: 't1', messageId: 'm1' })
  })

  it('old expected cannot clear a newer pending with different identity', () => {
    resetPending()
    // Original pending
    __testSetPendingNavigate({ topicId: 't1', messageId: 'msg-old' })

    // Simulate: locateToMessage overwrites with a new pending
    __testSetPendingNavigate({ topicId: 't1', messageId: 'msg-new' })

    // Old expected identity should NOT clear the new pending
    const oldResult = clearPendingNavigate({ topicId: 't1', messageId: 'msg-old' })
    expect(oldResult).toBe(false)
    expect(getPendingNavigate()).toEqual({ topicId: 't1', messageId: 'msg-new' })

    // New expected identity DOES clear
    const newResult = clearPendingNavigate({ topicId: 't1', messageId: 'msg-new' })
    expect(newResult).toBe(true)
    expect(getPendingNavigate()).toBeNull()
  })

  it('same-topic Drawer/anchor events do not consume pending (simulated by mismatched messageId)', () => {
    resetPending()
    __testSetPendingNavigate({ topicId: 't1', messageId: 'target-msg' })

    // Simulate: a Drawer event on the same topic but different messageId
    // The handler would call clearPendingNavigate only if it treated this as a pending match.
    // With the compare-and-clear API, a mismatched messageId returns false.
    const drawerEventResult = clearPendingNavigate({ topicId: 't1', messageId: 'drawer-msg' })

    expect(drawerEventResult).toBe(false)
    expect(getPendingNavigate()).toEqual({ topicId: 't1', messageId: 'target-msg' })
  })

  it('pending is preserved after failed clear attempt (no side-effect on mismatch)', () => {
    resetPending()
    __testSetPendingNavigate({ topicId: 't1', messageId: 'm1' })

    // Multiple failed attempts
    clearPendingNavigate({ topicId: 't1', messageId: 'm2' })
    clearPendingNavigate({ topicId: 't2', messageId: 'm1' })
    clearPendingNavigate({ topicId: 't2', messageId: 'm2' })

    // Pending is still intact
    expect(getPendingNavigate()).toEqual({ topicId: 't1', messageId: 'm1' })

    // Finally, correct identity clears it
    expect(clearPendingNavigate({ topicId: 't1', messageId: 'm1' })).toBe(true)
    expect(getPendingNavigate()).toBeNull()
  })

  it('after clear, subsequent clears return false (already null)', () => {
    resetPending()
    __testSetPendingNavigate({ topicId: 't1', messageId: 'm1' })

    expect(clearPendingNavigate({ topicId: 't1', messageId: 'm1' })).toBe(true)
    expect(clearPendingNavigate({ topicId: 't1', messageId: 'm1' })).toBe(false)
  })
})
