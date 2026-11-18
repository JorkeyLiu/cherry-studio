import type { TopicBranchWire } from '@renderer/services/db/types'
import type { HistoryReferenceMeta } from '@shared/chatDb'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number; name?: string }) => {
      if (key === 'chat.topics.branch.children_here') return `此处有 ${opts?.count ?? 0} 条分支`
      if (opts?.name) return `${key}:${opts.name}`
      return key
    }
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

vi.mock('@renderer/store', () => ({ useAppDispatch: () => vi.fn() }))
vi.mock('@renderer/services/db/DbService', () => ({ dbService: { renameBranch: vi.fn() } }))
vi.mock('@renderer/services/db/branchSubtree', () => ({ deleteBranchSubtree: vi.fn() }))
vi.mock('@renderer/pages/home/Messages/useBranchTree', () => ({ requestTopicBranches: vi.fn() }))

const {
  FOLDED_MARKER_IDS_ATTR,
  FOLDED_MARKER_SELECTOR,
  findFoldedMarkerElement,
  isFoldMarkerMounted,
  parseFoldedMessageIdsAttr
} = await import('../messageNavigation')
const { isForkDividerCrossOwner } = await import('../BranchDividers')
const { isReferenceCrossOwner } = await import('../ReferenceDivider')

const branchWire = (id: string, topicId = 't-1'): TopicBranchWire =>
  ({
    id,
    topicId,
    parentBranchId: null,
    anchorMessageId: 'm-0',
    name: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }) as TopicBranchWire

const reference = (sourceTopicId: string, sourceBranchId: string | null = null): HistoryReferenceMeta =>
  ({
    sourceTopicId,
    sourceBranchId,
    status: 'available'
  }) as HistoryReferenceMeta

describe('parseFoldedMessageIdsAttr', () => {
  it('parses the collapsed-root space-separated token list', () => {
    expect(parseFoldedMessageIdsAttr('m-1 m-2 m-3')).toEqual(['m-1', 'm-2', 'm-3'])
  })

  it('parses a JSON string array', () => {
    expect(parseFoldedMessageIdsAttr('["m-1", "m-2"]')).toEqual(['m-1', 'm-2'])
  })

  it('collapses irregular whitespace to tokens', () => {
    expect(parseFoldedMessageIdsAttr('  m-1\tm-2\nm-3  ')).toEqual(['m-1', 'm-2', 'm-3'])
  })

  it('fail-closes on empty, blank, null and undefined', () => {
    expect(parseFoldedMessageIdsAttr('')).toBeNull()
    expect(parseFoldedMessageIdsAttr('   ')).toBeNull()
    expect(parseFoldedMessageIdsAttr(null)).toBeNull()
    expect(parseFoldedMessageIdsAttr(undefined)).toBeNull()
  })

  it('fail-closes on malformed JSON arrays and non-arrays', () => {
    expect(parseFoldedMessageIdsAttr('["m-1",')).toBeNull()
    expect(parseFoldedMessageIdsAttr('{"id":"m-1"}')).toBeNull()
    expect(parseFoldedMessageIdsAttr('["m-1", ""]')).toBeNull()
    expect(parseFoldedMessageIdsAttr('[]')).toBeNull()
  })
})

describe('fold marker DOM grounding', () => {
  it('exposes the stable selector and attribute contract', () => {
    expect(FOLDED_MARKER_IDS_ATTR).toBe('data-folded-message-ids')
    expect(FOLDED_MARKER_SELECTOR).toBe('[data-folded-message-ids]')
  })

  it('finds the first connected marker that stands in for the id', () => {
    document.body.innerHTML =
      '<div data-folded-message-ids="m-1 m-2"><span>collapsed</span></div>' +
      '<div data-folded-message-ids="m-9"><span>other</span></div>'
    const marker = findFoldedMarkerElement('m-2')
    expect(marker).not.toBeNull()
    expect(marker?.getAttribute('data-folded-message-ids')).toBe('m-1 m-2')
    expect(isFoldMarkerMounted('m-9')).toBe(true)
    expect(isFoldMarkerMounted('m-zzz')).toBe(false)
    document.body.innerHTML = ''
  })

  it('ignores disconnected markers', () => {
    const detached = document.createElement('div')
    detached.setAttribute('data-folded-message-ids', 'm-7 m-8')
    expect(findFoldedMarkerElement('m-7', document)).toBeNull()
    document.body.appendChild(detached)
    expect(findFoldedMarkerElement('m-8', document)).not.toBeNull()
    detached.remove()
  })

  it('fail-closes on empty ids and malformed values', () => {
    document.body.innerHTML = '<div data-folded-message-ids="   "></div>'
    expect(findFoldedMarkerElement('')).toBeNull()
    expect(findFoldedMarkerElement('m-1')).toBeNull()
    document.body.innerHTML = ''
  })
})

describe('isForkDividerCrossOwner', () => {
  it('untaken fork keeps the same owner on both sides', () => {
    expect(isForkDividerCrossOwner('t-1', null, null)).toBe(false)
    expect(isForkDividerCrossOwner('t-1', null, undefined)).toBe(false)
  })

  it('taken child on the same viewed branch is not a cross-owner row', () => {
    expect(isForkDividerCrossOwner('t-1', 'b-1', branchWire('b-1'))).toBe(false)
  })

  it('taken child on another branch is cross-owner', () => {
    expect(isForkDividerCrossOwner('t-1', null, branchWire('b-2'))).toBe(true)
    expect(isForkDividerCrossOwner('t-1', 'b-1', branchWire('b-2'))).toBe(true)
  })

  it('taken child from a foreign topic is cross-owner', () => {
    expect(isForkDividerCrossOwner('t-1', null, branchWire('b-2', 't-2'))).toBe(true)
  })
})

describe('isReferenceCrossOwner', () => {
  it('foreign source topic is always cross-owner', () => {
    expect(isReferenceCrossOwner(reference('t-src'), 't-1')).toBe(true)
  })

  it('same topic without a route qualifier stays cross-owner (two-sided rule)', () => {
    expect(isReferenceCrossOwner(reference('t-1', null), 't-1')).toBe(true)
  })

  it('same topic and same branch is the same owner', () => {
    expect(isReferenceCrossOwner(reference('t-1', 'b-1'), 't-1', 'b-1')).toBe(false)
  })

  it('same topic but another branch is cross-owner', () => {
    expect(isReferenceCrossOwner(reference('t-1', 'b-2'), 't-1', 'b-1')).toBe(true)
  })
})
