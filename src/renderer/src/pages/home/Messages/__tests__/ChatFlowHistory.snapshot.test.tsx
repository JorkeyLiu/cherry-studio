import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { act, render, screen, waitFor } from '@testing-library/react'
import type * as XyflowReactModule from '@xyflow/react'
import type * as ReactI18nextModule from 'react-i18next'
import type * as ReactReduxModule from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ChatFlowHistory, {
  buildChatFlowGraph,
  CHAT_FLOW_SNAPSHOT_REFRESH_DEBOUNCE_MS,
  nodeTypes
} from '../ChatFlowHistory'

const mocks = vi.hoisted(() => ({
  loadWholeTopicSnapshot: vi.fn(),
  messageCompleteHandlers: new Set<(payload: any) => void>(),
  seenSelectors: [] as Array<(state: any) => any>,
  state: {
    assistants: {
      assistants: [
        {
          id: 'assistant-1',
          topics: [
            { id: 'topic-1', updatedAt: 'updated-1' },
            { id: 'topic-2', updatedAt: 'updated-2' }
          ]
        }
      ]
    }
  } as any
}))

vi.mock('@renderer/utils/topicSnapshot', () => ({
  loadWholeTopicSnapshot: mocks.loadWholeTopicSnapshot
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => ({ userName: 'TestUser' })
}))

vi.mock('@renderer/context/ThemeProvider', () => ({
  useTheme: () => ({ settedTheme: 'light' })
}))

vi.mock('@renderer/hooks/useAvatar', () => ({
  default: () => 'avatar-url'
}))

vi.mock('@renderer/components/Avatar/EmojiAvatar', () => ({
  default: ({ children }: any) => <div>{children}</div>
}))

vi.mock('@renderer/components/Avatar/ModelAvatar', () => ({
  default: () => <div data-testid="model-avatar" />
}))

vi.mock('react-redux', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactReduxModule>()
  const useSelector = (selector: (state: any) => any) => {
    mocks.seenSelectors.push(selector)
    return selector(mocks.state)
  }
  // Preserve react-redux v9 typed-hook factories used by the real store module.
  ;(useSelector as any).withTypes = () => useSelector
  return {
    ...actual,
    useSelector
  }
})

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactI18nextModule>()
  // Stable t identity across renders: the component rebuilds its graph when t
  // changes (like the real react-i18next stable t), so a fresh arrow per
  // render would cause an infinite render loop.
  const t = (key: string) => key
  return {
    ...actual,
    useTranslation: () => ({ t, i18n: { language: 'en' } })
  }
})

vi.mock('@renderer/services/EventService', () => ({
  EVENT_NAMES: {
    MESSAGE_COMPLETE: 'MESSAGE_COMPLETE',
    NAVIGATE_TO_MESSAGE: 'NAVIGATE_TO_MESSAGE'
  },
  EventEmitter: {
    on: vi.fn((event: string, handler: (payload: any) => void) => {
      if (event === 'MESSAGE_COMPLETE') {
        mocks.messageCompleteHandlers.add(handler)
      }
      return () => {
        mocks.messageCompleteHandlers.delete(handler)
      }
    }),
    emit: vi.fn((event: string, payload?: any) => {
      if (event === 'MESSAGE_COMPLETE') {
        mocks.messageCompleteHandlers.forEach((handler) => handler(payload))
      }
    }),
    off: vi.fn()
  }
}))

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof XyflowReactModule>()
  const MockFlow = ({ nodes }: any) => (
    <div data-testid="flow">
      {(nodes ?? []).map((node: any) => (
        <div key={node.id} data-testid={`node-${node.id}`} data-message-id={node.data?.messageId}>
          {node.data?.content}
        </div>
      ))}
    </div>
  )
  return {
    ...actual,
    ReactFlow: MockFlow,
    ReactFlowProvider: ({ children }: any) => <>{children}</>,
    Controls: () => null,
    MiniMap: () => null,
    Handle: () => null
  }
})

const t = (key: string) => key

const makeTextBlock = (id: string, messageId: string, content: string): MessageBlock =>
  ({
    id,
    messageId,
    type: MessageBlockType.MAIN_TEXT,
    content,
    status: MessageBlockStatus.SUCCESS,
    createdAt: '2026-01-01T00:00:00.000Z'
  }) as unknown as MessageBlock

const makeMessage = (overrides: Partial<Message> & { id: string; role: Message['role'] }): Message =>
  ({
    assistantId: 'assistant-1',
    topicId: 'topic-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'success',
    blocks: [],
    ...overrides
  }) as Message

const snapshotOf = (messages: Message[], blocks: MessageBlock[]) => {
  const blocksById = new Map(blocks.map((block) => [block.id, block]))
  return {
    messages,
    blocks,
    blocksById,
    snapshot: { topicId: 'topic-1', messageCount: messages.length, blockCount: blocks.length }
  }
}

const twoTurnFixture = () => {
  const u1 = makeMessage({ id: 'u1', role: 'user', createdAt: '2026-01-01T00:00:01.000Z', blocks: ['b-u1'] })
  const a1 = makeMessage({
    id: 'a1',
    role: 'assistant',
    askId: 'u1',
    createdAt: '2026-01-01T00:00:02.000Z',
    blocks: ['b-a1'],
    model: { id: 'm1', name: 'Model One' } as any
  })
  const u2 = makeMessage({ id: 'u2', role: 'user', createdAt: '2026-01-01T00:00:03.000Z', blocks: ['b-u2'] })
  const a2 = makeMessage({
    id: 'a2',
    role: 'assistant',
    askId: 'u2',
    createdAt: '2026-01-01T00:00:04.000Z',
    blocks: ['b-a2'],
    model: { id: 'm1', name: 'Model One' } as any
  })
  const blocks = [
    makeTextBlock('b-u1', 'u1', 'first question'),
    makeTextBlock('b-a1', 'a1', 'first answer'),
    makeTextBlock('b-u2', 'u2', 'second question'),
    makeTextBlock('b-a2', 'a2', 'second answer')
  ]
  return { messages: [u1, a1, u2, a2], blocks }
}

if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: () => false,
      onchange: null
    }))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.messageCompleteHandlers.clear()
  mocks.seenSelectors.length = 0
  mocks.state.assistants.assistants[0].topics = [
    { id: 'topic-1', updatedAt: 'updated-1' },
    { id: 'topic-2', updatedAt: 'updated-2' }
  ]
})

describe('buildChatFlowGraph (pure snapshot builder)', () => {
  it('builds chronological user/assistant nodes with snapshot text', () => {
    const { messages, blocks } = twoTurnFixture()
    const { blocksById } = snapshotOf(messages, blocks)
    const { nodes, edges } = buildChatFlowGraph(messages, blocksById, {
      userName: 'TestUser',
      userAvatar: null,
      t
    })

    expect(nodes.map((node) => node.id)).toEqual(['user-u1', 'assistant-a1', 'user-u2', 'assistant-a2'])
    const byId = new Map(nodes.map((node) => [node.id, node]))
    expect(byId.get('user-u1')?.data.content).toBe('first question')
    expect(byId.get('assistant-a1')?.data.content).toBe('first answer')
    expect(byId.get('assistant-a1')?.data.messageId).toBe('a1')
    expect(byId.get('assistant-a1')?.data.model).toBe('Model One')
    // Edge emission order matches the builder: each user turn emits its own
    // user->assistant edges first; the cross-turn assistant->user edge is
    // appended when the following user turn is processed.
    expect(edges.map((edge) => `${edge.source}->${edge.target}`)).toEqual([
      'user-u1->assistant-a1',
      'user-u2->assistant-a2',
      'assistant-a1->user-u2'
    ])
  })

  it('includes old/window-outside messages passed in the complete snapshot', () => {
    const old = makeMessage({ id: 'old', role: 'user', createdAt: '2020-01-01T00:00:00.000Z', blocks: ['b-old'] })
    const { messages, blocks } = twoTurnFixture()
    const all = [old, ...messages]
    const { blocksById } = snapshotOf(all, [makeTextBlock('b-old', 'old', 'ancient question'), ...blocks])
    const { nodes } = buildChatFlowGraph(all, blocksById, { userName: 'TestUser', userAvatar: null, t })
    expect(nodes.some((node) => node.id === 'user-old')).toBe(true)
    expect(nodes.find((node) => node.id === 'user-old')?.data.content).toBe('ancient question')
  })

  it('fans out multiple assistant responses from one user node', () => {
    const u1 = makeMessage({ id: 'u1', role: 'user', createdAt: '2026-01-01T00:00:01.000Z', blocks: ['b-u1'] })
    const a1 = makeMessage({ id: 'a1', role: 'assistant', createdAt: '2026-01-01T00:00:02.000Z', blocks: ['b-a1'] })
    const a2 = makeMessage({ id: 'a2', role: 'assistant', createdAt: '2026-01-01T00:00:03.000Z', blocks: ['b-a2'] })
    const blocks = [
      makeTextBlock('b-u1', 'u1', 'q'),
      makeTextBlock('b-a1', 'a1', 'r1'),
      makeTextBlock('b-a2', 'a2', 'r2')
    ]
    const { blocksById } = snapshotOf([u1, a1, a2], blocks)
    const { nodes, edges } = buildChatFlowGraph([u1, a1, a2], blocksById, {
      userName: 'TestUser',
      userAvatar: null,
      t
    })
    expect(nodes.map((node) => node.id)).toEqual(['user-u1', 'assistant-a1', 'assistant-a2'])
    expect(edges.map((edge) => `${edge.source}->${edge.target}`)).toEqual([
      'user-u1->assistant-a1',
      'user-u1->assistant-a2'
    ])
  })

  it('keeps orphan assistant messages as top orphan nodes', () => {
    const orphan = makeMessage({
      id: 'orphan',
      role: 'assistant',
      createdAt: '2026-01-01T00:00:01.000Z',
      blocks: ['b-orphan'],
      model: { id: 'm9', name: 'Orphan Model' } as any
    })
    const { blocksById } = snapshotOf([orphan], [makeTextBlock('b-orphan', 'orphan', 'orphan text')])
    const { nodes } = buildChatFlowGraph([orphan], blocksById, { userName: 'TestUser', userAvatar: null, t })
    expect(nodes).toHaveLength(1)
    expect(nodes[0].id).toBe('orphan-assistant-orphan')
    expect(nodes[0].data.messageId).toBe('orphan')
    expect(nodes[0].data.content).toBe('orphan text')
  })

  it('returns empty for empty snapshots', () => {
    const { nodes, edges } = buildChatFlowGraph([], new Map(), { userName: 'TestUser', userAvatar: null, t })
    expect(nodes).toEqual([])
    expect(edges).toEqual([])
  })
})

describe('ChatFlowHistory snapshot wiring', () => {
  it('loads the whole-topic snapshot on mount and renders snapshot text', async () => {
    const { messages, blocks } = twoTurnFixture()
    mocks.loadWholeTopicSnapshot.mockResolvedValueOnce(snapshotOf(messages, blocks))

    render(<ChatFlowHistory conversationId="topic-1" />)
    expect(mocks.loadWholeTopicSnapshot).toHaveBeenCalledWith('topic-1', null)

    await waitFor(() => expect(screen.getByTestId('flow')).toBeInTheDocument())
    expect(screen.getByTestId('node-user-u1')).toHaveTextContent('first question')
    expect(screen.getByTestId('node-assistant-a1')).toHaveTextContent('first answer')
    expect(screen.getByTestId('node-assistant-a1')).toHaveAttribute('data-message-id', 'a1')
  })

  it('shows empty state for empty snapshots and NOT_FOUND without phantom UI', async () => {
    mocks.loadWholeTopicSnapshot.mockResolvedValueOnce(snapshotOf([], []))
    const { unmount } = render(<ChatFlowHistory conversationId="topic-1" />)
    await waitFor(() => expect(screen.getByText('chat.history.no_messages')).toBeInTheDocument())
    unmount()

    const notFound = new Error('missing topic')
    ;(notFound as any).code = 'NOT_FOUND'
    mocks.loadWholeTopicSnapshot.mockRejectedValueOnce(notFound)
    render(<ChatFlowHistory conversationId="topic-2" />)
    await waitFor(() => expect(screen.getByText('chat.history.no_messages')).toBeInTheDocument())
  })

  it('retains last good snapshot when background refetch fails', async () => {
    const { messages, blocks } = twoTurnFixture()
    mocks.loadWholeTopicSnapshot.mockResolvedValueOnce(snapshotOf(messages, blocks))
    const { EventEmitter } = await import('@renderer/services/EventService')

    const { rerender } = render(<ChatFlowHistory conversationId="topic-1" />)
    await waitFor(() => expect(screen.getByTestId('flow')).toBeInTheDocument())
    expect(screen.getByTestId('node-user-u1')).toHaveTextContent('first question')

    // updatedAt change + MESSAGE_COMPLETE share one debounced refetch; it rejects.
    mocks.loadWholeTopicSnapshot.mockRejectedValueOnce(new Error('background refetch boom'))
    mocks.state.assistants.assistants[0].topics = [
      { id: 'topic-1', updatedAt: 'updated-1b' },
      { id: 'topic-2', updatedAt: 'updated-2' }
    ]
    await act(async () => {
      rerender(<ChatFlowHistory conversationId="topic-1" />)
      EventEmitter.emit('MESSAGE_COMPLETE', { topicId: 'topic-1' })
    })
    await waitFor(() => expect(mocks.loadWholeTopicSnapshot).toHaveBeenCalledTimes(2), { timeout: 3000 })

    // Old graph remains visible; snapshot is not nulled to the empty state.
    await waitFor(() => expect(screen.getByTestId('node-user-u1')).toHaveTextContent('first question'), {
      timeout: 3000
    })
    expect(screen.getByTestId('flow')).toBeInTheDocument()
    expect(screen.getByTestId('node-assistant-a1')).toHaveTextContent('first answer')
    expect(screen.queryByText('chat.history.no_messages')).not.toBeInTheDocument()
  })

  it('subscribes only to the current topic updatedAt, never message stores', async () => {
    const { messages, blocks } = twoTurnFixture()
    mocks.loadWholeTopicSnapshot.mockResolvedValueOnce(snapshotOf(messages, blocks))
    render(<ChatFlowHistory conversationId="topic-1" />)
    await waitFor(() => expect(screen.getByTestId('flow')).toBeInTheDocument())

    expect(mocks.seenSelectors.length).toBeGreaterThan(0)
    const guarded = new Proxy(mocks.state, {
      get(target, prop) {
        if (prop === 'messages' || prop === 'messageBlocks' || prop === 'newMessage') {
          throw new Error(`selector read forbidden store slice: ${String(prop)}`)
        }
        return target[prop]
      }
    })
    for (const selector of mocks.seenSelectors) {
      expect(() => selector(guarded)).not.toThrow()
    }
    expect(mocks.seenSelectors.map((selector) => selector(mocks.state))).toContain('updated-1')
  })

  it('rejects stale responses when the topic changes mid-flight', async () => {
    const first = twoTurnFixture()
    const secondU = makeMessage({
      id: 'u9',
      role: 'user',
      topicId: 'topic-2',
      createdAt: '2026-02-01T00:00:01.000Z',
      blocks: ['b-u9']
    })
    let resolveFirst!: (value: any) => void
    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve
    })
    mocks.loadWholeTopicSnapshot.mockImplementationOnce(() => firstPromise)
    mocks.loadWholeTopicSnapshot.mockResolvedValueOnce(
      snapshotOf([secondU], [makeTextBlock('b-u9', 'u9', 'topic two')])
    )

    const { rerender } = render(<ChatFlowHistory conversationId="topic-1" />)
    rerender(<ChatFlowHistory conversationId="topic-2" />)
    await waitFor(() => expect(screen.getByTestId('node-user-u9')).toBeInTheDocument())

    await act(async () => {
      resolveFirst(snapshotOf(first.messages, first.blocks))
    })
    // Stale topic-1 payload must not overwrite the current topic-2 graph.
    expect(screen.queryByTestId('node-user-u1')).not.toBeInTheDocument()
    expect(screen.getByTestId('node-user-u9')).toHaveTextContent('topic two')
    expect(mocks.loadWholeTopicSnapshot).toHaveBeenCalledWith('topic-1', null)
    expect(mocks.loadWholeTopicSnapshot).toHaveBeenCalledWith('topic-2', null)
  })

  it('refetches on updatedAt change and MESSAGE_COMPLETE, coalesced without polling', async () => {
    vi.useFakeTimers()
    try {
      const { messages, blocks } = twoTurnFixture()
      mocks.loadWholeTopicSnapshot.mockResolvedValue(snapshotOf(messages, blocks))
      const { EventEmitter } = await import('@renderer/services/EventService')

      const { rerender } = render(<ChatFlowHistory conversationId="topic-1" />)
      await act(async () => {})
      expect(mocks.loadWholeTopicSnapshot).toHaveBeenCalledTimes(1)

      // No interval polling while idle.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })
      expect(mocks.loadWholeTopicSnapshot).toHaveBeenCalledTimes(1)

      // updatedAt change + terminal streaming event coalesce into one refetch.
      mocks.state.assistants.assistants[0].topics = [
        { id: 'topic-1', updatedAt: 'updated-1b' },
        { id: 'topic-2', updatedAt: 'updated-2' }
      ]
      rerender(<ChatFlowHistory conversationId="topic-1" />)
      await act(async () => {
        EventEmitter.emit('MESSAGE_COMPLETE', { topicId: 'topic-1' })
        EventEmitter.emit('MESSAGE_COMPLETE', { topicId: 'topic-1' })
        await vi.advanceTimersByTimeAsync(CHAT_FLOW_SNAPSHOT_REFRESH_DEBOUNCE_MS + 50)
      })
      expect(mocks.loadWholeTopicSnapshot).toHaveBeenCalledTimes(2)

      // Events for other topics are ignored.
      await act(async () => {
        EventEmitter.emit('MESSAGE_COMPLETE', { topicId: 'topic-2' })
        await vi.advanceTimersByTimeAsync(CHAT_FLOW_SNAPSHOT_REFRESH_DEBOUNCE_MS + 50)
      })
      expect(mocks.loadWholeTopicSnapshot).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cleans up timers/subscriptions so late responses never commit', async () => {
    vi.useFakeTimers()
    try {
      let resolveLoad!: (value: any) => void
      mocks.loadWholeTopicSnapshot.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveLoad = resolve
          })
      )
      const { EventEmitter } = await import('@renderer/services/EventService')
      const { unmount } = render(<ChatFlowHistory conversationId="topic-1" />)
      unmount()

      const { messages, blocks } = twoTurnFixture()
      await act(async () => {
        resolveLoad(snapshotOf(messages, blocks))
        EventEmitter.emit('MESSAGE_COMPLETE', { topicId: 'topic-1' })
        await vi.advanceTimersByTimeAsync(CHAT_FLOW_SNAPSHOT_REFRESH_DEBOUNCE_MS + 1_000)
      })
      expect(mocks.loadWholeTopicSnapshot).toHaveBeenCalledTimes(1)
      expect(mocks.messageCompleteHandlers.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits navigation for the clicked snapshot node', async () => {
    const { EventEmitter } = await import('@renderer/services/EventService')
    const emitSpy = EventEmitter.emit as unknown as ReturnType<typeof vi.fn>
    const CustomNode = nodeTypes.custom as any
    render(
      <CustomNode data={{ type: 'assistant', model: 'Model One', content: 'answer', messageId: 'a1', modelId: 'm1' }} />
    )
    const label = screen.getByText('Model One')
    await act(async () => {
      label.click()
    })
    expect(emitSpy).toHaveBeenCalledWith('NAVIGATE_TO_MESSAGE', 'a1')
  })
})
