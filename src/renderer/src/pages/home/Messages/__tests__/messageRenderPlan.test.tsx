/**
 * Sixth-slice render-plan proof: the single production assembly
 * (`buildMessageRenderPlan` + `buildMessageFlowNodesFromPlan`) preserves every
 * observable contract of the previous per-site derivation while removing the
 * duplicate work.
 *
 * - Parity: plan segments/layers/context/reference/flow equal the
 *   compatibility wrappers (same shared core) on identical inputs.
 * - Edges (hand-computed, not cross-equality): segment first-match overlap,
 *   independent first/last attribution, unknown boundaries, deep-reference
 *   fallback/deferral, blank-topicId fail-closed, selection atomicity,
 *   fold retention, first-write-wins index.
 * - Budgets: identity derived exactly once per group; no `includes` scans on
 *   segment membership; exactly one liveness `some` per group; context and
 *   reference resolved from the precomputed index/flags.
 */
import type { TopicBranchWire } from '@renderer/services/db/types'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import type { TopicSegment } from '@renderer/types/topicSegment'
import type { HistoryReferenceMeta } from '@shared/chatDb'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { buildDividerKey, dividerRowTestId } from '../BranchDividers'
import { deriveTurnAskId, renderEditFlowNodes } from '../messageEditSelectionLayout'
import {
  buildMessageFlowNodes,
  buildMessageFlowNodesFromPlan,
  type MessageFlowBodyArgs,
  type MessageFlowForkArgs,
  referenceDividerKey,
  resolveContextDividerGroupKey,
  resolveForkDividers,
  resolveReferenceDividers
} from '../messageFlowNodes'
import { buildRenderLayers, buildRenderSegments, deriveStableGroupId } from '../messageRenderLayers'
import { buildMessageRenderPlan, deriveStableGroupId as deriveStableGroupIdCanonical } from '../messageRenderPlan'
import { projectMessageViewportGroups } from '../messageViewportProjection'
import { createLatestMessageWindow } from '../messageWindow'

const TOPIC = 'topic-1'

const message = (
  id: string,
  role: Message['role'],
  opts: { askId?: string; topicId?: string; seq?: string; status?: Message['status']; folded?: boolean } = {}
): Message => ({
  id,
  role,
  askId: opts.askId,
  assistantId: 'assistant-1',
  topicId: opts.topicId ?? TOPIC,
  createdAt: `2026-07-19T00:00:${opts.seq ?? '00'}.000Z`,
  status: opts.status ?? (role === 'user' ? UserMessageStatus.SUCCESS : AssistantMessageStatus.SUCCESS),
  blocks: [],
  ...(opts.folded === undefined ? {} : { folded: opts.folded })
})

const processing = (id: string, askId: string, seq = '00'): Message =>
  message(id, 'assistant', { askId, seq, status: AssistantMessageStatus.PROCESSING })

const seg = (
  id: string,
  messageIds: string[],
  first: string | null,
  last: string | null,
  sortOrder = 0
): TopicSegment => ({
  id,
  topicId: TOPIC,
  name: id,
  messageIds,
  createdAt: '2026-07-19T00:00:00.000Z',
  updatedAt: '2026-07-19T00:00:00.000Z',
  sortOrder,
  firstMessageId: first,
  lastMessageId: last,
  messageCount: messageIds.length
})

const reference = (over: Partial<HistoryReferenceMeta> = {}): HistoryReferenceMeta => ({
  sourceTopicId: 'src-1',
  sourceBranchId: null,
  anchorMessageId: 's-a2',
  sourceName: 'Source',
  status: 'available',
  boundaryMessageId: 's-a2',
  ...over
})

function project(messages: Message[]) {
  const win = createLatestMessageWindow(messages, 10)
  return projectMessageViewportGroups(win.displayMessages, win.displayGroups)
}

const legacyCallbacks = (segmentsForTopic: TopicSegment[]) => ({
  isMessageInSegment: (messageId: string) => segmentsForTopic.find((s) => s.messageIds.includes(messageId)),
  isMessageFirstInSegment: (messageId: string) => segmentsForTopic.find((s) => s.firstMessageId === messageId),
  isMessageLastInSegment: (messageId: string) => segmentsForTopic.find((s) => s.lastMessageId === messageId)
})

const bodyProbe = (captured: MessageFlowBodyArgs[]) => (args: MessageFlowBodyArgs) => {
  captured.push(args)
  return null
}
const forkProbe = () => null
const contextProbe = () => null

function signatureOf(nodes: ReturnType<typeof buildMessageFlowNodes>): unknown[] {
  return nodes.map((n) =>
    n.kind === 'turn'
      ? {
          kind: 'turn',
          groupKey: n.entry.groupKey,
          turnAskId: n.entry.turnAskId,
          selected: n.entry.selected,
          segmentId: n.entry.segmentId,
          segmentIsLive: n.entry.segmentIsLive,
          layerKind: n.entry.kind,
          layerRunId: n.entry.layerRunId,
          segment: n.entry.segment?.id ?? null,
          segmentIsFirst: n.entry.segmentIsFirst,
          segmentIsLast: n.entry.segmentIsLast,
          isFolded: n.entry.isFolded,
          messageIds: n.entry.messageIds
        }
      : { kind: 'boundary', boundaryKind: n.entry.boundaryKind, boundaryKey: n.entry.boundaryKey }
  )
}

describe('messageRenderPlan — production parity with the compatibility entries', () => {
  it('matches legacy segments/layers/context/reference/flow values on a mixed window', () => {
    const msgs: Message[] = [
      message('u0', 'user', { seq: '01' }),
      message('a0', 'assistant', { askId: 'u0', seq: '02' }),
      message('u1', 'user', { seq: '03' }),
      processing('a1', 'u1', '04'),
      message('u2', 'user', { seq: '05' })
    ]
    const grouped = project(msgs)
    const segmentsForTopic: TopicSegment[] = [seg('seg-1', ['u0', 'a0'], 'u0', 'a0', 0)]
    const params = {
      groupedMessages: grouped,
      isEditMode: true,
      selectedGroupIds: ['u0'],
      segmentsForTopic,
      contextBoundaryMessageId: 'u1' as string | null,
      reference: reference(),
      targetTopicId: TOPIC
    }
    const plan = buildMessageRenderPlan(params)

    const legacySegments = buildRenderSegments(grouped, true, ['u0'])
    const legacyLayers = buildRenderLayers(legacySegments)
    expect(plan.segments).toEqual(legacySegments)
    expect(plan.layers).toEqual(legacyLayers)
    expect(plan.contextDividerGroupKey).toBe(resolveContextDividerGroupKey(grouped, 'u1'))
    expect(plan.referenceDividers).toEqual(resolveReferenceDividers(grouped, reference(), TOPIC))

    const cbs = legacyCallbacks(segmentsForTopic)
    const legacyNodes = buildMessageFlowNodes({
      layerRuns: legacyLayers,
      contextDividerGroupKey: resolveContextDividerGroupKey(grouped, 'u1'),
      referenceDividers: resolveReferenceDividers(grouped, reference(), TOPIC),
      forkDividers: [],
      branchPath: [],
      branches: [],
      topicDisplayName: 'T',
      ...cbs,
      renderBody: bodyProbe([]),
      renderForkBoundary: forkProbe,
      renderContextBoundary: contextProbe,
      renderReferenceDivider: () => null
    })
    const captured: MessageFlowBodyArgs[] = []
    const planNodes = buildMessageFlowNodesFromPlan(plan, {
      forkDividers: [],
      branchPath: [],
      branches: [],
      topicDisplayName: 'T',
      renderBody: bodyProbe(captured),
      renderForkBoundary: forkProbe,
      renderContextBoundary: contextProbe,
      renderReferenceDivider: () => null
    })
    expect(signatureOf(planNodes)).toEqual(signatureOf(legacyNodes))
    // Body injector receives identical observable tags through the plan path.
    // The shared emitter invokes body injectors newest-first during
    // construction while final nodes run oldest-first, so injector values
    // (not invocation order) are the contract: compare keyed by identity.
    const byStableId = <T extends { stableGroupId: string }>(arr: T[]): T[] =>
      [...arr].sort((x, y) => (x.stableGroupId < y.stableGroupId ? -1 : x.stableGroupId > y.stableGroupId ? 1 : 0))
    expect(
      byStableId(
        captured.map((a) => ({
          kind: a.kind,
          stableGroupId: a.stableGroupId,
          layerRunId: a.layerRunId,
          segment: a.segment?.id ?? null,
          isFirst: a.isFirst,
          isLast: a.isLast,
          ids: a.groupMessages.map((m) => m.id)
        }))
      )
    ).toEqual(
      byStableId(
        legacyNodes
          .filter((n) => n.kind === 'turn')
          .map((n) => ({
            kind: (n as { entry: { kind: string } }).entry.kind,
            stableGroupId: (n as { entry: { groupKey: string } }).entry.groupKey,
            layerRunId: (n as { entry: { layerRunId: string } }).entry.layerRunId,
            segment: (n as { entry: { segment?: TopicSegment } }).entry.segment?.id ?? null,
            isFirst: (n as { entry: { segmentIsFirst: boolean } }).entry.segmentIsFirst,
            isLast: (n as { entry: { segmentIsLast: boolean } }).entry.segmentIsLast,
            ids: (n as { entry: { messageIds: string[] } }).entry.messageIds
          }))
      )
    )
    // Order preserved: newest-first segments flat equals grouped flat.
    const segFlat = plan.segments.flatMap((s) => s.items.flatMap(([, m]) => m.map((x) => x.id)))
    expect(segFlat).toEqual(grouped.flatMap(([, m]) => m.map((x) => x.id)))
  })

  it('keeps fork+context wiring identical between plan and legacy entries (mounted DOM order)', () => {
    const all: Message[] = [
      message('u-old', 'user', { seq: '01' }),
      message('a-old', 'assistant', { askId: 'u-old', seq: '02' }),
      message('u-anchor', 'user', { seq: '03' }),
      message('a-anchor', 'assistant', { askId: 'u-anchor', seq: '04' }),
      message('u-new', 'user', { seq: '05' }),
      message('a-new', 'assistant', { askId: 'u-new', seq: '06' })
    ]
    const grouped = project(all)
    const child: TopicBranchWire = {
      id: 'b1',
      topicId: TOPIC,
      parentBranchId: null,
      anchorMessageId: 'u-anchor',
      name: 'Branch 1',
      createdAt: '2026-07-19T00:01:00.000Z',
      updatedAt: '2026-07-19T00:01:00.000Z'
    }
    const win = createLatestMessageWindow(all, 10)
    const forkDividers = resolveForkDividers({
      displayMessageIds: new Set(win.displayMessages.map((m) => m.id)),
      childrenByAnchor: new Map([['u-anchor', [child]]]),
      activeBranchId: null
    })
    const plan = buildMessageRenderPlan({
      groupedMessages: grouped,
      isEditMode: false,
      selectedGroupIds: [],
      segmentsForTopic: [],
      contextBoundaryMessageId: 'u-anchor',
      reference: null,
      targetTopicId: TOPIC
    })
    const renderBodyProbe = ({ stableGroupId, groupMessages }: MessageFlowBodyArgs) => (
      <div data-stable-group-id={stableGroupId} data-testid={`body-${groupMessages.map((m) => m.id).join('+')}`} />
    )
    const renderForkProbe = ({ anchorMessageId, parentBranchId }: MessageFlowForkArgs) => (
      <div
        data-testid={dividerRowTestId(anchorMessageId, parentBranchId)}
        data-divider-key={buildDividerKey(anchorMessageId, parentBranchId)}
      />
    )
    const renderContextProbe = (legacyKey: string) => (
      <div data-context-boundary data-testid="context-boundary" data-context-legacy-key={legacyKey} />
    )
    const base = {
      forkDividers,
      branchPath: [],
      branches: [],
      topicDisplayName: 'T',
      renderBody: renderBodyProbe,
      renderForkBoundary: renderForkProbe,
      renderContextBoundary: renderContextProbe
    }
    const planNodes = buildMessageFlowNodesFromPlan(plan, base)
    const legacyNodes = buildMessageFlowNodes({
      layerRuns: buildRenderLayers(buildRenderSegments(grouped, false, [])),
      contextDividerGroupKey: resolveContextDividerGroupKey(grouped, 'u-anchor'),
      ...base,
      ...legacyCallbacks([])
    })
    expect(signatureOf(planNodes)).toEqual(signatureOf(legacyNodes))

    const { container } = render(<>{renderEditFlowNodes({ nodes: planNodes, isEditMode: false })}</>)
    const ids = Array.from(container.querySelectorAll('[data-testid]')).map((el) => el.getAttribute('data-testid'))
    // renderEditFlowNodes wraps each turn-run in an EditTurn host (no covers
    // outside edit mode): runs split at dividers, so the anchor turn stands
    // alone between the context (DOM-before) and fork (DOM-after) dividers.
    expect(ids).toEqual([
      'edit-turn',
      'body-u-old',
      'body-a-old',
      'context-boundary',
      'edit-turn',
      'body-u-anchor',
      dividerRowTestId('u-anchor', null),
      'edit-turn',
      'body-a-anchor',
      'edit-turn',
      'body-u-new',
      'body-a-new'
    ])
    const context = container.querySelector('[data-testid="context-boundary"]') as Element
    const anchorBody = container.querySelector('[data-testid="body-u-anchor"]') as Element
    const fork = container.querySelector(`[data-testid="${dividerRowTestId('u-anchor', null)}"]`) as Element
    expect(context.compareDocumentPosition(anchorBody) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(anchorBody.compareDocumentPosition(fork) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('messageRenderPlan — segment attribution edges (hand-computed)', () => {
  const msgs: Message[] = [
    message('u0', 'user', { seq: '01' }),
    message('a0', 'assistant', { askId: 'u0', seq: '02' }),
    message('u1', 'user', { seq: '03' }),
    message('a1', 'assistant', { askId: 'u1', seq: '04' }),
    message('u2', 'user', { seq: '05' }),
    processing('live', 'u2', '06')
  ]
  // Entity order (snapshot order, not sortOrder): seg-2 first so its 'a1'
  // membership wins the first-match; first/last boundaries disagree on purpose.
  const segmentsForTopic: TopicSegment[] = [
    seg('seg-2', ['a1', 'u2'], 'a0', 'u2', 1),
    seg('seg-1', ['u1', 'a1'], 'u1', 'a1', 0)
  ]
  const grouped = project(msgs)
  const rowByFirstId = (plan: ReturnType<typeof buildMessageRenderPlan>) => {
    const map = new Map<string, (typeof plan.rows)[number]>()
    for (const row of plan.rows) {
      const first = row.entry[1][0]
      if (first) map.set(first.id, row)
    }
    return map
  }

  it('overlapping membership takes the first entity-order match; first/last stay independent', () => {
    const plan = buildMessageRenderPlan({
      groupedMessages: grouped,
      isEditMode: false,
      selectedGroupIds: [],
      segmentsForTopic,
      contextBoundaryMessageId: null,
      reference: null,
      targetTopicId: TOPIC
    })
    const byFirst = rowByFirstId(plan)
    // 'a1' is in both segments: seg-2 is earlier in entity order → wins.
    // Boundaries resolve independently of membership: 'a1' starts no segment
    // but closes seg-1 (seg-2 runs a0→u2), so membership and last disagree.
    expect(byFirst.get('a1')!.bodySegment?.id).toBe('seg-2')
    expect(byFirst.get('a1')!.bodyFirstSegment).toBeUndefined()
    expect(byFirst.get('a1')!.bodyLastSegment?.id).toBe('seg-1')
    // 'u2': membership seg-2, last boundary seg-2, no first boundary.
    expect(byFirst.get('u2')!.bodySegment?.id).toBe('seg-2')
    expect(byFirst.get('u2')!.bodyFirstSegment).toBeUndefined()
    expect(byFirst.get('u2')!.bodyLastSegment?.id).toBe('seg-2')
    // 'a0': no membership, but it IS seg-2's first boundary (different segment object than membership).
    expect(byFirst.get('a0')!.bodySegment).toBeUndefined()
    expect(byFirst.get('a0')!.bodyFirstSegment?.id).toBe('seg-2')
    expect(byFirst.get('a0')!.bodyLastSegment).toBeUndefined()
    // 'u1': membership seg-1, first boundary seg-1.
    expect(byFirst.get('u1')!.bodySegment?.id).toBe('seg-1')
    expect(byFirst.get('u1')!.bodyFirstSegment?.id).toBe('seg-1')
    expect(byFirst.get('u1')!.bodyLastSegment).toBeUndefined()
  })

  it('flow flags follow the contract: segment from first message, first/last from respective ends', () => {
    const plan = buildMessageRenderPlan({
      groupedMessages: grouped,
      isEditMode: false,
      selectedGroupIds: [],
      segmentsForTopic,
      contextBoundaryMessageId: null,
      reference: null,
      targetTopicId: TOPIC
    })
    const nodes = buildMessageFlowNodesFromPlan(plan, {
      forkDividers: [],
      branchPath: [],
      branches: [],
      topicDisplayName: 'T',
      renderBody: bodyProbe([]),
      renderForkBoundary: forkProbe,
      renderContextBoundary: contextProbe
    })
    const turns = nodes.filter((n) => n.kind === 'turn')
    const byFirstMsg = new Map(turns.map((t) => [(t as { entry: { messageIds: string[] } }).entry.messageIds[0], t]))
    const entry = (id: string) =>
      (byFirstMsg.get(id) as { entry: { segment?: TopicSegment; segmentIsFirst: boolean; segmentIsLast: boolean } })
        .entry
    // Membership follows the group's first message (seg-2 wins the overlap);
    // first/last follow the respective ends, so 'a1' closes seg-1 while
    // belonging to seg-2 — the designed mixed attribution.
    expect(entry('a1').segment?.id).toBe('seg-2')
    expect(entry('a1').segmentIsFirst).toBe(false)
    expect(entry('a1').segmentIsLast).toBe(true)
    expect(entry('a0').segment).toBeUndefined()
    expect(entry('a0').segmentIsFirst).toBe(true)
    expect(entry('a0').segmentIsLast).toBe(false)
    expect(entry('u2').segment?.id).toBe('seg-2')
    expect(entry('u2').segmentIsFirst).toBe(false)
    expect(entry('u2').segmentIsLast).toBe(true)
  })

  it('unknown context boundary resolves to null (no divider)', () => {
    const plan = buildMessageRenderPlan({
      groupedMessages: grouped,
      isEditMode: false,
      selectedGroupIds: [],
      segmentsForTopic,
      contextBoundaryMessageId: 'no-such-message',
      reference: null,
      targetTopicId: TOPIC
    })
    expect(plan.contextDividerGroupKey).toBeNull()
    expect(resolveContextDividerGroupKey(grouped, 'no-such-message')).toBeNull()
  })

  it('message id index is first-write-wins: the newest group holding an id wins', () => {
    const dup: Message = message('dup', 'user', { seq: '01' })
    const other: Message = message('other', 'user', { seq: '02' })
    const synthetic = [
      ['k-new', [dup, other]],
      ['k-old', [{ ...dup }]]
    ] as unknown as ReturnType<typeof project>
    const plan = buildMessageRenderPlan({
      groupedMessages: synthetic,
      isEditMode: false,
      selectedGroupIds: [],
      segmentsForTopic: [],
      contextBoundaryMessageId: 'dup',
      reference: null,
      targetTopicId: TOPIC
    })
    expect(plan.messageIdToGroupIndex.get('dup')).toBe(0)
    expect(plan.contextDividerGroupKey).toBe('k-new')
  })
})

describe('messageRenderPlan — dividers, selection, fold (hand-computed)', () => {
  it('selected contiguous history+live stays one atomic live segment; unselected splits on liveness', () => {
    const msgs: Message[] = [
      message('u0', 'user', { seq: '01' }),
      message('aHist', 'assistant', { askId: 'askHist', seq: '02' }),
      processing('aLive', 'askLive', '03')
    ]
    const grouped = project(msgs)
    const plan = buildMessageRenderPlan({
      groupedMessages: grouped,
      isEditMode: true,
      selectedGroupIds: ['askHist', 'askLive'],
      segmentsForTopic: [],
      contextBoundaryMessageId: null,
      reference: null,
      targetTopicId: TOPIC
    })
    expect(plan.segments.length).toBe(2)
    const [newest, oldest] = plan.segments
    expect(newest.selected).toBe(true)
    expect(newest.isLive).toBe(true)
    expect(newest.items.length).toBe(2)
    // The OR of mixed liveness: selected segment is live if any group is live.
    expect(oldest.selected).toBe(false)
    expect(oldest.isLive).toBe(false)
    // Layer runs merge by kind without crossing the selection turn run.
    expect(plan.layers.map((l) => l.kind)).toEqual(['live', 'history'])
    expect(plan.layers[0].stableLayerId).toBe(`layer:${deriveStableGroupIdCanonical([{ id: 'aHist' }])}`)
  })

  it('folded groups keep fold on the turn run (every member folded)', () => {
    // Each message projects to its own group; only the a0 run is fully folded.
    const msgs: Message[] = [
      message('u0', 'user', { seq: '01' }),
      message('a0', 'assistant', { askId: 'u0', seq: '02', folded: true }),
      message('u1', 'user', { seq: '03' })
    ]
    const grouped = project(msgs)
    const plan = buildMessageRenderPlan({
      groupedMessages: grouped,
      isEditMode: false,
      selectedGroupIds: [],
      segmentsForTopic: [],
      contextBoundaryMessageId: null,
      reference: null,
      targetTopicId: TOPIC
    })
    const nodes = buildMessageFlowNodesFromPlan(plan, {
      forkDividers: [],
      branchPath: [],
      branches: [],
      topicDisplayName: 'T',
      renderBody: bodyProbe([]),
      renderForkBoundary: forkProbe,
      renderContextBoundary: contextProbe
    })
    const turns = nodes.filter((n) => n.kind === 'turn')
    const turnFor = (id: string) =>
      turns.find((n) => (n as { entry: { messageIds: string[] } }).entry.messageIds.includes(id))
    const isFolded = (id: string) => (turnFor(id) as { entry: { isFolded: boolean } }).entry.isFolded
    expect(turnFor('a0')).toBeDefined()
    expect(isFolded('a0')).toBe(true)
    expect(isFolded('u0')).toBe(false)
    expect(isFolded('u1')).toBe(false)
    const foldedTurns = turns.filter((n) => (n as { entry: { isFolded: boolean } }).entry.isFolded)
    expect(foldedTurns.length).toBeGreaterThan(0)
  })

  it('stable ids keep full-length prefix encoding (legacy-compatible values)', () => {
    expect(deriveStableGroupId([{ id: 'a:b' }, { id: 'c' }])).toBe('3:a:b|1:c')
    expect(deriveStableGroupIdCanonical([{ id: 'a:b' }, { id: 'c' }])).toBe('3:a:b|1:c')
    const msgs: Message[] = [
      message('u0', 'user', { seq: '01' }),
      message('a0', 'assistant', { askId: 'u0', seq: '02' })
    ]
    const grouped = project(msgs)
    for (const [, gm] of grouped) {
      expect(deriveStableGroupId(gm)).toBe(deriveStableGroupIdCanonical(gm))
    }
    // turnAskId semantics unchanged: user id, else askId.
    expect(deriveTurnAskId([{ id: 'u9', role: 'user' }])).toBe('u9')
    expect(deriveTurnAskId([{ id: 'a9', role: 'assistant', askId: 'u9' }])).toBe('u9')
  })
})

describe('messageRenderPlan — reference edges (hand-computed)', () => {
  const SRC = 'src-1'
  const DST = 'dst-1'
  const refMsgs: Message[] = [
    message('s-u1', 'user', { topicId: SRC, seq: '01' }),
    message('s-a1', 'assistant', { askId: 's-u1', topicId: SRC, seq: '02' }),
    message('t-u1', 'user', { topicId: DST, seq: '05' }),
    message('t-a1', 'assistant', { askId: 't-u1', topicId: DST, seq: '06' })
  ]

  it('resident boundary wins over the fallback transition', () => {
    const grouped = project(refMsgs)
    const plan = buildMessageRenderPlan({
      groupedMessages: grouped,
      isEditMode: false,
      selectedGroupIds: [],
      segmentsForTopic: [],
      contextBoundaryMessageId: null,
      reference: reference({ boundaryMessageId: 's-a1' }),
      targetTopicId: DST
    })
    const expectedKey = grouped.find(([, m]) => m.some((x) => x.id === 's-a1'))![0]
    expect(plan.referenceDividers).toHaveLength(1)
    expect(plan.referenceDividers[0]).toMatchObject({
      boundaryKey: referenceDividerKey(DST),
      groupKey: expectedKey,
      placement: 'after-boundary'
    })
  })

  it('offscreen boundary falls back to the demonstrable foreign→owned transition', () => {
    const grouped = project(refMsgs)
    const plan = buildMessageRenderPlan({
      groupedMessages: grouped,
      isEditMode: false,
      selectedGroupIds: [],
      segmentsForTopic: [],
      contextBoundaryMessageId: null,
      reference: reference({ boundaryMessageId: 'not-in-window' }),
      targetTopicId: DST
    })
    const newestForeign = grouped.find(([, m]) => m.some((x) => x.topicId === SRC))![0]
    expect(plan.referenceDividers).toEqual([
      expect.objectContaining({ groupKey: newestForeign, placement: 'after-boundary' })
    ])
  })

  it('all-foreign window defers (no misplaced divider); blank topicId never counts as owned', () => {
    const prefixOnly: Message[] = [
      message('p-u1', 'user', { topicId: SRC, seq: '01' }),
      message('p-a1', 'assistant', { askId: 'p-u1', topicId: SRC, seq: '02' })
    ]
    const grouped = project(prefixOnly)
    const deferred = buildMessageRenderPlan({
      groupedMessages: grouped,
      isEditMode: false,
      selectedGroupIds: [],
      segmentsForTopic: [],
      contextBoundaryMessageId: null,
      reference: reference({ boundaryMessageId: 'endpoint-not-loaded' }),
      targetTopicId: DST
    })
    expect(deferred.referenceDividers).toEqual([])

    const blank = message('b-u1', 'user', { topicId: '', seq: '05' })
    const groupedBlank = project([...prefixOnly, blank])
    const blankPlan = buildMessageRenderPlan({
      groupedMessages: groupedBlank,
      isEditMode: false,
      selectedGroupIds: [],
      segmentsForTopic: [],
      contextBoundaryMessageId: null,
      reference: reference({ boundaryMessageId: 'endpoint-not-loaded' }),
      targetTopicId: DST
    })
    expect(blankPlan.referenceDividers).toEqual([])
  })

  it('missing source renders at the beginning; ordinary topics render nothing', () => {
    const grouped = project(refMsgs)
    const missing = buildMessageRenderPlan({
      groupedMessages: grouped,
      isEditMode: false,
      selectedGroupIds: [],
      segmentsForTopic: [],
      contextBoundaryMessageId: null,
      reference: reference({ status: 'missing', boundaryMessageId: null }),
      targetTopicId: DST
    })
    expect(missing.referenceDividers).toEqual([
      expect.objectContaining({ groupKey: null, placement: 'beginning', targetTopicId: DST })
    ])
    const ordinary = buildMessageRenderPlan({
      groupedMessages: grouped,
      isEditMode: false,
      selectedGroupIds: [],
      segmentsForTopic: [],
      contextBoundaryMessageId: null,
      reference: null,
      targetTopicId: DST
    })
    expect(ordinary.referenceDividers).toEqual([])
  })

  it('deep layers resolve only on their own resident boundary, otherwise deferred', () => {
    const chain: Message[] = [
      message('a-u1', 'user', { topicId: 'chain-a', seq: '01' }),
      message('a-a2', 'assistant', { askId: 'a-u1', topicId: 'chain-a', seq: '02' }),
      message('b-u1', 'user', { topicId: 'chain-b', seq: '03' }),
      message('b-a2', 'assistant', { askId: 'b-u1', topicId: 'chain-b', seq: '04' }),
      message('c-u1', 'user', { topicId: 'chain-c', seq: '05' }),
      message('c-a1', 'assistant', { askId: 'c-u1', topicId: 'chain-c', seq: '06' })
    ]
    const grouped = project(chain)
    const layered: HistoryReferenceMeta = reference({
      layers: [
        {
          targetTopicId: 'chain-c',
          sourceTopicId: 'chain-b',
          sourceBranchId: null,
          anchorMessageId: 'b-a2',
          sourceName: 'B',
          status: 'available',
          boundaryMessageId: 'b-a2'
        },
        {
          targetTopicId: 'chain-b',
          sourceTopicId: 'chain-a',
          sourceBranchId: null,
          anchorMessageId: 'a-missing',
          sourceName: 'A',
          status: 'available',
          boundaryMessageId: 'a-missing-not-loaded'
        }
      ]
    })
    const plan = buildMessageRenderPlan({
      groupedMessages: grouped,
      isEditMode: false,
      selectedGroupIds: [],
      segmentsForTopic: [],
      contextBoundaryMessageId: null,
      reference: layered,
      targetTopicId: 'chain-c'
    })
    // Only the resident layer-0 boundary; the offscreen ancestor defers (never head).
    expect(plan.referenceDividers.map((d) => d.targetTopicId)).toEqual(['chain-c'])
    expect(plan.referenceDividers.every((d) => d.placement === 'after-boundary')).toBe(true)
    expect(plan.referenceDividers.some((d) => d.placement === 'beginning')).toBe(false)
  })
})

describe('messageRenderPlan — derivation budgets (no duplicate production derivation)', () => {
  it('derives group identity exactly once per group; membership never scanned per group', () => {
    const msgs: Message[] = [
      message('u0', 'user', { seq: '01' }),
      message('a0', 'assistant', { askId: 'u0', seq: '02' }),
      message('u1', 'user', { seq: '03' }),
      processing('a1', 'u1', '04'),
      message('u2', 'user', { seq: '05' })
    ]
    const grouped = project(msgs)
    let deriveCalls = 0
    const countingDerive = (messages: readonly { id: string }[]) => {
      deriveCalls++
      return deriveStableGroupIdCanonical(messages as { id: string }[])
    }
    let includesCalls = 0
    let someCalls = 0
    const SCANNED = ['includes', 'indexOf', 'find', 'findIndex', 'filter']
    const proxiedSegments: TopicSegment[] = [
      {
        ...seg('seg-1', ['u0', 'a0', 'u1', 'a1', 'u2'], 'u0', 'u2', 0),
        messageIds: new Proxy(['u0', 'a0', 'u1', 'a1', 'u2'], {
          get(t, p, recv) {
            if (typeof p === 'string' && SCANNED.includes(p)) includesCalls++
            const value = Reflect.get(t, p, recv)
            return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(t) : value
          }
        })
      }
    ]
    const proxiedGrouped = grouped.map(
      ([key, messages]) =>
        [
          key,
          new Proxy(messages, {
            get(t, p, recv) {
              if (p === 'some') someCalls++
              const value = Reflect.get(t, p, recv)
              return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(t) : value
            }
          })
        ] as (typeof grouped)[number]
    )
    const plan = buildMessageRenderPlan({
      groupedMessages: proxiedGrouped,
      isEditMode: true,
      selectedGroupIds: ['u0'],
      segmentsForTopic: proxiedSegments,
      contextBoundaryMessageId: 'u1',
      reference: reference({ boundaryMessageId: 'not-in-window' }),
      targetTopicId: TOPIC,
      deriveGroupId: countingDerive
    })
    const nodes = buildMessageFlowNodesFromPlan(plan, {
      forkDividers: [],
      branchPath: [],
      branches: [],
      topicDisplayName: 'T',
      renderBody: bodyProbe([]),
      renderForkBoundary: forkProbe,
      renderContextBoundary: contextProbe
    })
    expect(nodes.length).toBeGreaterThan(0)
    // One identity derivation per group across segments, layers, context, reference, and flow.
    expect(deriveCalls).toBe(grouped.length)
    // Membership resolved through the precomputed Map — never a per-group scan.
    expect(includesCalls).toBe(0)
    // Exactly one liveness classification per group; dividers reuse flags/index.
    expect(someCalls).toBe(grouped.length)
  })
})
