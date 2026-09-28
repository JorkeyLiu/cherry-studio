/**
 * Production flow-node wiring — proves the real `Messages.tsx` builder
 * (`buildMessageFlowNodes`, not hand-authored FlowNode fixtures) maps
 * message groups, fork dividers, and the context divider into the exact
 * ordered flow consumed by `renderEditFlowNodes`.
 *
 * Why this closes the wiring gap: the nodes under test are produced by the
 * exact production builder (same group iteration, fork/context placement,
 * stable keys, askIds, selection flags, layer identity) fed by the real
 * projection pipeline (`createLatestMessageWindow` →
 * `projectMessageViewportGroups` → `buildRenderSegments`/`buildRenderLayers`
 * → `resolveContextDividerGroupKey`/`findAnchorsWithChildren`). Only the
 * React pixels are lightweight probes that mirror the production identity
 * attributes (`data-divider-*` via the real `buildDividerKey`/
 * `dividerRowTestId` helpers, `data-context-legacy-key`,
 * `data-stable-group-id`/`data-layer-kind`/`data-layer-run-id`). Rendering
 * the builder output through the real `renderEditFlowNodes` then pins DOM
 * order, standalone boundaries, selection outlining, and no-duplication.
 *
 * Mounting full `MessagesContent` is prohibitively coupled (store, IPC,
 * viewport reducer, scroll geometry); this builder-plus-renderer seam is the
 * narrowest execution of the exact production mapping.
 */
import type { TopicBranchWire } from '@renderer/services/db/types'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { buildDividerKey, dividerRowTestId, findAnchorsWithChildren } from '../BranchDividers'
import { deriveTurnAskId, renderEditFlowNodes } from '../messageEditSelectionLayout'
import {
  buildMessageFlowNodes,
  type MessageFlowBodyArgs,
  type MessageFlowForkArgs,
  resolveContextDividerGroupKey
} from '../messageFlowNodes'
import { buildRenderLayers, buildRenderSegments, deriveStableGroupId } from '../messageRenderLayers'
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

// Chronological oldest→newest: older turn, anchor turn (fork + context
// anchor), newer turn. The anchor user message carries both the fork
// boundary (a child branch forks here) and the context boundary.
const ALL_MESSAGES: Message[] = [
  message('u-old', 'user', undefined, '01'),
  message('a-old', 'assistant', 'u-old', '02'),
  message('u-anchor', 'user', undefined, '03'),
  message('a-anchor', 'assistant', 'u-anchor', '04'),
  message('u-new', 'user', undefined, '05'),
  message('a-new', 'assistant', 'u-new', '06')
]

const CHILD_BRANCH: TopicBranchWire = {
  id: 'b1',
  topicId: 'topic-1',
  parentBranchId: null,
  anchorMessageId: 'u-anchor',
  name: 'Branch 1',
  createdAt: '2026-07-19T00:01:00.000Z',
  updatedAt: '2026-07-19T00:01:00.000Z'
}

const CHILDREN_BY_ANCHOR = new Map<string, TopicBranchWire[]>([['u-anchor', [CHILD_BRANCH]]])

const renderBodyProbe = ({ kind, stableGroupId, layerRunId, groupMessages }: MessageFlowBodyArgs) => (
  <div
    style={{ position: 'relative' }}
    data-layer-kind={kind}
    data-stable-group-id={stableGroupId}
    data-layer-run-id={layerRunId}
    data-testid={`body-${groupMessages.map((m) => m.id).join('+')}`}>
    {groupMessages.map((m) => m.id).join(',')}
  </div>
)

const renderForkProbe = ({ anchorMessageId, parentBranchId, taken, children }: MessageFlowForkArgs) => (
  <div
    data-testid={dividerRowTestId(anchorMessageId, parentBranchId)}
    data-divider-key={buildDividerKey(anchorMessageId, parentBranchId)}
    data-divider-anchor={anchorMessageId}
    data-divider-parent={parentBranchId ?? 'main'}
    data-taken={taken ? taken.id : ''}
    data-child-count={children.length}
  />
)

const renderContextProbe = (legacyKey: string) => (
  <div data-context-boundary data-testid="context-boundary" data-context-legacy-key={legacyKey} />
)

const none = () => undefined

function buildFlow(selectedGroupIds: string[], isEditMode = true) {
  const win = createLatestMessageWindow(ALL_MESSAGES, 10)
  const grouped = projectMessageViewportGroups(win.displayMessages, win.displayGroups)
  const segments = buildRenderSegments(grouped, isEditMode, selectedGroupIds)
  const layers = buildRenderLayers(segments)
  const contextKey = resolveContextDividerGroupKey(grouped, 'u-anchor')
  const forkAnchorIds = findAnchorsWithChildren(win.displayMessages, CHILDREN_BY_ANCHOR)
  const nodes = buildMessageFlowNodes({
    layerRuns: layers,
    contextDividerGroupKey: contextKey,
    forkAnchorIds,
    childrenByAnchor: CHILDREN_BY_ANCHOR,
    branchPath: [],
    branches: [],
    topicDisplayName: 'Test Topic',
    isMessageInSegment: none,
    isMessageFirstInSegment: none,
    isMessageLastInSegment: none,
    renderBody: renderBodyProbe,
    renderForkBoundary: renderForkProbe,
    renderContextBoundary: renderContextProbe
  })
  return { win, grouped, segments, layers, contextKey, forkAnchorIds, nodes }
}

function domTestIds(container: HTMLElement): (string | null)[] {
  return Array.from(container.querySelectorAll('[data-testid]')).map((el) => el.getAttribute('data-testid'))
}

const FORK_TESTID = dividerRowTestId('u-anchor', null)

describe('messageFlowNodes production wiring', () => {
  it('maps groups, fork divider, and context divider into the exact newest→oldest flow', () => {
    const { grouped, layers, contextKey, forkAnchorIds, nodes } = buildFlow([])

    // All six groups projected newest-first; anchor group found by real key.
    expect(grouped.length).toBe(6)
    const anchorEntry = grouped.find(([, msgs]) => msgs.some((m) => m.id === 'u-anchor'))
    expect(anchorEntry).toBeDefined()
    expect(contextKey).toBe(anchorEntry![0])
    expect(forkAnchorIds).toEqual(['u-anchor'])

    // Exact node sequence: fork DOM-before the anchor body, context DOM-after.
    expect(nodes.map((n) => n.kind)).toEqual(['turn', 'turn', 'turn', 'boundary', 'turn', 'boundary', 'turn', 'turn'])

    // Every turn entry carries real group-derived identity: stable key,
    // askId, selection flag, segment id, liveness, and layer identity.
    const turnEntries = nodes.filter((n) => n.kind === 'turn').map((n) => n.entry)
    expect(turnEntries.length).toBe(6)
    expect(layers.length).toBe(1)
    const itemsNewestFirst = layers[0].segments.flatMap((s) => s.items)
    expect(turnEntries.map((e) => e.groupKey)).toEqual(
      itemsNewestFirst.map(([, msgs]) => deriveStableGroupId(msgs as readonly Message[]))
    )
    expect(turnEntries.map((e) => e.turnAskId)).toEqual(
      itemsNewestFirst.map(([, msgs]) => deriveTurnAskId(msgs as readonly Message[]))
    )
    expect(turnEntries.map((e) => e.selected)).toEqual([false, false, false, false, false, false])
    expect(turnEntries.map((e) => e.kind)).toEqual(['history', 'history', 'history', 'history', 'history', 'history'])
    for (const e of turnEntries) {
      expect(e.layerRunId).toBe(layers[0].stableLayerId)
    }
    // Real askIds: assistant groups resolve to their user askId.
    expect(turnEntries.map((e) => e.turnAskId)).toEqual(['u-new', 'u-new', 'u-anchor', 'u-anchor', 'u-old', 'u-old'])

    // Boundary identities are production-derived, not fixtures.
    const boundaries = nodes.filter((n) => n.kind === 'boundary').map((n) => n.entry)
    expect(boundaries.length).toBe(2)
    expect(boundaries[0].boundaryKind).toBe('fork')
    expect(boundaries[0].boundaryKey).toBe('branch-fork-u-anchor-main')
    expect(boundaries[1].boundaryKind).toBe('context')
    expect(boundaries[1].boundaryKey).toBe(`context-boundary:${contextKey}`)

    // Rendered through the real composer: exact DOM order, standalone
    // boundaries, preserved identity attributes, no duplication/omission.
    const { container } = render(<>{renderEditFlowNodes({ nodes, isEditMode: true })}</>)
    expect(domTestIds(container)).toEqual([
      'edit-turn',
      'body-a-new',
      'body-u-new',
      'edit-turn',
      'body-a-anchor',
      FORK_TESTID,
      'edit-turn',
      'body-u-anchor',
      'context-boundary',
      'edit-turn',
      'body-a-old',
      'body-u-old'
    ])
    const ids = domTestIds(container).filter((id) => id !== 'edit-turn')
    expect(new Set(ids).size).toBe(ids.length)

    const fork = container.querySelector(`[data-testid="${FORK_TESTID}"]`) as Element
    const anchorBody = container.querySelector('[data-testid="body-u-anchor"]') as Element
    const context = container.querySelector('[data-testid="context-boundary"]') as Element
    // Newest→oldest DOM order: fork before anchor (visually below it),
    // context after anchor (visually above it).
    expect(fork.compareDocumentPosition(anchorBody) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(anchorBody.compareDocumentPosition(context) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Standalone siblings: never inside a turn container.
    expect(fork.closest('[data-turn-ask]')).toBeNull()
    expect(context.closest('[data-turn-ask]')).toBeNull()
    // Fork divider identity attributes preserved.
    expect(fork.getAttribute('data-divider-key')).toBe(buildDividerKey('u-anchor', null))
    expect(fork.getAttribute('data-divider-anchor')).toBe('u-anchor')
    expect(fork.getAttribute('data-divider-parent')).toBe('main')
    // Context legacy key preserved.
    expect(context.getAttribute('data-context-legacy-key')).toBe(contextKey)
    expect(context.hasAttribute('data-context-boundary')).toBe(true)
    // Bodies keep real layer identity.
    for (const body of Array.from(container.querySelectorAll('[data-stable-group-id]'))) {
      expect(body.getAttribute('data-layer-kind')).toBe('history')
      expect(body.getAttribute('data-layer-run-id')).toBe(layers[0].stableLayerId)
    }
    // Same askId split by the fork yields two turn containers, not one.
    const turns = container.querySelectorAll('[data-testid="edit-turn"]')
    expect(turns.length).toBe(4)
  })

  it('selecting only the newer side excludes the adjacent fork boundary', () => {
    const { nodes } = buildFlow(['u-new'])
    const { container } = render(<>{renderEditFlowNodes({ nodes, isEditMode: true })}</>)
    const outlines = container.querySelectorAll('[data-stable-segment-id]')
    expect(outlines.length).toBe(1)
    const fork = container.querySelector(`[data-testid="${FORK_TESTID}"]`) as Element
    expect(fork.closest('[data-stable-segment-id]')).toBeNull()
    for (const id of ['body-a-new', 'body-u-new']) {
      expect((container.querySelector(`[data-testid="${id}"]`) as Element).closest('[data-stable-segment-id]')).toBe(
        outlines[0]
      )
    }
    // No duplication when selection is active.
    expect(container.querySelectorAll(`[data-testid="${FORK_TESTID}"]`).length).toBe(1)
    expect(container.querySelectorAll('[data-testid="context-boundary"]').length).toBe(1)
  })

  it('selecting only the anchor side excludes the trailing context boundary', () => {
    const { nodes } = buildFlow(['u-anchor'])
    const { container } = render(<>{renderEditFlowNodes({ nodes, isEditMode: true })}</>)
    const outlines = container.querySelectorAll('[data-stable-segment-id]')
    expect(outlines.length).toBe(1)
    const context = container.querySelector('[data-testid="context-boundary"]') as Element
    expect(context.closest('[data-stable-segment-id]')).toBeNull()
    for (const id of ['body-a-anchor', 'body-u-anchor']) {
      expect((container.querySelector(`[data-testid="${id}"]`) as Element).closest('[data-stable-segment-id]')).toBe(
        outlines[0]
      )
    }
    // The fork splits the selected same-askId turn, so it is interior here.
    const fork = container.querySelector(`[data-testid="${FORK_TESTID}"]`) as Element
    expect(fork.closest('[data-stable-segment-id]')).toBe(outlines[0])
  })

  it('selection spanning newer+anchor includes the fork boundary once in one outline', () => {
    const { nodes } = buildFlow(['u-new', 'u-anchor'])
    const { container } = render(<>{renderEditFlowNodes({ nodes, isEditMode: true })}</>)
    const outlines = container.querySelectorAll('[data-stable-segment-id]')
    expect(outlines.length).toBe(1)
    const fork = container.querySelector(`[data-testid="${FORK_TESTID}"]`) as Element
    expect(container.querySelectorAll(`[data-testid="${FORK_TESTID}"]`).length).toBe(1)
    expect(fork.closest('[data-stable-segment-id]')).toBe(outlines[0])
    for (const id of ['body-a-new', 'body-u-new', 'body-a-anchor', 'body-u-anchor']) {
      expect((container.querySelector(`[data-testid="${id}"]`) as Element).closest('[data-stable-segment-id]')).toBe(
        outlines[0]
      )
    }
    // Trailing context boundary stays outside the outline.
    const context = container.querySelector('[data-testid="context-boundary"]') as Element
    expect(context.closest('[data-stable-segment-id]')).toBeNull()
    // Nothing duplicated or omitted across the whole flow.
    for (const id of ['body-a-new', 'body-u-new', 'body-a-anchor', 'body-u-anchor', 'body-a-old', 'body-u-old']) {
      expect(container.querySelectorAll(`[data-testid="${id}"]`).length).toBe(1)
    }
  })

  it('selection spanning anchor+older includes the context boundary once in one outline', () => {
    const onTurnClick = vi.fn()
    const { nodes } = buildFlow(['u-anchor', 'u-old'])
    const { container } = render(<>{renderEditFlowNodes({ nodes, isEditMode: true, onTurnClick })}</>)
    const outlines = container.querySelectorAll('[data-stable-segment-id]')
    expect(outlines.length).toBe(1)
    const context = container.querySelector('[data-testid="context-boundary"]') as Element
    expect(container.querySelectorAll('[data-testid="context-boundary"]').length).toBe(1)
    expect(context.closest('[data-stable-segment-id]')).toBe(outlines[0])
    for (const id of ['body-a-anchor', 'body-u-anchor', 'body-a-old', 'body-u-old']) {
      expect((container.querySelector(`[data-testid="${id}"]`) as Element).closest('[data-stable-segment-id]')).toBe(
        outlines[0]
      )
    }
    // Unselected newer side stays outside.
    for (const id of ['body-a-new', 'body-u-new']) {
      expect(
        (container.querySelector(`[data-testid="${id}"]`) as Element).closest('[data-stable-segment-id]')
      ).toBeNull()
    }
    expect(onTurnClick).not.toHaveBeenCalled()
  })
})
