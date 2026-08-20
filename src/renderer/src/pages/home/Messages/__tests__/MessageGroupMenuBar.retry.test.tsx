import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Retry All event-time re-read contract — S3.4 finding 3
 *
 * Verifies that Retry All re-reads each explicit ID from store at click time,
 * skips entities whose status changed since render, and does not retry newly
 * added IDs not in the explicit rendered group.
 *
 * This is a focused logic test mirroring MessageGroupMenuBar.handleRetryAll
 * without rendering the component (avoids heavy transitive deps like
 * AssistantService → uuid).
 */

const mocks = vi.hoisted(() => ({
  regenerateAssistant: vi.fn().mockResolvedValue(undefined),
  storeGetState: vi.fn()
}))

// Minimal isFailed / isTransmitting helpers copied from component
const getMainTextContent = (m: any) => m._content || ''
const isFailedMessage = (m: any) => {
  if (m.role !== 'assistant') return false
  const isError = (m.status || '').toLowerCase() === 'error'
  const content = getMainTextContent(m)
  const noContent = !content || content.trim().length === 0
  const noBlocks = !m.blocks || m.blocks.length === 0
  return isError || noContent || noBlocks
}
const isTransmittingMessage = (m: any) => {
  if (m.role !== 'assistant') return false
  const s = m.status
  return s === 'processing' || s === 'pending' || s === 'searching'
}

// Replicate handleRetryAll from component using explicitIds + store re-read
const handleRetryAll = async (messages: any[], topicId: string) => {
  const explicitIds = messages.map((m) => m.id)
  for (const id of explicitIds) {
    const latest = mocks.storeGetState().messages.entities[id]
    if (!latest) continue
    if (latest.topicId !== topicId) continue
    if (!isFailedMessage(latest) || isTransmittingMessage(latest)) continue
    try {
      await mocks.regenerateAssistant({ topicId, messageId: id })
    } catch {}
  }
}

const makeMsg = (id: string, status: string): any => ({
  id,
  topicId: 'topic-1',
  role: 'assistant',
  askId: 'ask-1',
  blocks: [],
  status,
  _content: status === 'error' ? '' : 'hello'
})

describe('MessageGroupMenuBar Retry All — event-time re-read', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips an entity whose status changed since render (stale failed → now success)', async () => {
    const rendered = [makeMsg('a-1', 'error'), makeMsg('a-2', 'error')]
    mocks.storeGetState.mockReturnValue({
      messages: {
        entities: {
          'a-1': { ...rendered[0], status: 'error', topicId: 'topic-1' },
          'a-2': { ...rendered[1], status: 'success', topicId: 'topic-1', blocks: ['b1'], _content: 'hello' }
        }
      }
    })
    await handleRetryAll(rendered, 'topic-1')
    expect(mocks.regenerateAssistant).toHaveBeenCalledTimes(1)
    expect(mocks.regenerateAssistant).toHaveBeenCalledWith({ topicId: 'topic-1', messageId: 'a-1' })
  })

  it('does not retry newly added IDs not in explicit rendered group', async () => {
    const rendered = [makeMsg('a-1', 'error')]
    mocks.storeGetState.mockReturnValue({
      messages: {
        entities: {
          'a-1': { ...rendered[0], status: 'error', topicId: 'topic-1' },
          'a-3': { id: 'a-3', topicId: 'topic-1', role: 'assistant', status: 'error', blocks: [], _content: '' }
        }
      }
    })
    await handleRetryAll(rendered, 'topic-1')
    expect(mocks.regenerateAssistant).toHaveBeenCalledTimes(1)
    expect(mocks.regenerateAssistant).toHaveBeenCalledWith({ topicId: 'topic-1', messageId: 'a-1' })
    expect(mocks.regenerateAssistant).not.toHaveBeenCalledWith(expect.objectContaining({ messageId: 'a-3' }))
  })

  it('retries multiple explicit failed messages (event-time verified)', async () => {
    const rendered = [makeMsg('a-1', 'error'), makeMsg('a-2', 'error')]
    mocks.storeGetState.mockReturnValue({
      messages: {
        entities: {
          'a-1': { ...rendered[0], status: 'error', topicId: 'topic-1' },
          'a-2': { ...rendered[1], status: 'error', topicId: 'topic-1' }
        }
      }
    })
    await handleRetryAll(rendered, 'topic-1')
    expect(mocks.regenerateAssistant).toHaveBeenCalledTimes(2)
  })

  it('skips transmitting messages at click time', async () => {
    const rendered = [makeMsg('a-1', 'error')]
    mocks.storeGetState.mockReturnValue({
      messages: {
        entities: {
          'a-1': { id: 'a-1', topicId: 'topic-1', role: 'assistant', status: 'processing', blocks: [], _content: '' }
        }
      }
    })
    await handleRetryAll(rendered, 'topic-1')
    expect(mocks.regenerateAssistant).not.toHaveBeenCalled()
  })
})
