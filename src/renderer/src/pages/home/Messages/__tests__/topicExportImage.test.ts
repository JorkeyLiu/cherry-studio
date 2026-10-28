import type { Topic } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'
import type * as UtilsModule from '@renderer/utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Topic image export orchestration.
 *
 * The exported image must come from Main's caller-local whole-topic snapshot
 * rendered into a detached canvas, never from the resident windowed message
 * projection and never by stretching/mutating the live `#messages` container.
 * These tests pin the read source, the rendered content (first/middle/last
 * beyond the default window), cleanup on every exit path, and that the live
 * scroll container is left untouched.
 */

/** Default viewport window for a fresh topic; the fixture is well beyond it. */
const DEFAULT_WINDOW_MESSAGE_COUNT = 20
const FIXTURE_MESSAGE_COUNT = 60

const makeTopic = (id: string, name = 'Long Topic'): Topic =>
  ({ id, name, assistantId: 'assistant-1', createdAt: '0', updatedAt: '0' }) as unknown as Topic

const makeMessages = (count: number): Message[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `msg-${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    topicId: 'topic-target',
    blocks: [`block-${index + 1}`],
    askId: index % 2 === 0 ? undefined : `msg-${index}`,
    content: ''
  })) as unknown as Message[]

const makeBlocks = (count: number): MessageBlock[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `block-${index + 1}`,
    messageId: `msg-${index + 1}`,
    type: MessageBlockType.MAIN_TEXT,
    content: `content-${index + 1}`,
    createdAt: '0',
    status: 'success'
  })) as unknown as MessageBlock[]

const snapshotMessages = makeMessages(FIXTURE_MESSAGE_COUNT)

const createSnapshot = () => {
  const blocks = makeBlocks(FIXTURE_MESSAGE_COUNT)
  return {
    messages: snapshotMessages,
    blocks,
    blocksById: new Map(blocks.map((block) => [block.id, block])),
    snapshot: {
      completeness: 'whole-topic' as const,
      topicId: 'topic-target',
      firstMessageId: 'msg-1',
      lastMessageId: `msg-${FIXTURE_MESSAGE_COUNT}`,
      returnedCount: snapshotMessages.length
    }
  }
}

const loadWholeTopicSnapshot = vi.fn()
vi.mock('@renderer/utils/topicSnapshot', () => ({
  loadWholeTopicSnapshot: (...args: unknown[]) => loadWholeTopicSnapshot(...args)
}))

const captureScrollable = vi.fn()
// Partial mock: the export path resolves the capture helper from the same
// module surface the app uses, while every other util stays real.
vi.mock('@renderer/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof UtilsModule>()
  return {
    ...actual,
    captureScrollable: (...args: unknown[]) => captureScrollable(...args)
  }
})

// The canvas presentation is covered by its own component test; here it renders
// message ids so the orchestration can be asserted without the message tree.
vi.mock('../TopicExportImageCanvas', async () => {
  const React = await import('react')
  return {
    default: ({ messages }: { messages: Message[] }) =>
      React.createElement(
        'div',
        { 'data-topic-export-content': true },
        messages.map((message) =>
          React.createElement('span', { key: message.id, 'data-export-message-id': message.id }, message.id)
        )
      )
  }
})

import {
  captureTopicExportImage,
  resetTopicExportImageStateForTests,
  TOPIC_EXPORT_CANVAS_WIDTH_FALLBACK
} from '../topicExportImage'

const liveMessagesContainer = (): HTMLElement => {
  const container = document.createElement('div')
  container.id = 'messages'
  container.className = 'messages-container'
  container.style.height = '400px'
  container.textContent = 'resident viewport content'
  document.body.appendChild(container)
  return container
}

const exportHosts = (): Element[] => Array.from(document.body.querySelectorAll('[data-topic-export-host]'))

const capturedTarget = (callIndex = 0): HTMLElement => {
  const ref = captureScrollable.mock.calls[callIndex][0] as { current: HTMLElement }
  return ref.current
}

beforeEach(() => {
  document.body.innerHTML = ''
  loadWholeTopicSnapshot.mockReset()
  captureScrollable.mockReset()
  resetTopicExportImageStateForTests()
  loadWholeTopicSnapshot.mockResolvedValue(createSnapshot())
  captureScrollable.mockImplementation(async () => ({
    width: 900,
    height: 4000,
    toDataURL: () => 'data:image/png;base64,complete'
  }))
})

describe('captureTopicExportImage', () => {
  it('reads the addressed topic snapshot and renders every message, including those past the default window', async () => {
    const outcome = await captureTopicExportImage({ topic: makeTopic('topic-target'), width: 900 })

    expect(outcome.status).toBe('captured')
    expect(loadWholeTopicSnapshot).toHaveBeenCalledTimes(1)
    expect(loadWholeTopicSnapshot).toHaveBeenCalledWith('topic-target', null)

    const target = capturedTarget()
    expect(target.id).not.toBe('messages')

    const renderedIds = Array.from(target.querySelectorAll('[data-export-message-id]')).map((element) =>
      element.getAttribute('data-export-message-id')
    )
    expect(renderedIds).toHaveLength(FIXTURE_MESSAGE_COUNT)
    expect(renderedIds.length).toBeGreaterThan(DEFAULT_WINDOW_MESSAGE_COUNT)
    expect(renderedIds[0]).toBe('msg-1')
    expect(renderedIds[Math.floor(renderedIds.length / 2)]).toBe('msg-31')
    expect(renderedIds.at(-1)).toBe('msg-60')

    if (outcome.status === 'captured') {
      expect(outcome.dataUrl).toBe('data:image/png;base64,complete')
      expect(outcome.height).toBe(4000)
      expect(outcome.height).toBeGreaterThan(400)
    }
  })

  it('never mutates or captures the live messages container', async () => {
    const live = liveMessagesContainer()
    const liveStyleBefore = live.getAttribute('style')
    const liveHtmlBefore = live.innerHTML

    await captureTopicExportImage({ topic: makeTopic('topic-target'), width: 900 })

    expect(capturedTarget()).not.toBe(live)
    expect(live.getAttribute('style')).toBe(liveStyleBefore)
    expect(live.innerHTML).toBe(liveHtmlBefore)
    expect(live.classList.contains('hide-scrollbar')).toBe(false)
  })

  it('addresses the explicitly supplied branch route of the exported topic', async () => {
    const outcome = await captureTopicExportImage({
      topic: makeTopic('topic-target'),
      branchId: 'branch-target',
      width: 900
    })

    expect(outcome.status).toBe('captured')
    expect(loadWholeTopicSnapshot).toHaveBeenCalledTimes(1)
    expect(loadWholeTopicSnapshot).toHaveBeenCalledWith('topic-target', 'branch-target')
  })

  it('addresses the main route when the route is omitted or explicitly null', async () => {
    const withoutRoute = await captureTopicExportImage({ topic: makeTopic('topic-target'), width: 900 })
    expect(withoutRoute.status).toBe('captured')
    expect(loadWholeTopicSnapshot).toHaveBeenLastCalledWith('topic-target', null)

    const withNullRoute = await captureTopicExportImage({
      topic: makeTopic('topic-target'),
      branchId: null,
      width: 900
    })
    expect(withNullRoute.status).toBe('captured')
    expect(loadWholeTopicSnapshot).toHaveBeenLastCalledWith('topic-target', null)
    expect(loadWholeTopicSnapshot).toHaveBeenCalledTimes(2)
  })

  it('reads the addressed route once, so the route cannot change while the export runs', async () => {
    let releaseCapture: (() => void) | undefined
    captureScrollable.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCapture = () => resolve({ width: 900, height: 4000, toDataURL: () => 'data:image/png;base64,x' })
        })
    )

    const pending = captureTopicExportImage({
      topic: makeTopic('topic-target'),
      branchId: 'branch-a',
      width: 900
    })
    await vi.waitFor(() => expect(captureScrollable).toHaveBeenCalledTimes(1))

    // The route is a value bound before the first await: the in-flight export
    // neither re-reads the route nor re-reads the snapshot.
    expect(loadWholeTopicSnapshot).toHaveBeenCalledTimes(1)
    expect(loadWholeTopicSnapshot).toHaveBeenCalledWith('topic-target', 'branch-a')
    expect(capturedTarget().querySelectorAll('[data-export-message-id]')).toHaveLength(FIXTURE_MESSAGE_COUNT)

    releaseCapture?.()
    expect((await pending).status).toBe('captured')
    expect(loadWholeTopicSnapshot).toHaveBeenCalledTimes(1)
    expect(loadWholeTopicSnapshot).toHaveBeenCalledWith('topic-target', 'branch-a')
  })

  it('renders the snapshot route only, never the rows of the live projection', async () => {
    const live = liveMessagesContainer()
    live.innerHTML =
      '<div data-message-id="live-only-1">live row</div><span data-export-message-id="live-only-1">live row</span>'

    await captureTopicExportImage({ topic: makeTopic('topic-target'), branchId: 'branch-target', width: 900 })

    const renderedIds = Array.from(capturedTarget().querySelectorAll('[data-export-message-id]')).map((element) =>
      element.getAttribute('data-export-message-id')
    )
    expect(renderedIds).not.toContain('live-only-1')
    expect(renderedIds).toHaveLength(FIXTURE_MESSAGE_COUNT)
    // The live projection is untouched and still holds its own rows.
    expect(live.querySelector('[data-message-id="live-only-1"]')).not.toBeNull()
  })

  it('removes the transient export host after a successful capture', async () => {
    await captureTopicExportImage({ topic: makeTopic('topic-target'), width: 900 })
    expect(exportHosts()).toHaveLength(0)
  })
  it('falls back to the canonical canvas width when the live width is unavailable', async () => {
    let hostWidth: string | undefined
    captureScrollable.mockImplementation(async (ref: { current: HTMLElement | null }) => {
      hostWidth = ref.current?.parentElement?.style.width
      return { width: 900, height: 4000, toDataURL: () => 'data:image/png;base64,x' }
    })

    await captureTopicExportImage({ topic: makeTopic('topic-target') })

    expect(hostWidth).toBe(`${TOPIC_EXPORT_CANVAS_WIDTH_FALLBACK}px`)
  })

  it('reports an empty topic without rendering a canvas', async () => {
    loadWholeTopicSnapshot.mockResolvedValue({
      ...createSnapshot(),
      messages: [],
      blocks: [],
      blocksById: new Map()
    })

    const outcome = await captureTopicExportImage({ topic: makeTopic('topic-target'), width: 900 })

    expect(outcome).toEqual({ status: 'empty' })
    expect(captureScrollable).not.toHaveBeenCalled()
    expect(exportHosts()).toHaveLength(0)
  })

  it('cleans up and reports failure when the capture throws', async () => {
    captureScrollable.mockRejectedValue(new Error('capture exploded'))

    const outcome = await captureTopicExportImage({ topic: makeTopic('topic-target'), width: 900 })

    expect(outcome.status).toBe('failed')
    expect(exportHosts()).toHaveLength(0)
  })

  it('reports the explicit dimension rejection and still cleans up', async () => {
    captureScrollable.mockRejectedValue(undefined)

    const outcome = await captureTopicExportImage({ topic: makeTopic('topic-target'), width: 900 })

    expect(outcome).toEqual({ status: 'too-large' })
    expect(exportHosts()).toHaveLength(0)
  })

  it('refuses a concurrent export instead of stacking canvases', async () => {
    let releaseCapture: (() => void) | undefined
    captureScrollable.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCapture = () => resolve({ width: 900, height: 4000, toDataURL: () => 'data:image/png;base64,x' })
        })
    )

    const first = captureTopicExportImage({ topic: makeTopic('topic-target'), width: 900 })
    await vi.waitFor(() => expect(captureScrollable).toHaveBeenCalledTimes(1))

    const second = await captureTopicExportImage({ topic: makeTopic('topic-target'), width: 900 })
    expect(second).toEqual({ status: 'busy' })

    releaseCapture?.()
    expect((await first).status).toBe('captured')
    expect(exportHosts()).toHaveLength(0)
  })

  it('renders inside an offscreen, non-interactive host', async () => {
    let hostStyle: CSSStyleDeclaration | undefined
    captureScrollable.mockImplementation(async () => {
      hostStyle = capturedTarget().parentElement?.style
      return { width: 900, height: 4000, toDataURL: () => 'data:image/png;base64,x' }
    })

    await captureTopicExportImage({ topic: makeTopic('topic-target'), width: 900 })

    expect(hostStyle?.position).toBe('fixed')
    expect(hostStyle?.pointerEvents).toBe('none')
    expect(hostStyle?.left).toBe('-100000px')
  })
})
