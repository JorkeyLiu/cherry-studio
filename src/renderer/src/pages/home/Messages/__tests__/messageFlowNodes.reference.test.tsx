/**
 * Cross-topic history-reference divider wiring.
 *
 * Proves the production builder places each reference divider (one per
 * materialized relation layer) at that layer's exact readonly-foreign-prefix /
 * writable-target-suffix boundary, without guessing a wrong location. The
 * foreign-prefix messages keep their canonical SOURCE topicId (never restamped),
 * which is the stable signal the fallback uses when the boundary message is
 * outside the loaded window, and which also proves an upstream layer is only
 * shown on its own materialized boundary.
 */
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import type { HistoryReferenceMeta } from '@shared/chatDb'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import { renderEditFlowNodes } from '../messageEditSelectionLayout'
import {
  buildMessageFlowNodes,
  type MessageFlowBodyArgs,
  referenceDividerKey,
  type ReferenceDividerPlacement,
  resolveReferenceBoundary,
  resolveReferenceDividers
} from '../messageFlowNodes'
import { buildRenderLayers, buildRenderSegments } from '../messageRenderLayers'
import { projectMessageViewportGroups } from '../messageViewportProjection'
import { createLatestMessageWindow } from '../messageWindow'

const message = (id: string, role: Message['role'], topicId: string, askId?: string, seq = '00'): Message => ({
  id,
  role,
  askId,
  assistantId: 'assistant-1',
  topicId,
  createdAt: `2026-07-19T00:00:${seq}.000Z`,
  status: role === 'user' ? UserMessageStatus.SUCCESS : AssistantMessageStatus.SUCCESS,
  blocks: []
})

const SRC = 'src-1'
const DST = 'dst-1'

// Oldest→newest: two readonly foreign-prefix turns (source topic) then one
// target-owned turn (target topic).
const MESSAGES: Message[] = [
  message('s-u1', 'user', SRC, undefined, '01'),
  message('s-a1', 'assistant', SRC, 's-u1', '02'),
  message('s-u2', 'user', SRC, undefined, '03'),
  message('s-a2', 'assistant', SRC, 's-u2', '04'),
  message('t-u1', 'user', DST, undefined, '05'),
  message('t-a1', 'assistant', DST, 't-u1', '06')
]

// A→B→C chain: A rows, B rows over A's live prefix, C rows over B's live prefix.
const A_TOPIC = 'chain-a'
const B_TOPIC = 'chain-b'
const C_TOPIC = 'chain-c'
const CHAIN_MESSAGES: Message[] = [
  message('a-u1', 'user', A_TOPIC, undefined, '01'),
  message('a-a1', 'assistant', A_TOPIC, 'a-u1', '02'),
  message('a-u2', 'user', A_TOPIC, undefined, '03'),
  message('a-a2', 'assistant', A_TOPIC, 'a-u2', '04'),
  message('b-u1', 'user', B_TOPIC, undefined, '05'),
  message('b-a1', 'assistant', B_TOPIC, 'b-u1', '06'),
  message('b-u2', 'user', B_TOPIC, undefined, '07'),
  message('b-a2', 'assistant', B_TOPIC, 'b-u2', '08'),
  message('c-u1', 'user', C_TOPIC, undefined, '09'),
  message('c-a1', 'assistant', C_TOPIC, 'c-u1', '10')
]

const reference = (over: Partial<HistoryReferenceMeta> = {}): HistoryReferenceMeta => ({
  sourceTopicId: SRC,
  sourceBranchId: null,
  anchorMessageId: 's-a2',
  sourceName: 'Source',
  status: 'available',
  boundaryMessageId: 's-a2',
  ...over
})

/** C→B→A chain metadata as Main derives it: nearest layer first. */
const chainReference = (over: Partial<HistoryReferenceMeta> = {}): HistoryReferenceMeta => ({
  sourceTopicId: B_TOPIC,
  sourceBranchId: null,
  anchorMessageId: 'b-a2',
  sourceName: 'B',
  status: 'available',
  boundaryMessageId: 'b-a2',
  layers: [
    {
      targetTopicId: C_TOPIC,
      sourceTopicId: B_TOPIC,
      sourceBranchId: null,
      anchorMessageId: 'b-a2',
      sourceName: 'B',
      status: 'available',
      boundaryMessageId: 'b-a2'
    },
    {
      targetTopicId: B_TOPIC,
      sourceTopicId: A_TOPIC,
      sourceBranchId: null,
      anchorMessageId: 'a-a2',
      sourceName: 'A',
      status: 'available',
      boundaryMessageId: 'a-a2'
    }
  ],
  ...over
})

function project(messages: Message[] = MESSAGES) {
  const win = createLatestMessageWindow(messages, 10)
  return projectMessageViewportGroups(win.displayMessages, win.displayGroups)
}

const renderBodyProbe = ({ stableGroupId, groupMessages }: MessageFlowBodyArgs) => (
  <div data-stable-group-id={stableGroupId} data-testid={`body-${groupMessages.map((m) => m.id).join('+')}`} />
)

const noopBoundary = () => null

function buildFlow(
  referenceDividers: readonly ReferenceDividerPlacement[],
  info: { topicId: string; messages: Message[] }
): { nodes: ReturnType<typeof buildMessageFlowNodes>; element: ReactNode } {
  const grouped = project(info.messages)
  const segments = buildRenderSegments(grouped, false, [])
  const layerRuns = buildRenderLayers(segments)
  const nodes = buildMessageFlowNodes({
    layerRuns,
    contextDividerGroupKey: null,
    referenceDividers,
    forkDividers: [],
    branchPath: [],
    branches: [],
    topicDisplayName: 'Target',
    isMessageInSegment: () => undefined,
    isMessageFirstInSegment: () => undefined,
    isMessageLastInSegment: () => undefined,
    renderBody: renderBodyProbe,
    renderForkBoundary: noopBoundary,
    renderContextBoundary: noopBoundary,
    renderReferenceDivider: ({ targetTopicId }) => (
      <div
        data-testid="reference-boundary"
        data-boundary-kind="reference"
        data-reference-target-topic={targetTopicId}
      />
    )
  })
  return { nodes, element: <>{renderEditFlowNodes({ nodes, isEditMode: false })}</> }
}

const boundaryKeysOf = (nodes: ReturnType<typeof buildMessageFlowNodes>): string[] =>
  (nodes as Array<{ kind: string; entry?: { boundaryKind?: string; boundaryKey?: string } }>)
    .filter((node) => node.kind === 'boundary' && node.entry?.boundaryKind === 'reference')
    .map((node) => node.entry?.boundaryKey as string)

describe('resolveReferenceBoundary', () => {
  it('returns null for ordinary topics (no reference metadata)', () => {
    expect(resolveReferenceBoundary(project(), null, DST)).toBeNull()
    expect(resolveReferenceBoundary(project(), undefined, DST)).toBeNull()
  })

  it('places the divider directly after the resident boundary message group', () => {
    const grouped = project()
    const boundaryEntry = grouped.find(([, msgs]) => msgs.some((m) => m.id === 's-a2'))
    expect(boundaryEntry).toBeDefined()
    const boundary = resolveReferenceBoundary(
      grouped,
      {
        sourceTopicId: SRC,
        status: 'available',
        boundaryMessageId: 's-a2'
      },
      DST
    )
    expect(boundary).toEqual({ groupKey: boundaryEntry![0], placement: 'after-boundary' })
  })

  it('places the divider at the demonstrable foreign→owned transition when the boundary is outside the window', () => {
    const grouped = project()
    const newestPrefix = grouped.find(([, msgs]) => msgs.some((m) => m.topicId === SRC))
    expect(newestPrefix).toBeDefined()
    // The newest loaded foreign group is immediately followed (newer) by an
    // owned suffix group, so the transition is demonstrable.
    const boundary = resolveReferenceBoundary(
      grouped,
      {
        sourceTopicId: SRC,
        status: 'available',
        boundaryMessageId: 's-a2-outside-window'
      },
      DST
    )
    expect(boundary).toEqual({ groupKey: newestPrefix![0], placement: 'after-boundary' })
  })

  it('defers the divider (no false placement) when the loaded window is all foreign prefix and the endpoint is offscreen', () => {
    // Window holds only earlier readonly-prefix groups; the actual
    // prefix/suffix boundary (and the target-owned suffix) is newer and
    // offscreen. The fallback must NOT guess a boundary inside the prefix.
    const prefixOnly: Message[] = [
      message('p-u1', 'user', SRC, undefined, '01'),
      message('p-a1', 'assistant', SRC, 'p-u1', '02'),
      message('p-u2', 'user', SRC, undefined, '03'),
      message('p-a2', 'assistant', SRC, 'p-u2', '04')
    ]
    const groupedPrefix = project(prefixOnly)
    expect(groupedPrefix.length).toBeGreaterThan(0)
    expect(groupedPrefix.every(([, msgs]) => msgs.every((m) => m.topicId === SRC))).toBe(true)
    const boundary = resolveReferenceBoundary(
      groupedPrefix,
      { sourceTopicId: SRC, status: 'available', boundaryMessageId: 'endpoint-not-loaded' },
      DST
    )
    expect(boundary).toBeNull()
  })

  it('does not treat an unowned/blank topicId group as a demonstrable owned successor (fail-closed defer)', () => {
    // Newest group carries a blank topicId (no canonical owner): it must never
    // be read as the owned suffix, so the transition is not demonstrable and the
    // divider defers.
    const blank = message('b-u1', 'user', '', undefined, '05')
    const groupedBlank = project([...MESSAGES.slice(0, 4), blank])
    const boundary = resolveReferenceBoundary(
      groupedBlank,
      { sourceTopicId: SRC, status: 'available', boundaryMessageId: 'endpoint-not-loaded' },
      DST
    )
    expect(boundary).toBeNull()
  })

  it('derives the fallback from foreign ownership, not a single sourceTopicId (recursive reference)', () => {
    // Recursive reference: the foreign prefix keeps the GRAND-source canonical
    // topicId, which never equals the relation's declared sourceTopicId. The
    // fallback must still find the prefix/suffix transition by ownership.
    const grandSource = 'grand-src'
    const recursive: Message[] = [
      message('g-u1', 'user', grandSource, undefined, '01'),
      message('g-a1', 'assistant', grandSource, 'g-u1', '02'),
      message('t-u1', 'user', DST, undefined, '03'),
      message('t-a1', 'assistant', DST, 't-u1', '04')
    ]
    const groupedRecursive = project(recursive)
    const expectedKey = groupedRecursive.find(([, msgs]) => msgs.some((m) => m.id === 'g-a1'))![0]
    const boundary = resolveReferenceBoundary(
      groupedRecursive,
      { sourceTopicId: 'immediate-src', status: 'available', boundaryMessageId: 'not-in-window' },
      DST
    )
    expect(boundary).toEqual({ groupKey: expectedKey, placement: 'after-boundary' })
  })

  it('places the divider at the beginning when the source is missing or no prefix is loaded', () => {
    const grouped = project()
    expect(
      resolveReferenceBoundary(grouped, { sourceTopicId: SRC, status: 'missing', boundaryMessageId: null }, DST)
    ).toEqual({ groupKey: null, placement: 'beginning' })
    // Window with no foreign-prefix message: boundary falls to the beginning.
    const targetOnly = grouped.filter(([, msgs]) => msgs.every((m) => m.topicId === DST))
    expect(
      resolveReferenceBoundary(targetOnly, { sourceTopicId: SRC, status: 'available', boundaryMessageId: null }, DST)
    ).toEqual({ groupKey: null, placement: 'beginning' })
  })
})

describe('resolveReferenceDividers (layered relations)', () => {
  it('keeps the established single placement for one relation without layers', () => {
    const grouped = project()
    const boundaryEntry = grouped.find(([, msgs]) => msgs.some((m) => m.id === 's-a2'))!
    const placements = resolveReferenceDividers(grouped, reference(), DST)
    expect(placements).toHaveLength(1)
    expect(placements[0]).toMatchObject({
      boundaryKey: referenceDividerKey(DST),
      targetTopicId: DST,
      groupKey: boundaryEntry[0],
      placement: 'after-boundary'
    })
  })

  it('keeps the single beginning placement for a missing source', () => {
    const placements = resolveReferenceDividers(
      project(),
      reference({ status: 'missing', boundaryMessageId: null }),
      DST
    )
    expect(placements).toHaveLength(1)
    expect(placements[0]).toMatchObject({ placement: 'beginning', groupKey: null, targetTopicId: DST })
  })

  it('returns one placement per materialized layer, nearest first, each at its own boundary', () => {
    const grouped = project(CHAIN_MESSAGES)
    const placements = resolveReferenceDividers(grouped, chainReference(), C_TOPIC)
    expect(placements.map((placement) => placement.targetTopicId)).toEqual([C_TOPIC, B_TOPIC])
    // Stable, distinct identities (never a single folded history-reference key).
    expect(placements.map((placement) => placement.boundaryKey)).toEqual([
      referenceDividerKey(C_TOPIC),
      referenceDividerKey(B_TOPIC)
    ])
    const ownBoundaryKey = grouped.find(([, msgs]) => msgs.some((m) => m.id === 'b-a2'))![0]
    const ancestorBoundaryKey = grouped.find(([, msgs]) => msgs.some((m) => m.id === 'a-a2'))![0]
    expect(placements[0].groupKey).toBe(ownBoundaryKey)
    expect(placements[1].groupKey).toBe(ancestorBoundaryKey)
    // Each placement carries its own layer relation for rendering/navigation.
    expect(placements[1].reference.sourceTopicId).toBe(A_TOPIC)
  })

  it('keeps same-endpoint layers as distinct entries on the same boundary', () => {
    // E referenced B at B's own relation endpoint: both relations end on A's
    // last row, so both dividers share the boundary group but never merge.
    const sameEndReference = chainReference({
      layers: [
        {
          targetTopicId: C_TOPIC,
          sourceTopicId: B_TOPIC,
          sourceBranchId: null,
          anchorMessageId: 'a-a2',
          sourceName: 'B',
          status: 'available',
          boundaryMessageId: 'a-a2'
        },
        {
          targetTopicId: B_TOPIC,
          sourceTopicId: A_TOPIC,
          sourceBranchId: null,
          anchorMessageId: 'a-a2',
          sourceName: 'A',
          status: 'available',
          boundaryMessageId: 'a-a2'
        }
      ]
    })
    const grouped = project(CHAIN_MESSAGES)
    const placements = resolveReferenceDividers(grouped, sameEndReference, C_TOPIC)
    expect(placements).toHaveLength(2)
    expect(new Set(placements.map((placement) => placement.boundaryKey)).size).toBe(2)
    const sharedBoundaryKey = grouped.find(([, msgs]) => msgs.some((m) => m.id === 'a-a2'))![0]
    expect(placements.every((placement) => placement.groupKey === sharedBoundaryKey)).toBe(true)
  })

  it('defers an ancestor layer whose boundary is not loaded instead of promoting it to the head', () => {
    const grouped = project(CHAIN_MESSAGES).filter(([, msgs]) => !msgs.some((m) => m.id === 'a-a2'))
    expect(grouped.some(([, msgs]) => msgs.some((m) => m.id === 'a-a2'))).toBe(false)
    const placements = resolveReferenceDividers(grouped, chainReference(), C_TOPIC)
    expect(placements.map((placement) => placement.targetTopicId)).toEqual([C_TOPIC])
    // The deferred layer must not invent a beginning placement either.
    expect(
      placements.some((placement) => placement.placement === 'beginning' && placement.targetTopicId === B_TOPIC)
    ).toBe(false)
  })

  it('does not render an ancestor layer that Main did not report (downstream truncation)', () => {
    // Main reports a single layer when a downstream endpoint truncates the
    // upstream history; the renderer must never fabricate a second line.
    const truncatedReference = chainReference({
      sourceTopicId: B_TOPIC,
      anchorMessageId: 'a-a1',
      boundaryMessageId: 'a-a1',
      layers: [
        {
          targetTopicId: C_TOPIC,
          sourceTopicId: B_TOPIC,
          sourceBranchId: null,
          anchorMessageId: 'a-a1',
          sourceName: 'B',
          status: 'available',
          boundaryMessageId: 'a-a1'
        }
      ]
    })
    const grouped = project(CHAIN_MESSAGES)
    const placements = resolveReferenceDividers(grouped, truncatedReference, C_TOPIC)
    expect(placements).toHaveLength(1)
    expect(placements[0].targetTopicId).toBe(C_TOPIC)
  })
})

describe('buildMessageFlowNodes reference divider placement', () => {
  it('renders the divider DOM-before the boundary group (visually directly below it)', () => {
    const grouped = project()
    const placements = resolveReferenceDividers(grouped, reference(), DST)
    const { nodes, element } = buildFlow(placements, { topicId: DST, messages: MESSAGES })
    expect(boundaryKeysOf(nodes)).toEqual([referenceDividerKey(DST)])
    const { container } = render(element)
    const divider = container.querySelector('[data-testid="reference-boundary"]') as Element
    const boundaryBody = container.querySelector('[data-testid="body-s-a2"]') as Element
    expect(divider).not.toBeNull()
    expect(boundaryBody).not.toBeNull()
    // Newest→oldest DOM order: divider before boundary body under column-reverse.
    expect(divider.compareDocumentPosition(boundaryBody) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Never inside a turn container.
    expect(divider.closest('[data-turn-ask]')).toBeNull()
    expect(container.querySelectorAll('[data-testid="reference-boundary"]').length).toBe(1)
  })

  it('renders both chain dividers at their own boundaries in nearest-first DOM order', () => {
    const grouped = project(CHAIN_MESSAGES)
    const placements = resolveReferenceDividers(grouped, chainReference(), C_TOPIC)
    const { nodes, element } = buildFlow(placements, { topicId: C_TOPIC, messages: CHAIN_MESSAGES })
    // Two distinct stable identities, never one folded key.
    expect(boundaryKeysOf(nodes)).toEqual([referenceDividerKey(C_TOPIC), referenceDividerKey(B_TOPIC)])
    const { container } = render(element)
    const dividers = Array.from(container.querySelectorAll('[data-testid="reference-boundary"]'))
    expect(dividers.map((divider) => divider.getAttribute('data-reference-target-topic'))).toEqual([C_TOPIC, B_TOPIC])
    // The nearest divider (own relation, C→B) sits directly below B's last
    // message; the ancestor divider (B→A) directly below A's last message.
    const ownBody = container.querySelector('[data-testid="body-b-a2"]') as Element
    const ancestorBody = container.querySelector('[data-testid="body-a-a2"]') as Element
    expect(dividers[0].compareDocumentPosition(ownBody) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(dividers[1].compareDocumentPosition(ancestorBody) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Neither divider leaks into a turn container or above the owned suffix.
    expect(dividers[0].closest('[data-turn-ask]')).toBeNull()
    expect(dividers[1].closest('[data-turn-ask]')).toBeNull()
    const firstOwnedBody = container.querySelector('[data-testid="body-c-u1"]') as Element
    expect(dividers[0].compareDocumentPosition(firstOwnedBody) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
  })

  it('renders the divider at the beginning when missing', () => {
    const placements = resolveReferenceDividers(
      project(),
      reference({ status: 'missing', boundaryMessageId: null }),
      DST
    )
    const { container } = render(buildFlow(placements, { topicId: DST, messages: MESSAGES }).element)
    const divider = container.querySelector('[data-testid="reference-boundary"]') as Element
    const oldest = container.querySelector('[data-testid="body-s-u1"]') as Element
    expect(divider).not.toBeNull()
    // Appended last in newest→oldest DOM order = visual beginning (above oldest).
    expect(oldest.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(container.querySelectorAll('[data-testid="reference-boundary"]').length).toBe(1)
  })

  it('renders no reference divider for ordinary topics', () => {
    const { container } = render(buildFlow([], { topicId: DST, messages: MESSAGES }).element)
    expect(container.querySelector('[data-testid="reference-boundary"]')).toBeNull()
  })
})
