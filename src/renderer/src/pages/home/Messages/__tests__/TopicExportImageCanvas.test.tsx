import { createAntdThemeConfig } from '@renderer/context/antdThemeConfig'
import store from '@renderer/store'
import { ThemeMode, type Topic } from '@renderer/types'
import { type Message, type MessageBlock, MessageBlockType } from '@renderer/types/newMessage'
import { render, screen } from '@testing-library/react'
import { theme } from 'antd'
import { afterEach, describe, expect, it, vi } from 'vitest'

import TopicExportImageCanvas, { selectVisibleExportMessages } from '../TopicExportImageCanvas'

/**
 * Topic export canvas contract.
 *
 * The canvas is the caller-local render of a complete topic: chronological
 * order, every message beyond the default window, snapshot blocks injected per
 * message (never a Redux upsert), the existing multi-answer fold visibility,
 * and no `message-<id>` DOM anchors that could collide with the live rows.
 *
 * It also re-applies the app's antd configuration inside its own root: React
 * context does not cross the detached root, so without it the export renders
 * antd's light fallback while the page is dark (the exported thinking-block
 * header came out black-on-dark). The configuration must be the shared builder's
 * output for the live effective theme, and applying it must not touch the
 * global theme.
 */

const messageItemProps = vi.fn()

const { capturedThemeConfigs } = vi.hoisted(() => ({ capturedThemeConfigs: [] as any[] }))

vi.mock('antd', async () => {
  const actual: any = await vi.importActual('antd')
  return {
    ...actual,
    ConfigProvider: ({ theme: config, children }: any) => {
      capturedThemeConfigs.push(config)
      return children
    }
  }
})

vi.mock('../Message', () => ({
  default: (props: { message: Message; renderDomId?: boolean; hideMenuBar?: boolean }) => {
    messageItemProps(props)
    return <div data-testid={`item-${props.message.id}`}>{props.message.id}</div>
  }
}))

const makeTopic = (): Topic => ({ id: 'topic-1', name: 'Topic', assistantId: 'assistant-1' }) as unknown as Topic

const makeMessage = (id: string, overrides: Partial<Message> = {}): Message =>
  ({
    id,
    role: 'assistant',
    topicId: 'topic-1',
    blocks: [`block-${id}`],
    content: '',
    ...overrides
  }) as unknown as Message

const blocksById = new Map<string, MessageBlock>([
  ['block-msg-1', { id: 'block-msg-1', type: MessageBlockType.MAIN_TEXT, content: 'first' } as unknown as MessageBlock]
])

afterEach(() => {
  capturedThemeConfigs.length = 0
  document.body.removeAttribute('theme-mode')
  document.documentElement.classList.remove('dark', 'light')
  vi.restoreAllMocks()
})

describe('selectVisibleExportMessages', () => {
  it('keeps a complete chronological list, not a bounded window', () => {
    const messages = Array.from({ length: 40 }, (_, index) =>
      makeMessage(`msg-${index + 1}`, { role: index % 2 === 0 ? 'user' : 'assistant' })
    )

    const visible = selectVisibleExportMessages(messages)

    expect(visible).toHaveLength(40)
    expect(visible[0].id).toBe('msg-1')
    expect(visible[39].id).toBe('msg-40')
  })

  it('keeps exactly one member of a multi-answer group (fold visibility)', () => {
    const group = [
      makeMessage('answer-a', { askId: 'ask-1' }),
      makeMessage('answer-b', { askId: 'ask-1', foldSelected: true }),
      makeMessage('answer-c', { askId: 'ask-1' })
    ]

    expect(selectVisibleExportMessages(group).map((message) => message.id)).toEqual(['answer-b'])
  })

  it('falls back to the first member when the group has no selected answer', () => {
    const group = [makeMessage('answer-a', { askId: 'ask-1' }), makeMessage('answer-b', { askId: 'ask-1' })]

    expect(selectVisibleExportMessages(group).map((message) => message.id)).toEqual(['answer-a'])
  })

  it('does not fold independent answers that belong to different questions', () => {
    const messages = [makeMessage('answer-a', { askId: 'ask-1' }), makeMessage('answer-b', { askId: 'ask-2' })]

    expect(selectVisibleExportMessages(messages).map((message) => message.id)).toEqual(['answer-a', 'answer-b'])
  })
})

describe('TopicExportImageCanvas', () => {
  it('renders every message with the snapshot blocks injected and no live DOM anchors', () => {
    messageItemProps.mockReset()
    const messages = Array.from({ length: 12 }, (_, index) =>
      makeMessage(`msg-${index + 1}`, { role: index % 2 === 0 ? 'user' : 'assistant' })
    )

    render(
      <TopicExportImageCanvas
        topic={makeTopic()}
        messages={messages}
        blocksById={blocksById}
        width={720}
        themeMode={ThemeMode.light}
      />
    )

    expect(screen.getAllByTestId(/^item-/)).toHaveLength(12)
    expect(screen.getByTestId('item-msg-1')).toBeInTheDocument()
    expect(screen.getByTestId('item-msg-12')).toBeInTheDocument()

    const firstCall = messageItemProps.mock.calls[0][0] as {
      renderDomId?: boolean
      hideMenuBar?: boolean
      snapshotBlocksById?: Map<string, MessageBlock>
    }
    expect(firstCall.renderDomId).toBe(false)
    expect(firstCall.hideMenuBar).toBe(true)
    expect(firstCall.snapshotBlocksById).toBe(blocksById)
    // Every rendered message resolves blocks from the same caller-local map.
    for (const call of messageItemProps.mock.calls) {
      expect((call[0] as { snapshotBlocksById?: Map<string, MessageBlock> }).snapshotBlocksById).toBe(blocksById)
    }
  })

  it('lays the canvas out at the requested width inside a bubble container', () => {
    messageItemProps.mockReset()
    const { container } = render(
      <TopicExportImageCanvas
        topic={makeTopic()}
        messages={[makeMessage('msg-1')]}
        blocksById={blocksById}
        width={720}
        themeMode={ThemeMode.light}
      />
    )

    const canvas = container.querySelector('[data-topic-export-content]') as HTMLElement
    expect(canvas).not.toBeNull()
    expect(canvas.classList.contains('bubble')).toBe(true)
    expect(canvas.style.width).toBe('720px')
    expect(container.querySelector('#messages')).toBeNull()
  })

  it('renders with the live dark antd configuration (shared builder output)', () => {
    const colorPrimary = store.getState().settings.userTheme.colorPrimary
    document.body.setAttribute('theme-mode', ThemeMode.dark)

    render(
      <TopicExportImageCanvas
        topic={makeTopic()}
        messages={[makeMessage('msg-1')]}
        blocksById={blocksById}
        width={720}
        themeMode={ThemeMode.dark}
      />
    )

    expect(capturedThemeConfigs).toHaveLength(1)
    expect(capturedThemeConfigs[0]).toEqual(createAntdThemeConfig({ themeMode: ThemeMode.dark, colorPrimary }))
    expect(capturedThemeConfigs[0].algorithm).toEqual([theme.darkAlgorithm])
  })

  it('renders with the shared light antd configuration', () => {
    const colorPrimary = store.getState().settings.userTheme.colorPrimary
    document.body.setAttribute('theme-mode', ThemeMode.light)

    render(
      <TopicExportImageCanvas
        topic={makeTopic()}
        messages={[makeMessage('msg-1')]}
        blocksById={blocksById}
        width={720}
        themeMode={ThemeMode.light}
      />
    )

    expect(capturedThemeConfigs).toHaveLength(1)
    expect(capturedThemeConfigs[0]).toEqual(createAntdThemeConfig({ themeMode: ThemeMode.light, colorPrimary }))
    expect(capturedThemeConfigs[0].algorithm).toEqual([theme.defaultAlgorithm])
  })

  it('does not change the global theme or persisted state while rendering', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    document.body.setAttribute('theme-mode', ThemeMode.dark)
    const rootClassNameBefore = document.documentElement.className

    render(
      <TopicExportImageCanvas
        topic={makeTopic()}
        messages={[makeMessage('msg-1')]}
        blocksById={blocksById}
        width={720}
        themeMode={ThemeMode.dark}
      />
    )

    expect(document.body.getAttribute('theme-mode')).toBe(ThemeMode.dark)
    expect(document.documentElement.className).toBe(rootClassNameBefore)
    expect(setItem).not.toHaveBeenCalled()
  })
})
