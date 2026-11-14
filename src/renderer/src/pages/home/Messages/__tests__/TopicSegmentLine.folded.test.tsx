/**
 * Topic-segment group boundary — one group owns header, boundary and interaction.
 *
 * The law under test: a mounted topic-segment group is ONE presentation entity
 * no matter how many turn runs carry it. It owns exactly one in-flow header row
 * (the same occupied row in both presentation states, so adjacent groups can
 * never overlap and no label cascades), exactly one continuous rail with one
 * interaction surface, exactly one group menu and one groupwide hover.
 */
import { configureStore } from '@reduxjs/toolkit'
import type * as EventServiceModule from '@renderer/services/EventService'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, Fragment } from 'react'
import type * as ReactI18nextModule from 'react-i18next'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() }) }
}))

const {
  updateSegmentMetadataMock,
  listSegmentsMock,
  deleteSegmentMock,
  emitMock,
  dropdownState,
  popoverState,
  popconfirmState
} = vi.hoisted(() => ({
  updateSegmentMetadataMock: vi.fn(),
  listSegmentsMock: vi.fn(),
  deleteSegmentMock: vi.fn(),
  emitMock: vi.fn(),
  // The group menu is reached through antd's Dropdown; the stub records the
  // props so tests can inspect the items and drive them (the real popup is
  // portaled to body and is not part of this component's DOM). It also
  // mirrors the trigger's own gesture contract for `trigger: ['contextMenu']`
  // (see the Dropdown mock below), so the anchor input is observable.
  dropdownState: {
    items: [] as Array<Record<string, any>>,
    opens: 0,
    open: false,
    onOpenChange: null as null | ((open: boolean) => void),
    /** The pointer the trigger host observed for the last context gesture. */
    pointer: null as null | { x: number; y: number }
  },
  // Rename is ONE controlled anchored Popover; dissolve is a `Popconfirm`
  // (the header's literal one plus the pointer-anchored menu one). The stubs
  // record the props of each so tests can assert arrow/open/placement and drive
  // ok/cancel without any portal.
  popoverState: {
    props: null as null | Record<string, any>
  },
  popconfirmState: {
    byTrigger: new Map<string, Record<string, any>>()
  }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    upsertSegment: vi.fn(),
    updateSegmentMetadata: (...args: any[]) => updateSegmentMetadataMock(...args),
    replaceSegmentMembership: vi.fn(),
    deleteSegment: (...args: any[]) => deleteSegmentMock(...args),
    listSegments: (...args: any[]) => listSegmentsMock(...args)
  }
}))

// Navigation is the drawer's own channel: the group menu emits the SAME event
// with the SAME payload, so the test spies on the one emitter rather than
// asserting a second navigation mechanism.
vi.mock('@renderer/services/EventService', async (importOriginal) => {
  const actual = await importOriginal<typeof EventServiceModule>()
  // `emit` is shadowed by the spy.
  const emitter = Object.create(actual.EventEmitter)
  emitter.emit = (...args: any[]) => emitMock(...args)
  return { ...actual, EventEmitter: emitter }
})

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactI18nextModule>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: { count?: number }) => (opts && 'count' in opts ? String(opts.count) : key)
    })
  }
})

vi.mock('antd', () => {
  /**
   * Identity of the trigger child one overlay wraps: a DOM test id, the
   * `testId` prop of this file's own anchor pin, or the trigger's title.
   */
  const triggerKey = (children: any): string =>
    (children?.props?.['data-testid'] as string | undefined) ??
    (children?.props?.testId as string | undefined) ??
    (children?.props?.title as string | undefined) ??
    'unknown'

  return {
    // The group menu is a context-menu Dropdown: the stub records the items and
    // renders the child (no extra DOM level, since the real trigger clones the
    // child rather than wrapping it). The popup itself lives in a portal in the
    // real app, so tests drive the recorded items directly.
    //
    // It also reproduces rc-trigger's merge for `trigger: ['contextMenu']`: the
    // trigger host observes the gesture and its pointer FIRST (that point is
    // what antd anchors the popup to), then the child's own handler runs. A
    // handler below this host that stopped the gesture would never reach it and
    // the popup would fall back to the (possibly offscreen) child geometry.
    Dropdown: ({ children, menu, open, onOpenChange }: any) => {
      dropdownState.items = menu?.items ?? []
      dropdownState.opens += 1
      dropdownState.open = open === true
      dropdownState.onOpenChange = onOpenChange ?? null
      if (!children) return null
      return createElement(children.type, {
        ...children.props,
        onContextMenu: (event: React.MouseEvent) => {
          dropdownState.pointer = { x: event.clientX, y: event.clientY }
          onOpenChange?.(true)
          children.props.onContextMenu?.(event)
        }
      })
    },
    // Rename: ONE controlled anchored Popover. Its content is mounted only
    // while open, exactly like the real portal, and the recorded props are what
    // a test asserts on (arrow/open/placement).
    Popover: (props: any) => {
      popoverState.props = props
      return createElement(
        Fragment,
        null,
        props.children,
        props.open === true ? createElement('div', { 'data-testid': 'antd-popover-surface' }, props.content) : null
      )
    },
    // Dissolve: `Popconfirm`. The trigger child renders inline (the real
    // component clones it) and the confirmation body appears while open. The
    // header's literal one is uncontrolled (`open === undefined`); the menu one
    // is controlled and must report itself open with the app's own wording.
    Popconfirm: (props: any) => {
      popconfirmState.byTrigger.set(triggerKey(props.children), props)
      return createElement(
        Fragment,
        null,
        props.children,
        props.open === true
          ? createElement(
              'div',
              { 'data-testid': 'antd-popconfirm-surface' },
              createElement('div', { 'data-testid': 'antd-popconfirm-title' }, props.title),
              createElement(
                'button',
                {
                  type: 'button',
                  key: 'cancel',
                  onClick: () => {
                    props.onCancel?.()
                    props.onOpenChange?.(false)
                  }
                },
                props.cancelText
              ),
              createElement(
                'button',
                {
                  type: 'button',
                  key: 'ok',
                  onClick: () => {
                    props.onConfirm?.()
                    props.onOpenChange?.(false)
                  }
                },
                props.okText
              )
            )
          : null
      )
    },
    // One-line rename field: Enter mirrors `onPressEnter`; focus/select stay
    // DOM behaviour, which is what the surface drives on open.
    Input: ({ onPressEnter, size, ref, ...rest }: any) =>
      createElement('input', {
        ...rest,
        ref,
        onKeyDown: (event: any) => {
          rest.onKeyDown?.(event)
          if (event.key === 'Enter') onPressEnter?.(event)
        }
      }),
    Button: ({ size, type, danger, ...rest }: any) => createElement('button', { ...rest, type: 'button' })
  }
})

vi.mock('@renderer/utils/topicSegmentColor', () => ({
  getSegmentColor: (id: string) => `color-${id}`
}))
import {
  CONFIRM_POPOVER_CLASS_NAME,
  CONFIRM_POPOVER_INNER_PADDING_PX,
  CONFIRM_POPOVER_MAX_WIDTH_CSS,
  CONFIRM_POPOVER_MIN_WIDTH_CSS
} from '@renderer/components/ConfirmPopover'
import { EVENT_NAMES } from '@renderer/services/EventService'
import messagesReducer from '@renderer/store/newMessage'
import topicSegmentReducer from '@renderer/store/topicSegment'

import type { FlowNode } from '../messageEditSelectionLayout'
import { renderEditFlowNodes } from '../messageEditSelectionLayout'
import { SEGMENT_FOLD_MOTION_MS } from '../SegmentFoldTransition'
import { SEGMENT_GROUP_HEADER_HEIGHT_PX } from '../SegmentGroupPresentation'
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

/** A group's own spacing facts: the header row adds no padding/margin band. */
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

/**
 * Rules the component CSS declares for a given element's own classes: one
 * render (or one capability) never borrows another's rules, so a style
 * assertion is always about the element it was made for.
 */
function ownRules(element: HTMLElement): string[] {
  const css = Array.from(document.querySelectorAll('style'))
    .map((node) => node.textContent ?? '')
    .join('\n')
    .replace(/\s+/g, '')
  return (css.match(/[^{}]+\{[^}]*\}/g) ?? []).filter((rule) =>
    Array.from(element.classList).some((name) => rule.includes(`.${name}`))
  )
}

/** A folded group of the given route capability. */
function renderFolded(capability: 'owner' | 'readonly' | 'unknown' = 'owner') {
  return render(
    createElement(TopicSegmentLine, {
      segment: makeSegment({ folded: true }),
      isFirst: true,
      isLast: true,
      messageCount: 7
    }),
    { wrapper: wrapper(setupStore(capability)) }
  )
}

describe('TopicSegmentLine group boundary', () => {
  beforeEach(() => {
    updateSegmentMetadataMock.mockReset().mockResolvedValue(undefined)
    listSegmentsMock.mockReset().mockResolvedValue([])
    deleteSegmentMock.mockReset().mockResolvedValue(undefined)
    emitMock.mockReset().mockResolvedValue(undefined)
    dropdownState.items = []
    dropdownState.opens = 0
    dropdownState.open = false
    dropdownState.onOpenChange = null
    dropdownState.pointer = null
    window.modal = { confirm: vi.fn() } as any
    // Both group action surfaces are anchored overlays; tests reset their
    // recorded props so each case observes only its own render.
    popoverState.props = null
    popconfirmState.byTrigger.clear()
  })

  /** Keys of the group context menu, in render order. */
  function menuKeys(): string[] {
    return dropdownState.items.map((item) => String(item.key))
  }
  type Box = { left: number; right: number; top: number; bottom: number }

  /** A real DOM node with the viewport rect the portal painted. */
  function withRect<T extends HTMLElement>(element: T, rect: Box): T {
    Object.defineProperty(element, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: rect.left,
        y: rect.top,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
        toJSON: () => ({})
      })
    })
    return element
  }

  /**
   * The menu-item click payload antd hands an item's `onClick`. The row lives
   * INSIDE the menu list that painted it, exactly like the portal the app reads
   * before the menu unmounts: the group action anchors itself on the WHOLE
   * visible menu box, of which `row` is only one line.
   */
  function menuActionClick(menu: Box, row: Box) {
    const menuBox = withRect(document.createElement('div'), menu)
    menuBox.className = 'ant-dropdown-menu'
    const item = withRect(document.createElement('div'), row)
    item.className = 'ant-dropdown-menu-item'
    menuBox.appendChild(item)
    return { key: 'action', keyPath: ['action'], item: null, domEvent: { currentTarget: item, target: item } }
  }

  it('expanded: one in-flow header row owns the label, the rail and the fold target', async () => {
    const store = setupStore()
    const segment = makeSegment()
    const view = render(createElement(TopicSegmentLine, { segment, isFirst: true, isLast: false, messageCount: 7 }), {
      wrapper: wrapper(store)
    })

    const header = screen.getByTestId('topic-segment-group')
    expect(header.getAttribute('data-segment-id')).toBe('seg-1')
    expect(header.getAttribute('data-segment-folded')).toBe('false')
    // The row is IN NORMAL FLOW: one occupied row, no absolute seam paint.
    const cs = window.getComputedStyle(header)
    expect(cs.position).toBe('relative')
    expect(cs.height).toBe(`${SEGMENT_GROUP_HEADER_HEIGHT_PX}px`)
    expectNoFlowSpacing(header)
    expectNoOuterSpacing(screen.getByTestId('topic-segment-label'))

    // One pill, one continuous rail (with its one rule), one fold target.
    expect(screen.queryAllByTestId('topic-segment-label')).toHaveLength(1)
    expect(view.container.querySelectorAll('[data-testid="topic-segment-rail"]')).toHaveLength(1)
    expect(view.container.querySelectorAll('[data-testid="topic-segment-rule"]')).toHaveLength(1)
    expect(view.container.querySelectorAll('[data-testid="topic-segment-fold"]')).toHaveLength(1)
    expect(screen.getByTestId('topic-segment-actions')).toBeTruthy()
    expect(screen.queryByTestId('topic-segment-expand')).toBeNull()

    // The rail's transparent hit target collapses through the one authority
    // write (DB-first, route-scoped).
    fireEvent.click(screen.getByTestId('topic-segment-fold'))
    await waitFor(() => expect(updateSegmentMetadataMock).toHaveBeenCalledTimes(1))
    expect(updateSegmentMetadataMock).toHaveBeenCalledWith('seg-1', undefined, undefined, true, null)

    // The group name is an INLINE rename entrance: the pill's own label becomes
    // a one-line editor in place (no popup, no write from opening).
    fireEvent.click(screen.getByText('Seg'))
    expect(popoverState.props?.open ?? false, 'the pill rename opens no popover').toBe(false)
    const inline = screen.getByTestId('topic-segment-rename-inline') as HTMLInputElement
    expect(inline.value).toBe('Seg')
    expect(updateSegmentMetadataMock).toHaveBeenCalledTimes(1)

    // The count never gains a click behavior of its own.
    fireEvent.click(screen.getByTestId('topic-segment-count'))
    expect(updateSegmentMetadataMock).toHaveBeenCalledTimes(1)

    // Expanded, the pill is a plain label: neither its background nor its count
    // is a fold target (the rail is the group's only collapse gesture).
    fireEvent.click(screen.getByTestId('topic-segment-label'))
    expect(screen.getByTestId('topic-segment-label').getAttribute('role')).toBeNull()
    expect(updateSegmentMetadataMock).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('folded: the same occupied header row stays, the body owns no slot and the rail fades out', async () => {
    const store = setupStore()
    const segment = makeSegment({ folded: true })
    const view = render(createElement(TopicSegmentLine, { segment, isFirst: true, isLast: true, messageCount: 7 }), {
      wrapper: wrapper(store)
    })

    const header = screen.getByTestId('topic-segment-group')
    expect(header.getAttribute('data-segment-folded')).toBe('true')
    // Fixed header occupancy: identical row height in both states, so a
    // collapsed group never leaves a seam or a blank band behind.
    expect(window.getComputedStyle(header).height).toBe(`${SEGMENT_GROUP_HEADER_HEIGHT_PX}px`)

    // i18n replacement word stands in for the group name (the name itself is
    // still persisted and only surfaces in the hover hint).
    const expand = screen.getByTestId('topic-segment-expand')
    expect(expand.textContent).toBe('topicSegment.folded')
    expect(expand.getAttribute('title')).toBe('Seg · topicSegment.foldedHint')
    expect(screen.getByTestId('topic-segment-count').textContent).toBe('7')

    // The rail keeps its place but fades on the shared window (chrome never
    // switches a frame before the content it belongs to), so a folded group
    // offers no fold hit target and no hover rename/dissolve actions.
    expect(window.getComputedStyle(screen.getByTestId('topic-segment-rule')).opacity).toBe('0')
    expect(screen.queryByTestId('topic-segment-fold')).toBeNull()
    expect(screen.queryByTestId('topic-segment-actions')).toBeNull()

    fireEvent.click(expand)
    await waitFor(() => expect(updateSegmentMetadataMock).toHaveBeenCalledTimes(1))
    expect(updateSegmentMetadataMock).toHaveBeenCalledWith('seg-1', undefined, undefined, false, null)
    view.unmount()
  })

  it('folded: the WHOLE label pill is one expand target — word, count and background dispatch a single write', async () => {
    // Every part of the folded label is clicked on its own mount, so a second
    // dispatch from a child (the word used to own the click) would show up as
    // a second authority write.
    // The folded dot takes no layout (see the inset test below), so the folded
    // label's clickable regions are its visible parts: the word, the count and
    // the pill's own background.
    const parts: Array<[string, () => HTMLElement]> = [
      ['pill background', () => screen.getByTestId('topic-segment-label')],
      ['folded word', () => screen.getByTestId('topic-segment-expand')],
      ['count', () => screen.getByTestId('topic-segment-count')]
    ]
    for (const [label, partOf] of parts) {
      updateSegmentMetadataMock.mockClear()
      const view = renderFolded()
      fireEvent.click(partOf())
      await waitFor(() => expect(updateSegmentMetadataMock, `${label} expands once`).toHaveBeenCalledTimes(1))
      expect(updateSegmentMetadataMock).toHaveBeenCalledWith('seg-1', undefined, undefined, false, null)
      view.unmount()
    }
  })

  it('folded: the pill is the single tab stop and Enter/Space expand through the same write', async () => {
    const view = renderFolded()
    const pill = screen.getByTestId('topic-segment-label')
    // The tab stop and the semantics live on the pill, never on the word (that
    // would be a second, nested target) and never on the count.
    expect(pill.getAttribute('role')).toBe('button')
    expect(pill.getAttribute('tabindex')).toBe('0')
    expect(pill.getAttribute('aria-label')).toBe('topicSegment.expand · Seg')
    expect(screen.getByTestId('topic-segment-expand').getAttribute('role')).toBeNull()
    expect(screen.getByTestId('topic-segment-count').getAttribute('role')).toBeNull()

    pill.focus()
    expect(document.activeElement).toBe(pill)
    fireEvent.keyDown(pill, { key: 'Enter' })
    await waitFor(() => expect(updateSegmentMetadataMock).toHaveBeenCalledTimes(1))
    expect(updateSegmentMetadataMock).toHaveBeenCalledWith('seg-1', undefined, undefined, false, null)
    // Space is the same one dispatch from the same target.
    fireEvent.keyDown(pill, { key: ' ' })
    await waitFor(() => expect(updateSegmentMetadataMock).toHaveBeenCalledTimes(2))
    view.unmount()
  })

  it('folded: pill hover promises the expand — pointer over the whole pill and an underline on the word — and a read-only pill promises neither', () => {
    const writableView = renderFolded()
    const pill = screen.getByTestId('topic-segment-label')
    const word = screen.getByTestId('topic-segment-expand')
    expect(window.getComputedStyle(pill).cursor).toBe('pointer')
    // so hovering the count, the word or the pill's own background underlines
    // the same word; it is not a rule of the word's own hover.
    const underlineRule = ownRules(word).find((rule) => rule.includes('text-decoration:underline'))
    expect(underlineRule, 'the folded word underlines').toBeDefined()
    const pillClasses = Array.from(pill.classList)
    expect(pillClasses.some((name) => underlineRule!.includes(`.${name}:hover`))).toBe(true)
    expect(pillClasses.some((name) => underlineRule!.includes(`.${name}:focus-visible`))).toBe(true)
    writableView.unmount()

    const readOnlyView = renderFolded('readonly')
    const readOnlyPill = screen.getByTestId('topic-segment-label')
    const readOnlyWord = screen.getByTestId('topic-segment-expand')
    // No write means no promise: the plain arrow cursor and no underline rule.
    expect(window.getComputedStyle(readOnlyPill).cursor).toBe('default')
    expect(ownRules(readOnlyWord).some((rule) => rule.includes('text-decoration:underline'))).toBe(false)
    const readOnlyUnderline = ownRules(readOnlyWord).find((rule) => rule.includes('text-decoration:none'))
    expect(readOnlyUnderline, 'the read-only word declares no underline').toBeDefined()
    readOnlyView.unmount()
  })

  it('folded: the tint dot leaves the layout, so the folded label is dotless and the word starts at the pill inset', () => {
    const foldedView = renderFolded()
    const pill = screen.getByTestId('topic-segment-label')
    const content = pill.firstElementChild as HTMLElement
    const dot = content.firstElementChild as HTMLElement
    const word = screen.getByTestId('topic-segment-expand')
    // The dot NODE is the same object in both states (the chrome is never
    // replaced on fold), but folded it takes no layout at all: `display: none`,
    // never a box left in the row at `opacity: 0` (which would keep the `6px`
    // dot plus the `6px` content gap and push the word right by `12px`).
    expect(dot).toBeTruthy()
    expect(dot.nextElementSibling).toBe(word)
    expect(window.getComputedStyle(dot).display).toBe('none')
    const dotRules = ownRules(dot)
    expect(
      dotRules.some((rule) => rule.includes('display:none')),
      'the folded dot leaves the layout'
    ).toBe(true)
    expect(
      dotRules.some((rule) => rule.includes('opacity:0')),
      'the folded dot is never merely hidden at opacity 0'
    ).toBe(false)
    expect(
      dotRules.some((rule) => rule.includes('background:var(--color-text-3)')),
      'the folded dot carries no visible neutral mark'
    ).toBe(false)
    // The dot takes no layout and the pill keeps its intended `24px` box, so the
    // folded and expanded labels are the same height (a height regression is its
    // own class of bug: the pill must never shrink with its content).
    expect(window.getComputedStyle(pill).height).toBe('24px')
    // The folded word therefore starts at the pill's own inset: `6px` padding +
    // the `1px` border, with no folded-only padding rule.
    expect(ownRules(pill).some((rule) => rule.includes('padding:08px06px'))).toBe(true)
    expect(ownRules(content).some((rule) => rule.includes('gap:6px'))).toBe(true)
    foldedView.unmount()

    const expandedView = render(
      createElement(TopicSegmentLine, { segment: makeSegment(), isFirst: true, isLast: true, messageCount: 7 }),
      { wrapper: wrapper(setupStore()) }
    )
    const expandedContent = screen.getByTestId('topic-segment-label').firstElementChild as HTMLElement
    const expandedDot = expandedContent.firstElementChild as HTMLElement
    // Expanded keeps the visible dot, the unchanged content gap and the group's
    // own segment color — inside the same `24px` pill box.
    expect(window.getComputedStyle(screen.getByTestId('topic-segment-label')).height).toBe('24px')
    expect(window.getComputedStyle(expandedDot).display).toBe('inline-block')
    expect(window.getComputedStyle(expandedDot).width).toBe('6px')
    expect(window.getComputedStyle(expandedDot).height).toBe('6px')
    expect(ownRules(expandedContent).some((rule) => rule.includes('gap:6px'))).toBe(true)
    expect(
      ownRules(expandedDot).some((rule) => rule.includes('background:color-seg-1')),
      'expanded the dot is the group segment color'
    ).toBe(true)
    expandedView.unmount()
  })

  it('a partially mounted group still owns exactly one header row, one rail and one interaction surface', () => {
    const store = setupStore()
    // isFirst === false: the mounted window does not contain the group's first
    // message. The group identity is the header's identity, so the one header
    // row still paints the one label, the one continuous rail and the authority
    // count — and it keeps its single fold/menu interaction surface.
    const segment = makeSegment()
    const view = render(createElement(TopicSegmentLine, { segment, isFirst: false, isLast: true, messageCount: 7 }), {
      wrapper: wrapper(store)
    })
    expect(screen.getByTestId('topic-segment-group').getAttribute('data-segment-first')).toBe('false')
    expect(screen.getByTestId('topic-segment-group').getAttribute('data-segment-last')).toBe('true')
    expect(screen.getByTestId('topic-segment-label')).toBeTruthy()
    expect(screen.getByTestId('topic-segment-count').textContent).toBe('7')
    expect(view.container.querySelectorAll('[data-testid="topic-segment-rail"]')).toHaveLength(1)
    expect(view.container.querySelectorAll('[data-testid="topic-segment-rule"]')).toHaveLength(1)
    expect(view.container.querySelectorAll('[data-testid="topic-segment-fold"]')).toHaveLength(1)
    // The one rail interaction surface is still the group's menu trigger host.
    expect(fireEvent.contextMenu(screen.getByTestId('topic-segment-fold'), { clientX: 120, clientY: 200 })).toBe(false)
    expect(dropdownState.pointer).toEqual({ x: 120, y: 200 })
    view.unmount()
  })

  it('an inherited/read-only group renders the label but offers no fold write', async () => {
    for (const capability of ['readonly', 'unknown'] as const) {
      const store = setupStore(capability)
      const segment = makeSegment()
      const view = render(createElement(TopicSegmentLine, { segment, isFirst: true, isLast: false, messageCount: 7 }), {
        wrapper: wrapper(store)
      })
      // The one interaction surface stays present so keyboard parity (Shift+F10
      // on the rail opens the same group menu) does not depend on write
      // capability, but the fold write itself is owner-only: a read-only route
      // gets no click write at all (zero IPC).
      const foldSurface = screen.getByTestId('topic-segment-fold')
      expect(foldSurface.getAttribute('aria-disabled')).toBe('true')
      fireEvent.click(foldSurface)
      expect(updateSegmentMetadataMock).not.toHaveBeenCalled()
      expect(screen.getByTestId('topic-segment-rule')).toBeTruthy()
      view.unmount()

      const foldedView = render(
        createElement(TopicSegmentLine, {
          segment: makeSegment({ folded: true }),
          isFirst: true,
          isLast: false,
          messageCount: 7
        }),
        { wrapper: wrapper(setupStore(capability)) }
      )
      const foldedPill = screen.getByTestId('topic-segment-label')
      // No write means no promise: the folded pill stays a plain label (no
      // button role, no tab stop) and no part of it expands.
      expect(foldedPill.getAttribute('role')).toBeNull()
      expect(foldedPill.getAttribute('tabindex')).toBeNull()
      fireEvent.click(screen.getByTestId('topic-segment-expand'))
      fireEvent.click(foldedPill)
      fireEvent.click(screen.getByTestId('topic-segment-count'))
      fireEvent.keyDown(foldedPill, { key: 'Enter' })
      expect(updateSegmentMetadataMock).not.toHaveBeenCalled()
      foldedView.unmount()
    }
  })

  it('the header row carries the segment-header interaction region in both states', () => {
    const store = setupStore()
    for (const folded of [false, true]) {
      const segment = makeSegment({ folded })
      const view = render(createElement(TopicSegmentLine, { segment, isFirst: true, isLast: false, messageCount: 7 }), {
        wrapper: wrapper(store)
      })
      // The fold/expand gesture holds the HEADER ROW stationary, so the region
      // annotation sits on the row that exists in BOTH presentation states at
      // the same flow position — never on the collapse hit target or the expand
      // word, each of which only exists in one of the two states.
      const header = screen.getByTestId('topic-segment-group')
      expect(header.getAttribute('data-interaction-region')).toBe('segment-header')
      expect(view.container.querySelectorAll('[data-interaction-region="segment-header"]')).toHaveLength(1)
      view.unmount()
    }
  })

  it('groupwide hover raises the whole group: the line and the header actions together', () => {
    const store = setupStore()
    const segment = makeSegment()
    render(createElement(TopicSegmentLine, { segment, isFirst: true, isLast: false, messageCount: 7 }), {
      wrapper: wrapper(store)
    })
    const actions = screen.getByTestId('topic-segment-actions')
    expect(window.getComputedStyle(actions).opacity).toBe('0')

    // Hovering the rail (a point of the group boundary far below the header
    // text) is the SAME hover as hovering the header: one own state, one line,
    // one set of actions — never a per-run mark.
    fireEvent.mouseOver(screen.getByTestId('topic-segment-fold'))
    expect(window.getComputedStyle(actions).opacity).toBe('1')

    fireEvent.mouseOut(screen.getByTestId('topic-segment-fold'), { relatedTarget: document.body })
    expect(window.getComputedStyle(actions).opacity).toBe('0')
  })

  it('chrome color/opacity continuity rides the shared fold window', () => {
    const store = setupStore()
    const view = render(
      createElement(TopicSegmentLine, { segment: makeSegment(), isFirst: true, isLast: false, messageCount: 7 }),
      { wrapper: wrapper(store) }
    )
    // The rule and the pill tint/border animate in place instead of switching on
    // the first fold frame, and each uses the one shared window constant. The
    // dot carries no paint change (folded it takes no layout, expanded it is the
    // segment color), so it declares no transition of its own.
    const dotTransition = getComputedStyle(
      screen.getByTestId('topic-segment-label').firstElementChild!.firstElementChild as Element
    ).transition
    expect(dotTransition, 'the dot has no repaint to animate').toBe('')
    const ruleTransition = getComputedStyle(screen.getByTestId('topic-segment-rule')).transition
    expect(ruleTransition).toContain('opacity')
    expect(ruleTransition).toContain(`${SEGMENT_FOLD_MOTION_MS}ms`)
    const pillTransition = getComputedStyle(screen.getByTestId('topic-segment-label')).transition
    expect(pillTransition, 'pill tint transitions instead of snapping').toContain('background-color')
    expect(pillTransition, 'pill border transitions instead of snapping').toContain('border-color')
    expect(
      getComputedStyle(screen.getByTestId('topic-segment-label').firstElementChild!.firstElementChild as Element)
        .display
    ).toBe('inline-block')
    view.unmount()
  })

  it('the group edge right click claims the gesture so the message menu never opens', () => {
    for (const folded of [false, true]) {
      const ancestorContextMenu = vi.fn()
      const store = setupStore()
      const view = render(
        createElement(
          'div',
          { onContextMenu: ancestorContextMenu },
          createElement(TopicSegmentLine, {
            segment: makeSegment(folded ? { folded: true } : {}),
            isFirst: true,
            isLast: false,
            messageCount: 7
          })
        ),
        { wrapper: wrapper(store) }
      )
      // Both group edges claim the right click: the rail's rule (a point of the
      // continuous boundary) and the pill.
      const targets = folded
        ? [screen.getByTestId('topic-segment-label')]
        : [screen.getByTestId('topic-segment-rule'), screen.getByTestId('topic-segment-label')]
      for (const target of targets) {
        // fireEvent returns false when the default is prevented, which is the
        // claim that keeps the message list's own context-menu host closed.
        expect(fireEvent.contextMenu(target)).toBe(false)
      }
      expect(ancestorContextMenu).not.toHaveBeenCalled()
      view.unmount()
    }
  })

  it('anchors the group menu at the observed pointer, never at the offscreen header row', () => {
    // The real defect this guards: the group header row has scrolled out of the
    // scrollport while one continuous rail of the same group is still visible
    // and clickable. The trigger host (the header row) is what antd observes
    // the gesture on, and the POINT it records there is what the popup is
    // anchored to. A handler on the pill or the rail that stopped the right
    // click below that host would leave the trigger without a pointer, and the
    // popup would then mirror the row's own geometry — above the scrollport.
    const ancestorContextMenu = vi.fn()
    const store = setupStore()
    const view = render(
      createElement(
        'div',
        { onContextMenu: ancestorContextMenu },
        createElement(TopicSegmentLine, {
          segment: makeSegment(),
          isFirst: true,
          isLast: false,
          messageCount: 7
        })
      ),
      { wrapper: wrapper(store) }
    )
    // The header row is above the scrollport; the rail point the user
    // right-clicks is inside it.
    const header = screen.getByTestId('topic-segment-group')
    Object.defineProperty(header, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: -393,
        top: -393,
        right: 100,
        bottom: -393 + SEGMENT_GROUP_HEADER_HEIGHT_PX,
        left: 0,
        width: 100,
        height: SEGMENT_GROUP_HEADER_HEIGHT_PX,
        toJSON: () => ({})
      })
    })

    const rail = screen.getByTestId('topic-segment-rule')
    expect(fireEvent.contextMenu(rail, { clientX: 412, clientY: 337 })).toBe(false)
    // The trigger host observed the real gesture and its pointer (the anchor
    // input), i.e. the group's claim ran at the host, not below it.
    expect(dropdownState.pointer).toEqual({ x: 412, y: 337 })
    // The one controlled menu is opened through the trigger's own open channel.
    expect(dropdownState.open).toBe(true)
    // And the same gesture still never reaches the message list's menu host.
    expect(ancestorContextMenu).not.toHaveBeenCalled()
    view.unmount()
  })

  describe('group menu', () => {
    const renderExpanded = (capability: 'owner' | 'readonly' | 'unknown' = 'owner', overrides = {}) =>
      render(
        createElement(TopicSegmentLine, {
          segment: makeSegment(overrides),
          isFirst: true,
          isLast: false,
          messageCount: 7
        }),
        { wrapper: wrapper(setupStore(capability)) }
      )

    it('offers the group actions in the user-facing order on an owned, expanded group', () => {
      renderExpanded()
      expect(dropdownState.opens).toBe(1)
      expect(menuKeys()).toEqual(['rename', 'toggle-fold', 'jump-to-start', 'dissolve'])
      expect(dropdownState.items.map((item) => item.label)).toEqual([
        'topicSegment.rename',
        'topicSegment.fold',
        'topicSegment.jumpToStart',
        'topicSegment.dissolveAction'
      ])
      // Dissolve is the only destructive item, so it keeps the danger style.
      expect(dropdownState.items[3].danger).toBe(true)
    })

    it('offers rename, expand, jump and dissolve on a folded group', () => {
      renderExpanded('owner', { folded: true })
      // Both action surfaces are anchored popovers with no dependency on the
      // body, so the folded menu keeps both.
      expect(menuKeys()).toEqual(['rename', 'toggle-fold', 'jump-to-start', 'dissolve'])
      expect(dropdownState.items[1].label).toBe('topicSegment.expand')
    })

    it('withholds the fold write on an inherited/read-only group but keeps the rest', () => {
      for (const capability of ['readonly', 'unknown'] as const) {
        const view = renderExpanded(capability)
        expect(menuKeys()).toEqual(['rename', 'jump-to-start', 'dissolve'])
        view.unmount()
      }
    })

    it('folds from the menu through the same authority write the rail uses', async () => {
      renderExpanded()
      await act(async () => {
        dropdownState.items[1].onClick()
      })
      await waitFor(() => expect(updateSegmentMetadataMock).toHaveBeenCalledTimes(1))
      expect(updateSegmentMetadataMock).toHaveBeenCalledWith('seg-1', undefined, undefined, true, null)
    })

    it('expands from the menu on a folded group (route-aware)', async () => {
      renderExpanded('owner', { folded: true })
      await act(async () => {
        dropdownState.items[1].onClick()
      })
      await waitFor(() => expect(updateSegmentMetadataMock).toHaveBeenCalledTimes(1))
      expect(updateSegmentMetadataMock).toHaveBeenCalledWith('seg-1', undefined, undefined, false, null)
    })

    it('renames INLINE in the pill from both header entrances, with no anchored surface', async () => {
      const view = renderExpanded()
      fireEvent.click(screen.getByText('Seg'))
      const inline = screen.getByTestId('topic-segment-rename-inline') as HTMLInputElement
      expect(inline, 'the label itself becomes a one-line editor').toBeTruthy()
      expect(inline.value, 'the editor opens with the authoritative name').toBe('Seg')
      // Opening selects the whole name, so a rename is one keystroke away.
      expect(inline.selectionStart).toBe(0)
      expect(inline.selectionEnd).toBe(3)
      // No anchored surface and no centered prompt: the pill IS the editor.
      expect(popoverState.props?.open ?? false, 'the pill rename opens no popover').toBe(false)
      expect(updateSegmentMetadataMock, 'opening writes nothing').not.toHaveBeenCalled()
      // Escape cancels: the label returns and nothing is written.
      await act(async () => {
        fireEvent.keyDown(inline, { key: 'Escape' })
      })
      expect(screen.queryByTestId('topic-segment-rename-inline')).toBeNull()
      expect(screen.getByText('Seg')).toBeTruthy()
      expect(updateSegmentMetadataMock).not.toHaveBeenCalled()
      view.unmount()

      // The hover pencil is the second header entrance and opens the same editor.
      const pencilView = renderExpanded()
      fireEvent.click(screen.getByTitle('topicSegment.rename'))
      expect(screen.getByTestId('topic-segment-rename-inline')).toBeTruthy()
      expect(popoverState.props?.open ?? false, 'the pencil opens no popover either').toBe(false)
      expect(updateSegmentMetadataMock).not.toHaveBeenCalled()
      pencilView.unmount()
    })

    it('commits the inline draft on Enter and on blur, trimmed, without folding or navigating', async () => {
      const cases: Array<{ draft: string; commit: 'enter' | 'blur'; expected: string | null }> = [
        { draft: '  Renamed group  ', commit: 'enter', expected: 'Renamed group' },
        { draft: 'Blurred group', commit: 'blur', expected: 'Blurred group' },
        { draft: 'Seg', commit: 'enter', expected: null },
        { draft: '   ', commit: 'blur', expected: null }
      ]
      for (const { draft, commit, expected } of cases) {
        updateSegmentMetadataMock.mockClear()
        emitMock.mockClear()
        const view = renderExpanded()
        fireEvent.click(screen.getByText('Seg'))
        await act(async () => {
          fireEvent.change(screen.getByTestId('topic-segment-rename-inline'), { target: { value: draft } })
        })
        await act(async () => {
          const field = screen.getByTestId('topic-segment-rename-inline')
          if (commit === 'enter') fireEvent.keyDown(field, { key: 'Enter' })
          else fireEvent.blur(field)
        })
        expect(screen.queryByTestId('topic-segment-rename-inline'), 'the editor closes').toBeNull()
        if (expected) {
          await waitFor(() => expect(updateSegmentMetadataMock).toHaveBeenCalledTimes(1))
          expect(updateSegmentMetadataMock).toHaveBeenCalledWith('seg-1', expected)
        } else {
          // Give the (wrong) write path a chance to run before asserting none.
          await act(async () => {
            await Promise.resolve()
          })
          expect(updateSegmentMetadataMock, 'blank/unchanged drafts write nothing').not.toHaveBeenCalled()
        }
        // A rename is never a fold and never a row navigation.
        expect(updateSegmentMetadataMock).not.toHaveBeenCalledWith('seg-1', undefined, undefined, true, null)
        expect(emitMock, 'a rename never navigates the message row').not.toHaveBeenCalled()
        view.unmount()
      }
    })

    it('saves a trimmed rename on Enter and drops blank/unchanged drafts', async () => {
      const cases: Array<{ draft: string; expected: string | null }> = [
        { draft: '  Renamed group  ', expected: 'Renamed group' },
        { draft: 'Seg', expected: null },
        { draft: '   ', expected: null }
      ]
      for (const { draft, expected } of cases) {
        updateSegmentMetadataMock.mockClear()
        const view = renderExpanded()
        // The menu path pins the WHOLE menu box; this case drives the write
        // path, so the boxes are supplied exactly as antd hands them over.
        const rail = screen.getByTestId('topic-segment-rule')
        fireEvent.contextMenu(rail, { clientX: 300, clientY: 240 })
        await act(async () => {
          dropdownState.items[0].onClick(
            menuActionClick(
              { left: 60, right: 220, top: 150, bottom: 320 },
              { left: 60, right: 220, top: 150, bottom: 182 }
            )
          )
        })
        expect(popoverState.props!.open, 'the menu rename opens the same anchored surface').toBe(true)
        const input = screen.getByTestId('topic-segment-rename-input') as HTMLInputElement
        expect(input.value).toBe('Seg')
        await act(async () => {
          fireEvent.change(input, { target: { value: draft } })
        })
        await act(async () => {
          fireEvent.keyDown(screen.getByTestId('topic-segment-rename-input'), { key: 'Enter' })
        })
        expect(popoverState.props!.open, 'confirming closes the surface').toBe(false)
        if (expected) {
          await waitFor(() => expect(updateSegmentMetadataMock).toHaveBeenCalledTimes(1))
          expect(updateSegmentMetadataMock).toHaveBeenCalledWith('seg-1', expected)
        } else {
          // Give the (wrong) write path a chance to run before asserting none.
          await act(async () => {
            await Promise.resolve()
          })
          expect(updateSegmentMetadataMock).not.toHaveBeenCalled()
        }
        view.unmount()
      }
    })

    it('keeps the header trash on its own button-anchored confirmation, with the app wording and no dialog', async () => {
      const view = renderExpanded()
      const confirm = popconfirmState.byTrigger.get('topicSegment.dissolveAction')
      expect(confirm, 'the header trash keeps its own anchored confirmation').toBeTruthy()
      expect(confirm!.title).toBe('topicSegment.dissolve.confirm')
      // Labels are the shared standard's own locale defaults: the caller passes
      // neither, and the popup must still never fall back to the library's `OK`.
      expect(confirm!.okText).toBe('common.confirm')
      expect(confirm!.cancelText).toBe('common.cancel')
      expect(confirm!.okButtonProps).toEqual({ danger: true })
      // The surface stays UNCONTROLLED (its trigger button owns the open state),
      // keeps the library's default direction arrow and no placement override:
      // anchored at the button, never a centered modal. Its width is the shared
      // content-driven, viewport-bounded standard, so the long confirm sentence
      // wraps inside a compact popup instead of becoming a banner.
      expect(confirm!.open).toBeUndefined()
      expect(confirm!.arrow ?? true).not.toBe(false)
      expect(confirm!.placement).toBeUndefined()
      expect(confirm!.styles.root, 'the shared compact bounds, not a local fixed width').toMatchObject({
        minWidth: CONFIRM_POPOVER_MIN_WIDTH_CSS,
        maxWidth: CONFIRM_POPOVER_MAX_WIDTH_CSS
      })
      expect(confirm!.styles.root).not.toHaveProperty('width')
      expect(confirm!.styles.body, 'the shared body padding/type/wrapping').toMatchObject({
        padding: CONFIRM_POPOVER_INNER_PADDING_PX,
        fontWeight: 'normal',
        overflowWrap: 'anywhere'
      })
      expect(confirm!.classNames, 'the shared popover class is merged').toEqual({ root: CONFIRM_POPOVER_CLASS_NAME })
      expect(window.modal.confirm, 'no centered dialog is involved').not.toHaveBeenCalled()
      fireEvent.click(screen.getByTitle('topicSegment.dissolveAction'))
      await act(async () => {
        await confirm!.onConfirm?.()
      })
      await waitFor(() => expect(deleteSegmentMock).toHaveBeenCalledWith('seg-1'))
      view.unmount()
    })

    it('anchors a menu action on the group RAIL, 8px above the whole menu box', async () => {
      // The menu is a portaled element that unmounts with the click, so its
      // whole box is captured while the click still dispatches (antd hands the
      // item handler the DOM event). The pin itself is a 1px point ON the group
      // rail: the surface sits where it always did (above the whole menu) but its
      // left arrow now points at that line instead of at a vanished row.
      const view = renderExpanded()
      const rail = screen.getByTestId('topic-segment-rule') as HTMLElement
      withRect(rail, { left: 40, right: 44, top: 100, bottom: 700 })
      expect(fireEvent.contextMenu(rail, { clientX: 300, clientY: 240 })).toBe(false)
      expect(dropdownState.pointer).toEqual({ x: 300, y: 240 })
      await act(async () => {
        dropdownState.items[3].onClick(
          menuActionClick(
            { left: 80, right: 280, top: 196, bottom: 356 },
            { left: 80, right: 280, top: 328, bottom: 356 }
          )
        )
      })
      const surface = popconfirmState.byTrigger.get('topic-segment-dissolve-anchor')
      expect(surface, 'the menu dissolve is an anchored Popconfirm').toBeTruthy()
      expect(surface!.open).toBe(true)
      expect(surface!.title).toBe('topicSegment.dissolve.confirm')
      expect(surface!.okText).toBe('common.confirm')
      expect(surface!.cancelText).toBe('common.cancel')
      expect(surface!.okButtonProps).toEqual({ danger: true })
      expect(surface!.placement, 'the bottom edge anchors above the whole menu').toBe('rightBottom')
      expect(surface!.arrow, 'the surface keeps the library left arrow, centred on the pin').toEqual({
        pointAtCenter: true
      })
      expect(surface!.align, 'a 1px pin and 13px to the left edge, with no arrow flip').toEqual({
        offset: [12, 0],
        overflow: { adjustX: false, adjustY: false, shiftX: true, shiftY: true }
      })
      // The library paints its direction arrow from the placement class, which it
      // derives from the alignment POINTS; overriding those points would leave no
      // placement and therefore no arrow. `pointAtCenter` supplies the same
      // anchored corner instead of a local points override.
      expect(surface!.align, 'the built-in alignment points are kept, never overridden').not.toHaveProperty('points')
      // The menu dissolve IS the shared `ConfirmPopover`: content-driven bounds
      // (never a fixed width), the shared body padding/type/wrapping, and the
      // shared class merged on top of any caller class.
      expect(surface!.styles.root, 'the confirm gets the shared compact bounds').toMatchObject({
        minWidth: CONFIRM_POPOVER_MIN_WIDTH_CSS,
        maxWidth: CONFIRM_POPOVER_MAX_WIDTH_CSS
      })
      expect(surface!.styles.root, 'no fixed width is forced on the confirm').not.toHaveProperty('width')
      expect(surface!.styles.body, 'the shared body padding/type/wrapping').toMatchObject({
        padding: CONFIRM_POPOVER_INNER_PADDING_PX,
        fontWeight: 'normal',
        overflowWrap: 'anywhere'
      })
      expect(surface!.classNames, 'the shared popover class is merged').toEqual({ root: CONFIRM_POPOVER_CLASS_NAME })
      expect(window.modal.confirm, 'no centered dialog is involved').not.toHaveBeenCalled()
      const pin = screen.getByTestId('topic-segment-dissolve-anchor')
      expect(pin.style.position).toBe('absolute')
      expect(pin.getAttribute('data-anchor-side')).toBe('above')
      expect(pin.style.left, 'the pin sits ON the group rail, never on the menu left edge').toBe('40px')
      expect(pin.style.top, 'the anchored edge is 8px above the whole menu').toBe('188px')
      expect(pin.style.width, 'the pin is a point on the line').toBe('1px')
      expect(pin.style.height).toBe('1px')
      expect(screen.getByTestId('antd-popconfirm-surface')).toBeTruthy()
      // Cancel writes nothing and closes the one surface (the rendered cancel
      // button is the user's path; it reports the closed state upward).
      const confirmSurface = screen.getByTestId('antd-popconfirm-surface')
      await act(async () => {
        fireEvent.click(confirmSurface.querySelectorAll('button')[0])
      })
      expect(deleteSegmentMock).not.toHaveBeenCalled()
      expect(popconfirmState.byTrigger.get('topic-segment-dissolve-anchor')!.open).toBe(false)
      // Confirm removes the group through the one authority write.
      await act(async () => {
        await surface!.onConfirm?.()
      })
      await waitFor(() => expect(deleteSegmentMock).toHaveBeenCalledWith('seg-1'))
      view.unmount()
    })

    it('opens below the whole menu when the arrow would otherwise point past the rail', async () => {
      // The boundary clamp: a menu opened where the rail only BEGINS below it (the
      // pill at a group's top) would put the surface's left arrow above the line,
      // i.e. pointing at nothing. The same capture therefore prefers the side
      // whose arrow actually lands on the rail.
      const view = renderExpanded()
      const rail = screen.getByTestId('topic-segment-rule') as HTMLElement
      withRect(rail, { left: 40, right: 44, top: 320, bottom: 700 })
      fireEvent.contextMenu(rail, { clientX: 300, clientY: 240 })
      await act(async () => {
        dropdownState.items[0].onClick(
          menuActionClick(
            { left: 40, right: 240, top: 196, bottom: 356 },
            { left: 40, right: 240, top: 196, bottom: 228 }
          )
        )
      })
      expect(popoverState.props!.open).toBe(true)
      expect(popoverState.props!.placement, 'the top edge anchors below the whole menu').toBe('rightTop')
      expect(popoverState.props!.arrow, 'the mirrored surface keeps the library left arrow').toEqual({
        pointAtCenter: true
      })
      expect(popoverState.props!.align, 'the same 1px-pin alignment, mirrored').toEqual({
        offset: [12, 0],
        overflow: { adjustX: false, adjustY: false, shiftX: true, shiftY: true }
      })
      const pin = screen.getByTestId('topic-segment-rename-anchor')
      expect(pin.getAttribute('data-anchor-side')).toBe('below')
      expect(pin.style.left).toBe('40px')
      expect(pin.style.top, 'the anchored edge is 8px below the whole menu').toBe('364px')
      view.unmount()
    })
    it('anchors the menu rename on the rail above the whole menu, and keeps the pointer as fallback', async () => {
      const view = renderExpanded()
      const rail = screen.getByTestId('topic-segment-rule') as HTMLElement
      // A measured rail: x 40, spanning 100..700 in viewport px. Its line is what
      // the surface's left arrow points at.
      withRect(rail, { left: 40, right: 44, top: 100, bottom: 700 })
      fireEvent.contextMenu(rail, { clientX: 300, clientY: 240 })
      await act(async () => {
        dropdownState.items[0].onClick(
          menuActionClick(
            { left: 40, right: 240, top: 196, bottom: 356 },
            { left: 40, right: 240, top: 196, bottom: 228 }
          )
        )
      })
      expect(popoverState.props!.open, 'the menu rename opens the one anchored surface').toBe(true)
      // The region is still the one the user knows (above the whole menu, 8px
      // clear), now carrying the left arrow that points at the group rail.
      expect(popoverState.props!.placement, 'the bottom edge anchors above the whole menu').toBe('rightBottom')
      expect(popoverState.props!.arrow, 'the menu surface keeps the library left arrow, centred on the pin').toEqual({
        pointAtCenter: true
      })
      expect(popoverState.props!.align, 'a 1px pin and 13px to the left edge, with no arrow flip').toEqual({
        offset: [12, 0],
        overflow: { adjustX: false, adjustY: false, shiftX: true, shiftY: true }
      })
      expect(popoverState.props!.align, 'the built-in alignment points are kept, never overridden').not.toHaveProperty(
        'points'
      )
      // The rename surface shares the ONE compact-popup standard: the same
      // viewport-bounded min/max as every `ConfirmPopover`, with its own preferred
      // width expressed INSIDE those bounds instead of a second width constant.
      const renameRoot = popoverState.props!.styles.root
      expect(renameRoot.width, 'the rename keeps its preferred width').toBe(308)
      expect(renameRoot.minWidth, 'the shared minimum-width bound').toBe(CONFIRM_POPOVER_MIN_WIDTH_CSS)
      expect(renameRoot.maxWidth, 'the shared viewport-bounded maximum').toBe(CONFIRM_POPOVER_MAX_WIDTH_CSS)
      expect(popoverState.props!.styles.body, 'the shared body padding/type/wrapping').toMatchObject({
        padding: CONFIRM_POPOVER_INNER_PADDING_PX,
        fontWeight: 'normal',
        overflowWrap: 'anywhere'
      })
      expect(popoverState.props!.classNames, 'the shared popover class is merged, never replaced').toEqual({
        root: CONFIRM_POPOVER_CLASS_NAME
      })
      const pin = screen.getByTestId('topic-segment-rename-anchor')
      expect(
        pin.style.position,
        'the anchor is rebased into the group header row, not left in a viewport-fixed layer'
      ).toBe('absolute')
      expect(pin.getAttribute('data-anchor-side')).toBe('above')
      expect(pin.style.left, 'the pin sits ON the group rail, never on the menu left edge').toBe('40px')
      expect(pin.style.top, 'the anchored edge is 8px above the whole menu').toBe('188px')
      expect(pin.style.width, 'the pin is a point on the line').toBe('1px')
      expect(pin.style.height).toBe('1px')
      view.unmount()

      // A pointer-less invocation whose menu box is already gone still opens the
      // surface: the group's own right-click point supplies the gesture position,
      // the rail still supplies the line the arrow points at.
      const fallbackView = renderExpanded()
      const fallbackRail = screen.getByTestId('topic-segment-rule') as HTMLElement
      withRect(fallbackRail, { left: 40, right: 44, top: 100, bottom: 700 })
      fireEvent.contextMenu(fallbackRail, { clientX: 300, clientY: 240 })
      await act(async () => {
        dropdownState.items[0].onClick({ domEvent: { currentTarget: null, target: null } })
      })
      const fallbackPin = screen.getByTestId('topic-segment-rename-anchor')
      expect(fallbackPin.style.left).toBe('40px')
      expect(fallbackPin.style.top, 'the gesture point stands in for the missing menu edge').toBe('232px')
      expect(fallbackPin.style.width).toBe('1px')
      fallbackView.unmount()
    })
    it('rebases the rail pointer into the group header row, so a transformed ancestor cannot displace it', async () => {
      const view = renderExpanded()
      // The chat message container uses `transform`/`will-change` for its own
      // layout work, which becomes the containing block of a viewport-`fixed`
      // child and would place the pin far from the point the user acted on. The
      // pin is therefore expressed in the header row's own space.
      const row = screen.getByTestId('topic-segment-group') as HTMLElement
      row.getBoundingClientRect = () =>
        ({
          left: 20,
          top: 100,
          right: 320,
          bottom: 164,
          width: 300,
          height: 64,
          x: 20,
          y: 100,
          toJSON: () => ({})
        }) as DOMRect
      const rail = screen.getByTestId('topic-segment-rule') as HTMLElement
      withRect(rail, { left: 40, right: 44, top: 150, bottom: 500 })
      fireEvent.contextMenu(rail, { clientX: 300, clientY: 240 })
      await act(async () => {
        dropdownState.items[0].onClick(
          menuActionClick(
            { left: 40, right: 300, top: 196, bottom: 396 },
            { left: 40, right: 300, top: 196, bottom: 228 }
          )
        )
      })
      const pin = screen.getByTestId('topic-segment-rename-anchor')
      // The rail line is 40 in viewport space, rebased on the row's left edge 20:
      // the pin stays ON the rail, wherever the row has been transformed to.
      expect(pin.style.left, 'the captured rail line is expressed in the header row space').toBe('20px')
      // Anchored edge = the whole menu's top edge 196 minus the 8px gap, rebased on
      // the row's top edge 100.
      expect(pin.style.top, 'the same anchored edge is rebased on the same row').toBe('88px')
      // The pin is a point on the line: no viewport-measured box is involved.
      expect(pin.style.width).toBe('1px')
      expect(pin.style.height).toBe('1px')
      expect(pin.getAttribute('data-anchor-side')).toBe('above')
      view.unmount()
    })
    it('jumps to the group start through the drawer navigation event', () => {
      renderExpanded()
      dropdownState.items[2].onClick()
      // Verbatim the drawer's navigation: one event, one payload, so a jump from
      // the group edge and a jump from the drawer are the same behaviour.
      expect(emitMock).toHaveBeenCalledWith(EVENT_NAMES.NAVIGATE_TO_MESSAGE, 'm0')
    })

    it('opens the same menu from the keyboard (context-menu key / Shift+F10)', () => {
      renderExpanded()
      fireEvent.keyDown(screen.getByTestId('topic-segment-fold'), { key: 'F10', shiftKey: true })
      expect(menuKeys()).toEqual(['rename', 'toggle-fold', 'jump-to-start', 'dissolve'])
    })

    /**
     * A group edge click is the one dismissal the popup library cannot do on its
     * own: rc-trigger treats its trigger child as part of the popup, and the
     * folded pill stops propagation before the trigger's click-to-hide. The one
     * boundary dismiss must therefore close the controlled menu AND leave each
     * edge's own action intact, exactly once.
     */
    const renderWithAncestorMenu = (folded: boolean, ancestorContextMenu: () => void) =>
      render(
        createElement(
          'div',
          { onContextMenu: ancestorContextMenu },
          createElement(TopicSegmentLine, {
            segment: makeSegment(folded ? { folded: true } : {}),
            isFirst: true,
            isLast: false,
            messageCount: 7
          })
        ),
        { wrapper: wrapper(setupStore()) }
      )

    it('dismisses the open group menu from any part of the same folded pill, and still expands once', async () => {
      const parts: Array<[string, () => HTMLElement]> = [
        ['folded word', () => screen.getByTestId('topic-segment-expand')],
        ['count', () => screen.getByTestId('topic-segment-count')],
        ['pill background', () => screen.getByTestId('topic-segment-label')]
      ]
      for (const [label, partOf] of parts) {
        updateSegmentMetadataMock.mockClear()
        const ancestorContextMenu = vi.fn()
        const view = renderWithAncestorMenu(true, ancestorContextMenu)
        // The menu is opened on the group's own edge, exactly like a right click
        // on the continuous rail.
        expect(fireEvent.contextMenu(screen.getByTestId('topic-segment-rule'), { clientX: 210, clientY: 180 })).toBe(
          false
        )
        expect(dropdownState.open, 'the group menu is open').toBe(true)

        // Clicking any part of the SAME group's pill closes that controlled menu
        // (rc-trigger alone never sees it as an outside click).
        fireEvent.click(partOf())
        expect(dropdownState.open, `${label} dismisses the open group menu`).toBe(false)
        // ...and the pill's own expand action still dispatches exactly once.
        await waitFor(() => expect(updateSegmentMetadataMock, `${label} expands once`).toHaveBeenCalledTimes(1))
        expect(updateSegmentMetadataMock).toHaveBeenCalledWith('seg-1', undefined, undefined, false, null)
        expect(ancestorContextMenu, 'a left click opens no message menu').not.toHaveBeenCalled()
        view.unmount()
      }
    })

    it('dismisses the open group menu from an unfolded group and keeps each edge action', async () => {
      // The name: dismiss + the pill's INLINE rename editor, with no write and no
      // anchored surface.
      const nameAncestor = vi.fn()
      const nameView = renderWithAncestorMenu(false, nameAncestor)
      expect(fireEvent.contextMenu(screen.getByTestId('topic-segment-rule'), { clientX: 210, clientY: 180 })).toBe(
        false
      )
      expect(dropdownState.open).toBe(true)
      fireEvent.click(screen.getByText('Seg'))
      expect(dropdownState.open, 'the same group name dismisses the open menu').toBe(false)
      const inline = screen.getByTestId('topic-segment-rename-inline') as HTMLInputElement
      expect(inline.value, 'the inline editor still opens on the same click').toBe('Seg')
      expect(popoverState.props?.open ?? false, 'the inline editor opens no anchored surface').toBe(false)
      expect(updateSegmentMetadataMock, 'opening the editor writes nothing').not.toHaveBeenCalled()
      expect(nameAncestor).not.toHaveBeenCalled()
      nameView.unmount()

      // The unfolded pill's own background: dismiss only, it is no fold target.
      updateSegmentMetadataMock.mockClear()
      const backgroundView = renderWithAncestorMenu(false, vi.fn())
      expect(fireEvent.contextMenu(screen.getByTestId('topic-segment-rule'), { clientX: 210, clientY: 180 })).toBe(
        false
      )
      expect(dropdownState.open).toBe(true)
      fireEvent.click(screen.getByTestId('topic-segment-label'))
      expect(dropdownState.open, 'the pill background dismisses the open menu').toBe(false)
      expect(updateSegmentMetadataMock, 'an unfolded pill background collapses nothing').not.toHaveBeenCalled()
      backgroundView.unmount()

      // The rail: dismiss + the group's own collapse write, once.
      updateSegmentMetadataMock.mockClear()
      const railAncestor = vi.fn()
      const railView = renderWithAncestorMenu(false, railAncestor)
      expect(fireEvent.contextMenu(screen.getByTestId('topic-segment-rule'), { clientX: 210, clientY: 180 })).toBe(
        false
      )
      expect(dropdownState.open).toBe(true)
      fireEvent.click(screen.getByTestId('topic-segment-fold'))
      expect(dropdownState.open, 'the rail target dismisses the open menu').toBe(false)
      await waitFor(() => expect(updateSegmentMetadataMock).toHaveBeenCalledTimes(1))
      expect(updateSegmentMetadataMock).toHaveBeenCalledWith('seg-1', undefined, undefined, true, null)
      expect(railAncestor).not.toHaveBeenCalled()
      railView.unmount()
    })

    it('reopens on a right click after a dismissal and keeps its pointer anchor and menu actions', async () => {
      const ancestorContextMenu = vi.fn()
      const view = renderWithAncestorMenu(false, ancestorContextMenu)
      const rail = screen.getByTestId('topic-segment-rule') as HTMLElement
      withRect(rail, { left: 40, right: 44, top: 100, bottom: 700 })
      expect(fireEvent.contextMenu(rail, { clientX: 300, clientY: 240 })).toBe(false)
      expect(dropdownState.open).toBe(true)
      expect(dropdownState.pointer, 'the menu keeps the pointer it was anchored at').toEqual({ x: 300, y: 240 })
      expect(ancestorContextMenu, 'the message list menu never opens').not.toHaveBeenCalled()

      // The same group's rail target dismisses the menu through the same write.
      fireEvent.click(screen.getByTestId('topic-segment-fold'))
      expect(dropdownState.open).toBe(false)
      await waitFor(() => expect(updateSegmentMetadataMock).toHaveBeenCalledTimes(1))

      // A fresh right click on the same edge reopens it, still at the pointer.
      expect(fireEvent.contextMenu(rail, { clientX: 280, clientY: 260 })).toBe(false)
      expect(dropdownState.open, 'the same gesture still opens the one menu').toBe(true)
      expect(dropdownState.pointer).toEqual({ x: 280, y: 260 })
      expect(ancestorContextMenu).not.toHaveBeenCalled()

      // A menu action still runs against the whole menu box it read while the
      // click dispatched — the boundary dismiss never unmounts it early.
      await act(async () => {
        dropdownState.items[0].onClick(
          menuActionClick(
            { left: 40, right: 240, top: 196, bottom: 356 },
            { left: 40, right: 240, top: 196, bottom: 228 }
          )
        )
      })
      expect(popoverState.props!.open, 'the menu rename opens its anchored surface').toBe(true)
      const pin = screen.getByTestId('topic-segment-rename-anchor')
      expect(pin.style.left, 'the anchor is the rail line read at click time').toBe('40px')
      expect(pin.style.top, 'the anchored edge is 8px above the whole captured menu box').toBe('188px')
      view.unmount()
    })
  })

  /**
   * Production wiring: the flow composition resolves ONE group presentation per
   * mounted group. A group whose members split across two turn runs (the real
   * cause: an assistant row without `askId` derives a different turn id than its
   * user row, and a divider or a viewport-partial membership does the same) must
   * still expose exactly one header row, one label, one rail and one fold write
   * target — and no per-run mark at all. That is the locator contract the E2E
   * assets rely on.
   */
  describe('one group owner across split runs (production wiring)', () => {
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

    const renderChrome = ({ segment, firstMounted, lastMounted, messageCount }: any) =>
      createElement(TopicSegmentLine, {
        segment,
        isFirst: firstMounted,
        isLast: lastMounted,
        messageCount
      })

    const renderSplit = (segment: any, folded: boolean) =>
      renderEditFlowNodes({
        nodes: splitNodes(segment, folded),
        isEditMode: false,
        renderSegmentChrome: renderChrome
      })

    const splitMarkers = (container: HTMLElement) => ({
      groups: container.querySelectorAll('[data-testid="topic-segment-group"]').length,
      labels: container.querySelectorAll('[data-testid="topic-segment-label"]').length,
      rails: container.querySelectorAll('[data-testid="topic-segment-rail"]').length,
      rules: container.querySelectorAll('[data-testid="topic-segment-rule"]').length,
      foldTargets: container.querySelectorAll('[data-testid="topic-segment-fold"]').length,
      // The old per-run contract must be gone entirely: no per-run rail, no
      // per-run fold target, no per-run continuation host.
      continuationRails: container.querySelectorAll('[data-segment-continuation-id]').length,
      continuationTargets: container.querySelectorAll('[data-testid="topic-segment-fold-continuation"]').length
    })

    it('expanded: two runs, ONE header row, ONE rail, ONE fold target, no per-run marks', () => {
      const store = setupStore()
      const segment = makeSegment()
      const view = render(createElement(Fragment, null, ...renderSplit(segment, false)), {
        wrapper: wrapper(store)
      })
      expect(splitMarkers(view.container)).toEqual({
        groups: 1,
        labels: 1,
        rails: 1,
        rules: 1,
        foldTargets: 1,
        continuationRails: 0,
        continuationTargets: 0
      })
      // The one owner sits in the run holding the group's own first member.
      const header = view.container.querySelector('[data-testid="topic-segment-group"]') as HTMLElement
      // The header row is an in-flow sibling of the turn inside the elected
      // run host (never inside the turn), and that host holds the group's own
      // first member (the user row).
      const holdingHost = header.parentElement as HTMLElement
      expect(holdingHost.querySelector('[data-testid="edit-turn"]')).not.toBeNull()
      expect(header.closest('[data-testid="edit-turn"]')).toBeNull()
      expect(holdingHost.querySelector('[data-testid="body-g-user"]')).not.toBeNull()
      // Exactly one carrying run is the interaction scope owner.
      const runs = Array.from(view.container.querySelectorAll('[data-testid="edit-turn"]')).map(
        (t) => t.parentElement as HTMLElement
      )
      expect(runs.filter((r) => r.getAttribute('data-interaction-scope-id') === 'seg-1')).toHaveLength(1)
      expect((runs.find((r) => r.contains(header)) as HTMLElement).getAttribute('data-interaction-scope-id')).toBe(
        'seg-1'
      )
    })

    it('collapsed: the same single owner and the same single rail, no duplicate seam label', () => {
      const store = setupStore()
      const segment = makeSegment({ folded: true })
      const view = render(createElement(Fragment, null, ...renderSplit(segment, true)), {
        wrapper: wrapper(store)
      })
      expect(splitMarkers(view.container)).toEqual({
        groups: 1,
        labels: 1,
        rails: 1,
        rules: 1,
        foldTargets: 0,
        continuationRails: 0,
        continuationTargets: 0
      })
      expect(getComputedStyle(view.container.querySelector('[data-testid="topic-segment-rule"]')!).opacity).toBe('0')
      expect(view.container.querySelectorAll('[data-testid="topic-segment-expand"]')).toHaveLength(1)
      expect(screen.getByTestId('topic-segment-count').textContent).toBe('7')
    })

    it('keeps the same header row and rail DOM nodes across the fold (chrome animates in place)', () => {
      const store = setupStore()
      const view = render(createElement(Fragment, null, ...renderSplit(makeSegment(), false)), {
        wrapper: wrapper(store)
      })
      const headerBefore = view.container.querySelector('[data-testid="topic-segment-group"]') as HTMLElement
      const ruleBefore = headerBefore.querySelector('[data-testid="topic-segment-rule"]') as HTMLElement
      expect(ruleBefore).not.toBeNull()

      // One commit-level flip, exactly as production: the authority fold flag
      // changes and the composition re-runs for the same mounted flow.
      view.rerender(createElement(Fragment, null, ...renderSplit(makeSegment({ folded: true }), true)))

      const headerAfter = view.container.querySelector('[data-testid="topic-segment-group"]') as HTMLElement
      const ruleAfter = headerAfter.querySelector('[data-testid="topic-segment-rule"]') as HTMLElement
      // Same nodes: a replaced chrome node can only be committed already faded,
      // so the declared opacity transition would never run.
      expect(headerAfter).toBe(headerBefore)
      expect(ruleAfter).toBe(ruleBefore)
      expect(getComputedStyle(ruleAfter).opacity).toBe('0')
      // The pill keeps the group's tint dot NODE (same element), so the chrome
      // cross-fades in place instead of a node being replaced on the fold.
      const dotBefore = headerBefore.querySelector('[data-testid="topic-segment-label"] > div > span') as HTMLElement
      const dot = headerAfter.querySelector('[data-testid="topic-segment-label"] > div > span') as HTMLElement
      expect(dot).not.toBeNull()
      expect(dot, 'the same dot node survives the fold').toBe(dotBefore)
      expect(getComputedStyle(dot).display).toBe('none')
      expect(
        ownRules(dot).some((rule) => rule.includes('background:var(--color-text-3)')),
        'the folded dot carries no visible neutral mark'
      ).toBe(false)
    })

    it('a divider-split group still owns exactly one header row and one rail', () => {
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
      expect(splitMarkers(view.container)).toMatchObject({
        groups: 1,
        labels: 1,
        rails: 1,
        rules: 1,
        foldTargets: 1
      })
      // The owner is the group's visual top (the older run, rendered last in
      // newest→oldest order), i.e. its rail runs down across the divider.
      const header = view.container.querySelector('[data-testid="topic-segment-group"]') as HTMLElement
      // The one owner rides the group's mounted visual top (the older run), and
      // the turn bodies above/below it keep their own runs: the header is a
      // sibling of the turn, so the rail can span across the divider without
      // wrapping either run.
      const holdingHost = header.parentElement as HTMLElement
      expect(holdingHost.querySelector('[data-testid="body-g-older"]')).not.toBeNull()
      expect(header.closest('[data-testid="edit-turn"]')).toBeNull()
    })

    it('adjacent groups each keep their own occupied header row (folded next to expanded)', () => {
      const store = setupStore()
      const segA = makeSegment({ id: 'seg-a', name: 'A', folded: true })
      const segB = makeSegment({ id: 'seg-b', name: 'B', folded: false })
      const entry = (groupKey: string, segment: any, extra: Record<string, unknown>) => ({
        groupKey,
        turnAskId: `ask-${groupKey}`,
        selected: false,
        segmentId: `seg:${groupKey}`,
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
              { kind: 'turn', entry: entry('g-b', segB, { segmentIsFirst: true, segmentIsLast: true }) },
              { kind: 'turn', entry: entry('g-a', segA, { segmentIsFirst: true, segmentIsLast: true }) }
            ],
            isEditMode: false,
            renderSegmentChrome: renderChrome
          })
        ),
        { wrapper: wrapper(store) }
      )
      // One owner each, in its own run host: two header rows, two labels, two
      // rails, two rules. No shared seam, no cascade, no overlap.
      expect(view.container.querySelectorAll('[data-testid="topic-segment-group"]')).toHaveLength(2)
      expect(view.container.querySelectorAll('[data-testid="topic-segment-label"]')).toHaveLength(2)
      expect(view.container.querySelectorAll('[data-testid="topic-segment-rail"]')).toHaveLength(2)
      expect(view.container.querySelectorAll('[data-testid="topic-segment-rule"]')).toHaveLength(2)
      const headers = Array.from(
        view.container.querySelectorAll('[data-testid="topic-segment-group"]')
      ) as HTMLElement[]
      // Fixed header occupancy in both states, so the collapsed group's row and
      // its neighbour's row are separate normal-flow rows.
      for (const header of headers) {
        expect(window.getComputedStyle(header).height).toBe(`${SEGMENT_GROUP_HEADER_HEIGHT_PX}px`)
      }
      expect(headers[0].parentElement).not.toBe(headers[1].parentElement)
      // The collapsed group paints no fold target; the expanded one keeps its own.
      expect(view.container.querySelectorAll('[data-testid="topic-segment-fold"]')).toHaveLength(1)
      expect(view.container.querySelectorAll('[data-testid="topic-segment-expand"]')).toHaveLength(1)
    })
  })
})
