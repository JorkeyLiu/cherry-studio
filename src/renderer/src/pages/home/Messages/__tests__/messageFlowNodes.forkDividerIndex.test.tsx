/**
 * Fork-divider boundary index — result-equivalence lock for `buildMessageFlowNodes`.
 *
 * The builder resolves each group's fork dividers through a per-build
 * `boundaryMessageId` lookup instead of scanning the whole divider list per
 * group. These tests pin the observable result (never the lookup itself):
 * every divider still lands only under its resident boundary message, several
 * dividers on one boundary keep their resolved order, empty inputs emit no
 * fork boundary, and a mixed input produces node signatures identical to an
 * independent naive per-group matcher (the pre-index matching semantics).
 */
import type { TopicBranchWire } from '@renderer/services/db/types'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { buildDividerKey, dividerRowTestId } from '../BranchDividers'
import { deriveTurnAskId, renderEditFlowNodes } from '../messageEditSelectionLayout'
import {
  buildMessageFlowNodes,
  type ForkDividerPlacement,
  type MessageFlowBodyArgs,
  type MessageFlowForkArgs
} from '../messageFlowNodes'
import { buildRenderLayers, buildRenderSegments, deriveStableGroupId } from '../messageRenderLayers'
import type { MessageViewportProjectedGroup } from '../messageViewportProjection'
import { projectMessageViewportGroups } from '../messageViewportProjection'
import { createLatestMessageWindow } from '../messageWindow'

const message = (id: string, role: Message['role'], askId?: string, seq = '00'): Message => ({
  id,
  role,
  askId,
  assistantId: 'assistant-1',
  topicId: 'topic-1',
  createdAt: `2026-07-19T00:00:${seq}.000Z`,
  status: role === 'user' ? UserMessageStatus.SUCCESS : AssistantMessageStatus.SUCCESS,
  blocks: []
})

const childBranch = (
  id: string,
  anchorMessageId: string,
  parentBranchId: string | null,
  seq: string
): TopicBranchWire => ({
  id,
  topicId: 'topic-1',
  parentBranchId,
  anchorMessageId,
  name: `Branch ${id}`,
  createdAt: `2026-07-19T00:01:${seq}.000Z`,
  updatedAt: `2026-07-19T00:01:${seq}.000Z`
})

const messageDivider = (
  children: TopicBranchWire[],
  anchorMessageId: string,
  parentBranchId: string | null,
  boundaryMessageId: string
): ForkDividerPlacement => ({
  anchorMessageId,
  parentBranchId,
  children,
  placement: 'message',
  boundaryMessageId
})

const renderBodyProbe = ({ kind, stableGroupId, layerRunId, groupMessages }: MessageFlowBodyArgs) => (
  <div
    data-layer-kind={kind}
    data-stable-group-id={stableGroupId}
    data-layer-run-id={layerRunId}
    data-testid={`body-${groupMessages.map((m) => m.id).join('+')}`}
  />
)

const renderForkProbe = ({ anchorMessageId, parentBranchId, children }: MessageFlowForkArgs) => (
  <div
    data-testid={dividerRowTestId(anchorMessageId, parentBranchId)}
    data-divider-key={buildDividerKey(anchorMessageId, parentBranchId)}
    data-divider-anchor={anchorMessageId}
    data-child-count={children.length}
  />
)

const noopBoundary = () => null

function buildProductionFlow(messages: Message[], forkDividers: ForkDividerPlacement[]) {
  const win = createLatestMessageWindow(messages, 20)
  const grouped = projectMessageViewportGroups(win.displayMessages, win.displayGroups)
  const segments = buildRenderSegments(grouped, false, [])
  const layers = buildRenderLayers(segments)
  const nodes = buildMessageFlowNodes({
    layerRuns: layers,
    contextDividerGroupKey: null,
    forkDividers,
    branchPath: [],
    branches: [],
    topicDisplayName: 'Test Topic',
    isMessageInSegment: () => undefined,
    isMessageFirstInSegment: () => undefined,
    isMessageLastInSegment: () => undefined,
    renderBody: renderBodyProbe,
    renderForkBoundary: renderForkProbe,
    renderContextBoundary: noopBoundary
  })
  return { grouped, segments, layers, nodes }
}

type FlowNodes = ReturnType<typeof buildMessageFlowNodes>

const signatureOf = (nodes: FlowNodes): string[] =>
  nodes.map((node) => {
    if (node.kind === 'turn') {
      const entry = node.entry
      return `turn|${entry.groupKey}|${entry.turnAskId}|${entry.kind}|${entry.layerRunId}|${String(entry.selected)}|${entry.segmentId}|${(entry.messageIds ?? []).join('+')}|${String(entry.isFolded)}`
    }
    const entry = node.entry
    return `boundary|${entry.boundaryKind}|${entry.boundaryKey}`
  })

const forkBoundaryKeysOf = (nodes: FlowNodes): string[] =>
  nodes
    .filter((node) => node.kind === 'boundary' && node.entry.boundaryKind === 'fork')
    .map((node) => (node.entry as { boundaryKey: string }).boundaryKey)

/** Pre-index matching semantics: per-group resident set scanned against the whole input list. */
const naiveDividersForGroup = (
  groupMessageIds: readonly string[],
  forkDividers: readonly ForkDividerPlacement[]
): ForkDividerPlacement[] => {
  const groupIdSet = new Set(groupMessageIds)
  return forkDividers.filter(
    (divider) =>
      divider.placement === 'message' && divider.boundaryMessageId !== null && groupIdSet.has(divider.boundaryMessageId)
  )
}

const forkKeyOf = (divider: ForkDividerPlacement): string =>
  `branch-fork-${divider.anchorMessageId}-${divider.parentBranchId ?? 'main'}`

describe('messageFlowNodes fork-divider boundary index', () => {
  it('places one divider per group only under its resident boundary message across many groups', () => {
    const messages: Message[] = [
      message('m-u1', 'user', undefined, '01'),
      message('m-a1', 'assistant', 'm-u1', '02'),
      message('m-u2', 'user', undefined, '03'),
      message('m-a2', 'assistant', 'm-u2', '04'),
      message('m-u3', 'user', undefined, '05'),
      message('m-a3', 'assistant', 'm-u3', '06')
    ]
    const dividerA = messageDivider([childBranch('b-a', 'm-u1', null, '01')], 'm-u1', null, 'm-a1')
    const dividerC = messageDivider([childBranch('b-c', 'm-u3', null, '02')], 'm-u3', null, 'm-a3')
    const { grouped, layers, nodes } = buildProductionFlow(messages, [dividerA, dividerC])

    // Only the two resident boundaries emit; nothing leaks onto other groups.
    expect(forkBoundaryKeysOf(nodes)).toEqual([forkKeyOf(dividerA), forkKeyOf(dividerC)])

    // Stable turn fields are untouched by the lookup: every turn keeps its
    // production-derived identity, askId, liveness, and layer membership.
    const turns = nodes.filter((node) => node.kind === 'turn')
    expect(turns.length).toBe(grouped.length)
    const itemsOldestFirst = [...layers[0].segments.flatMap((seg) => seg.items)].reverse()
    expect(turns.map((node) => (node.entry as { groupKey: string }).groupKey)).toEqual(
      itemsOldestFirst.map(([, msgs]) => deriveStableGroupId(msgs as readonly Message[]))
    )
    expect(turns.map((node) => (node.entry as { turnAskId: string }).turnAskId)).toEqual(
      itemsOldestFirst.map(([, msgs]) => deriveTurnAskId(msgs as readonly Message[]))
    )
    for (const node of turns) {
      const entry = node.entry as { kind: string; layerRunId: string; selected: boolean }
      expect(entry.kind).toBe('history')
      expect(entry.layerRunId).toBe(layers[0].stableLayerId)
      expect(entry.selected).toBe(false)
    }

    // Rendered DOM: each divider sits directly below its own boundary body and
    // outside any turn container, with stable group keys preserved on bodies.
    const { container } = render(<>{renderEditFlowNodes({ nodes, isEditMode: false })}</>)
    const bodyA = container.querySelector('[data-testid="body-m-a1"]') as Element
    const bodyC = container.querySelector('[data-testid="body-m-a3"]') as Element
    const forkA = container.querySelector(`[data-testid="${dividerRowTestId('m-u1', null)}"]`) as Element
    const forkC = container.querySelector(`[data-testid="${dividerRowTestId('m-u3', null)}"]`) as Element
    expect(bodyA.compareDocumentPosition(forkA) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(bodyC.compareDocumentPosition(forkC) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(forkA.closest('[data-turn-ask]')).toBeNull()
    expect(forkC.closest('[data-turn-ask]')).toBeNull()
    const stableIds = Array.from(container.querySelectorAll('[data-stable-group-id]')).map((el) =>
      el.getAttribute('data-stable-group-id')
    )
    expect(new Set(stableIds).size).toBe(stableIds.length)
  })

  it('keeps several dividers on the same boundary in resolved input order', () => {
    const messages: Message[] = [
      message('m-u1', 'user', undefined, '01'),
      message('m-a1', 'assistant', 'm-u1', '02'),
      message('m-u2', 'user', undefined, '03'),
      message('m-a2', 'assistant', 'm-u2', '04')
    ]
    // Two forks inherit at the same resident message: the input order is the
    // resolved order and must survive the per-build lookup as a unit.
    const first = messageDivider([childBranch('b-1', 'm-u1', null, '01')], 'm-u1', null, 'm-a1')
    const second = messageDivider([childBranch('b-2', 'm-u1', 'b-1', '02')], 'm-u1', 'b-1', 'm-a1')
    const { nodes } = buildProductionFlow(messages, [first, second])

    const naive = naiveDividersForGroup(['m-a1'], [first, second])
    expect(naive.map(forkKeyOf)).toEqual([forkKeyOf(first), forkKeyOf(second)])
    // The builder pushes dividers newest-first before the anchor body and
    // reverses once, so both land DOM-after the body in flipped relative
    // order; the naive matcher run through the same collect-then-reverse
    // semantics predicts exactly that.
    const naiveCollection = naive.map((divider) => `boundary|fork|${forkKeyOf(divider)}`)
    const actualForkSigs = signatureOf(nodes).filter((sig) => sig.startsWith('boundary|fork'))
    expect(actualForkSigs).toEqual([...naiveCollection].reverse())

    const { container } = render(<>{renderEditFlowNodes({ nodes, isEditMode: false })}</>)
    const body = container.querySelector('[data-testid="body-m-a1"]') as Element
    const forkFirst = container.querySelector(`[data-testid="${dividerRowTestId('m-u1', null)}"]`) as Element
    const forkSecond = container.querySelector(`[data-testid="${dividerRowTestId('m-u1', 'b-1')}"]`) as Element
    expect(body.compareDocumentPosition(forkFirst) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(body.compareDocumentPosition(forkSecond) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(container.querySelectorAll('[data-testid^="branch-fork-divider-"]').length).toBe(2)
  })

  it('emits no fork boundary without dividers and no nodes without groups', () => {
    const messages: Message[] = [message('m-u1', 'user', undefined, '01')]
    const { nodes } = buildProductionFlow(messages, [])
    expect(nodes.length).toBeGreaterThan(0)
    expect(nodes.every((node) => node.kind === 'turn')).toBe(true)

    const empty = buildMessageFlowNodes({
      layerRuns: [],
      contextDividerGroupKey: null,
      forkDividers: [],
      branchPath: [],
      branches: [],
      topicDisplayName: 'Test Topic',
      isMessageInSegment: () => undefined,
      isMessageFirstInSegment: () => undefined,
      isMessageLastInSegment: () => undefined,
      renderBody: renderBodyProbe,
      renderForkBoundary: renderForkProbe,
      renderContextBoundary: noopBoundary
    })
    expect(empty).toEqual([])
  })

  it('matches the naive per-group matcher on a mixed input (index changes no result)', () => {
    // Oldest→newest: four turns; dividers hit two of them, share one boundary,
    // miss the window once, and add a head divider through the head loop.
    const messages: Message[] = [
      message('w-u1', 'user', undefined, '01'),
      message('w-a1', 'assistant', 'w-u1', '02'),
      message('w-u2', 'user', undefined, '03'),
      message('w-a2', 'assistant', 'w-u2', '04'),
      message('w-u3', 'user', undefined, '05'),
      message('w-a3', 'assistant', 'w-u3', '06'),
      message('w-u4', 'user', undefined, '07'),
      message('w-a4', 'assistant', 'w-u4', '08')
    ]
    const hitOld = messageDivider([childBranch('b-old', 'w-u1', null, '01')], 'w-u1', null, 'w-a1')
    const sharedFirst = messageDivider([childBranch('b-s1', 'w-u3', null, '02')], 'w-u3', null, 'w-a3')
    const sharedSecond = messageDivider([childBranch('b-s2', 'w-u3', 'b-s1', '03')], 'w-u3', 'b-s1', 'w-a3')
    const offscreen = messageDivider([childBranch('b-off', 'w-u9', null, '04')], 'w-u9', null, 'missing-id')
    const head: ForkDividerPlacement = {
      anchorMessageId: 'w-u0',
      parentBranchId: null,
      children: [childBranch('b-head', 'w-u0', null, '05')],
      placement: 'head',
      boundaryMessageId: null
    }
    const forkDividers = [hitOld, sharedFirst, sharedSecond, offscreen, head]
    const { grouped, segments, layers, nodes } = buildProductionFlow(messages, forkDividers)

    // Independent oracle: naive per-group matching in newest→oldest collection
    // order, head loop, single final reversal — the pre-index semantics.
    const layerRunId = layers[0].stableLayerId
    const segmentOf = (groupKey: string) => segments.find((seg) => seg.items.some(([key]) => key === groupKey))!
    const collected: string[] = []
    for (const [legacyKey, groupMessages] of grouped) {
      const ids = (groupMessages as Message[]).map((m) => m.id)
      for (const divider of naiveDividersForGroup(ids, forkDividers)) {
        collected.push(`boundary|fork|${forkKeyOf(divider)}`)
      }
      const groupKey = deriveStableGroupId(groupMessages as readonly Message[])
      const turnAskId = deriveTurnAskId(groupMessages as readonly Message[])
      const seg = segmentOf(legacyKey)
      collected.push(
        `turn|${groupKey}|${turnAskId}|history|${layerRunId}|false|${seg.stableSegmentId}|${ids.join('+')}|false`
      )
    }
    for (const divider of forkDividers) {
      if (divider.placement === 'head') collected.push(`boundary|fork|${forkKeyOf(divider)}`)
    }
    const expected = collected.reverse()

    expect(signatureOf(nodes)).toEqual(expected)
    // The offscreen boundary never materializes; the head divider renders first.
    expect(forkBoundaryKeysOf(nodes)).not.toContain(forkKeyOf(offscreen))
    expect(signatureOf(nodes)[0]).toBe(`boundary|fork|${forkKeyOf(head)}`)
  })

  it('restores resolved input order when one group holds several boundary messages', () => {
    // One hand-built group carries two boundary messages while the divider
    // input lists the later message's divider first: the per-group hit must
    // still emit in resolved input order, exactly like the naive filter.
    const mkGroup = (key: string, ids: string[]): MessageViewportProjectedGroup => [
      key,
      ids.map((id, index) => ({ ...message(id, 'user', undefined, `0${index + 1}`), index }))
    ]
    const dividerLater = messageDivider([childBranch('b-later', 'g-u2', null, '01')], 'g-u2', null, 'g-u2')
    const dividerEarlier = messageDivider([childBranch('b-earlier', 'g-u1', null, '02')], 'g-u1', null, 'g-u1')
    const forkDividers = [dividerLater, dividerEarlier]
    const multiGroup = mkGroup('g-new', ['g-u1', 'g-u2'])
    const singleGroup = mkGroup('g-old', ['g-u0'])
    const layers = [
      {
        kind: 'history' as const,
        segments: [
          {
            selected: false,
            items: [multiGroup, singleGroup],
            stableSegmentId: 'seg-1',
            isLive: false
          }
        ],
        stableLayerId: 'layer-1'
      }
    ]
    const nodes = buildMessageFlowNodes({
      layerRuns: layers,
      contextDividerGroupKey: null,
      forkDividers,
      branchPath: [],
      branches: [],
      topicDisplayName: 'Test Topic',
      isMessageInSegment: () => undefined,
      isMessageFirstInSegment: () => undefined,
      isMessageLastInSegment: () => undefined,
      renderBody: renderBodyProbe,
      renderForkBoundary: renderForkProbe,
      renderContextBoundary: noopBoundary
    })
    const naiveNewestFirst: string[] = []
    for (const [, groupMessages] of [multiGroup, singleGroup]) {
      for (const divider of naiveDividersForGroup(
        (groupMessages as Message[]).map((m) => m.id),
        forkDividers
      )) {
        naiveNewestFirst.push(`boundary|fork|${forkKeyOf(divider)}`)
      }
      naiveNewestFirst.push('turn')
    }
    const expectedForkOrder = naiveNewestFirst.filter((sig) => sig.startsWith('boundary|fork')).reverse()
    expect(signatureOf(nodes).filter((sig) => sig.startsWith('boundary|fork'))).toEqual(expectedForkOrder)
  })
})
