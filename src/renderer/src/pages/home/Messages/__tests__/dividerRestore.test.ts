/**
 * Divider identity + offset restore decision. Covers contract (2).
 */
import { describe, expect, it } from 'vitest'

import { buildDividerKey, captureDividerOffset, decideDividerRestoreTarget, dividerRowTestId } from '../BranchDividers'

describe('divider identity', () => {
  it('builds a stable anchor+parent key and row test id', () => {
    expect(buildDividerKey('m1', null)).toBe('m1::main')
    expect(buildDividerKey('m1', 'b1')).toBe('m1::b1')
    expect(dividerRowTestId('m1', null)).toBe('branch-fork-divider-m1-main')
    expect(dividerRowTestId('m1', 'b1')).toBe('branch-fork-divider-m1-b1')
  })

  it('captures row offset relative to container top', () => {
    const container = document.createElement('div')
    const row = document.createElement('div')
    Object.defineProperty(container, 'getBoundingClientRect', {
      value: () => ({
        top: 100,
        bottom: 900,
        height: 800,
        left: 0,
        right: 0,
        width: 0,
        x: 0,
        y: 100,
        toJSON: () => ({})
      }),
      configurable: true
    })
    Object.defineProperty(row, 'getBoundingClientRect', {
      value: () => ({
        top: 250,
        bottom: 290,
        height: 40,
        left: 0,
        right: 0,
        width: 0,
        x: 0,
        y: 250,
        toJSON: () => ({})
      }),
      configurable: true
    })
    expect(captureDividerOffset(row, container)).toBe(150)
    expect(captureDividerOffset(null, container)).toBeNull()
  })
})

describe('decideDividerRestoreTarget (fallback chain, never bottom)', () => {
  it('prefers the same logical divider row when present in target', () => {
    expect(
      decideDividerRestoreTarget({
        dividerKeyPresentInTarget: true,
        sharedVisualMessageId: 'm9',
        forkAnchorMessageId: 'fork'
      })
    ).toEqual({ kind: 'divider-row', targetId: null, dividerKey: '__divider__' })
  })

  it('falls back to the shared message visual anchor, then the fork message', () => {
    expect(
      decideDividerRestoreTarget({
        dividerKeyPresentInTarget: false,
        sharedVisualMessageId: 'm9',
        forkAnchorMessageId: 'fork'
      })
    ).toEqual({ kind: 'shared-message', targetId: 'm9', dividerKey: null })
    expect(
      decideDividerRestoreTarget({
        dividerKeyPresentInTarget: false,
        sharedVisualMessageId: null,
        forkAnchorMessageId: 'fork'
      })
    ).toEqual({ kind: 'fork-message', targetId: 'fork', dividerKey: null })
  })
})
