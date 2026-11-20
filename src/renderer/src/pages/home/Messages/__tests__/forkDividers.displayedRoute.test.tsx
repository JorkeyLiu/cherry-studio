/**
 * Fork dividers follow the DISPLAYED route, never the selected intent alone.
 *
 * Regression for the 46px route-switch jump: flipping the selected route
 * child→main while the old child window is still mounted must keep the old
 * window's dividers (same identity, placement, label, DOM nodes) — the
 * selected-only relation filter used to drop the resident child-parent
 * divider one frame early, shrinking the flow by one divider row and shifting
 * every row below it. Only after the window accepts the target route do the
 * target inputs take effect; the reverse direction and the normal
 * parent-layer divider are retained throughout.
 *
 * The harness below mirrors the exact `MessagesContent` fork-chrome wiring
 * (real `useBranchTree` over the real store + real `resolveForkDividers` +
 * real `buildMessageFlowNodes` + real `renderEditFlowNodes`) with the
 * displayed route held as a prop exactly like `MessagesContent`'s
 * `displayedBranchId` (controller displayed route). It drives genuine React
 * updates — a store `activeBranchSet` (selected intent) while the displayed
 * props stay put, then a window/displayed commit — and asserts mounted DOM
 * identity/attributes, not source strings.
 */
import type { TopicBranchWire } from '@renderer/services/db/types'
import store from '@renderer/store'
import { activeBranchReset, activeBranchSet, branchesReceived, branchesRemoved } from '@renderer/store/topicBranch'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { act, render } from '@testing-library/react'
import { useMemo } from 'react'
import { Provider } from 'react-redux'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildDividerKey, dividerRowTestId } from '../BranchDividers'
import { forkMarkerLabel } from '../forkPlacement'
import { renderEditFlowNodes } from '../messageEditSelectionLayout'
import {
  buildMessageFlowNodes,
  type MessageFlowBodyArgs,
  type MessageFlowForkArgs,
  resolveForkDividers
} from '../messageFlowNodes'
import { buildRenderLayers, buildRenderSegments } from '../messageRenderLayers'
import { projectMessageViewportGroups } from '../messageViewportProjection'
import { createLatestMessageWindow } from '../messageWindow'
import { useBranchTree } from '../useBranchTree'

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  fetchTopicBranchesThunk: () => () => Promise.resolve()
}))

const TOPIC = 't-fork-displayed-46'

const message = (id: string, role: Message['role'], askId?: string): Message =>
  ({
    id,
    role,
    askId,
    assistantId: 'assistant-1',
    topicId: TOPIC,
    createdAt: `2026-07-19T00:00:${id.length.toString().padStart(2, '0')}.000Z`,
    status: role === 'user' ? UserMessageStatus.SUCCESS : AssistantMessageStatus.SUCCESS,
    blocks: []
  }) as Message

// Old child-route window (b01): prefix + fork anchor u-a + b01-own anchor u-b.
const OLD_WINDOW_IDS = ['u0', 'a0', 'u-a', 'a-a', 'u-b', 'a-b']
// New main-route window after accept: same prefix, its own suffix.
const MAIN_WINDOW_IDS = ['u0', 'a0', 'u-a', 'a-a', 'u-m', 'a-m']

const MESSAGES_BY_ID = new Map<string, Message>(
  (['u0', 'u-a', 'u-b', 'u-m'] as const).flatMap((u) => [
    [u, message(u, 'user')] as const,
    [`a${u.slice(1)}`, message(`a${u.slice(1)}`, 'assistant', u)] as const
  ])
)

const B01: TopicBranchWire = {
  id: 'b01',
  topicId: TOPIC,
  parentBranchId: null,
  anchorMessageId: 'u-a',
  name: 'B01',
  createdAt: '2026-07-19T00:01:00.000Z',
  updatedAt: '2026-07-19T00:01:00.000Z',
  inheritedBoundary: { kind: 'message', messageId: 'u-a' }
}

const B02: TopicBranchWire = {
  id: 'b02',
  topicId: TOPIC,
  parentBranchId: 'b01',
  anchorMessageId: 'u-b',
  name: 'B02',
  createdAt: '2026-07-19T00:02:00.000Z',
  updatedAt: '2026-07-19T00:02:00.000Z',
  inheritedBoundary: { kind: 'message', messageId: 'u-b' }
}

const fakeT = ((key: string, opts?: { count?: number }): string =>
  key === 'chat.topics.branch.children_here' ? `${opts?.count ?? 0} branches here` : key) as never

const bodyProbe = ({ kind, stableGroupId, layerRunId, groupMessages }: MessageFlowBodyArgs) => (
  <div
    style={{ position: 'relative' }}
    data-layer-kind={kind}
    data-stable-group-id={stableGroupId}
    data-layer-run-id={layerRunId}
    data-testid={`body-${groupMessages.map((m) => m.id).join('+')}`}
  />
)

const forkProbe = ({
  anchorMessageId,
  taken,
  children,
  parentBranchId,
  parentLabel,
  placement
}: MessageFlowForkArgs) => (
  <div
    data-testid={dividerRowTestId(anchorMessageId, parentBranchId)}
    data-divider-key={buildDividerKey(anchorMessageId, parentBranchId)}
    data-divider-parent={parentBranchId ?? 'main'}
    data-divider-parent-label={parentLabel}
    data-divider-placement={placement}
    data-taken={taken ? taken.id : ''}
    data-child-count={children.length}
    data-label={forkMarkerLabel(taken, children, fakeT)}
  />
)

const none = () => undefined

/**
 * Exact `MessagesContent` fork-chrome wiring: the branch tree is addressed by
 * the DISPLAYED route prop (controller displayed route), every relation
 * input (children filter, active id, active path, taken) follows it, and the
 * selected intent is not read here at all.
 */
function ForkFlowHarness({
  messageIds,
  displayedBranchId
}: {
  messageIds: readonly string[]
  displayedBranchId: string | null
}) {
  const displayBranchTree = useBranchTree(TOPIC, displayedBranchId)
  const forkDividers = useMemo(
    () =>
      resolveForkDividers({
        displayMessageIds: new Set(messageIds),
        childrenByAnchor: displayBranchTree.childrenByAnchor,
        activeBranchId: displayedBranchId,
        activeRoutePath: displayBranchTree.path.map((b) => b.id),
        historyHeadLoaded: false
      }),
    [messageIds, displayBranchTree, displayedBranchId]
  )
  const layerRuns = useMemo(() => {
    const msgs = messageIds.map((id) => MESSAGES_BY_ID.get(id)).filter((m): m is Message => !!m)
    const win = createLatestMessageWindow(msgs, 50)
    const grouped = projectMessageViewportGroups(win.displayMessages, win.displayGroups)
    return buildRenderLayers(buildRenderSegments(grouped, false, []))
  }, [messageIds])
  const nodes = buildMessageFlowNodes({
    layerRuns,
    contextDividerGroupKey: null,
    forkDividers,
    branchPath: displayBranchTree.path,
    branches: displayBranchTree.branches,
    topicDisplayName: 'T',
    isMessageInSegment: none,
    isMessageFirstInSegment: none,
    isMessageLastInSegment: none,
    renderBody: bodyProbe,
    renderForkBoundary: forkProbe,
    renderContextBoundary: () => null
  })
  return <>{renderEditFlowNodes({ nodes, isEditMode: false })}</>
}

const dividerKeys = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll('[data-divider-key]')).map((el) => el.getAttribute('data-divider-key') ?? '')

afterEach(() => {
  store.dispatch(branchesRemoved({ topicIds: [TOPIC] }))
  store.dispatch(activeBranchReset({ topicId: TOPIC }))
})

describe('fork dividers follow the displayed route across a real route switch', () => {
  it('keeps the old child-parent divider mounted while selected flips with the old window, then commits the target', () => {
    store.dispatch(branchesReceived({ topicId: TOPIC, branches: [B01, B02] }))
    store.dispatch(activeBranchSet({ topicId: TOPIC, branchId: 'b01' }))

    const { container, rerender } = render(
      <Provider store={store}>
        <ForkFlowHarness messageIds={OLD_WINDOW_IDS} displayedBranchId="b01" />
      </Provider>
    )

    // Viewing b01: both the main-parent fork (taken) and the b01-parent fork, oldest-first in normal flow.
    expect(dividerKeys(container)).toEqual(['u-a::main', 'u-b::b01'])
    const forkA = container.querySelector('[data-divider-key="u-a::main"]') as HTMLElement
    const forkB = container.querySelector('[data-divider-key="u-b::b01"]') as HTMLElement
    expect(forkA.getAttribute('data-divider-placement')).toBe('message')
    expect(forkB.getAttribute('data-divider-placement')).toBe('message')
    expect(forkA.getAttribute('data-taken')).toBe('b01')
    expect(forkA.getAttribute('data-label')).toBe('B01')
    expect(forkB.getAttribute('data-taken')).toBe('')
    expect(forkB.getAttribute('data-label')).toBe('1 branches here')

    // Selected intent flips to main, but the displayed window/route is still
    // b01's (fetch-hold): the old dividers must keep identity, placement,
    // labels, order — and the very same DOM nodes (no 46px churn).
    act(() => {
      store.dispatch(activeBranchSet({ topicId: TOPIC, branchId: null }))
    })
    expect(dividerKeys(container)).toEqual(['u-a::main', 'u-b::b01'])
    expect(container.querySelector('[data-divider-key="u-a::main"]')).toBe(forkA)
    expect(container.querySelector('[data-divider-key="u-b::b01"]')).toBe(forkB)
    expect((container.querySelector('[data-divider-key="u-a::main"]') as HTMLElement).getAttribute('data-taken')).toBe(
      'b01'
    )
    expect((container.querySelector('[data-divider-key="u-a::main"]') as HTMLElement).getAttribute('data-label')).toBe(
      'B01'
    )
    expect(container.querySelectorAll('[data-divider-key]').length).toBe(2)

    // The window accepts main: the target inputs take effect — the normal
    // parent-layer divider stays (untaken now), the child-parent one is gone.
    rerender(
      <Provider store={store}>
        <ForkFlowHarness messageIds={MAIN_WINDOW_IDS} displayedBranchId={null} />
      </Provider>
    )
    expect(dividerKeys(container)).toEqual(['u-a::main'])
    const forkAMain = container.querySelector('[data-divider-key="u-a::main"]') as HTMLElement
    expect(forkAMain.getAttribute('data-divider-placement')).toBe('message')
    expect(forkAMain.getAttribute('data-taken')).toBe('')
    expect(forkAMain.getAttribute('data-label')).toBe('1 branches here')
    expect(container.querySelectorAll('[data-divider-key]').length).toBe(1)

    // Reverse direction: back to the child window restores both dividers with
    // the taken label, in the same order.
    act(() => {
      store.dispatch(activeBranchSet({ topicId: TOPIC, branchId: 'b01' }))
    })
    rerender(
      <Provider store={store}>
        <ForkFlowHarness messageIds={OLD_WINDOW_IDS} displayedBranchId="b01" />
      </Provider>
    )
    expect(dividerKeys(container)).toEqual(['u-a::main', 'u-b::b01'])
    expect((container.querySelector('[data-divider-key="u-a::main"]') as HTMLElement).getAttribute('data-taken')).toBe(
      'b01'
    )
  })
})
