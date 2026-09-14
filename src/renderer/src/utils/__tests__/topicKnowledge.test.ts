import type { Topic } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CONTENT_TYPES } from '../knowledge'
import { loadWholeTopicSnapshot } from '../topicSnapshot'

// Mock modules to prevent circular dependencies during test loading
vi.mock('@renderer/components/Popups/SaveToKnowledgePopup', () => ({
  default: {}
}))

vi.mock('@renderer/pages/home/Messages/MessageMenubar', () => ({
  default: {}
}))

// Legacy compat mock — no production knowledge path should use it
vi.mock('@renderer/hooks/useTopic', () => ({
  TopicManager: {
    getTopicMessages: vi.fn()
  }
}))

vi.mock('../topicSnapshot', () => ({
  loadWholeTopicSnapshot: vi.fn()
}))

const makeBlock = (id: string, messageId: string, type: MessageBlockType, extra: Record<string, any> = {}) => {
  return {
    id,
    messageId,
    type,
    status: MessageBlockStatus.SUCCESS,
    createdAt: '2024-01-01T00:00:00Z',
    ...extra
  } as unknown as MessageBlock
}

const makeMessage = (id: string, role: 'user' | 'assistant', blockIds: string[]) => {
  return { id, role, blocks: blockIds } as unknown as Message
}

describe('Topic Knowledge Functions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const createTestTopic = (): Topic => ({
    id: 'test-topic-1',
    assistantId: 'test-assistant',
    name: 'Test Topic',
    createdAt: '2023-01-01T00:00:00Z',
    updatedAt: '2023-01-01T00:00:00Z',
    messages: []
  })

  describe('CONTENT_TYPES', () => {
    it('should have all expected content types', () => {
      expect(CONTENT_TYPES.TEXT).toBe('text')
      expect(CONTENT_TYPES.CODE).toBe('code')
      expect(CONTENT_TYPES.THINKING).toBe('thinking')
      expect(CONTENT_TYPES.TOOL_USE).toBe('tools')
      expect(CONTENT_TYPES.CITATION).toBe('citations')
      expect(CONTENT_TYPES.TRANSLATION).toBe('translations')
      expect(CONTENT_TYPES.ERROR).toBe('errors')
      expect(CONTENT_TYPES.FILE).toBe('files')
      expect(CONTENT_TYPES.IMAGES).toBe('images')
    })
  })

  describe('Topic Data Structure', () => {
    it('should create valid topic structure', () => {
      const topic = createTestTopic()

      expect(topic).toHaveProperty('id')
      expect(topic).toHaveProperty('name')
      expect(topic).toHaveProperty('assistantId')
      expect(topic).toHaveProperty('createdAt')
      expect(topic).toHaveProperty('updatedAt')
      expect(topic).toHaveProperty('messages')
      expect(Array.isArray(topic.messages)).toBe(true)
    })
  })

  describe('Topic Knowledge Functions Integration', () => {
    it('should be importable without circular dependencies', async () => {
      const knowledgeModule = await import('../knowledge')

      expect(knowledgeModule).toHaveProperty('analyzeTopicContent')
      expect(knowledgeModule).toHaveProperty('processTopicContent')
      expect(knowledgeModule).toHaveProperty('CONTENT_TYPES')
      expect(typeof knowledgeModule.analyzeTopicContent).toBe('function')
      expect(typeof knowledgeModule.processTopicContent).toBe('function')
    })

    it('should handle TopicManager mock correctly', async () => {
      const { TopicManager } = await import('@renderer/hooks/useTopic')
      expect(TopicManager).toHaveProperty('getTopicMessages')
      expect(typeof TopicManager.getTopicMessages).toBe('function')
    })
  })

  describe('analyzeTopicContent (whole-topic snapshot)', () => {
    it('counts full snapshot messages and selected block taxonomy with local blocks', async () => {
      const { analyzeTopicContent } = await import('../knowledge')
      const { TopicManager } = await import('@renderer/hooks/useTopic')
      const m1 = makeMessage('m1', 'user', ['b1', 'b2'])
      const m2 = makeMessage('m2', 'assistant', ['b3', 'b4', 'b5'])
      const b1 = makeBlock('b1', 'm1', MessageBlockType.MAIN_TEXT, { content: 'hello' })
      const b2 = makeBlock('b2', 'm1', MessageBlockType.CODE, { content: 'code-1' })
      const b3 = makeBlock('b3', 'm2', MessageBlockType.THINKING, { content: 'think' })
      const b4 = makeBlock('b4', 'm2', MessageBlockType.FILE, {
        file: { id: 'f1', name: 'a.pdf', path: '/a.pdf', type: 'application/pdf', size: 10 }
      })
      const b5 = makeBlock('b5', 'm2', MessageBlockType.MAIN_TEXT, { content: '  ' })
      const blocksById = new Map([
        ['b1', b1],
        ['b2', b2],
        ['b3', b3],
        ['b4', b4],
        ['b5', b5]
      ])
      vi.mocked(loadWholeTopicSnapshot).mockResolvedValue({
        messages: [m1, m2],
        blocks: [b1, b2, b3, b4, b5],
        blocksById: blocksById as any,
        snapshot: {
          completeness: 'whole-topic',
          topicId: 'test-topic-1',
          firstMessageId: 'm1',
          lastMessageId: 'm2',
          returnedCount: 2
        }
      } as any)

      const stats = await analyzeTopicContent(createTestTopic())

      expect(stats.messages).toBe(2)
      expect(stats.text).toBe(1)
      expect(stats.code).toBe(1)
      expect(stats.thinking).toBe(1)
      expect(stats.files).toBe(1)
      expect(loadWholeTopicSnapshot).toHaveBeenCalledTimes(1)
      expect(loadWholeTopicSnapshot).toHaveBeenCalledWith('test-topic-1')
      expect(TopicManager.getTopicMessages).not.toHaveBeenCalled()
    })
  })

  describe('processTopicContent (whole-topic snapshot)', () => {
    it('formats text, extracts files, and preserves order from local blocks', async () => {
      const { processTopicContent } = await import('../knowledge')
      const { TopicManager } = await import('@renderer/hooks/useTopic')
      const m1 = makeMessage('m1', 'user', ['b1'])
      const m2 = makeMessage('m2', 'assistant', ['b2', 'b3'])
      const b1 = makeBlock('b1', 'm1', MessageBlockType.MAIN_TEXT, { content: 'user text' })
      const b2 = makeBlock('b2', 'm2', MessageBlockType.MAIN_TEXT, { content: 'assistant text' })
      const b3 = makeBlock('b3', 'm2', MessageBlockType.FILE, {
        file: { id: 'f2', name: 'b.pdf', path: '/b.pdf', type: 'application/pdf', size: 20 }
      })
      const blocksById = new Map([
        ['b1', b1],
        ['b2', b2],
        ['b3', b3]
      ])
      vi.mocked(loadWholeTopicSnapshot).mockResolvedValue({
        messages: [m1, m2],
        blocks: [b1, b2, b3],
        blocksById: blocksById as any,
        snapshot: {
          completeness: 'whole-topic',
          topicId: 'test-topic-1',
          firstMessageId: 'm1',
          lastMessageId: 'm2',
          returnedCount: 2
        }
      } as any)

      const result = await processTopicContent(createTestTopic(), [CONTENT_TYPES.TEXT, CONTENT_TYPES.FILE])

      expect(result.text).toContain('# Test Topic')
      expect(result.text).toContain('user text')
      expect(result.text).toContain('assistant text')
      expect(result.text.indexOf('user text') < result.text.indexOf('assistant text')).toBe(true)
      expect(result.files).toHaveLength(1)
      expect(result.files[0]).toMatchObject({ id: 'f2' })
      expect(loadWholeTopicSnapshot).toHaveBeenCalledTimes(1)
      expect(TopicManager.getTopicMessages).not.toHaveBeenCalled()
    })
  })
})
