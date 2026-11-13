/**
 * Topic segment chrome — folded (collapsed) presentation.
 *
 * Folding is presentation state on the one existing group entity: no separate
 * collapse entity, no extra entry point, no layout band. The law under test:
 * the chrome host is out of flow in BOTH states (so a collapsed group opens no
 * row height, no padding/min-height and no message-margin accumulation between
 * neighbouring messages), exactly one label per group is painted, and the
 * collapsed label keeps the expanded header's shape while only the former name
 * object becomes the expand target.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { configureStore } from '@reduxjs/toolkit'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, Fragment } from 'react'
import type * as ReactI18nextModule from 'react-i18next'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() }) }
}))

const { updateSegmentMetadataMock, listSegmentsMock } = vi.hoisted(() => ({
  updateSegmentMetadataMock: vi.fn(),
  listSegmentsMock: vi.fn()
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    upsertSegment: vi.fn(),
    updateSegmentMetadata: (...args: any[]) => updateSegmentMetadataMock(...args),
    replaceSegmentMembership: vi.fn(),
    deleteSegment: vi.fn(),
    listSegments: (...args: any[]) => listSegmentsMock(...args)
  }
}))

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactI18nextModule>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: { count?: number }) => (opts && 'count' in opts ? String(opts.count) : key)
    })
  }
})

vi.mock('antd', () => ({
  Input: (props: any) => createElement('input', props),
  Popconfirm: ({ children }: any) => createElement('div', null, children)
}))

vi.mock('@renderer/utils/topicSegmentColor', () => ({
  getSegmentColor: (id: string) => `color-${id}`
}))

import messagesReducer from '@renderer/store/newMessage'
import topicSegmentReducer from '@renderer/store/topicSegment'

import type { FlowNode, RunSegmentChrome } from '../messageEditSelectionLayout'
import { renderEditFlowNodes } from '../messageEditSelectionLayout'
import TopicSegmentLine from '../TopicSegmentLine'

/**
 * Store with the route capability the hook reads: `owner` = every loaded member
 * is mutable through the active (main) route, `readonly` = loaded but immutable
 * (inherited branch group), `unknown` = capability never published. Folding is
 * an owner-only write, so the two non-owner shapes must not offer it.
 */
function setupStore(capability: 'owner' | 'readonly' | 'unknown' = 'owner') {
  const messages = (messagesReducer as any)(undefined, { type: '@@INIT' })
  const mutableIds = capability === 'owner' ? { t1: ['m0', 'm1', 'm2'] } : { t1: [] }
  return configureStore({
    reducer: { topicSegments: topicSegmentReducer, messages: messagesReducer as any },
    preloadedState: {
      messages: {
        ...messages,
        messageIdsByTopic: { t1: ['m0', 'm1', 'm2'] },
        mutableRouteByTopic: capability === 'unknown' ? {} : { t1: null },
        mutableMessageIdsByTopic: mutableIds
      }
    } as any
  } as any)
}

function wrapper(store: ReturnType<typeof setupStore>) {
  return ({ children }: { children: React.ReactNode }) => createElement(Provider, { store, children } as any)
}

const TS = '2026-01-01T00:00:00.000Z'

function makeSegment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'seg-1',
    topicId: 't1',
    name: 'Seg',
    // Loaded membership is windowed (2 ids) while authority count is 7.
    messageIds: ['m1', 'm2'],
    createdAt: TS,
    updatedAt: TS,
    sortOrder: 0,
    firstMessageId: 'm0',
    lastMessageId: 'm6',
    messageCount: 7,
    ...overrides
  } as any
}
/** Zero-flow spacing facts a chrome host must not introduce. */
function expectNoFlowSpacing(el: Element) {
  const cs = window.getComputedStyle(el as HTMLElement)
  for (const value of [cs.padding, cs.paddingTop, cs.paddingBottom, cs.margin, cs.marginTop, cs.marginBottom]) {
    expect(['', '0px']).toContain(value)
  }
  expect(['', 'auto', 'normal', '0px']).toContain(cs.minHeight)
}

/** A label pill keeps its own inner shape; only outer spacing must stay zero. */
function expectNoOuterSpacing(el: Element) {
  const cs = window.getComputedStyle(el as HTMLElement)
  for (const value of [cs.margin, cs.marginTop, cs.marginBottom]) {
    expect(['', '0px']).toContain(value)
  }
  expect(['', 'auto', 'normal', '0px']).toContain(cs.minHeight)
}
describe('TopicSegmentLine folded presentation', () => {
  beforeEach(() => {
    updateSegmentMetadataMock.mockReset().mockResolvedValue(undefined)
    listSegmentsMock.mockReset().mockResolvedValue([])
  })

  it('collapsed label keeps the group-header shape, hides the name, and expands on the former name object', async () => {
    const store = setupStore()
    const segment = makeSegment({ folded: true })
    render(createElement(TopicSegmentLine, { segment, isFirst: true, isLast: false }), {
      wrapper: wrapper(store)
    })

    const line = screen.getByTestId('topic-segment-line')
    expect(line.getAttribute('data-segment-folded')).toBe('true')
    expect(line.getAttribute('data-segment-id')).toBe('seg-1')
    const label = screen.getByTestId('topic-segment-label')
    expect(label.getAttribute('data-segment-folded')).toBe('true')

    // i18n replacement word stands in for the group name (the name itself is
    // still persisted and only surfaces in the hover hint).
    const expand = screen.getByTestId('topic-segment-expand')
    expect(expand.textContent).toBe('topicSegment.folded')
    expect(expand.getAttribute('title')).toBe('Seg · topicSegment.foldedHint')

    // Authority message count stays visible next to the collapsed word.
    expect(screen.getByTestId('topic-segment-count').textContent).toBe('7')

    // No left rule, no collapse hit target, no hover rename/dissolve actions.
    expect(screen.queryByTestId('topic-segment-rule')).toBeNull()
    expect(screen.queryByTestId('topic-segment-fold')).toBeNull()
    expect(screen.queryByTestId('topic-segment-actions')).toBeNull()

    fireEvent.click(expand)
    await waitFor(() => expect(updateSegmentMetadataMock).toHaveBeenCalledTimes(1))
    // Route owner of the fold write is the hook topic's active route (main = null).
    expect(updateSegmentMetadataMock).toHaveBeenCalledWith('seg-1', undefined, undefined, false, null)
  })

  it('chrome host is out of flow in both states (no row height, no spacing band)', () => {
    const store = setupStore()
    for (const folded of [false, true]) {
      const segment = makeSegment({ folded })
      const view = render(createElement(TopicSegmentLine, { segment, isFirst: true, isLast: false, messageCount: 7 }), {
        wrapper: wrapper(store)
      })
      const line = screen.getByTestId('topic-segment-line')
      const cs = window.getComputedStyle(line)
      // Absolute positioning is what keeps the collapsed header from opening a
      // row: the host takes no space in the message flow in either state.
      expect(cs.position).toBe('absolute')
      expect(['', '0px']).toContain(cs.top)
      expect(['', '0px']).toContain(cs.bottom)
      expectNoFlowSpacing(line)
      // The label pill itself adds no spacing to its own host slot.
      expectNoOuterSpacing(screen.getByTestId('topic-segment-label'))
      view.unmount()
    }
  })

  it('collapsed label renders even when the authority first message is outside the mounted window', () => {
    const store = setupStore()
    const segment = makeSegment({ folded: true })
    // isFirst === false (window does not contain the group's first message).
    render(createElement(TopicSegmentLine, { segment, isFirst: false, isLast: false }), {
      wrapper: wrapper(store)
    })
    expect(screen.getByTestId('topic-segment-label')).toBeTruthy()
    expect(screen.getByTestId('topic-segment-count').textContent).toBe('7')
  })

  it('a non-heading expanded run paints only the rule continuation (no second header host)', () => {
    const store = setupStore()
    const segment = makeSegment()
    render(createElement(TopicSegmentLine, { segment, isFirst: false, isLast: true, ownsLabel: false }), {
      wrapper: wrapper(store)
    })
    // The composing flow elects exactly one chrome header per group, so a
    // non-owning run must not paint a second `topic-segment-line` host (which
    // would duplicate the segment id and the fold write target).
    expect(screen.queryByTestId('topic-segment-line')).toBeNull()
    expect(screen.queryByTestId('topic-segment-label')).toBeNull()
    expect(screen.queryByTestId('topic-segment-fold')).toBeNull()
    // The group's vertical line stays continuous through this run.
    const continuation = screen.getByTestId('topic-segment-rule-continuation')
    expect(continuation.getAttribute('data-segment-continuation-id')).toBe('seg-1')
    expect(window.getComputedStyle(continuation.parentElement as HTMLElement).position).toBe('absolute')
    expectNoFlowSpacing(continuation.parentElement as HTMLElement)
  })

  it('a non-heading collapsed run paints nothing at all (no seam duplicate)', () => {
    const store = setupStore()
    const segment = makeSegment({ folded: true })
    const view = render(createElement(TopicSegmentLine, { segment, isFirst: false, isLast: false, ownsLabel: false }), {
      wrapper: wrapper(store)
    })
    expect(view.container.querySelector('*')).toBeNull()
    expect(screen.queryByTestId('topic-segment-line')).toBeNull()
    expect(screen.queryByTestId('topic-segment-label')).toBeNull()
    expect(screen.queryByTestId('topic-segment-rule-continuation')).toBeNull()
  })

  it('cascades coincident collapsed labels by a fixed horizontal slot', () => {
    const store = setupStore()
    const segment = makeSegment({ folded: true })
    const cascadeSlot = (index: number) => {
      const view = render(
        createElement(TopicSegmentLine, { segment, isFirst: false, isLast: false, stackIndex: index }),
        {
          wrapper: wrapper(store)
        }
      )
      const slot = screen.getByTestId('topic-segment-label').getAttribute('data-segment-cascade')
      view.unmount()
      return slot
    }
    // Slot 0 stays on the seam; later coincident labels shift by the fixed
    // horizontal slot so each remains identifiable without any vertical
    // footprint (jsdom cannot measure the pixel shift — the slot value is the
    // behavioural unit; geometry is verified in the UI observation pass).
    expect(cascadeSlot(0)).toBe('0')
    expect(cascadeSlot(1)).toBe('1')
    expect(cascadeSlot(2)).toBe('2')
  })

  it('expanded state: only the left rule folds, the name still renames, the count stays inert', async () => {
    const store = setupStore()
    const segment = makeSegment()
    render(createElement(TopicSegmentLine, { segment, isFirst: true, isLast: false, messageCount: 7 }), {
      wrapper: wrapper(store)
    })

    // Expanded: no collapsed word, rule + hit target + hover actions present.
    expect(screen.queryByTestId('topic-segment-expand')).toBeNull()
    expect(screen.getByTestId('topic-segment-rule')).toBeTruthy()
    expect(screen.getByTestId('topic-segment-actions')).toBeTruthy()
    expect(screen.getByTestId('topic-segment-line').getAttribute('data-segment-folded')).toBe('false')

    // Only the left rule's hit target collapses the group.
    fireEvent.click(screen.getByTestId('topic-segment-fold'))
    await waitFor(() => expect(updateSegmentMetadataMock).toHaveBeenCalledTimes(1))
    expect(updateSegmentMetadataMock).toHaveBeenCalledWith('seg-1', undefined, undefined, true, null)

    // The group name remains the rename target (Edit opens, no metadata write).
    fireEvent.click(screen.getByText('Seg'))
    expect(screen.getByDisplayValue('Seg')).toBeTruthy()
    expect(updateSegmentMetadataMock).toHaveBeenCalledTimes(1)

    // The count never gains a click behavior of its own.
    fireEvent.click(screen.getByTestId('topic-segment-count'))
    expect(updateSegmentMetadataMock).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('topic-segment-expand')).toBeNull()
  })

  it('folded bodies leave the mounted flow without touching the window/pagination slice', () => {
    const src = readFileSync(join(process.cwd(), 'src/renderer/src/pages/home/Messages/Messages.tsx'), 'utf8')
    // The exclusion derives from the authority segment catalog, never from a loaded window.
    expect(src).toContain('for (const segment of segmentsForTopic)')
    expect(src).toContain('if (segment.folded !== true) continue')
    // Applied only to the rendered group bodies; run entries keep the group so
    // its chrome (collapsed label) still renders at the seam.
    expect(src).toContain('groupMessages.filter((message) => !foldedMessageIds.has(message.id))')
    // The settled folded body still mounts no rows: the fold flag is forwarded
    // to the motion owner, whose `closed` presentation renders nothing at rest.
    expect(src).toContain('folded={visibleMessages.length === 0}')
    const motionSrc = readFileSync(
      join(process.cwd(), 'src/renderer/src/pages/home/Messages/SegmentFoldTransition.tsx'),
      'utf8'
    )
    // The one exception is the flow-terminal group, which reserves the minimal
    // label slot so its collapsed pill stays inside the scrollport; every other
    // folded group settles to nothing at all.
    expect(motionSrc).toContain('if (!tailSlot) return null')
    expect(motionSrc).toContain('data-segment-fold-tail-slot')
    // A closing (retained) body is presentation-only: it is inert and it holds
    // the registry channel that owns no anchor, so a disappearing row can never
    // become a persisted reading anchor.
    expect(motionSrc).toContain('export const presentationOnlyMessageElementRegistrar')
    expect(src).toContain('inert ? presentationOnlyMessageElementRegistrar : registerMessageElement')
    expect(src).toContain('onGroupClick={inert ? undefined : handleGroupClick}')
    // Tail reservation is derived from the stable flow order plus the authority
    // window fact, never from scroll position or a measured DOM box.
    expect(src).toContain('const tailSlot = flowBottom && !hasMoreNewer && visibleMessages.length === 0')
    // The collapsed label is forwarded the run-level composition identities.
    expect(src).toContain('ownsLabel={ownsLabel}')
    expect(src).toContain('stackIndex={stackIndex}')
    // No phantom row/spacing placeholder is mounted for a fully folded group.
    expect(src).not.toContain('folded-placeholder')
  })

  it('an inherited/read-only group renders the label but offers no fold write', async () => {
    for (const capability of ['readonly', 'unknown'] as const) {
      const store = setupStore(capability)
      const segment = makeSegment()
      const view = render(createElement(TopicSegmentLine, { segment, isFirst: true, isLast: false, messageCount: 7 }), {
        wrapper: wrapper(store)
      })
      // No fold hit target: the write would remove the group from request
      // context, so it is owner-only (zero IPC on a read-only route).
      expect(screen.queryByTestId('topic-segment-fold')).toBeNull()
      expect(screen.getByTestId('topic-segment-rule')).toBeTruthy()
      view.unmount()
      const foldedSegment = makeSegment({ folded: true })
      const foldedView = render(
        createElement(TopicSegmentLine, { segment: foldedSegment, isFirst: true, isLast: false }),
        { wrapper: wrapper(setupStore(capability)) }
      )
      const expand = screen.getByTestId('topic-segment-expand')
      expect(expand.getAttribute('aria-disabled')).toBe('true')
      fireEvent.click(expand)
      expect(updateSegmentMetadataMock).not.toHaveBeenCalled()
      foldedView.unmount()
    }
  })

  it('the chrome host carries the segment-header interaction region in both states', () => {
    const store = setupStore()
    for (const folded of [false, true]) {
      const segment = makeSegment({ folded })
      const view = render(createElement(TopicSegmentLine, { segment, isFirst: true, isLast: false, messageCount: 7 }), {
        wrapper: wrapper(store)
      })
      // The fold/expand gesture holds the HEADER stationary, so the region
      // annotation must sit on the host that exists in BOTH presentation
      // states at the seam — never on the collapse hit target or the expand
      // word, each of which only exists in one of the two states.
      const line = screen.getByTestId('topic-segment-line')
      expect(line.getAttribute('data-interaction-region')).toBe('segment-header')
      expect(view.container.querySelectorAll('[data-interaction-region="segment-header"]').length).toBe(1)
      view.unmount()
    }
  })

  /**
   * Production wiring: the flow composition elects ONE chrome header per
   * segment. A group whose members split across two turn runs (the real
   * cause: an assistant row without `askId` derives a different turn id than
   * its user row, and a divider or a viewport-partial membership does the
   * same) must still expose exactly one `topic-segment-line` host, one label
   * and one fold write target — that is the locator contract the E2E assets
   * rely on. Rule-only continuation keeps the line unbroken.
   */
  describe('one chrome header per group across split runs (production wiring)', () => {
    const splitNodes = (segment: any, folded: boolean): FlowNode[] => {
      const bodyNode = (groupKey: string) =>
        folded ? null : createElement('div', { 'data-testid': `body-${groupKey}` }, groupKey)
      return [
        // Newest member: assistant row of the same Q&A turn, no shared askId.
        {
          kind: 'turn',
          entry: {
            groupKey: 'g-assistant',
            turnAskId: 'a1',
            selected: false,
            segmentId: 'seg:fold',
            segmentIsLive: false,
            kind: 'history',
            layerRunId: 'layer:x',
            segment,
            segmentIsFirst: false,
            segmentIsLast: true,
            bodyNode: bodyNode('g-assistant')
          }
        },
        // Oldest member: the group's authority first message.
        {
          kind: 'turn',
          entry: {
            groupKey: 'g-user',
            turnAskId: 'u1',
            selected: false,
            segmentId: 'seg:fold',
            segmentIsLive: false,
            kind: 'history',
            layerRunId: 'layer:x',
            segment,
            segmentIsFirst: true,
            segmentIsLast: false,
            bodyNode: bodyNode('g-user')
          }
        }
      ]
    }

    const renderChrome = ({ segment, isFirst, isLast, ownsLabel, stackIndex }: RunSegmentChrome) =>
      createElement(TopicSegmentLine, {
        segment,
        isFirst,
        isLast,
        ownsLabel,
        stackIndex,
        // Mirrors Messages.tsx: the count rides only the group-first run.
        messageCount: isFirst ? segment.messageCount : undefined
      })

    const renderSplit = (segment: any, folded: boolean) =>
      renderEditFlowNodes({
        nodes: splitNodes(segment, folded),
        isEditMode: false,
        renderSegmentChrome: renderChrome
      })

    it('expanded: two runs, one header host, one label, one fold target, unbroken rule', () => {
      const store = setupStore()
      const segment = makeSegment()
      const view = render(createElement(Fragment, null, ...renderSplit(segment, false)), {
        wrapper: wrapper(store)
      })
      expect(view.container.querySelectorAll('[data-testid="topic-segment-line"]').length).toBe(1)
      expect(view.container.querySelectorAll('[data-segment-id="seg-1"]').length).toBe(1)
      expect(view.container.querySelectorAll('[data-testid="topic-segment-label"]').length).toBe(1)
      expect(view.container.querySelectorAll('[data-testid="topic-segment-fold"]').length).toBe(1)
      expect(view.container.querySelectorAll('[data-testid="topic-segment-rule"]').length).toBe(1)
      expect(view.container.querySelectorAll('[data-testid="topic-segment-rule-continuation"]').length).toBe(1)
      // The single header sits on the group's own first member run, not on the
      // newest split run.
      const header = view.container.querySelector('[data-testid="topic-segment-line"]') as HTMLElement
      const holdingTurn = header.parentElement!.querySelector('[data-testid="edit-turn"]') as HTMLElement
      expect(holdingTurn.querySelector('[data-testid="body-g-user"]')).not.toBeNull()
      // Rename stays on the name object of the one header.
      fireEvent.click(screen.getByText('Seg'))
      expect(screen.getByDisplayValue('Seg')).toBeTruthy()
      expect(updateSegmentMetadataMock).not.toHaveBeenCalled()
    })

    it('collapsed: two runs, one pill on the seam, no continuation rule, no duplicate target', () => {
      const store = setupStore()
      const segment = makeSegment({ folded: true })
      const view = render(createElement(Fragment, null, ...renderSplit(segment, true)), {
        wrapper: wrapper(store)
      })
      expect(view.container.querySelectorAll('[data-testid="topic-segment-line"]').length).toBe(1)
      expect(view.container.querySelectorAll('[data-segment-id="seg-1"]').length).toBe(1)
      expect(view.container.querySelectorAll('[data-testid="topic-segment-label"]').length).toBe(1)
      expect(view.container.querySelectorAll('[data-testid="topic-segment-fold"]').length).toBe(0)
      expect(view.container.querySelectorAll('[data-segment-continuation-id="seg-1"]').length).toBe(0)
      // Expand target exists exactly once on the single pill.
      expect(view.container.querySelectorAll('[data-testid="topic-segment-expand"]').length).toBe(1)
      expect(screen.getByTestId('topic-segment-count').textContent).toBe('7')
    })

    it('divider-split expanded group still paints one header and one continuation', () => {
      const store = setupStore()
      const segment = makeSegment()
      const entry = (groupKey: string, extra: Record<string, unknown>) => ({
        groupKey,
        turnAskId: 'u1',
        selected: false,
        segmentId: 'seg:fold',
        segmentIsLive: false,
        kind: 'history' as const,
        layerRunId: 'layer:x',
        segment,
        bodyNode: createElement('div', { 'data-testid': `body-${groupKey}` }, groupKey),
        ...extra
      })
      const view = render(
        createElement(
          Fragment,
          null,
          ...renderEditFlowNodes({
            nodes: [
              { kind: 'turn', entry: entry('g-newer', { segmentIsLast: true }) },
              {
                kind: 'boundary',
                entry: {
                  boundaryKey: 'b1',
                  boundaryKind: 'fork',
                  node: createElement('div', { 'data-testid': 'div-1' })
                }
              },
              { kind: 'turn', entry: entry('g-older', { segmentIsFirst: true }) }
            ],
            isEditMode: false,
            renderSegmentChrome: renderChrome
          })
        ),
        { wrapper: wrapper(store) }
      )
      expect(view.container.querySelectorAll('[data-testid="topic-segment-line"]').length).toBe(1)
      expect(view.container.querySelectorAll('[data-testid="topic-segment-label"]').length).toBe(1)
      expect(view.container.querySelectorAll('[data-testid="topic-segment-fold"]').length).toBe(1)
      expect(view.container.querySelectorAll('[data-testid="topic-segment-rule-continuation"]').length).toBe(1)
    })
    it('only the elected header run carries the segment interaction scope id', () => {
      const store = setupStore()
      for (const folded of [false, true]) {
        const segment = makeSegment(folded ? { folded: true } : {})
        const view = render(createElement(Fragment, null, ...renderSplit(segment, folded)), {
          wrapper: wrapper(store)
        })
        const header = view.container.querySelector('[data-testid="topic-segment-line"]') as HTMLElement
        // The structural scope owner of the fold gesture is the RUN host (it
        // spans the chrome host AND the turn bodies, so it survives the fold),
        // and exactly one run per segment carries it — the elected header run.
        const turns = Array.from(view.container.querySelectorAll('[data-testid="edit-turn"]'))
        const runs = turns.map((t) => t.parentElement as HTMLElement)
        expect(runs.some((r) => r.contains(header))).toBe(true)
        expect(runs.filter((r) => r.getAttribute('data-interaction-scope-id') === 'seg-1').length).toBe(1)
        expect((runs.find((r) => r.contains(header)) as HTMLElement).getAttribute('data-interaction-scope-id')).toBe(
          'seg-1'
        )
        view.unmount()
      }
    })

    it('left-rule hover brightens only: no background band, no shadow/glow, no color shift', () => {
      const chromeSrc = readFileSync(
        join(process.cwd(), 'src/renderer/src/pages/home/Messages/TopicSegmentLine.tsx'),
        'utf8'
      )
      // The 8px transparent click target paints nothing in any state.
      expect(chromeSrc).toContain('background: transparent')
      expect(chromeSrc, 'no hover background band over the message column').not.toContain('background-color: color-mix')
      expect(chromeSrc, 'no shadow on the hit target').not.toContain('box-shadow')
      expect(chromeSrc, 'no glow/drop-shadow on the hit target').not.toContain('drop-shadow')
      // The hover/focus affordance is a brightness-only filter on the RULE.
      expect(chromeSrc, 'the rule brightens on hover').toContain('filter: brightness(1.35)')
      expect(chromeSrc, 'the color system is never shifted (no saturation change)').not.toContain('saturate(')
      expect(chromeSrc).toContain(":has([data-testid='topic-segment-fold']:hover)")
      expect(chromeSrc).toContain(":has([data-testid='topic-segment-fold']:focus-visible)")
      // The transparent target keeps its 8px hit area and its keyboard focus ring.
      expect(chromeSrc).toContain('width: 8px')
      expect(chromeSrc).toContain('outline: 2px solid var(--color-primary)')
      // The group-name rename object and the folded expand target are untouched.
      expect(chromeSrc).toContain('onClick={handleStartEdit}')
      expect(chromeSrc).toContain('onClick={canFold ? handleExpand : undefined}')
    })
  })
})
