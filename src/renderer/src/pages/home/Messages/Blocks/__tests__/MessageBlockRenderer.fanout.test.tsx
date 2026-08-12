import { configureStore } from '@reduxjs/toolkit'
import { updateOneBlock, upsertManyBlocks } from '@renderer/store/messageBlock'
import messageBlocksReducer from '@renderer/store/messageBlock'
import type { MainTextMessageBlock, Message } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { act, render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import MessageBlockRenderer from '../index'

/**
 * LOCK-003 fan-out regression tests.
 *
 * MessageBlockRenderer must subscribe only to its own message's blocks. When
 * one streaming block commits to the store, the owning message re-renders but
 * every other visible message's renderer must stay untouched.
 */

const spies = vi.hoisted(() => ({ renderCount: new Map<string, number>() }))

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: any) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>
  }
}))

vi.mock('../BlockErrorFallback', () => ({ default: () => null }))
vi.mock('../CitationBlock', () => ({ default: () => null }))
vi.mock('../ErrorBlock', () => ({ default: () => null }))
vi.mock('../FileBlock', () => ({ default: () => null }))
vi.mock('../ImageBlock', () => ({ default: () => null }))
vi.mock('../PlaceholderBlock', () => ({ default: () => null }))
vi.mock('../ThinkingBlock', () => ({ default: () => null }))
vi.mock('../ToolBlock', () => ({ default: () => null }))
vi.mock('../ToolBlockGroup', () => ({ default: () => null }))
vi.mock('../TranslationBlock', () => ({ default: () => null }))
vi.mock('../VideoBlock', () => ({ default: () => null }))

// Render-counting MainTextBlock: the observable unit whose re-renders are the
// streaming fan-out cost (it feeds Markdown).
vi.mock('../MainTextBlock', () => ({
  __esModule: true,
  default: ({ block }: any) => {
    spies.renderCount.set(block.id, (spies.renderCount.get(block.id) ?? 0) + 1)
    return <div data-testid={`main-text-${block.id}`}>{block.content}</div>
  }
}))

const makeMainTextBlock = (id: string, content: string): MainTextMessageBlock => ({
  id,
  messageId: `msg-${id}`,
  type: MessageBlockType.MAIN_TEXT,
  status: MessageBlockStatus.SUCCESS,
  createdAt: new Date().toISOString(),
  content
})

const makeMessage = (id: string, blocks: string[]): Message =>
  ({
    id,
    topicId: 'topic-1',
    role: 'assistant',
    assistantId: 'asst-1',
    askId: `ask-${id}`,
    blocks,
    model: { provider: 'openai', id: 'gpt-4' },
    status: 'success',
    type: 'message'
  }) as unknown as Message

const createStore = () =>
  configureStore({
    reducer: { messageBlocks: messageBlocksReducer }
  })

describe('MessageBlockRenderer fan-out (LOCK-003)', () => {
  beforeEach(() => {
    spies.renderCount.clear()
  })

  it('does not re-render an unrelated visible message when one block updates', () => {
    const store = createStore()
    store.dispatch(
      upsertManyBlocks([makeMainTextBlock('block-a', 'A original'), makeMainTextBlock('block-b', 'B text')])
    )

    render(
      <Provider store={store}>
        <MessageBlockRenderer blocks={['block-a']} message={makeMessage('msg-a', ['block-a'])} />
        <MessageBlockRenderer blocks={['block-b']} message={makeMessage('msg-b', ['block-b'])} />
      </Provider>
    )

    expect(spies.renderCount.get('block-a')).toBe(1)
    expect(spies.renderCount.get('block-b')).toBe(1)

    // A block update for message A only (the streaming commit path).
    act(() => {
      store.dispatch(updateOneBlock({ id: 'block-a', changes: { content: 'A updated content' } }))
    })

    // Owning message re-renders with the new content…
    expect(spies.renderCount.get('block-a')).toBe(2)
    // …but the unrelated visible message does not re-render at all.
    expect(spies.renderCount.get('block-b')).toBe(1)
  })

  it('renders newly added blocks for the owning message without re-rendering unrelated messages', () => {
    const store = createStore()
    store.dispatch(
      upsertManyBlocks([makeMainTextBlock('block-a', 'A original'), makeMainTextBlock('block-b', 'B text')])
    )

    // Stable message references, like the real viewport tree keeps during
    // streaming (only the owning message's blocks array changes).
    const msgA = makeMessage('msg-a', ['block-a'])
    const msgB = makeMessage('msg-b', ['block-b'])

    const { rerender } = render(
      <Provider store={store}>
        <MessageBlockRenderer blocks={msgA.blocks} message={msgA} />
        <MessageBlockRenderer blocks={msgB.blocks} message={msgB} />
      </Provider>
    )

    // A new block is appended to message A (block transition) and committed.
    store.dispatch(upsertManyBlocks([makeMainTextBlock('block-a2', 'A second block')]))

    rerender(
      <Provider store={store}>
        <MessageBlockRenderer blocks={['block-a', 'block-a2']} message={msgA} />
        <MessageBlockRenderer blocks={msgB.blocks} message={msgB} />
      </Provider>
    )

    // The owning message renders its new block…
    expect(spies.renderCount.get('block-a2')).toBe(1)
    // …and the unrelated message is still untouched.
    expect(spies.renderCount.get('block-b')).toBe(1)
  })

  it('re-renders the owning message when its own block content changes', () => {
    const store = createStore()
    store.dispatch(upsertManyBlocks([makeMainTextBlock('block-a', 'before'), makeMainTextBlock('block-b', 'B')]))

    const { getByTestId } = render(
      <Provider store={store}>
        <MessageBlockRenderer blocks={['block-a']} message={makeMessage('msg-a', ['block-a'])} />
        <MessageBlockRenderer blocks={['block-b']} message={makeMessage('msg-b', ['block-b'])} />
      </Provider>
    )

    act(() => {
      store.dispatch(updateOneBlock({ id: 'block-a', changes: { content: 'after' } }))
    })

    expect(getByTestId('main-text-block-a')).toHaveTextContent('after')
    expect(spies.renderCount.get('block-a')).toBe(2)
    expect(spies.renderCount.get('block-b')).toBe(1)
  })
})
