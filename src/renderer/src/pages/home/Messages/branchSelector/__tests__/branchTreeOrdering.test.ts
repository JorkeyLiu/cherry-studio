import type { TopicBranchWire } from '@renderer/services/db/types'
import { describe, expect, it } from 'vitest'

import { BRANCH_TREE_ROOT_ID, buildBranchTreeIndex } from '../branchTreeModel'
import { orderBranchTreeIndexByAnchorRanks } from '../branchTreeOrdering'

const wire = (
  id: string,
  parentBranchId: string | null,
  createdAt: string,
  anchorMessageId = `m-${id}`
): TopicBranchWire => ({
  id,
  topicId: 't-1',
  parentBranchId,
  anchorMessageId,
  name: id,
  createdAt,
  updatedAt: createdAt
})

const ids = (branches: readonly TopicBranchWire[] | undefined): string[] => branches?.map((branch) => branch.id) ?? []

const rankMap = (entries: Array<[string, number]>): ReadonlyMap<string, number> => new Map(entries)

describe('orderBranchTreeIndexByAnchorRanks', () => {
  it('orders by message rank even when catalog input, creation time, and ids disagree', () => {
    const branches = [
      wire('z-late', null, '2026-01-01T00:00:00.000Z', 'm-late'),
      wire('a-early', null, '2026-01-03T00:00:00.000Z', 'm-early'),
      wire('m-middle', null, '2026-01-02T00:00:00.000Z', 'm-middle')
    ]
    const index = buildBranchTreeIndex(branches)
    const ranks = new Map([
      [
        null,
        rankMap([
          ['m-late', 2],
          ['m-early', 0],
          ['m-middle', 1]
        ])
      ]
    ])

    const ordered = orderBranchTreeIndexByAnchorRanks(index, branches, ranks)

    expect(ids(ordered.childrenOf.get(BRANCH_TREE_ROOT_ID))).toEqual(['a-early', 'm-middle', 'z-late'])
  })

  it('keeps branches at the same anchor in their original catalog order', () => {
    const branches = [
      wire('z-same-first', null, '2026-01-02T00:00:00.000Z', 'm-shared'),
      wire('a-same-second', null, '2026-01-01T00:00:00.000Z', 'm-shared'),
      wire('later-anchor', null, '2026-01-03T00:00:00.000Z', 'm-later')
    ]
    const index = buildBranchTreeIndex(branches)
    const ranks = new Map([
      [
        null,
        rankMap([
          ['m-shared', 0],
          ['m-later', 1]
        ])
      ]
    ])

    const ordered = orderBranchTreeIndexByAnchorRanks(index, branches, ranks)

    expect(ids(ordered.childrenOf.get(BRANCH_TREE_ROOT_ID))).toEqual(['z-same-first', 'a-same-second', 'later-anchor'])
  })

  it('places ranked branches before missing ranks and preserves missing-rank catalog order', () => {
    const branches = [
      wire('missing-first', null, '2026-01-01T00:00:00.000Z', 'm-missing-first'),
      wire('ranked-late', null, '2026-01-02T00:00:00.000Z', 'm-ranked-late'),
      wire('missing-second', null, '2026-01-03T00:00:00.000Z', 'm-missing-second'),
      wire('ranked-early', null, '2026-01-04T00:00:00.000Z', 'm-ranked-early')
    ]
    const index = buildBranchTreeIndex(branches)
    const ranks = new Map([
      [
        null,
        rankMap([
          ['m-ranked-late', 1],
          ['m-ranked-early', 0]
        ])
      ]
    ])

    const ordered = orderBranchTreeIndexByAnchorRanks(index, branches, ranks)

    expect(ids(ordered.childrenOf.get(BRANCH_TREE_ROOT_ID))).toEqual([
      'ranked-early',
      'ranked-late',
      'missing-first',
      'missing-second'
    ])
  })

  it('keeps the whole group in catalog order when every rank is missing', () => {
    const branches = [
      wire('z-first', null, '2026-01-03T00:00:00.000Z'),
      wire('a-second', null, '2026-01-02T00:00:00.000Z'),
      wire('m-third', null, '2026-01-01T00:00:00.000Z')
    ]
    const index = buildBranchTreeIndex(branches)

    const ordered = orderBranchTreeIndexByAnchorRanks(index, branches, new Map([[null, new Map()]]))

    expect(ids(ordered.childrenOf.get(BRANCH_TREE_ROOT_ID))).toEqual(['z-first', 'a-second', 'm-third'])
  })

  it('sorts each nested parent route against that parent route’s own message sequence', () => {
    const branches = [
      wire('root-late', null, '2026-01-01T00:00:00.000Z', 'm-root-late'),
      wire('child-middle', 'root-late', '2026-01-02T00:00:00.000Z', 'm-child-middle'),
      wire('root-early', null, '2026-01-03T00:00:00.000Z', 'm-root-early'),
      wire('child-early', 'root-late', '2026-01-04T00:00:00.000Z', 'm-child-early'),
      wire('other-late', 'root-early', '2026-01-05T00:00:00.000Z', 'm-other-late'),
      wire('other-early', 'root-early', '2026-01-06T00:00:00.000Z', 'm-other-early')
    ]
    const index = buildBranchTreeIndex(branches)
    const ranks = new Map<string | null, ReadonlyMap<string, number>>([
      [
        null,
        rankMap([
          ['m-root-late', 1],
          ['m-root-early', 0]
        ])
      ],
      [
        'root-late',
        rankMap([
          ['m-child-middle', 1],
          ['m-child-early', 0]
        ])
      ],
      [
        'root-early',
        rankMap([
          ['m-other-late', 1],
          ['m-other-early', 0]
        ])
      ]
    ])

    const ordered = orderBranchTreeIndexByAnchorRanks(index, branches, ranks)

    expect(ids(ordered.childrenOf.get(BRANCH_TREE_ROOT_ID))).toEqual(['root-early', 'root-late'])
    expect(ids(ordered.childrenOf.get('root-late'))).toEqual(['child-early', 'child-middle'])
    expect(ids(ordered.childrenOf.get('root-early'))).toEqual(['other-early', 'other-late'])
  })

  it('returns a new child map without mutating the input index or its tree structure', () => {
    const branches = [
      wire('z-first', null, '2026-01-02T00:00:00.000Z', 'm-late'),
      wire('a-second', null, '2026-01-01T00:00:00.000Z', 'm-early')
    ]
    const index = buildBranchTreeIndex(branches)
    const originalChildren = index.childrenOf.get(BRANCH_TREE_ROOT_ID)
    const originalSnapshot = [...(originalChildren ?? [])]
    const ranks = new Map([
      [
        null,
        rankMap([
          ['m-late', 1],
          ['m-early', 0]
        ])
      ]
    ])

    const ordered = orderBranchTreeIndexByAnchorRanks(index, branches, ranks)

    expect(ordered).not.toBe(index)
    expect(ordered.childrenOf).not.toBe(index.childrenOf)
    expect(ordered.childrenOf.get(BRANCH_TREE_ROOT_ID)).not.toBe(originalChildren)
    expect(originalChildren).toEqual(originalSnapshot)
    expect(ids(index.childrenOf.get(BRANCH_TREE_ROOT_ID))).toEqual(['a-second', 'z-first'])
    expect(ordered.byId).toBe(index.byId)
    expect(ordered.parentKeyOf).toBe(index.parentKeyOf)
    expect(ordered.depthOf).toBe(index.depthOf)
    expect(ordered.ancestorsOf).toBe(index.ancestorsOf)
    expect(ordered.chainTo).toBe(index.chainTo)
    expect(ordered.orderedKeys).toBe(index.orderedKeys)
  })
})
