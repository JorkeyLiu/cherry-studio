import { BlockManager } from '@renderer/services/messageStreaming/BlockManager'
import { AssistantExecutionState } from '@renderer/services/messageStreaming/executionState'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('BlockManager first-frame immediate vs throttled repair', () => {
  const topicId = 't1'
  const assistantMsgId = 'm1'
  let dispatch: ReturnType<typeof vi.fn>
  let saveUpdatedBlockToDB: ReturnType<typeof vi.fn>
  let throttledBlockUpdate: ReturnType<typeof vi.fn>
  let flushThrottledBlockUpdate: ReturnType<typeof vi.fn>
  let cancelThrottledBlockUpdate: ReturnType<typeof vi.fn>
  let getState: ReturnType<typeof vi.fn>

  const mkExec = (initialContent: string) => {
    const msg: Message = {
      id: assistantMsgId,
      topicId,
      role: 'assistant',
      blocks: ['b-think'],
      status: 'processing'
    } as unknown as Message
    const block: MessageBlock = {
      id: 'b-think',
      messageId: assistantMsgId,
      type: MessageBlockType.THINKING,
      status: MessageBlockStatus.STREAMING,
      content: initialContent,
      thinking_millsec: 0,
      createdAt: new Date().toISOString()
    } as unknown as MessageBlock
    return new AssistantExecutionState(msg, [block])
  }

  beforeEach(() => {
    dispatch = vi.fn()
    saveUpdatedBlockToDB = vi.fn().mockResolvedValue(undefined)
    throttledBlockUpdate = vi.fn()
    flushThrottledBlockUpdate = vi.fn()
    cancelThrottledBlockUpdate = vi.fn()
    getState = vi.fn(() => ({
      messages: { entities: { [assistantMsgId]: { id: assistantMsgId } } },
      messageBlocks: { entities: {} }
    })) as any
  })

  function createManager(exec: AssistantExecutionState) {
    return new BlockManager({
      dispatch: dispatch as any,
      getState: getState as any,
      saveUpdatedBlockToDB: saveUpdatedBlockToDB as any,
      saveUpdatesToDB: vi.fn().mockResolvedValue(undefined),
      assistantMsgId,
      topicId,
      executionState: exec,
      throttledBlockUpdate: throttledBlockUpdate as any,
      flushThrottledBlockUpdate,
      cancelThrottledBlockUpdate
    })
  }

  it('first transition empty->non-empty mirrors to Redux immediately (not throttled)', () => {
    const exec = mkExec('')
    const manager = createManager(exec)
    // Need lastBlockType set to THINKING so type not considered changed
    manager.lastBlockType = MessageBlockType.THINKING
    manager.activeBlockInfo = { id: 'b-think', type: MessageBlockType.THINKING }

    manager.smartBlockUpdate('b-think', { content: 'hello' }, MessageBlockType.THINKING, false)

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(throttledBlockUpdate).not.toHaveBeenCalled()
    expect(saveUpdatedBlockToDB).toHaveBeenCalledTimes(1)
    // executionState should have updated content
    expect((exec.getBlock('b-think') as any).content).toBe('hello')
  })

  it('second chunk is throttled (not immediate)', () => {
    const exec = mkExec('')
    const manager = createManager(exec)
    manager.lastBlockType = MessageBlockType.THINKING
    manager.activeBlockInfo = { id: 'b-think', type: MessageBlockType.THINKING }

    // first immediate
    manager.smartBlockUpdate('b-think', { content: 'hello' }, MessageBlockType.THINKING, false)
    dispatch.mockClear()
    saveUpdatedBlockToDB.mockClear()
    throttledBlockUpdate.mockClear()

    // second non-empty -> should be throttled
    manager.smartBlockUpdate('b-think', { content: 'hello world' }, MessageBlockType.THINKING, false)

    expect(dispatch).not.toHaveBeenCalled()
    expect(throttledBlockUpdate).toHaveBeenCalledTimes(1)
    expect(throttledBlockUpdate).toHaveBeenCalledWith(
      'b-think',
      { content: 'hello world' },
      undefined,
      undefined,
      expect.any(Function)
    )
    // local executionState still updated immediately despite throttled mirror
    expect((exec.getBlock('b-think') as any).content).toBe('hello world')
  })

  it('empty->empty does not trigger immediate (stays throttled/noop)', () => {
    const exec = mkExec('')
    const manager = createManager(exec)
    manager.lastBlockType = MessageBlockType.THINKING
    manager.activeBlockInfo = { id: 'b-think', type: MessageBlockType.THINKING }

    manager.smartBlockUpdate('b-think', { content: '' }, MessageBlockType.THINKING, false)

    // empty to empty: incoming trim empty so not first thinking chunk -> goes throttled
    expect(dispatch).not.toHaveBeenCalled()
    expect(throttledBlockUpdate).toHaveBeenCalledTimes(1)
  })

  it('final quiesce invariants: throttled second chunk flushed via barrier', async () => {
    const exec = mkExec('')
    const manager = createManager(exec)
    manager.lastBlockType = MessageBlockType.THINKING
    manager.activeBlockInfo = { id: 'b-think', type: MessageBlockType.THINKING }

    manager.smartBlockUpdate('b-think', { content: 'hello' }, MessageBlockType.THINKING, false)
    manager.smartBlockUpdate('b-think', { content: 'hello world' }, MessageBlockType.THINKING, false)
    // only second is in touched set
    expect((manager as any).touchedThrottledBlocks.has('b-think')).toBe(true)

    await manager.quiesceWrites()
    expect(flushThrottledBlockUpdate).toHaveBeenCalledWith('b-think')
  })
})
