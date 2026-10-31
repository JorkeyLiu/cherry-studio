/**
 * Cross-topic history-reference divider wiring.
 *
 * Proves the production builder places the reference divider at the exact
 * readonly-foreign-prefix / writable-target-suffix boundary (or at the
 * beginning when the source is missing / no prefix is loaded), without
 * guessing a wrong location. The foreign-prefix messages keep their canonical
 * SOURCE topicId (never restamped), which is the stable signal the fallback
 * uses when the boundary message is outside the loaded window.
 */
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import { renderEditFlowNodes } from '../messageEditSelectionLayout'
import { buildMessageFlowNodes, type MessageFlowBodyArgs, resolveReferenceBoundary } from '../messageFlowNodes'
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

function project() {
  const win = createLatestMessageWindow(MESSAGES, 10)
  return projectMessageViewportGroups(win.displayMessages, win.displayGroups)
}

const renderBodyProbe = ({ stableGroupId, groupMessages }: MessageFlowBodyArgs) => (
  <div data-stable-group-id={stableGroupId} data-testid={`body-${groupMessages.map((m) => m.id).join('+')}`} />
)

const noopBoundary = () => null

function buildWithReference(referenceBoundary: ReturnType<typeof resolveReferenceBoundary>): ReactNode {
  const grouped = project()
  const segments = buildRenderSegments(grouped, false, [])
  const layers = buildRenderLayers(segments)
  const nodes = buildMessageFlowNodes({
    layerRuns: layers,
    contextDividerGroupKey: null,
    referenceBoundary,
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
    renderReferenceBoundary: () => <div data-testid="reference-boundary" data-boundary-kind="reference" />
  })
  return <>{renderEditFlowNodes({ nodes, isEditMode: false })}</>
}

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
    const win = createLatestMessageWindow(prefixOnly, 10)
    const groupedPrefix = projectMessageViewportGroups(win.displayMessages, win.displayGroups)
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
    const win = createLatestMessageWindow([...MESSAGES.slice(0, 4), blank], 10)
    const groupedBlank = projectMessageViewportGroups(win.displayMessages, win.displayGroups)
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
    const win = createLatestMessageWindow(recursive, 10)
    const groupedRecursive = projectMessageViewportGroups(win.displayMessages, win.displayGroups)
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

describe('buildMessageFlowNodes reference divider placement', () => {
  it('renders the divider DOM-before the boundary group (visually directly below it)', () => {
    const grouped = project()
    const boundaryEntry = grouped.find(([, msgs]) => msgs.some((m) => m.id === 's-a2'))!
    const { container } = render(buildWithReference({ groupKey: boundaryEntry[0], placement: 'after-boundary' }))
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

  it('renders the divider at the beginning when missing', () => {
    const { container } = render(buildWithReference({ groupKey: null, placement: 'beginning' }))
    const divider = container.querySelector('[data-testid="reference-boundary"]') as Element
    const oldest = container.querySelector('[data-testid="body-s-u1"]') as Element
    expect(divider).not.toBeNull()
    // Appended last in newest→oldest DOM order = visual beginning (above oldest).
    expect(oldest.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(container.querySelectorAll('[data-testid="reference-boundary"]').length).toBe(1)
  })

  it('renders no reference divider for ordinary topics', () => {
    const { container } = render(buildWithReference(null))
    expect(container.querySelector('[data-testid="reference-boundary"]')).toBeNull()
  })
})
