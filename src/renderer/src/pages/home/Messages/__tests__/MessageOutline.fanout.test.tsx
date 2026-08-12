import { configureStore } from '@reduxjs/toolkit'
import messageBlocksReducer, { updateOneBlock, upsertManyBlocks } from '@renderer/store/messageBlock'
import type { MainTextMessageBlock, Message } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { act, render } from '@testing-library/react'
import { Profiler, type ProfilerOnRenderCallback } from 'react'
import { Provider } from 'react-redux'
import { describe, expect, it } from 'vitest'

import MessageOutline from '../MessageOutline'

/**
 * LOCK-003 fan-out regression for MessageOutline.
 *
 * The outline must subscribe only to its own message's blocks. When an
 * unrelated streaming block commits, the outline must not re-render or
 * re-parse headings.
 */

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

describe('MessageOutline fan-out (LOCK-003)', () => {
  it('does not re-render or re-parse headings for unrelated block updates', () => {
    const store = createStore()
    store.dispatch(
      upsertManyBlocks([
        makeMainTextBlock('block-a', '# Heading A\n\ncontent a'),
        makeMainTextBlock('block-b', '# Heading B\n\ncontent b')
      ])
    )

    const commits = { a: 0, b: 0 }
    const onRender: ProfilerOnRenderCallback = (id) => {
      commits[id as 'a' | 'b']++
    }

    render(
      <Provider store={store}>
        <Profiler id="a" onRender={onRender}>
          <MessageOutline message={makeMessage('msg-a', ['block-a'])} />
        </Profiler>
        <Profiler id="b" onRender={onRender}>
          <MessageOutline message={makeMessage('msg-b', ['block-b'])} />
        </Profiler>
      </Provider>
    )

    expect(commits.a).toBe(1)
    expect(commits.b).toBe(1)

    // A's own block updates (heading changes as content streams) — only the
    // owning outline re-renders and re-parses its headings.
    act(() => {
      store.dispatch(updateOneBlock({ id: 'block-a', changes: { content: '# Heading A2\n\nmore content' } }))
    })

    expect(commits.a).toBe(2)
    expect(commits.b).toBe(1)
  })

  it('keeps its own headings correct after the owning block updates', () => {
    const store = createStore()
    store.dispatch(upsertManyBlocks([makeMainTextBlock('block-a', '# First\n\ntext')]))

    const { getByText } = render(
      <Provider store={store}>
        <MessageOutline message={makeMessage('msg-a', ['block-a'])} />
      </Provider>
    )

    expect(getByText('First')).toBeInTheDocument()

    act(() => {
      store.dispatch(updateOneBlock({ id: 'block-a', changes: { content: '# Second\n\nupdated' } }))
    })

    expect(getByText('Second')).toBeInTheDocument()
  })
})
