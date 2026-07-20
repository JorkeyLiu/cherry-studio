/**
 * Wire Adapter Tests — unit tests for wire ↔ domain conversion.
 *
 * Covers:
 * - JsonObject → Domain DTO mapping (known fields, overflow)
 * - Domain DTO → JsonObject reconstruction
 * - Tool block object content round-trip
 * - File reference projection (create/remove/cascade)
 * - Relational message.blocks reconstruction
 * - Unknown JSON extension keys round-trip
 * - Nullable semantics
 */

import type { JsonObject } from '@shared/chatDb'
import { describe, expect, it } from 'vitest'

import type { MessageBlockData } from '../domain/types'
import {
  blocksToWire,
  blockToWire,
  messagesToWire,
  messageToWire,
  projectFileReferences,
  reconstructMessageBlockRelations,
  topicToWire,
  wireToBlock,
  wireToBlockPatch,
  wireToMessage,
  wireToMessagePatch,
  wireToTopic
} from '../wireAdapters'

describe('wireAdapters', () => {
  // =========================================================================
  // wireToTopic / topicToWire
  // =========================================================================

  describe('wireToTopic / topicToWire round-trip', () => {
    it('maps known fields and preserves overflow', () => {
      const json: JsonObject = {
        id: 't-1',
        assistantId: 'asst-1',
        name: 'Test',
        createdAt: '2024-01-01',
        updatedAt: null,
        deletedAt: null,
        customField: 'preserved',
        nested: { key: 42 }
      }

      const topic = wireToTopic(json)
      expect(topic.id).toBe('t-1')
      expect(topic.assistantId).toBe('asst-1')
      expect(topic.name).toBe('Test')
      expect(topic.overflow.customField).toBe('preserved')
      expect(topic.overflow.nested).toEqual({ key: 42 })

      // Round-trip
      const wire = topicToWire(topic)
      expect(wire.id).toBe('t-1')
      expect(wire.assistantId).toBe('asst-1')
      expect(wire.customField).toBe('preserved')
      expect(wire.nested).toEqual({ key: 42 })
      // overflow key should not appear in wire
      expect(wire.overflow).toBeUndefined()
    })

    it('handles null fields correctly', () => {
      const json: JsonObject = {
        id: 't-1',
        assistantId: null,
        name: null,
        createdAt: null,
        updatedAt: null,
        deletedAt: null
      }

      const topic = wireToTopic(json)
      expect(topic.assistantId).toBeNull()
      expect(topic.name).toBeNull()

      const wire = topicToWire(topic)
      expect(wire.assistantId).toBeNull()
      expect(wire.name).toBeNull()
    })
  })

  // =========================================================================
  // wireToMessage / messageToWire
  // =========================================================================

  describe('wireToMessage / messageToWire round-trip', () => {
    it('maps known fields and preserves overflow', () => {
      const json: JsonObject = {
        id: 'm-1',
        topicId: 't-1',
        role: 'user',
        content: 'Hello',
        status: 'success',
        askId: null,
        model: 'gpt-4',
        modelId: null,
        assistantId: 'asst-1',
        createdAt: '2024-01-01',
        updatedAt: null,
        sortOrder: 0,
        customMeta: { usage: { tokens: 100 } },
        mentions: ['model-1']
      }

      const msg = wireToMessage(json)
      expect(msg.id).toBe('m-1')
      expect(msg.topicId).toBe('t-1')
      expect(msg.role).toBe('user')
      expect(msg.overflow.customMeta).toEqual({ usage: { tokens: 100 } })
      expect(msg.overflow.mentions).toEqual(['model-1'])

      const wire = messageToWire(msg)
      expect(wire.id).toBe('m-1')
      expect(wire.role).toBe('user')
      expect(wire.customMeta).toEqual({ usage: { tokens: 100 } })
      expect(wire.mentions).toEqual(['model-1'])
      expect(wire.overflow).toBeUndefined()
    })

    it('defaults missing optional fields', () => {
      const json: JsonObject = {
        id: 'm-1',
        topicId: 't-1'
      }

      const msg = wireToMessage(json)
      expect(msg.role).toBeNull()
      expect(msg.content).toBeNull()
      expect(msg.status).toBeNull()
      expect(msg.sortOrder).toBe(0)
    })
  })

  // =========================================================================
  // wireToBlock / blockToWire
  // =========================================================================

  describe('wireToBlock / blockToWire round-trip', () => {
    it('maps known fields and preserves overflow', () => {
      const json: JsonObject = {
        id: 'b-1',
        messageId: 'm-1',
        type: 'main_text',
        content: 'Hello',
        status: 'success',
        createdAt: '2024-01-01',
        updatedAt: null,
        sortOrder: 0,
        citationReferences: [{ citationBlockId: 'cb-1' }]
      }

      const block = wireToBlock(json)
      expect(block.id).toBe('b-1')
      expect(block.messageId).toBe('m-1')
      expect(block.type).toBe('main_text')
      expect(block.content).toBe('Hello')
      expect(block.overflow.citationReferences).toEqual([{ citationBlockId: 'cb-1' }])

      const wire = blockToWire(block)
      expect(wire.id).toBe('b-1')
      expect(wire.citationReferences).toEqual([{ citationBlockId: 'cb-1' }])
      expect(wire.overflow).toBeUndefined()
    })

    it('handles tool block object content', () => {
      const toolContent = { toolResult: 'data', items: [1, 2, 3] }
      const json: JsonObject = {
        id: 'b-tool',
        messageId: 'm-1',
        type: 'tool',
        content: toolContent as any,
        status: 'success'
      }

      const block = wireToBlock(json)
      // Object content should move to overflow.content
      expect(block.content).toBeNull()
      expect(block.overflow.content).toEqual(toolContent)

      // reconstructBlock should restore object content
      const wire = blockToWire(block)
      expect(wire.content).toEqual(toolContent)
    })

    it('preserves string content for non-tool blocks', () => {
      const json: JsonObject = {
        id: 'b-1',
        messageId: 'm-1',
        type: 'main_text',
        content: 'Text content',
        status: 'success'
      }

      const block = wireToBlock(json)
      expect(block.content).toBe('Text content')

      const wire = blockToWire(block)
      expect(wire.content).toBe('Text content')
    })
  })

  // =========================================================================
  // reconstructMessageBlockRelations
  // =========================================================================

  describe('reconstructMessageBlockRelations', () => {
    it('rebuilds blocks array from block list', () => {
      const messages: JsonObject[] = [
        { id: 'm-1', content: 'msg1' },
        { id: 'm-2', content: 'msg2' }
      ]
      const blocks: JsonObject[] = [
        { id: 'b-1', messageId: 'm-1' },
        { id: 'b-2', messageId: 'm-1' },
        { id: 'b-3', messageId: 'm-2' }
      ]

      const result = reconstructMessageBlockRelations(messages, blocks)
      expect(result[0].blocks).toEqual(['b-1', 'b-2'])
      expect(result[1].blocks).toEqual(['b-3'])
    })

    it('returns empty blocks array for messages with no blocks', () => {
      const messages: JsonObject[] = [{ id: 'm-1' }]
      const blocks: JsonObject[] = []

      const result = reconstructMessageBlockRelations(messages, blocks)
      expect(result[0].blocks).toEqual([])
    })
  })

  // =========================================================================
  // projectFileReferences
  // =========================================================================

  describe('projectFileReferences', () => {
    it('creates reference for file block with overflow.file', () => {
      const block: MessageBlockData = {
        id: 'b-1',
        messageId: 'm-1',
        type: 'file',
        content: null,
        status: 'success',
        createdAt: null,
        updatedAt: null,
        sortOrder: 0,
        overflow: {
          file: { id: 'file-1', name: 'test.pdf', path: '/path/test.pdf', type: 'application/pdf' }
        }
      }

      const refs = projectFileReferences(block)
      expect(refs).toHaveLength(1)
      expect(refs[0].fileId).toBe('file-1')
      expect(refs[0].fileName).toBe('test.pdf')
      expect(refs[0].filePath).toBe('/path/test.pdf')
      expect(refs[0].fileType).toBe('application/pdf')
      expect(refs[0].blockId).toBe('b-1')
    })

    it('creates reference for image block', () => {
      const block: MessageBlockData = {
        id: 'b-img',
        messageId: 'm-1',
        type: 'image',
        content: null,
        status: 'success',
        createdAt: null,
        updatedAt: null,
        sortOrder: 0,
        overflow: {
          file: { id: 'img-1', name: 'photo.jpg', path: '/path/photo.jpg', type: 'image/jpeg' }
        }
      }

      const refs = projectFileReferences(block)
      expect(refs).toHaveLength(1)
      expect(refs[0].fileId).toBe('img-1')
    })

    it('returns empty for non-file blocks', () => {
      const block: MessageBlockData = {
        id: 'b-1',
        messageId: 'm-1',
        type: 'main_text',
        content: 'Hello',
        status: 'success',
        createdAt: null,
        updatedAt: null,
        sortOrder: 0,
        overflow: {}
      }

      const refs = projectFileReferences(block)
      expect(refs).toHaveLength(0)
    })

    it('returns empty when file block has no file metadata', () => {
      const block: MessageBlockData = {
        id: 'b-1',
        messageId: 'm-1',
        type: 'file',
        content: null,
        status: 'success',
        createdAt: null,
        updatedAt: null,
        sortOrder: 0,
        overflow: {}
      }

      const refs = projectFileReferences(block)
      expect(refs).toHaveLength(0)
    })

    it('creates zero references for non-file removal', () => {
      const block: MessageBlockData = {
        id: 'b-1',
        messageId: 'm-1',
        type: 'main_text',
        content: 'text',
        status: 'success',
        createdAt: null,
        updatedAt: null,
        sortOrder: 0,
        overflow: {}
      }

      const refs = projectFileReferences(block)
      expect(refs).toHaveLength(0)
    })
  })

  // =========================================================================
  // Batch adapters
  // =========================================================================

  describe('batch adapters', () => {
    it('wireToBlocks / blocksToWire round-trip', () => {
      const json: JsonObject[] = [
        { id: 'b-1', messageId: 'm-1', type: 'main_text', content: 'Hello', status: 'success' },
        { id: 'b-2', messageId: 'm-1', type: 'thinking', content: 'Hmm', status: 'success' }
      ]

      const blocks = json.map(wireToBlock)
      expect(blocks).toHaveLength(2)
      expect(blocks[0].id).toBe('b-1')

      const wire = blocksToWire(blocks)
      expect(wire).toHaveLength(2)
      expect(wire[0].id).toBe('b-1')
      expect(wire[0].content).toBe('Hello')
    })

    it('messagesToWire converts correctly', () => {
      const json: JsonObject[] = [{ id: 'm-1', topicId: 't-1', role: 'user', content: 'Hello' }]

      const messages = json.map(wireToMessage)
      const wire = messagesToWire(messages)
      expect(wire[0].id).toBe('m-1')
      expect(wire[0].role).toBe('user')
    })
  })

  // =========================================================================
  // Patch adapters
  // =========================================================================

  describe('wireToMessagePatch', () => {
    it('creates partial patch with only specified fields', () => {
      const json: JsonObject = { content: 'Updated', status: 'success' }

      const patch = wireToMessagePatch(json)
      expect(patch.content).toBe('Updated')
      expect(patch.status).toBe('success')
      expect(patch.id).toBeUndefined()
      expect(patch.role).toBeUndefined()
    })

    it('routes unknown keys to overflow', () => {
      const json: JsonObject = { content: 'Updated', customField: 'value' }

      const patch = wireToMessagePatch(json)
      expect(patch.content).toBe('Updated')
      expect(patch.overflow).toBeDefined()
      expect(patch.overflow!.customField).toBe('value')
    })
  })

  describe('wireToBlockPatch', () => {
    it('handles tool block object content in patch', () => {
      const json: JsonObject = {
        content: { toolResult: 'data' } as any,
        status: 'success'
      }

      const patch = wireToBlockPatch(json)
      expect(patch.content).toBeNull()
      expect(patch.overflow).toBeDefined()
      expect(patch.overflow!.content).toEqual({ toolResult: 'data' })
    })
  })

  // =========================================================================
  // Nullable semantics
  // =========================================================================

  describe('nullable semantics', () => {
    it('null values are preserved through round-trip', () => {
      const json: JsonObject = {
        id: 'm-1',
        topicId: 't-1',
        role: null,
        content: null,
        status: null,
        askId: null,
        model: null
      }

      const msg = wireToMessage(json)
      expect(msg.role).toBeNull()
      expect(msg.content).toBeNull()

      const wire = messageToWire(msg)
      expect(wire.role).toBeNull()
      expect(wire.content).toBeNull()
    })
  })

  // =========================================================================
  // Structured Message.model round-trip
  // =========================================================================

  describe('structured Message.model round-trip', () => {
    it('preserves structured model in overflow, nulls the column', () => {
      const structuredModel = {
        id: 'gpt-4',
        provider: 'openai',
        name: 'GPT-4',
        group: 'gpt',
        owned_by: 'openai',
        description: 'Large language model',
        capabilities: [{ type: 'text' as any }],
        pricing: { input: 0.03, output: 0.06 }
      }
      const json: JsonObject = {
        id: 'm-1',
        topicId: 't-1',
        role: 'assistant',
        model: structuredModel as any,
        modelId: 'gpt-4'
      }

      const msg = wireToMessage(json)
      // Column model is null (object can't bind to TEXT)
      expect(msg.model).toBeNull()
      // modelId from explicit wire field
      expect(msg.modelId).toBe('gpt-4')
      // Structured object preserved in overflow
      expect(msg.overflow.model).toEqual(structuredModel)

      // Round-trip: reconstruct restores structured model
      const wire = messageToWire(msg)
      expect(wire.model).toEqual(structuredModel)
      expect(wire.modelId).toBe('gpt-4')
      expect(wire.overflow).toBeUndefined()
    })

    it('extracts modelId from structured model.id when explicit modelId absent', () => {
      const structuredModel = {
        id: 'claude-3',
        provider: 'anthropic',
        name: 'Claude 3',
        group: 'claude'
      }
      const json: JsonObject = {
        id: 'm-1',
        topicId: 't-1',
        model: structuredModel as any
        // no modelId field
      }

      const msg = wireToMessage(json)
      expect(msg.model).toBeNull()
      expect(msg.modelId).toBe('claude-3')
      expect(msg.overflow.model).toEqual(structuredModel)

      const wire = messageToWire(msg)
      expect(wire.model).toEqual(structuredModel)
      expect(wire.modelId).toBe('claude-3')
    })

    it('preserves explicit modelId over structured model.id', () => {
      const structuredModel = { id: 'model-a', provider: 'p', name: 'A', group: 'g' }
      const json: JsonObject = {
        id: 'm-1',
        topicId: 't-1',
        model: structuredModel as any,
        modelId: 'explicit-id'
      }

      const msg = wireToMessage(json)
      expect(msg.modelId).toBe('explicit-id')
      expect(msg.overflow.model).toEqual(structuredModel)
    })

    it('preserves scalar string model in column (legacy behavior)', () => {
      const json: JsonObject = {
        id: 'm-1',
        topicId: 't-1',
        model: 'gpt-4-turbo'
      }

      const msg = wireToMessage(json)
      expect(msg.model).toBe('gpt-4-turbo')
      // Not in overflow (it's a scalar)
      expect(msg.overflow.model).toBeUndefined()

      const wire = messageToWire(msg)
      expect(wire.model).toBe('gpt-4-turbo')
    })

    it('handles null model correctly', () => {
      const json: JsonObject = {
        id: 'm-1',
        topicId: 't-1',
        model: null
      }

      const msg = wireToMessage(json)
      expect(msg.model).toBeNull()
      expect(msg.overflow.model).toBeUndefined()

      const wire = messageToWire(msg)
      expect(wire.model).toBeNull()
    })

    it('does not mutate input json', () => {
      const structuredModel = { id: 'm1', provider: 'p', name: 'M', group: 'g' }
      const json: JsonObject = {
        id: 'm-1',
        topicId: 't-1',
        model: structuredModel as any
      }
      const originalKeys = Object.keys(json)
      wireToMessage(json)
      expect(Object.keys(json)).toEqual(originalKeys)
      expect(json.model).toEqual(structuredModel)
    })

    it('patch routes structured model to overflow and sets column null', () => {
      const structuredModel = { id: 'new-m', provider: 'p', name: 'New', group: 'g' }
      const patch = wireToMessagePatch({ model: structuredModel as any })
      expect(patch.model).toBeNull()
      expect(patch.modelId).toBe('new-m')
      expect(patch.overflow).toBeDefined()
      expect(patch.overflow!.model).toEqual(structuredModel)
    })

    it('patch preserves explicit modelId when model is structured', () => {
      const structuredModel = { id: 'm1', provider: 'p', name: 'M', group: 'g' }
      const patch = wireToMessagePatch({ model: structuredModel as any, modelId: 'explicit' })
      expect(patch.model).toBeNull()
      expect(patch.modelId).toBe('explicit')
      expect(patch.overflow!.model).toEqual(structuredModel)
    })

    it('patch preserves scalar model in column (legacy)', () => {
      const patch = wireToMessagePatch({ model: 'gpt-4' })
      expect(patch.model).toBe('gpt-4')
      expect(patch.overflow).toBeUndefined()
    })
  })
})
