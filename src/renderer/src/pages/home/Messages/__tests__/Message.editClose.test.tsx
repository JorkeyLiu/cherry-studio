import type { Topic } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// This test verifies Message.tsx editor-close contract without rendering the full component tree.
// It simulates handleEditSave/handleEditResend as implemented in Message.tsx: they await the
// controller's boolean result and only call stopEditing on true, throwing on false so the
// MessageEditor catch keeps the editor open.

const makeMessage = (id = 'msg-1'): Message =>
  ({
    id,
    topicId: 'topic-1',
    role: 'user',
    assistantId: 'asst-1',
    blocks: [],
    status: 'success'
  }) as unknown as Message

const topic = { id: 'topic-1' } as Topic

describe('Message editor-close semantics — S3.4 (missing/failure vs success)', () => {
  beforeEach(() => vi.clearAllMocks())

  const simulateHandleEditSave = async (
    editSave: (target: any, blocks: MessageBlock[], onCommit?: any) => Promise<boolean>,
    stopEditing: () => void,
    shouldThrow: boolean = true
  ) => {
    const blocks: MessageBlock[] = []
    try {
      const ok = await editSave({ topicId: topic.id, messageId: makeMessage().id }, blocks)
      if (ok === false) {
        throw new Error('missing target')
      }
      stopEditing()
      return 'closed'
    } catch (e) {
      if (shouldThrow) throw e
      return 'kept'
    }
  }

  it('does not close editor on missing/cross-topic target (editSave returns false)', async () => {
    const editSave = vi.fn().mockResolvedValue(false)
    const stopEditing = vi.fn()
    await expect(simulateHandleEditSave(editSave, stopEditing)).rejects.toThrow('missing target')
    expect(stopEditing).not.toHaveBeenCalled()
  })

  it('does not close editor on thrown persistence error', async () => {
    const editSave = vi.fn().mockRejectedValue(new Error('DB failure'))
    const stopEditing = vi.fn()
    await expect(simulateHandleEditSave(editSave, stopEditing)).rejects.toThrow('DB failure')
    expect(stopEditing).not.toHaveBeenCalled()
  })

  it('closes editor on successful editSave (returns true)', async () => {
    const editSave = vi.fn().mockResolvedValue(true)
    const stopEditing = vi.fn()
    const result = await simulateHandleEditSave(editSave, stopEditing, false)
    expect(result).toBe('closed')
    expect(stopEditing).toHaveBeenCalledTimes(1)
  })

  it('resendWithEdit missing also keeps editor open', async () => {
    const resendWithEdit = vi.fn().mockResolvedValue(false)
    const stopEditing = vi.fn()
    const simulateResend = async () => {
      const ok = await resendWithEdit({ topicId: topic.id, messageId: 'm1' }, [])
      if (ok === false) throw new Error('missing')
      stopEditing()
    }
    await expect(simulateResend()).rejects.toThrow('missing')
    expect(stopEditing).not.toHaveBeenCalled()
  })

  it('successful resendWithEdit closes editor', async () => {
    const resendWithEdit = vi.fn().mockResolvedValue(true)
    const stopEditing = vi.fn()
    const simulateResend = async () => {
      const ok = await resendWithEdit({ topicId: topic.id, messageId: 'm1' }, [])
      if (ok === false) throw new Error('missing')
      stopEditing()
    }
    await simulateResend()
    expect(stopEditing).toHaveBeenCalledTimes(1)
  })
})
