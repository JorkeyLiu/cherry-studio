import store from '@renderer/store'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { describe, expect, it } from 'vitest'

import { buildOrderedFlowItems, deriveTurnKey, renderEditFlowNodes } from '../messageEditSelectionLayout'
import { buildMessageFlowNodes } from '../messageFlowNodes'
import { buildRenderLayers, buildRenderSegments } from '../messageRenderLayers'
import { projectMessageViewportGroups } from '../messageViewportProjection'
import { createLatestMessageWindow } from '../messageWindow'

const msg = (id: string, role: Message['role'], askId: string | undefined, seq: string, folded?: true): Message =>
  ({
    id,
    role,
    askId,
    assistantId: 'assistant-1',
    topicId: 'topic-1',
    createdAt: `2026-07-19T00:00:${seq}.000Z`,
    status: role === 'user' ? UserMessageStatus.SUCCESS : AssistantMessageStatus.SUCCESS,
    blocks: [],
    ...(folded ? { folded: true as const } : {})
  }) as unknown as Message

// 5 turns oldest->newest; turns 3 and 4 fully folded (user+assistant carry folded:true).
const ALL: Message[] = [
  msg('u1', 'user', undefined, '01'),
  msg('a1', 'assistant', 'u1', '02'),
  msg('u2', 'user', undefined, '03'),
  msg('a2', 'assistant', 'u2', '04'),
  msg('u3', 'user', undefined, '05', true),
  msg('a3', 'assistant', 'u3', '06', true),
  msg('u4', 'user', undefined, '07', true),
  msg('a4', 'assistant', 'u4', '08', true),
  msg('u5', 'user', undefined, '09'),
  msg('a5', 'assistant', 'u5', '10')
]

const renderBodyProbe = ({ kind, stableGroupId, layerRunId, groupMessages }: any) => (
  <div
    style={{ position: 'relative' }}
    data-layer-kind={kind}
    data-stable-group-id={stableGroupId}
    data-layer-run-id={layerRunId}
    data-testid={`body-${groupMessages.map((m: Message) => m.id).join('+')}`}>
    {groupMessages.map((m: Message) => m.id).join(',')}
  </div>
)

const none = () => undefined

function buildFlow(selectedGroupIds: string[]) {
  const win = createLatestMessageWindow(ALL, 10)
  const grouped = projectMessageViewportGroups(win.displayMessages, win.displayGroups)
  const segments = buildRenderSegments(grouped, true, selectedGroupIds)
  const layers = buildRenderLayers(segments)
  const nodes = buildMessageFlowNodes({
    layerRuns: layers,
    contextDividerGroupKey: null,
    forkDividers: [],
    branchPath: [],
    branches: [],
    topicDisplayName: 'T',
    isMessageInSegment: none,
    isMessageFirstInSegment: none,
    isMessageLastInSegment: none,
    renderBody: renderBodyProbe,
    renderForkBoundary: () => null,
    renderContextBoundary: () => null
  })
  return { nodes }
}

describe('folded shell survives range selection', () => {
  it('a range covering folded turns keeps one collapsed selected FoldedSection', () => {
    // Edit-mode: turn 2 clicked, Shift-click reaches turn 5.
    const selected = ['u2', 'u3', 'u4', 'u5']
    const { nodes } = buildFlow(selected)
    const expandedFoldSectionIds = new Set<string>()
    const { container } = render(
      <Provider store={store}>
        {renderEditFlowNodes({
          nodes,
          isEditMode: true,
          selectedTurnAskIds: new Set(selected),
          expandedFoldSectionIds
        })}
      </Provider>
    )
    const collapsed = container.querySelectorAll('[data-testid="folded-section-collapsed"]')
    expect(collapsed.length).toBe(1)
    const shell = collapsed[0] as HTMLElement
    // The block is fully selected (turns 3+4 are all inside the range).
    expect(shell.getAttribute('data-folded-section-selected')).toBe('true')
    expect(shell.getAttribute('data-folded-section-partial')).toBe('false')
    // Folded member ids stay behind the collapsed marker, not as mounted rows.
    const foldedIds = (shell.getAttribute('data-folded-message-ids') ?? '').split(' ').filter(Boolean)
    expect(foldedIds.sort()).toEqual(['a3', 'a4', 'u3', 'u4'])
    for (const id of ['u3', 'a3', 'u4', 'a4']) {
      expect(container.querySelector(`[data-testid="body-${id}"]`)).toBeNull()
    }
    // Unfolded selected turns keep their own outline with mounted bodies.
    expect(container.querySelector('[data-testid="body-u2"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="body-a5"]')).not.toBeNull()
    // Range selection never writes browse-expand state.
    expect(expandedFoldSectionIds.size).toBe(0)
  })

  it('manual expand keeps the selection on the block and mounts its bodies', () => {
    const selected = ['u2', 'u3', 'u4', 'u5']
    const { nodes } = buildFlow(selected)
    const ordered = buildOrderedFlowItems(nodes)
    const firstFoldedRun = ordered.find(
      (o) => o.kind === 'turn-run' && o.run.length > 0 && o.run.every((e) => e.isFolded === true)
    )
    expect(firstFoldedRun?.kind).toBe('turn-run')
    const sectionKey = firstFoldedRun?.kind === 'turn-run' ? `folded-section:${deriveTurnKey(firstFoldedRun.run)}` : ''
    expect(sectionKey.startsWith('folded-section:')).toBe(true)
    const { container } = render(
      <Provider store={store}>
        {renderEditFlowNodes({
          nodes,
          isEditMode: true,
          selectedTurnAskIds: new Set(selected),
          expandedFoldSectionIds: new Set([sectionKey])
        })}
      </Provider>
    )
    const expanded = container.querySelectorAll('[data-testid="folded-section-expanded"]')
    expect(expanded.length).toBe(1)
    expect((expanded[0] as HTMLElement).getAttribute('data-folded-section-selected')).toBe('true')
    // Expanded browse mounts the folded bodies; the selection is retained.
    for (const id of ['u3', 'a3', 'u4', 'a4']) {
      expect(container.querySelector(`[data-testid="body-${id}"]`)).not.toBeNull()
    }
  })

  it('an unselected folded block still collapses while neighbours select', () => {
    // Only turn 5 selected: the folded turns 3+4 keep a collapsed unselected shell.
    const selected = ['u5']
    const { nodes } = buildFlow(selected)
    const { container } = render(
      <Provider store={store}>
        {renderEditFlowNodes({
          nodes,
          isEditMode: true,
          selectedTurnAskIds: new Set(selected),
          expandedFoldSectionIds: new Set<string>()
        })}
      </Provider>
    )
    const collapsed = container.querySelectorAll('[data-testid="folded-section-collapsed"]')
    expect(collapsed.length).toBe(1)
    expect((collapsed[0] as HTMLElement).getAttribute('data-folded-section-selected')).toBe('false')
  })
})
