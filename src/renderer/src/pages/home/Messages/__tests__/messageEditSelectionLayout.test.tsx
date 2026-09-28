/**
 * Edit-selection flow contract — independent boundary nodes.
 *
 * Mounted flow is an explicit typed sequence (turn | boundary) in
 * newest→oldest render order under column-reverse:
 * - Fork boundary renders DOM-before its anchor body → visually directly
 *   below the anchor (boundary between anchor above and newer below).
 * - Context boundary renders DOM-after its anchor body (legacy placement)
 *   → visually directly above the anchor on the older side.
 * DOM-earlier means visually lower in both cases.
 *
 * - Turn bodies never contain dividers; boundaries are siblings, so turn
 *   click capture cannot swallow divider controls.
 * - Adjacent bodies sharing askId merge into one EditTurn, but any
 *   boundary flushes the run: same askId on both sides yields two turns.
 * - Selected contiguous ranges keep one atomic SelectionBlock wrapping
 *   selected turns + strictly interior boundaries (sequence/range
 *   membership — no leading/interior hoisting). Edge boundaries stay
 *   outside.
 */
import { fireEvent, render } from '@testing-library/react'
import { useEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'

import {
  buildOrderedFlowItems,
  deriveSelectionRangeKey,
  deriveTurnAskId,
  deriveTurnKey,
  EditTurnContainer,
  type FlowBodyEntry,
  type FlowNode,
  renderEditFlowNodes,
  SelectionBlock
} from '../messageEditSelectionLayout'

const bodyDiv = (groupKey: string, opts?: Partial<FlowBodyEntry>) => (
  <div
    data-layer-kind={opts?.kind ?? 'history'}
    data-layer-run-id={opts?.layerRunId ?? 'layer:x'}
    data-stable-group-id={groupKey}
    data-testid={`body-${groupKey}`}>
    {groupKey}
  </div>
)

function turnNode(
  groupKey: string,
  turnAskId: string,
  opts?: Partial<FlowBodyEntry> & { bodyTestId?: string }
): FlowNode {
  const { bodyTestId: _ignored, ...rest } = opts ?? {}
  void _ignored
  return {
    kind: 'turn',
    entry: {
      groupKey,
      turnAskId,
      selected: rest.selected ?? false,
      segmentId: rest.segmentId ?? 'seg:edit',
      segmentIsLive: rest.segmentIsLive ?? false,
      kind: rest.kind ?? 'history',
      layerRunId: rest.layerRunId ?? 'layer:x',
      bodyNode: rest.bodyNode ?? bodyDiv(groupKey, rest)
    }
  }
}

function forkBoundary(boundaryKey: string, testId: string, label = testId): FlowNode {
  return {
    kind: 'boundary',
    entry: {
      boundaryKey,
      boundaryKind: 'fork',
      node: <div data-testid={testId}>{label}</div>
    }
  }
}

function contextBoundary(legacyKey: string): FlowNode {
  return {
    kind: 'boundary',
    entry: {
      boundaryKey: `context-boundary:${legacyKey}`,
      boundaryKind: 'context',
      node: (
        <div data-context-boundary data-testid="context-boundary" data-context-legacy-key={legacyKey}>
          context {legacyKey}
        </div>
      )
    }
  }
}

function renderFlow(nodes: FlowNode[], isEditMode = true, onTurnClick?: (...args: any[]) => void) {
  return render(<>{renderEditFlowNodes({ nodes, isEditMode, onTurnClick })}</>)
}

function testIds(container: HTMLElement): (string | null)[] {
  return Array.from(container.querySelectorAll('[data-testid]')).map((el) => el.getAttribute('data-testid'))
}

describe('deriveTurnAskId', () => {
  it('uses the user id for user groups and the askId for assistant groups', () => {
    expect(deriveTurnAskId([{ id: 'u1', role: 'user' }])).toBe('u1')
    expect(
      deriveTurnAskId([
        { id: 'a1', role: 'assistant', askId: 'u1' },
        { id: 'a2', role: 'assistant', askId: 'u1' }
      ])
    ).toBe('u1')
    expect(deriveTurnAskId([{ id: 'a9', role: 'assistant' }])).toBe('a9')
    expect(deriveTurnAskId([])).toBe('')
  })
})

describe('flow turns and boundaries', () => {
  it('no divider is inside a turn container (fork and context)', () => {
    const { container } = renderFlow([
      turnNode('g-newer', 'ask-b'),
      forkBoundary('branch-fork-anchor-main', 'div-fork'),
      turnNode('g-anchor', 'ask-a'),
      contextBoundary('legacy-anchor')
    ])
    for (const testId of ['div-fork', 'context-boundary']) {
      const el = container.querySelector(`[data-testid="${testId}"]`) as Element
      expect(el.closest('[data-turn-ask]')).toBeNull()
    }
    // Bodies stay inside their own turns.
    expect(
      (container.querySelector('[data-testid="body-g-newer"]') as Element).closest('[data-turn-ask]')
    ).not.toBeNull()
    expect(
      (container.querySelector('[data-testid="body-g-anchor"]') as Element).closest('[data-turn-ask]')
    ).not.toBeNull()
  })

  it('fork DOM order maps to below-anchor visual placement under column-reverse', () => {
    // Render order newest→oldest: newer body, fork boundary, anchor body.
    const { container } = renderFlow([
      turnNode('g-newer', 'ask-b'),
      forkBoundary('branch-fork-anchor-main', 'div-fork'),
      turnNode('g-anchor', 'ask-a')
    ])
    // DOM order preserved exactly.
    expect(testIds(container)).toEqual(['edit-turn', 'body-g-newer', 'div-fork', 'edit-turn', 'body-g-anchor'])
    // Column-reverse: DOM-earlier is visually lower, so the boundary
    // (DOM between newer and anchor) sits visually below the anchor and
    // above the newer content.
  })

  it('context DOM order preserves legacy after-body placement under column-reverse', () => {
    // Legacy inline divider sat after the group div; the sibling boundary
    // keeps that DOM position: anchor body then context line.
    const { container } = renderFlow([
      turnNode('g-newer', 'ask-b'),
      turnNode('g-anchor', 'ask-a'),
      contextBoundary('legacy-anchor')
    ])
    expect(testIds(container)).toEqual(['edit-turn', 'body-g-newer', 'edit-turn', 'body-g-anchor', 'context-boundary'])
    // DOM-later is visually higher, so the line sits visually above the
    // anchor on the older side — same visual placement as legacy.
    const line = container.querySelector('[data-testid="context-boundary"]') as Element
    expect(line.getAttribute('data-context-legacy-key')).toBe('legacy-anchor')
    expect(line.closest('[data-turn-ask]')).toBeNull()
  })

  it('selecting only the turn visually above the fork line excludes the line', () => {
    const { container } = renderFlow([
      turnNode('g-newer', 'ask-b', { selected: false, segmentId: 'seg:x' }),
      forkBoundary('branch-fork-anchor-main', 'div-fork'),
      turnNode('g-anchor', 'ask-a', { selected: true, segmentId: 'seg:above' })
    ])
    const outlines = container.querySelectorAll('[data-stable-segment-id="seg:above"]')
    expect(outlines.length).toBe(1)
    const line = container.querySelector('[data-testid="div-fork"]') as Element
    expect(line.closest('[data-stable-segment-id]')).toBeNull()
    const anchor = container.querySelector('[data-testid="body-g-anchor"]') as Element
    expect(anchor.closest('[data-stable-segment-id]')).toBe(outlines[0])
  })

  it('selecting only the turn visually below the fork line excludes the line', () => {
    const { container } = renderFlow([
      turnNode('g-newer', 'ask-b', { selected: true, segmentId: 'seg:below' }),
      forkBoundary('branch-fork-anchor-main', 'div-fork'),
      turnNode('g-anchor', 'ask-a', { selected: false, segmentId: 'seg:x' })
    ])
    const outlines = container.querySelectorAll('[data-stable-segment-id="seg:below"]')
    expect(outlines.length).toBe(1)
    const line = container.querySelector('[data-testid="div-fork"]') as Element
    expect(line.closest('[data-stable-segment-id]')).toBeNull()
    const newer = container.querySelector('[data-testid="body-g-newer"]') as Element
    expect(newer.closest('[data-stable-segment-id]')).toBe(outlines[0])
  })

  it('continuous selection on both sides wraps both turns and the boundary exactly once', () => {
    const { container } = renderFlow([
      turnNode('g-newer', 'ask-b', { selected: true, segmentId: 'seg:span' }),
      forkBoundary('branch-fork-anchor-main', 'div-span-main'),
      turnNode('g-anchor', 'ask-a', { selected: true, segmentId: 'seg:span' })
    ])
    const outlines = container.querySelectorAll('[data-stable-segment-id="seg:span"]')
    expect(outlines.length).toBe(1)
    const line = container.querySelector('[data-testid="div-span-main"]') as Element
    expect(line.closest('[data-stable-segment-id]')).toBe(outlines[0])
    expect(container.querySelectorAll('[data-testid="div-span-main"]').length).toBe(1)
    expect(testIds(container)).toEqual(['edit-turn', 'body-g-newer', 'div-span-main', 'edit-turn', 'body-g-anchor'])
  })

  it('multiple adjacent fork boundaries keep stable relative order (outside edge, inside span)', () => {
    const adjacent = (): FlowNode[] => [
      turnNode('g-newer', 'ask-b', { selected: false, segmentId: 'seg:x' }),
      forkBoundary('branch-fork-anchor-main', 'div-main'),
      forkBoundary('branch-fork-anchor-b1', 'div-b1'),
      turnNode('g-anchor', 'ask-a', { selected: false, segmentId: 'seg:y' })
    ]
    const edge = renderFlow([
      turnNode('g-newer', 'ask-b', { selected: false, segmentId: 'seg:x' }),
      forkBoundary('branch-fork-anchor-main', 'div-main'),
      forkBoundary('branch-fork-anchor-b1', 'div-b1'),
      turnNode('g-anchor', 'ask-a', { selected: true, segmentId: 'seg:edge' })
    ])
    // Edge-only selection: both lines stay outside, order intact.
    expect(edge.container.querySelectorAll('[data-stable-segment-id="seg:edge"]').length).toBe(1)
    for (const id of ['div-main', 'div-b1']) {
      expect(
        (edge.container.querySelector(`[data-testid="${id}"]`) as Element).closest('[data-stable-segment-id]')
      ).toBeNull()
    }
    expect(testIds(edge.container)).toEqual([
      'edit-turn',
      'body-g-newer',
      'div-main',
      'div-b1',
      'edit-turn',
      'body-g-anchor'
    ])
    edge.unmount()

    const span = renderFlow([
      turnNode('g-newer', 'ask-b', { selected: true, segmentId: 'seg:span2' }),
      forkBoundary('branch-fork-anchor-main', 'div-main'),
      forkBoundary('branch-fork-anchor-b1', 'div-b1'),
      turnNode('g-anchor', 'ask-a', { selected: true, segmentId: 'seg:span2' })
    ])
    const outlines = span.container.querySelectorAll('[data-stable-segment-id="seg:span2"]')
    expect(outlines.length).toBe(1)
    for (const id of ['div-main', 'div-b1']) {
      expect(
        (span.container.querySelector(`[data-testid="${id}"]`) as Element).closest('[data-stable-segment-id]')
      ).toBe(outlines[0])
    }
    expect(testIds(span.container)).toEqual([
      'edit-turn',
      'body-g-newer',
      'div-main',
      'div-b1',
      'edit-turn',
      'body-g-anchor'
    ])
    span.unmount()
    expect(adjacent().length).toBe(4)
  })

  it('same askId separated by a boundary yields two turn containers with no spanning preview', () => {
    const { container } = renderFlow([
      turnNode('g-assistant', 'ask-x'),
      forkBoundary('branch-fork-mid-main', 'div-mid'),
      turnNode('g-user', 'ask-x')
    ])
    const turns = container.querySelectorAll('[data-testid="edit-turn"]')
    expect(turns.length).toBe(2)
    expect(turns[0].querySelector('[data-testid="body-g-assistant"]')).not.toBeNull()
    expect(turns[1].querySelector('[data-testid="body-g-user"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-stable-segment-id]').length).toBe(0)
    expect(container.querySelector('[data-testid="edit-preview-frame"]')).toBeNull()
  })

  it('same askId split still selects atomically: two turns + interior line in one outline', () => {
    const { container } = renderFlow([
      turnNode('g-assistant', 'ask-x', { selected: true, segmentId: 'seg:split' }),
      forkBoundary('branch-fork-mid-main', 'div-mid'),
      turnNode('g-user', 'ask-x', { selected: true, segmentId: 'seg:split' })
    ])
    expect(container.querySelectorAll('[data-testid="edit-turn"]').length).toBe(2)
    const outlines = container.querySelectorAll('[data-stable-segment-id="seg:split"]')
    expect(outlines.length).toBe(1)
    expect((container.querySelector('[data-testid="div-mid"]') as Element).closest('[data-stable-segment-id]')).toBe(
      outlines[0]
    )
  })

  it('boundary controls are not intercepted by turn capture; nested turn controls are selection-only', () => {
    const onTurnClick = vi.fn()
    const dividerAction = vi.fn()
    const nestedAction = vi.fn()
    const anchorTurn: FlowNode = {
      kind: 'turn',
      entry: {
        groupKey: 'g-anchor',
        turnAskId: 'ask-a',
        selected: false,
        segmentId: 'seg:edit',
        segmentIsLive: false,
        kind: 'history',
        layerRunId: 'layer:x',
        bodyNode: (
          <div data-testid="body-nested">
            content
            <button type="button" data-testid="nested-action" onClick={nestedAction}>
              model selector action
            </button>
          </div>
        )
      }
    }
    const divider: FlowNode = {
      kind: 'boundary',
      entry: {
        boundaryKey: 'branch-fork-anchor-main',
        boundaryKind: 'fork',
        node: (
          <div data-testid="div-controls">
            <button type="button" data-testid="divider-action" onClick={dividerAction}>
              switch branch
            </button>
          </div>
        )
      }
    }
    const { container } = renderFlow([turnNode('g-newer', 'ask-b'), divider, anchorTurn], true, onTurnClick)
    // Divider control runs its own behavior and never toggles selection.
    fireEvent.click(container.querySelector('[data-testid="divider-action"]') as HTMLElement)
    expect(dividerAction).toHaveBeenCalledTimes(1)
    expect(onTurnClick).not.toHaveBeenCalled()
    // Turn nested ordinary action is blocked at the turn boundary; the
    // turn toggles exactly once with modifier forwarding.
    fireEvent.click(container.querySelector('[data-testid="nested-action"]') as HTMLElement)
    expect(nestedAction).not.toHaveBeenCalled()
    expect(onTurnClick).toHaveBeenCalledTimes(1)
    expect(onTurnClick).toHaveBeenCalledWith('ask-a', false, false)
    fireEvent.click(container.querySelector('[data-testid="body-nested"]') as HTMLElement)
    expect(onTurnClick).toHaveBeenCalledTimes(2)
  })

  it('selection ranges keep unique stable ids with no duplicated or omitted nodes', () => {
    const nodes: FlowNode[] = [
      turnNode('g-n2', 'ask-c', { selected: true, segmentId: 'seg:one' }),
      forkBoundary('branch-fork-c-main', 'div-c'),
      turnNode('g-c', 'ask-c', { selected: true, segmentId: 'seg:one' }),
      turnNode('g-gap', 'ask-gap', { selected: false, segmentId: 'seg:x' }),
      turnNode('g-n1', 'ask-b', { selected: true, segmentId: 'seg:two' }),
      contextBoundary('legacy-b'),
      turnNode('g-b', 'ask-b', { selected: false, segmentId: 'seg:x' })
    ]
    const { container } = renderFlow(nodes)
    // Two atomic outlines, each with a unique stable id.
    const outlines = Array.from(container.querySelectorAll('[data-stable-segment-id]'))
    const ids = outlines.map((el) => el.getAttribute('data-stable-segment-id'))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('seg:one')
    // Interior fork line inside the first range exactly once; trailing
    // context line at the selected→unselected edge stays outside.
    expect(container.querySelectorAll('[data-testid="div-c"]').length).toBe(1)
    expect(
      (container.querySelector('[data-testid="div-c"]') as Element).closest('[data-stable-segment-id]')
    ).not.toBeNull()
    expect(
      (container.querySelector('[data-testid="context-boundary"]') as Element).closest('[data-stable-segment-id]')
    ).toBeNull()
    // Every body and boundary renders exactly once, in flow order.
    for (const id of ['body-g-n2', 'div-c', 'body-g-c', 'body-g-gap', 'body-g-n1', 'context-boundary', 'body-g-b']) {
      expect(container.querySelectorAll(`[data-testid="${id}"]`).length).toBe(1)
    }
    // Mixed-segment ranges derive a stable unique key.
    const mixed = deriveSelectionRangeKey([
      [
        {
          groupKey: 'g1',
          turnAskId: 'a',
          selected: true,
          segmentId: 'seg:one',
          segmentIsLive: false,
          kind: 'history',
          layerRunId: 'l1',
          bodyNode: null
        }
      ],
      [
        {
          groupKey: 'g2',
          turnAskId: 'b',
          selected: true,
          segmentId: 'seg:two',
          segmentIsLive: false,
          kind: 'history',
          layerRunId: 'l1',
          bodyNode: null
        }
      ]
    ])
    expect(mixed).not.toBe('seg:one')
    expect(mixed).not.toBe('seg:two')
    expect(
      deriveSelectionRangeKey([
        [
          {
            groupKey: 'g1',
            turnAskId: 'a',
            selected: true,
            segmentId: 'seg:one',
            segmentIsLive: false,
            kind: 'history',
            layerRunId: 'l1',
            bodyNode: null
          }
        ]
      ])
    ).toBe('seg:one')
  })
})

describe('turn runs with boundary flush', () => {
  const key = (groupKey: string, turnAskId: string): FlowNode => turnNode(groupKey, turnAskId)

  it('groups adjacent same-askId bodies and splits on intervening content or boundary', () => {
    const items = buildOrderedFlowItems([
      key('g-newer-b', 'ask-b'),
      key('g-user-b', 'ask-b'),
      key('g-newer-a', 'ask-a'),
      key('g-user-a', 'ask-a')
    ])
    expect(items.length).toBe(2)
    expect(items[0].kind).toBe('turn-run')
    const split = buildOrderedFlowItems([turnNode('g1', 'ask-x'), forkBoundary('b1', 'div-1'), turnNode('g2', 'ask-x')])
    expect(split.filter((i) => i.kind === 'turn-run').length).toBe(2)
  })

  it('never wraps non-consecutive same askId across intervening content', () => {
    const items = buildOrderedFlowItems([key('g1', 'ask-x'), key('g2', 'ask-y'), key('g3', 'ask-x')])
    const runs = items.filter((i) => i.kind === 'turn-run')
    expect(runs.length).toBe(3)
    expect(deriveTurnKey((runs[0] as { run: FlowBodyEntry[] }).run)).not.toBe(
      deriveTurnKey((runs[2] as { run: FlowBodyEntry[] }).run)
    )
  })

  it('keeps empty askIds as singletons and derives stable keys', () => {
    const items = buildOrderedFlowItems([key('g1', ''), key('g2', '')])
    expect(items.filter((i) => i.kind === 'turn-run').length).toBe(2)
    const a = buildOrderedFlowItems([key('g1', 'ask-x')])[0]
    const b = buildOrderedFlowItems([key('g1', 'ask-x')])[0]
    expect(deriveTurnKey((a as { run: FlowBodyEntry[] }).run)).toBe(deriveTurnKey((b as { run: FlowBodyEntry[] }).run))
  })
})

describe('renderEditFlowNodes', () => {
  it('encloses a normal user + assistant turn in exactly one container with no geometry overlay', () => {
    // Render order is newest→oldest: assistant first, user second.
    const { container } = renderFlow([turnNode('g-assistant', 'u1'), turnNode('g-user', 'u1')])
    const turns = container.querySelectorAll('[data-testid="edit-turn"]')
    expect(turns.length).toBe(1)
    expect(turns[0].getAttribute('data-turn-ask')).toBe('u1')
    expect(turns[0].querySelector('[data-testid="body-g-assistant"]')).not.toBeNull()
    expect(turns[0].querySelector('[data-testid="body-g-user"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="edit-preview-frame"]')).toBeNull()
    expect(container.querySelector('[data-group-ask]')).toBeNull()
  })

  it('A→B→A hover across sibling turns stays reliable with no shared state or timers', () => {
    const { container } = renderFlow([
      turnNode('g-b-assistant', 'ask-b'),
      turnNode('g-b-user', 'ask-b'),
      turnNode('g-a-assistant', 'ask-a'),
      turnNode('g-a-user', 'ask-a')
    ])
    const turns = Array.from(container.querySelectorAll('[data-testid="edit-turn"]')) as HTMLElement[]
    expect(turns.length).toBe(2)
    const [turnB, turnA] = turns
    expect(turnB.classList.contains('edit-turn-interactive')).toBe(true)
    expect(turnA.classList.contains('edit-turn-interactive')).toBe(true)
    for (let i = 0; i < 5; i++) {
      fireEvent.mouseEnter(turnA)
      fireEvent.mouseOver(turnA)
      fireEvent.mouseLeave(turnA)
      fireEvent.mouseEnter(turnB)
      fireEvent.mouseOver(turnB)
      fireEvent.mouseLeave(turnB)
      fireEvent.mouseEnter(turnA)
      expect(turnA.classList.contains('edit-turn-interactive')).toBe(true)
      expect(turnB.classList.contains('edit-turn-interactive')).toBe(true)
      expect(container.querySelectorAll('[data-testid="edit-turn"]').length).toBe(2)
    }
  })

  it('streaming turn shares one container while children keep distinct layer classifications', () => {
    const { container } = renderFlow([
      turnNode('g-live', 'u-stream', { kind: 'live', layerRunId: 'layer:live' }),
      turnNode('g-history', 'u-stream', { kind: 'history', layerRunId: 'layer:history' })
    ])
    const turns = container.querySelectorAll('[data-testid="edit-turn"]')
    expect(turns.length).toBe(1)
    const live = container.querySelector('[data-testid="body-g-live"]') as HTMLElement
    const history = container.querySelector('[data-testid="body-g-history"]') as HTMLElement
    expect(live.getAttribute('data-layer-kind')).toBe('live')
    expect(history.getAttribute('data-layer-kind')).toBe('history')
    expect(live.getAttribute('data-layer-run-id')).not.toBe(history.getAttribute('data-layer-run-id'))
    expect(turns[0].hasAttribute('data-layer-kind')).toBe(false)
  })

  it('stateful children survive hover and edit-mode toggle without remount', () => {
    const mounts = new Map<string, number>()
    function StatefulBody({ id }: { id: string }) {
      useEffect(() => {
        mounts.set(id, (mounts.get(id) ?? 0) + 1)
      }, [id])
      return (
        <div data-layer-kind="history" data-layer-run-id="layer:x" data-stable-group-id={id} data-testid={`body-${id}`}>
          {id}
        </div>
      )
    }
    const makeNodes = (selected: boolean): FlowNode[] => [
      {
        kind: 'turn',
        entry: {
          groupKey: 'g-assistant',
          turnAskId: 'u1',
          selected,
          segmentId: 'seg:sel',
          segmentIsLive: false,
          kind: 'history',
          layerRunId: 'layer:x',
          bodyNode: <StatefulBody id="g-assistant" />
        }
      },
      {
        kind: 'turn',
        entry: {
          groupKey: 'g-user',
          turnAskId: 'u1',
          selected,
          segmentId: 'seg:sel',
          segmentIsLive: false,
          kind: 'history',
          layerRunId: 'layer:x',
          bodyNode: <StatefulBody id="g-user" />
        }
      }
    ]
    const { container, rerender } = render(<>{renderEditFlowNodes({ nodes: makeNodes(false), isEditMode: true })}</>)
    const turnBefore = container.querySelector('[data-testid="edit-turn"]') as HTMLElement
    const bodyBefore = container.querySelector('[data-testid="body-g-user"]') as HTMLElement
    expect(mounts.get('g-user')).toBe(1)
    // Pointer movement has no handler/state: nothing re-renders.
    fireEvent.mouseEnter(turnBefore)
    fireEvent.mouseLeave(turnBefore)
    expect(container.querySelector('[data-testid="edit-turn"]')).toBe(turnBefore)
    expect(mounts.get('g-user')).toBe(1)
    // Edit-mode toggle keeps the same turn element and child nodes: the
    // container exists in both modes with the same stable key, so React
    // reconciles props only.
    rerender(<>{renderEditFlowNodes({ nodes: makeNodes(false), isEditMode: false })}</>)
    expect(container.querySelector('[data-testid="edit-turn"]')).toBe(turnBefore)
    expect(container.querySelector('[data-testid="body-g-user"]')).toBe(bodyBefore)
    expect(mounts.get('g-user')).toBe(1)
    expect(mounts.get('g-assistant')).toBe(1)
  })

  it('selecting a turn remounts children under the new SelectionBlock parent (documented pre-existing behavior)', () => {
    // Pre-existing contract: selection wraps turns in a newly mounted
    // SelectionBlock. Because the EditTurn gains a new parent (different
    // type/key at the root list), React mounts a new subtree — stateful
    // children remount. Hover and edit-mode toggles above do not remount;
    // selection does. This test pins that distinction.
    const mounts = new Map<string, number>()
    function StatefulBody({ id }: { id: string }) {
      useEffect(() => {
        mounts.set(id, (mounts.get(id) ?? 0) + 1)
      }, [id])
      return <div data-testid={`body-${id}`}>{id}</div>
    }
    const makeNodes = (selected: boolean): FlowNode[] => [
      {
        kind: 'turn',
        entry: {
          groupKey: 'g-assistant',
          turnAskId: 'u1',
          selected,
          segmentId: 'seg:sel',
          segmentIsLive: false,
          kind: 'history',
          layerRunId: 'layer:x',
          bodyNode: <StatefulBody id="g-assistant" />
        }
      },
      {
        kind: 'turn',
        entry: {
          groupKey: 'g-user',
          turnAskId: 'u1',
          selected,
          segmentId: 'seg:sel',
          segmentIsLive: false,
          kind: 'history',
          layerRunId: 'layer:x',
          bodyNode: <StatefulBody id="g-user" />
        }
      }
    ]
    const { container, rerender } = render(<>{renderEditFlowNodes({ nodes: makeNodes(false), isEditMode: true })}</>)
    expect(mounts.get('g-user')).toBe(1)
    expect(container.querySelectorAll('[data-stable-segment-id]').length).toBe(0)
    rerender(<>{renderEditFlowNodes({ nodes: makeNodes(true), isEditMode: true })}</>)
    expect(container.querySelectorAll('[data-stable-segment-id="seg:sel"]').length).toBe(1)
    // New outline parent → children mount again.
    expect(mounts.get('g-user')).toBe(2)
    expect(mounts.get('g-assistant')).toBe(2)
  })

  it('clicking anywhere in the turn toggles once with modifier forwarding; nested actions are blocked', () => {
    const onTurnClick = vi.fn()
    const nestedAction = vi.fn()
    const nestedTurn: FlowNode = {
      kind: 'turn',
      entry: {
        groupKey: 'g-assistant',
        turnAskId: 'u1',
        selected: false,
        segmentId: 'seg:edit',
        segmentIsLive: false,
        kind: 'history',
        layerRunId: 'layer:x',
        bodyNode: (
          <div data-testid="body-nested">
            content
            <button type="button" data-testid="nested-action" onClick={nestedAction}>
              model selector action
            </button>
          </div>
        )
      }
    }
    const { container } = renderFlow([nestedTurn, turnNode('g-user', 'u1')], true, onTurnClick)
    const turn = container.querySelector('[data-testid="edit-turn"]') as HTMLElement
    fireEvent.click(turn.querySelector('[data-testid="body-nested"]') as HTMLElement)
    expect(onTurnClick).toHaveBeenCalledTimes(1)
    expect(onTurnClick).toHaveBeenCalledWith('u1', false, false)
    fireEvent.click(turn, { ctrlKey: true })
    expect(onTurnClick).toHaveBeenCalledWith('u1', true, false)
    fireEvent.click(turn, { shiftKey: true })
    expect(onTurnClick).toHaveBeenCalledWith('u1', false, true)
    fireEvent.click(container.querySelector('[data-testid="nested-action"]') as HTMLElement)
    expect(nestedAction).not.toHaveBeenCalled()
    expect(onTurnClick).toHaveBeenCalledTimes(4)
  })

  it('selected turns show the selected outline only, with no preview ring', () => {
    const selected = (groupKey: string, turnAskId: string, segmentId: string): FlowNode =>
      turnNode(groupKey, turnAskId, { selected: true, segmentId, segmentIsLive: false })
    const { container } = renderFlow(
      [
        selected('g-b-assistant', 'ask-b', 'seg:sel'),
        selected('g-b-user', 'ask-b', 'seg:sel'),
        selected('g-a-assistant', 'ask-a', 'seg:sel'),
        selected('g-a-user', 'ask-a', 'seg:sel')
      ],
      true
    )
    const outlines = container.querySelectorAll('[data-stable-segment-id="seg:sel"]')
    expect(outlines.length).toBe(1)
    const turns = container.querySelectorAll('[data-testid="edit-turn"]')
    expect(turns.length).toBe(2)
    for (const turn of Array.from(turns)) {
      expect((turn as HTMLElement).classList.contains('edit-turn-interactive')).toBe(false)
      expect((turn as HTMLElement).classList.contains('edit-turn-selected')).toBe(true)
      expect(turn.closest('[data-stable-segment-id]')).toBe(outlines[0])
    }
    expect(container.querySelector('.edit-turn-interactive')).toBeNull()
    expect(container.querySelector('[data-testid="edit-preview-frame"]')).toBeNull()
  })

  it('unselected turns carry one ring per turn, never per message or visual group', () => {
    const { container } = renderFlow([turnNode('g-assistant', 'u1'), turnNode('g-user', 'u1')])
    expect(container.querySelectorAll('.edit-turn-interactive').length).toBe(1)
    expect(container.querySelector('.edit-mode-preview')).toBeNull()
    expect(container.querySelector('.edit-mode-unselected')).toBeNull()
    const rules = EditTurnContainer.componentStyle.rules.join('')
    expect(rules).toContain(':hover')
    expect(rules).toContain('box-shadow')
    expect(rules).toContain('var(--color-border)')
    expect(rules).not.toContain('absolute')
  })

  it('non-consecutive same askId never wraps across intervening content', () => {
    const { container } = renderFlow([turnNode('g1', 'ask-x'), turnNode('g2', 'ask-y'), turnNode('g3', 'ask-x')])
    const turns = container.querySelectorAll('[data-testid="edit-turn"]')
    expect(turns.length).toBe(3)
    expect(turns[0].querySelector('[data-testid="body-g2"]')).toBeNull()
    expect(turns[2].querySelector('[data-testid="body-g2"]')).toBeNull()
  })

  it('turn wrapper preserves DOM order and adds no spacing of its own', () => {
    const rules = EditTurnContainer.componentStyle.rules.join('')
    expect(rules).toContain('column-reverse')
    expect(rules).not.toMatch(/margin\s*:/)
    expect(rules).not.toMatch(/padding\s*:/)
    expect(rules).not.toMatch(/gap\s*:/)
  })

  it('selected groups retain the primary selected visual', () => {
    const rules = SelectionBlock.componentStyle.rules.join('')
    expect(rules).toContain('box-shadow')
    expect(rules).toContain('var(--color-primary)')
  })

  it('outside edit mode turns render as plain containers with no interaction', () => {
    const onTurnClick = vi.fn()
    const { container } = renderFlow([turnNode('g-assistant', 'u1'), turnNode('g-user', 'u1')], false, onTurnClick)
    const turn = container.querySelector('[data-testid="edit-turn"]') as HTMLElement
    expect(turn.classList.contains('edit-turn-interactive')).toBe(false)
    fireEvent.click(turn)
    expect(onTurnClick).not.toHaveBeenCalled()
  })
})
