/**
 * Clipboard slice — explicit content kinds.
 *
 * The opt-in tree capture is an ADDITIONAL clipboard content kind, so the slice
 * must keep the two kinds mutually exclusive:
 * - a tree publication installs the capture (and carries no ordinary items),
 * - any ordinary copy/cut publication REMOVES a previously captured tree, so a
 *   plain copy can never leave a stale tree payload behind for paste,
 * - clearing the clipboard drops both.
 */
import type { ClipboardTreeCapture } from '@renderer/types/editMode'
import { describe, expect, it } from 'vitest'

import reducer, { clearClipboard, setClipboard } from '../clipboard'

const capture = {
  payload: {
    source: { topicId: 'topic-1', branchId: null },
    roots: [],
    messages: [],
    blocks: [],
    branches: [],
    segments: []
  },
  meta: { completeness: 'clipboard-tree', topicId: 'topic-1', branchId: null }
} as unknown as ClipboardTreeCapture

const ordinaryItem = {
  originalAskId: 'u1',
  messages: [],
  blocks: [],
  positionIndex: 0
}

describe('clipboard slice content kinds', () => {
  it('installs a tree capture as its own content kind without ordinary items', () => {
    const state = reducer(
      undefined,
      setClipboard({
        mode: 'copy',
        sourceTopicId: 'topic-1',
        sourceBranchId: null,
        tree: capture
      })
    )

    expect(state.mode).toBe('copy')
    expect(state.items).toEqual([])
    expect(state.tree).toBe(capture)
    expect(state.timestamp).toBeGreaterThan(0)
  })

  it('clears a previous tree capture on an ordinary copy/cut publication', () => {
    const withTree = reducer(
      undefined,
      setClipboard({ mode: 'copy', sourceTopicId: 'topic-1', sourceBranchId: null, tree: capture })
    )
    const ordinary = reducer(
      withTree,
      setClipboard({
        mode: 'copy',
        items: [ordinaryItem],
        sourceTopicId: 'topic-1',
        sourceBranchId: null
      })
    )

    expect(ordinary.tree).toBeUndefined()
    expect(ordinary.items).toEqual([ordinaryItem])
  })

  it('drops the tree capture when the clipboard is cleared', () => {
    const withTree = reducer(
      undefined,
      setClipboard({ mode: 'cut', sourceTopicId: 'topic-1', sourceBranchId: 'branch-1', tree: capture })
    )
    const cleared = reducer(withTree, clearClipboard())

    expect(cleared.tree).toBeUndefined()
    expect(cleared.mode).toBeNull()
    expect(cleared.items).toEqual([])
  })
})
