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
  deriveRunSegmentChrome,
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
    // DOM order preserved exactly (the edit-only cover closes each turn;
    // boundaries stay siblings outside turns).
    expect(testIds(container)).toEqual([
      'edit-turn',
      'body-g-newer',
      'edit-turn-cover',
      'div-fork',
      'edit-turn',
      'body-g-anchor',
      'edit-turn-cover'
    ])
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
    expect(testIds(container)).toEqual([
      'edit-turn',
      'body-g-newer',
      'edit-turn-cover',
      'edit-turn',
      'body-g-anchor',
      'edit-turn-cover',
      'context-boundary'
    ])
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
    expect(testIds(container)).toEqual([
      'edit-turn',
      'body-g-newer',
      'edit-turn-cover',
      'div-span-main',
      'edit-turn',
      'body-g-anchor',
      'edit-turn-cover'
    ])
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
      'edit-turn-cover',
      'div-main',
      'div-b1',
      'edit-turn',
      'body-g-anchor',
      'edit-turn-cover'
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
      'edit-turn-cover',
      'div-main',
      'div-b1',
      'edit-turn',
      'body-g-anchor',
      'edit-turn-cover'
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
  it('encloses a normal user + assistant turn in exactly one container with an out-of-flow cover only', () => {
    // Render order is newest→oldest: assistant first, user second. The
    // edit-only cover is absolutely positioned (out of flow), so turn
    // geometry matches normal mode exactly.
    const { container } = renderFlow([turnNode('g-assistant', 'u1'), turnNode('g-user', 'u1')])
    const turns = container.querySelectorAll('[data-testid="edit-turn"]')
    expect(turns.length).toBe(1)
    expect(turns[0].getAttribute('data-turn-ask')).toBe('u1')
    expect(turns[0].querySelector('[data-testid="body-g-assistant"]')).not.toBeNull()
    expect(turns[0].querySelector('[data-testid="body-g-user"]')).not.toBeNull()
    const cover = turns[0].querySelector('[data-testid="edit-turn-cover"]') as HTMLElement
    expect(cover).not.toBeNull()
    expect(window.getComputedStyle(cover).position).toBe('absolute')
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

  it('edit mode shields content with inert display:contents and an edit-only cover, hiding the footer immediately', () => {
    // Single-owner contract: the turn preserves the original body mount
    // (markers, Sortable structure, label bar) with no per-child edit
    // branches; the inert content + absolute cover block pointer/hover/
    // drag/focus while the same edit-class commit hides the message footer
    // with no transition (height reserved). The multi-answer label bar is
    // intentionally unaffected.
    const shieldTurn: FlowNode = {
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
          <div data-testid="body-shield">
            <div data-testid="answer-group-selector" data-message-id="a2" data-interaction-region="answer-tab">
              model b label
            </div>
            <div className="group-menu-bar" data-testid="shield-bar">
              bar
            </div>
            <div className="MessageFooter" data-testid="shield-footer">
              <div className="menubar show" data-testid="shield-menubar">
                <div className="message-action-button" data-testid="shield-action">
                  action
                </div>
              </div>
              <span className="message-footer-metadata" data-testid="shield-metadata">
                meta
              </span>
            </div>
          </div>
        )
      }
    }
    const { container, rerender } = renderFlow([shieldTurn, turnNode('g-user', 'u1')], true, vi.fn())
    const turn = container.querySelector('[data-testid="edit-turn"]') as HTMLElement
    expect(turn.classList.contains('edit-turn-interactive')).toBe(true)
    // Preserved geometry: relative positioning adds no offset; the cover
    // is out of flow.
    expect(window.getComputedStyle(turn).position).toBe('relative')
    // Stable content wrapper present with no box-layout change + inert.
    const body = turn.querySelector('[data-testid="body-shield"]') as HTMLElement
    expect(body).not.toBeNull()
    const content = body.parentElement
    expect(content).not.toBeNull()
    expect(content!.hasAttribute('inert')).toBe(true)
    expect(window.getComputedStyle(content!).display).toBe('contents')
    // Original child identity preserved verbatim (no child rewrites).
    expect(turn.querySelector('[data-testid="answer-group-selector"]')).not.toBeNull()
    expect(turn.querySelector('[data-testid="answer-group-selector"]')?.getAttribute('data-interaction-region')).toBe(
      'answer-tab'
    )
    // Edit-only cover: non-focusable descriptive layer receiving pointer.
    const cover = turn.querySelector('[data-testid="edit-turn-cover"]') as HTMLElement
    expect(cover).not.toBeNull()
    expect(cover.getAttribute('aria-hidden')).toBe('true')
    expect(cover.hasAttribute('tabindex')).toBe(false)
    expect(cover.getAttribute('role')).toBeNull()
    expect(window.getComputedStyle(cover).position).toBe('absolute')
    expect(window.getComputedStyle(cover).zIndex).toBe('1')
    // Immediate footer hide in the same commit: no transition, height
    // reserved (visibility, not display:none).
    const footer = turn.querySelector('[data-testid="shield-footer"]') as HTMLElement
    expect(window.getComputedStyle(footer).visibility).toBe('hidden')
    expect(window.getComputedStyle(footer).opacity).toBe('0')
    expect(window.getComputedStyle(footer).transition).toBe('none')
    expect(window.getComputedStyle(footer).display).not.toBe('none')
    for (const testId of ['shield-menubar', 'shield-action', 'shield-metadata']) {
      const el = turn.querySelector(`[data-testid="${testId}"]`) as HTMLElement
      expect(window.getComputedStyle(el).visibility).toBe('hidden')
      expect(window.getComputedStyle(el).opacity).toBe('0')
      expect(window.getComputedStyle(el).transition).toBe('none')
    }
    // Multi-answer label bar is NOT affected by the footer hide.
    const bar = turn.querySelector('[data-testid="shield-bar"]') as HTMLElement
    expect(window.getComputedStyle(bar).visibility).not.toBe('hidden')
    // Normal mode restores: no cover, no inert, footer visible, static box.
    rerender(<>{renderEditFlowNodes({ nodes: [shieldTurn, turnNode('g-user', 'u1')], isEditMode: false })}</>)
    const plain = container.querySelector('[data-testid="edit-turn"]') as HTMLElement
    expect(plain.querySelector('[data-testid="edit-turn-cover"]')).toBeNull()
    const plainBody = plain.querySelector('[data-testid="body-shield"]') as HTMLElement
    expect(plainBody.parentElement?.hasAttribute('inert')).toBe(false)
    expect(window.getComputedStyle(plain).position).not.toBe('relative')
    const plainFooter = plain.querySelector('[data-testid="shield-footer"]') as HTMLElement
    expect(window.getComputedStyle(plainFooter).visibility).not.toBe('hidden')
  })

  it('cover click selects the whole turn once with modifier forwarding', () => {
    const onTurnClick = vi.fn()
    const { container } = renderFlow([turnNode('g-assistant', 'u1'), turnNode('g-user', 'u1')], true, onTurnClick)
    const cover = container.querySelector('[data-testid="edit-turn-cover"]') as HTMLElement
    fireEvent.click(cover)
    expect(onTurnClick).toHaveBeenCalledTimes(1)
    expect(onTurnClick).toHaveBeenCalledWith('u1', false, false)
    fireEvent.click(cover, { ctrlKey: true })
    expect(onTurnClick).toHaveBeenCalledWith('u1', true, false)
    fireEvent.click(cover, { shiftKey: true })
    expect(onTurnClick).toHaveBeenCalledWith('u1', false, true)
  })

  it('right-click auto-selects a non-selected turn and preserves selection without suppressing the batch menu', () => {
    const parentMenu = vi.fn()
    const { container, rerender } = render(
      <div onContextMenu={parentMenu}>
        {renderEditFlowNodes({
          nodes: [turnNode('g-assistant', 'u1'), turnNode('g-user', 'u1')],
          isEditMode: true,
          onTurnClick: vi.fn()
        })}
      </div>
    )
    // Replace the turn click spy via a fresh flow with a known handler.
    const onTurnClick = vi.fn()
    rerender(
      <div onContextMenu={parentMenu}>
        {renderEditFlowNodes({
          nodes: [turnNode('g-assistant', 'u1'), turnNode('g-user', 'u1')],
          isEditMode: true,
          onTurnClick
        })}
      </div>
    )
    const cover = container.querySelector('[data-testid="edit-turn-cover"]') as HTMLElement
    const result = fireEvent.contextMenu(cover)
    expect(onTurnClick).toHaveBeenCalledTimes(1)
    expect(onTurnClick).toHaveBeenCalledWith('u1', false, false)
    // No blanket suppression: the ancestor batch menu still receives the
    // bubbled event (not canceled).
    expect(result).toBe(true)
    expect(parentMenu).toHaveBeenCalledTimes(1)
    // An already-selected turn preserves the selection (no toggle-clear).
    const keep = vi.fn()
    const selectedNode: FlowNode = turnNode('g-assistant', 'u1', { selected: true, segmentId: 'seg:sel' })
    const userNode: FlowNode = turnNode('g-user', 'u1', { selected: true, segmentId: 'seg:sel' })
    const { container: selectedContainer } = renderFlow([selectedNode, userNode], true, keep)
    const selectedCover = selectedContainer.querySelector('[data-testid="edit-turn-cover"]') as HTMLElement
    fireEvent.contextMenu(selectedCover)
    expect(keep).not.toHaveBeenCalled()
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

describe('segment chrome ownership (group/run host sibling)', () => {
  const segmentFixture = (overrides: Record<string, unknown> = {}) =>
    ({
      id: 'seg-1',
      topicId: 't1',
      name: 'Seg',
      messageIds: ['u1'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sortOrder: 0,
      firstMessageId: 'u1',
      lastMessageId: 'u1',
      messageCount: 7,
      ...overrides
    }) as any

  const segmentedTurn = (groupKey: string, opts?: Partial<FlowBodyEntry>): FlowNode => ({
    kind: 'turn',
    entry: {
      groupKey,
      turnAskId: opts?.turnAskId ?? 'u1',
      selected: opts?.selected ?? false,
      segmentId: opts?.segmentId ?? 'seg:edit',
      segmentIsLive: opts?.segmentIsLive ?? false,
      kind: opts?.kind ?? 'history',
      layerRunId: opts?.layerRunId ?? 'layer:x',
      segment: opts?.segment ?? segmentFixture(),
      segmentIsFirst: opts?.segmentIsFirst,
      segmentIsLast: opts?.segmentIsLast,
      bodyNode: opts?.bodyNode ?? (
        <div
          data-layer-kind="history"
          data-layer-run-id="layer:x"
          data-stable-group-id={groupKey}
          data-testid={`body-${groupKey}`}>
          {groupKey}
        </div>
      )
    }
  })

  it('renders segment chrome as a sibling of the turn, outside inert content and the click cover', () => {
    const onTurnClick = vi.fn()
    const nodes: FlowNode[] = [
      segmentedTurn('g-assistant', { segmentIsFirst: false, segmentIsLast: true }),
      segmentedTurn('g-user', { segmentIsFirst: true })
    ]
    const { container } = render(
      <>
        {renderEditFlowNodes({
          nodes,
          isEditMode: true,
          onTurnClick,
          renderSegmentChrome: ({ isFirst, isLast, messageCount }) => (
            <div
              data-testid="segment-chrome"
              data-first={String(isFirst)}
              data-last={String(isLast)}
              data-count={messageCount}
            />
          )
        })}
      </>
    )
    const chrome = container.querySelector('[data-testid="segment-chrome"]') as HTMLElement
    const turn = container.querySelector('[data-testid="edit-turn"]') as HTMLElement
    expect(chrome).not.toBeNull()
    // Chrome is a sibling of the turn — never inside its inert content/capture
    // subtree.
    expect(turn.contains(chrome)).toBe(false)
    expect(chrome.closest('[data-testid="edit-turn"]')).toBeNull()
    const content = container.querySelector('[data-testid="body-g-user"]')!.parentElement as HTMLElement
    expect(content.hasAttribute('inert')).toBe(true)
    expect(content.contains(chrome)).toBe(false)
    // Run-level first/last spans: first from the segment-first member, last
    // from the segment-last member; count only on first.
    expect(chrome.getAttribute('data-first')).toBe('true')
    expect(chrome.getAttribute('data-last')).toBe('true')
    expect(chrome.getAttribute('data-count')).toBe('7')
    // Chrome click does not select the turn; original content still does.
    fireEvent.click(chrome)
    expect(onTurnClick).not.toHaveBeenCalled()
    fireEvent.click(container.querySelector('[data-testid="body-g-user"]') as HTMLElement)
    expect(onTurnClick).toHaveBeenCalledTimes(1)
    expect(onTurnClick).toHaveBeenCalledWith('u1', false, false)
  })

  it('keeps chrome in normal mode too (shared rendering, no edit-mode variant)', () => {
    const nodes: FlowNode[] = [segmentedTurn('g-user', { segmentIsFirst: true, segmentIsLast: true })]
    const { container, rerender } = render(
      <>
        {renderEditFlowNodes({
          nodes,
          isEditMode: false,
          renderSegmentChrome: () => <div data-testid="segment-chrome" />
        })}
      </>
    )
    expect(container.querySelector('[data-testid="segment-chrome"]')).not.toBeNull()
    const turn = container.querySelector('[data-testid="edit-turn"]') as HTMLElement
    expect(turn.classList.contains('edit-turn-interactive')).toBe(false)
    expect(turn.querySelector('[data-testid="edit-turn-cover"]')).toBeNull()
    // Toggle edit mode keeps the chrome present.
    rerender(
      <>
        {renderEditFlowNodes({
          nodes,
          isEditMode: true,
          renderSegmentChrome: () => <div data-testid="segment-chrome" />
        })}
      </>
    )
    expect(container.querySelector('[data-testid="segment-chrome"]')).not.toBeNull()
    expect(
      (container.querySelector('[data-testid="segment-chrome"]') as Element).closest('[data-testid="edit-turn"]')
    ).toBeNull()
  })

  it('renders no chrome when no run member belongs to a segment', () => {
    const nodes: FlowNode[] = [
      { kind: 'turn', entry: { ...(segmentedTurn('g-user').entry as FlowBodyEntry), segment: undefined } }
    ]
    const renderChrome = vi.fn()
    render(<>{renderEditFlowNodes({ nodes, isEditMode: true, renderSegmentChrome: renderChrome })}</>)
    expect(renderChrome).not.toHaveBeenCalled()
  })

  it('deriveRunSegmentChrome anchors on the segment-first member and spans run-wide last', () => {
    const run: FlowBodyEntry[] = [
      { ...(segmentedTurn('g-assistant', { segmentIsLast: true }).entry as FlowBodyEntry) },
      { ...(segmentedTurn('g-user', { segmentIsFirst: true }).entry as FlowBodyEntry) }
    ]
    const chrome = deriveRunSegmentChrome(run)
    expect(chrome).not.toBeNull()
    expect(chrome!.isFirst).toBe(true)
    expect(chrome!.isLast).toBe(true)
    expect(chrome!.messageCount).toBe(7)
    expect(chrome!.segment.id).toBe('seg-1')

    const middle: FlowBodyEntry[] = [{ ...(segmentedTurn('g-mid').entry as FlowBodyEntry) }]
    const mid = deriveRunSegmentChrome(middle)
    expect(mid!.isFirst).toBe(false)
    expect(mid!.isLast).toBe(false)
    expect(mid!.messageCount).toBeUndefined()

    expect(
      deriveRunSegmentChrome([{ ...(segmentedTurn('g-user').entry as FlowBodyEntry), segment: undefined }])
    ).toBeNull()
  })
})

describe('segment-homogeneous run invariant', () => {
  const segmentFixture = (overrides: Record<string, unknown> = {}) =>
    ({
      id: 'seg-1',
      topicId: 't1',
      name: 'Seg',
      messageIds: ['u1'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sortOrder: 0,
      firstMessageId: 'u1',
      lastMessageId: 'u1',
      messageCount: 7,
      ...overrides
    }) as any

  const segmentedTurn = (groupKey: string, opts?: Partial<FlowBodyEntry>): FlowNode => ({
    kind: 'turn',
    entry: {
      groupKey,
      turnAskId: opts?.turnAskId ?? 'u1',
      selected: opts?.selected ?? false,
      segmentId: opts?.segmentId ?? 'seg:edit',
      segmentIsLive: opts?.segmentIsLive ?? false,
      kind: opts?.kind ?? 'history',
      layerRunId: opts?.layerRunId ?? 'layer:x',
      segment: opts?.segment,
      segmentIsFirst: opts?.segmentIsFirst,
      segmentIsLast: opts?.segmentIsLast,
      bodyNode: opts?.bodyNode ?? (
        <div
          data-layer-kind="history"
          data-layer-run-id="layer:x"
          data-stable-group-id={groupKey}
          data-testid={`body-${groupKey}`}>
          {groupKey}
        </div>
      )
    }
  })

  const runsOf = (nodes: FlowNode[]): FlowBodyEntry[][] =>
    buildOrderedFlowItems(nodes)
      .filter((i) => i.kind === 'turn-run')
      .map((i) => (i as { run: FlowBodyEntry[] }).run)

  it('splits a same-askId turn at an unsegmented↔segment transition at the assistant subgroup', () => {
    const segA = segmentFixture({ id: 'seg-a' })
    const runs = runsOf([
      segmentedTurn('g-assistant-seg', { turnAskId: 'u1', segment: segA, segmentIsFirst: true, segmentIsLast: true }),
      segmentedTurn('g-user-plain', { turnAskId: 'u1', segment: undefined })
    ])
    expect(runs.length).toBe(2)
    expect(runs[0].map((g) => g.groupKey)).toEqual(['g-assistant-seg'])
    expect(runs[1].map((g) => g.groupKey)).toEqual(['g-user-plain'])
    expect(runs[0][0].segment?.id).toBe('seg-a')
    expect(runs[1][0].segment).toBeUndefined()
  })

  it('keeps first/last flags of one segment in a single run (flags alone never split)', () => {
    const segA = segmentFixture({ id: 'seg-a' })
    const runs = runsOf([
      segmentedTurn('g-assistant', { turnAskId: 'u1', segment: segA, segmentIsLast: true }),
      segmentedTurn('g-user', { turnAskId: 'u1', segment: segA, segmentIsFirst: true })
    ])
    expect(runs.length).toBe(1)
    expect(runs[0].map((g) => g.groupKey)).toEqual(['g-assistant', 'g-user'])
    const chrome = deriveRunSegmentChrome(runs[0])
    expect(chrome!.isFirst).toBe(true)
    expect(chrome!.isLast).toBe(true)
    expect(chrome!.segment.id).toBe('seg-a')
  })

  it('retains one chrome per segment for adjacent same-askId runs in distinct segments (no bleed); selection stays on the shared askId', () => {
    const onTurnClick = vi.fn()
    const segA = segmentFixture({ id: 'seg-a', messageCount: 3 })
    const segB = segmentFixture({ id: 'seg-b', messageCount: 5 })
    const nodes: FlowNode[] = [
      segmentedTurn('g-b', { turnAskId: 'u1', segment: segB, segmentIsLast: true }),
      segmentedTurn('g-a', { turnAskId: 'u1', segment: segA, segmentIsFirst: true })
    ]
    const seen: string[] = []
    const { container } = render(
      <>
        {renderEditFlowNodes({
          nodes,
          isEditMode: true,
          onTurnClick,
          renderSegmentChrome: ({ segment }) => {
            seen.push(segment.id)
            return <div data-testid={`chrome-${segment.id}`} />
          }
        })}
      </>
    )
    // One homogeneous run per segment, each with its own chrome, in flow order.
    expect(seen).toEqual(['seg-b', 'seg-a'])
    expect(container.querySelectorAll('[data-testid="chrome-seg-a"]').length).toBe(1)
    expect(container.querySelectorAll('[data-testid="chrome-seg-b"]').length).toBe(1)
    // No bleed: each chrome sits beside its own turn only.
    const turns = Array.from(container.querySelectorAll('[data-testid="edit-turn"]')) as HTMLElement[]
    const turnA = turns.find((t) => t.querySelector('[data-testid="body-g-a"]')) as HTMLElement
    const turnB = turns.find((t) => t.querySelector('[data-testid="body-g-b"]')) as HTMLElement
    expect(turnA.querySelector('[data-testid="chrome-seg-a"]')).toBeNull()
    expect(turnB.querySelector('[data-testid="chrome-seg-b"]')).toBeNull()
    const hostA = turnA.parentElement as HTMLElement
    const hostB = turnB.parentElement as HTMLElement
    expect(hostA.querySelector('[data-testid="chrome-seg-a"]')).not.toBeNull()
    expect(hostA.querySelector('[data-testid="chrome-seg-b"]')).toBeNull()
    expect(hostB.querySelector('[data-testid="chrome-seg-b"]')).not.toBeNull()
    expect(hostB.querySelector('[data-testid="chrome-seg-a"]')).toBeNull()
    // Selection identity is the shared askId on both runs.
    expect(turnA.getAttribute('data-turn-ask')).toBe('u1')
    expect(turnB.getAttribute('data-turn-ask')).toBe('u1')
    fireEvent.click(container.querySelector('[data-testid="body-g-a"]') as HTMLElement)
    fireEvent.click(container.querySelector('[data-testid="body-g-b"]') as HTMLElement)
    expect(onTurnClick).toHaveBeenNthCalledWith(1, 'u1', false, false)
    expect(onTurnClick).toHaveBeenNthCalledWith(2, 'u1', false, false)
  })

  it('derives distinct stable run ids for adjacent same-askId runs split by segment membership', () => {
    const segA = segmentFixture({ id: 'seg-a' })
    const segB = segmentFixture({ id: 'seg-b' })
    const runs = runsOf([
      segmentedTurn('g-b', { turnAskId: 'u1', segment: segB }),
      segmentedTurn('g-a', { turnAskId: 'u1', segment: segA })
    ])
    expect(runs.length).toBe(2)
    const keys = runs.map((run) => deriveTurnKey(run))
    expect(new Set(keys).size).toBe(2)
    expect(keys[0]).not.toBe(keys[1])
  })

  it('still joins a normal whole-turn run (same segment, same askId) and keeps boundaries split', () => {
    const segA = segmentFixture({ id: 'seg-a' })
    const joined = runsOf([
      segmentedTurn('g-assistant', { turnAskId: 'u1', segment: segA, segmentIsLast: true }),
      segmentedTurn('g-user', { turnAskId: 'u1', segment: segA, segmentIsFirst: true })
    ])
    expect(joined.length).toBe(1)
    expect(joined[0].map((g) => g.groupKey)).toEqual(['g-assistant', 'g-user'])
    const split = buildOrderedFlowItems([
      segmentedTurn('g1', { turnAskId: 'ask-x', segment: segA }),
      {
        kind: 'boundary',
        entry: { boundaryKey: 'b1', boundaryKind: 'fork', node: <div data-testid="div-1" /> }
      },
      segmentedTurn('g2', { turnAskId: 'ask-x', segment: segA })
    ])
    expect(split.filter((i) => i.kind === 'turn-run').length).toBe(2)
  })
})

describe('edit-mode native selection suppression owned by the turn', () => {
  // One segmented run (renders sibling chrome) + one plain turn. The chrome
  // sits beside the turn inside RunHost, never inside it.
  const chromeSegment = { id: 'seg-chrome', topicId: 't1', name: 'Chrome', messageIds: ['u1'], messageCount: 4 } as any

  const suppressionNodes = (): FlowNode[] => [
    {
      kind: 'turn',
      entry: {
        groupKey: 'g-chrome',
        turnAskId: 'ask-chrome',
        selected: false,
        segmentId: 'seg:chrome',
        segmentIsLive: false,
        kind: 'history',
        layerRunId: 'layer:x',
        segment: chromeSegment,
        segmentIsFirst: true,
        segmentIsLast: true,
        bodyNode: bodyDiv('g-chrome')
      }
    },
    turnNode('g-plain', 'ask-plain')
  ]

  function renderFlowWithSiblingChrome(isEditMode: boolean) {
    return render(
      <div>
        <button type="button" data-testid="plain-sibling-control">
          ordinary non-message control
        </button>
        {renderEditFlowNodes({
          nodes: suppressionNodes(),
          isEditMode,
          onTurnClick: vi.fn(),
          renderSegmentChrome: () => (
            <div data-testid="segment-chrome">
              <input data-testid="segment-rename-input" defaultValue="Seg" />
            </div>
          )
        })}
      </div>
    )
  }

  function dispatchSelectStart(el: Element): Event {
    const ev = new Event('selectstart', { bubbles: true, cancelable: true })
    el.dispatchEvent(ev)
    return ev
  }

  it('cancels selectstart inside the edit turn (inert content and cover)', () => {
    const { container } = renderFlowWithSiblingChrome(true)
    const body = container.querySelector('[data-testid="body-g-plain"]') as HTMLElement
    const cover = container.querySelector('[data-testid="edit-turn-cover"]') as HTMLElement
    expect(dispatchSelectStart(body).defaultPrevented).toBe(true)
    expect(dispatchSelectStart(cover).defaultPrevented).toBe(true)
  })

  it('keeps native selectstart on the sibling segment chrome/rename field and ordinary non-message controls', () => {
    const { container } = renderFlowWithSiblingChrome(true)
    const chrome = container.querySelector('[data-testid="segment-chrome"]') as HTMLElement
    const input = container.querySelector('[data-testid="segment-rename-input"]') as HTMLElement
    const sibling = container.querySelector('[data-testid="plain-sibling-control"]') as HTMLElement
    // None of these live inside a turn, so the turn-scoped listener never
    // sees (or cancels) their native selection.
    expect(chrome.closest('[data-testid="edit-turn"]')).toBeNull()
    expect(input.closest('[data-testid="edit-turn"]')).toBeNull()
    for (const el of [chrome, input, sibling]) {
      expect(dispatchSelectStart(el).defaultPrevented).toBe(false)
    }
  })

  it('keeps the native mousedown boundary scoped to the turn, leaving right/secondary and outside untouched', () => {
    const { container } = renderFlowWithSiblingChrome(true)
    const body = container.querySelector('[data-testid="body-g-plain"]') as HTMLElement
    const cover = container.querySelector('[data-testid="edit-turn-cover"]') as HTMLElement
    const sibling = container.querySelector('[data-testid="plain-sibling-control"]') as HTMLElement
    // Primary button inside the turn is blocked (no native range; the click
    // capture still performs group selection).
    expect(fireEvent.mouseDown(body, { button: 0 })).toBe(false)
    expect(fireEvent.mouseDown(cover, { button: 0 })).toBe(false)
    // Secondary button inside the turn is untouched so the batch context
    // menu is preserved.
    expect(fireEvent.mouseDown(cover, { button: 2 })).toBe(true)
    // Primary button outside any turn is untouched.
    expect(fireEvent.mouseDown(sibling, { button: 0 })).toBe(true)
  })

  it('restores native selection on mode exit without remounting the turn or its content', () => {
    const { container, rerender } = render(
      <>{renderEditFlowNodes({ nodes: suppressionNodes(), isEditMode: true, onTurnClick: vi.fn() })}</>
    )
    const turnBefore = container.querySelector('[data-testid="edit-turn"]') as HTMLElement
    const bodyBefore = container.querySelector('[data-testid="body-g-plain"]') as HTMLElement
    expect(dispatchSelectStart(bodyBefore).defaultPrevented).toBe(true)
    expect(fireEvent.mouseDown(bodyBefore, { button: 0 })).toBe(false)

    rerender(<>{renderEditFlowNodes({ nodes: suppressionNodes(), isEditMode: false, onTurnClick: vi.fn() })}</>)
    // Same turn/body node identity: suppression toggles without a remount.
    expect(container.querySelector('[data-testid="edit-turn"]')).toBe(turnBefore)
    expect(container.querySelector('[data-testid="body-g-plain"]')).toBe(bodyBefore)
    // Normal mode: neither selectstart nor mousedown is canceled.
    expect(dispatchSelectStart(bodyBefore).defaultPrevented).toBe(false)
    expect(fireEvent.mouseDown(bodyBefore, { button: 0 })).toBe(true)
  })

  it('attaches the turn selectstart listener in edit mode and detaches it on unmount', () => {
    const addSpy = vi.spyOn(HTMLElement.prototype, 'addEventListener')
    const removeSpy = vi.spyOn(HTMLElement.prototype, 'removeEventListener')
    try {
      const { unmount } = render(
        <>{renderEditFlowNodes({ nodes: suppressionNodes(), isEditMode: true, onTurnClick: vi.fn() })}</>
      )
      const added = addSpy.mock.calls.filter((c) => c[0] === 'selectstart').length
      expect(added).toBeGreaterThan(0)
      unmount()
      const removed = removeSpy.mock.calls.filter((c) => c[0] === 'selectstart').length
      expect(removed).toBeGreaterThanOrEqual(added)
    } finally {
      addSpy.mockRestore()
      removeSpy.mockRestore()
    }
  })
})
