import { configureStore } from '@reduxjs/toolkit'
import messageBlocksReducer, { upsertManyBlocks } from '@renderer/store/messageBlock'
import type { MainTextMessageBlock, Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { describe, expect, it, vi } from 'vitest'

import MessageBlockRenderer from '../index'

/**
 * Waiting-dots presentation: the loading placeholder must appear immediately
 * with the assistant header (static outer wrapper, no fade/slide entry).
 * BeatLoader keeps its own loop; real content blocks keep their animation.
 */

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: any) => <>{children}</>,
  motion: {
    div: ({ children, initial, animate, variants, ...rest }: any) => {
      void variants
      return (
        <div data-initial={initial} data-animate={animate} {...rest}>
          {children}
        </div>
      )
    }
  }
}))

vi.mock('../BlockErrorFallback', () => ({ default: () => null }))
vi.mock('../CitationBlock', () => ({ default: () => null }))
vi.mock('../ErrorBlock', () => ({ default: () => null }))
vi.mock('../FileBlock', () => ({ default: () => null }))
vi.mock('../ImageBlock', () => ({ default: () => null }))
vi.mock('../ThinkingBlock', () => ({ default: () => null }))
vi.mock('../ToolBlock', () => ({ default: () => null }))
vi.mock('../ToolBlockGroup', () => ({ default: () => null }))
vi.mock('../TranslationBlock', () => ({ default: () => null }))
vi.mock('../VideoBlock', () => ({ default: () => null }))
vi.mock('../MainTextBlock', () => ({
  __esModule: true,
  default: ({ block }: any) => <div data-testid={`main-text-${block.id}`}>{block.content}</div>
}))

const makeMessage = (id: string, blocks: string[], status: AssistantMessageStatus): Message =>
  ({
    id,
    topicId: 'topic-1',
    role: 'assistant',
    assistantId: 'asst-1',
    askId: `ask-${id}`,
    blocks,
    model: { provider: 'openai', id: 'gpt-4' },
    status,
    type: 'message'
  }) as unknown as Message

const createStore = () =>
  configureStore({
    reducer: { messageBlocks: messageBlocksReducer }
  })

const placeholderWrapper = (container: HTMLElement): HTMLElement | null => {
  const wrappers = Array.from(container.querySelectorAll('.block-wrapper'))
  // The placeholder is the only wrapper rendering BeatLoader dots (spans)
  // when no body block is present; with a body block it renders last.
  const withDots = wrappers.filter((w) => w.querySelector('span') && !w.querySelector('[data-testid^="main-text-"]'))
  return (withDots[withDots.length - 1] as HTMLElement | undefined) ?? null
}

describe('MessageBlockRenderer waiting-dots placeholder', () => {
  it.each([AssistantMessageStatus.PENDING, AssistantMessageStatus.PROCESSING, AssistantMessageStatus.SEARCHING])(
    'shows dots immediately with a static outer wrapper while %s',
    (status) => {
      const store = createStore()
      const message = makeMessage('msg-waiting', [], status)

      const { container } = render(
        <Provider store={store}>
          <MessageBlockRenderer blocks={[]} message={message} />
        </Provider>
      )

      const wrapper = placeholderWrapper(container)
      expect(wrapper).not.toBeNull()
      // BeatLoader dots render inside the placeholder.
      expect(wrapper!.querySelector('span')).not.toBeNull()
      // No fade/slide entry: static opacity-1/x-0 wrapper state.
      expect(wrapper!.getAttribute('data-initial')).toBe('static')
      expect(wrapper!.getAttribute('data-animate')).toBe('static')
    }
  )

  it.each([AssistantMessageStatus.SUCCESS, AssistantMessageStatus.PAUSED, AssistantMessageStatus.ERROR])(
    'hides dots once terminal (%s)',
    (status) => {
      const store = createStore()
      const message = makeMessage('msg-done', [], status)

      const { container } = render(
        <Provider store={store}>
          <MessageBlockRenderer blocks={[]} message={message} />
        </Provider>
      )

      expect(placeholderWrapper(container)).toBeNull()
      expect(container.querySelector('.block-wrapper')).toBeNull()
    }
  )

  it('keeps real content-block entry animation unchanged', () => {
    const block: MainTextMessageBlock = {
      id: 'block-body',
      messageId: 'msg-body',
      type: MessageBlockType.MAIN_TEXT,
      status: MessageBlockStatus.SUCCESS,
      createdAt: new Date().toISOString(),
      content: 'hello'
    }

    const store = createStore()
    store.dispatch(upsertManyBlocks([block]))

    const streaming = render(
      <Provider store={store}>
        <MessageBlockRenderer
          blocks={[block.id]}
          message={makeMessage('msg-body', [block.id], AssistantMessageStatus.PROCESSING)}
        />
      </Provider>
    )
    const bodyWrapper = streaming.container
      .querySelector('[data-testid="main-text-block-body"]')
      ?.closest('.block-wrapper')
    expect(bodyWrapper?.getAttribute('data-initial')).toBe('hidden')
    expect(bodyWrapper?.getAttribute('data-animate')).toBe('visible')
    streaming.unmount()

    const settled = render(
      <Provider store={store}>
        <MessageBlockRenderer
          blocks={[block.id]}
          message={makeMessage('msg-body', [block.id], AssistantMessageStatus.SUCCESS)}
        />
      </Provider>
    )
    const settledWrapper = settled.container
      .querySelector('[data-testid="main-text-block-body"]')
      ?.closest('.block-wrapper')
    expect(settledWrapper?.getAttribute('data-initial')).toBe('static')
    expect(settledWrapper?.getAttribute('data-animate')).toBe('static')
  })
})
