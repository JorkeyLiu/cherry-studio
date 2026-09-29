/**
 * Position-primitive behavior (pure, no DOM loops):
 * - restore-target validity never consults the viewport scroll token
 *   (anchoring after beginScroll keeps it true);
 * - keyboard pre-cancel ignores inputs and modified keys.
 *
 * Persistent stable anchoring itself runs in the scoped keeper
 * (`routeViewportContext`), covered by routeViewportStableAnchor tests —
 * never by a permanent rAF loop here.
 */
import { describe, expect, it } from 'vitest'

import { isRestoreTargetValid, shouldCancelStabilizerForKeyDown } from '../positionStabilizer'

describe('isRestoreTargetValid (epoch validity, never scroll-token)', () => {
  it('stays true after beginScroll(anchoring): only topic/route/mounted/epoch matter', () => {
    // No scrollMode/scrollToken input exists: anchoring cannot flip this.
    expect(isRestoreTargetValid({ topicMatch: true, routeMatch: true, mounted: true, epochCurrent: true })).toBe(true)
  })

  it('fails on topic/route/unmount/epoch mismatch', () => {
    expect(isRestoreTargetValid({ topicMatch: false, routeMatch: true, mounted: true, epochCurrent: true })).toBe(false)
    expect(isRestoreTargetValid({ topicMatch: true, routeMatch: false, mounted: true, epochCurrent: true })).toBe(false)
    expect(isRestoreTargetValid({ topicMatch: true, routeMatch: true, mounted: false, epochCurrent: true })).toBe(false)
    expect(isRestoreTargetValid({ topicMatch: true, routeMatch: true, mounted: true, epochCurrent: false })).toBe(false)
  })
})

describe('keyboard scroll pre-cancel (inputs excluded)', () => {
  it.each(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])(
    'declares user intent for scroll key %s on a plain target',
    (key) => {
      expect(shouldCancelStabilizerForKeyDown({ key }, { tagName: 'DIV' })).toBe(true)
    }
  )

  it('ignores non-scroll keys', () => {
    expect(shouldCancelStabilizerForKeyDown({ key: 'a' }, { tagName: 'DIV' })).toBe(false)
    expect(shouldCancelStabilizerForKeyDown({ key: 'Enter' }, { tagName: 'DIV' })).toBe(false)
  })

  it.each([['INPUT'], ['TEXTAREA'], ['SELECT']])('ignores scroll keys inside %s', (tag) => {
    expect(shouldCancelStabilizerForKeyDown({ key: 'ArrowDown' }, { tagName: tag })).toBe(false)
    expect(shouldCancelStabilizerForKeyDown({ key: ' ' }, { tagName: tag })).toBe(false)
  })

  it('ignores contentEditable targets and modified keys', () => {
    expect(shouldCancelStabilizerForKeyDown({ key: 'ArrowDown' }, { tagName: 'DIV', isContentEditable: true })).toBe(
      false
    )
    expect(shouldCancelStabilizerForKeyDown({ key: 'ArrowDown', ctrlKey: true }, { tagName: 'DIV' })).toBe(false)
    expect(shouldCancelStabilizerForKeyDown({ key: 'Home', metaKey: true }, { tagName: 'DIV' })).toBe(false)
  })
})
