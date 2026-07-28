import { describe, expect, it } from 'vitest'

import { chatDbContracts, getContract, validateChatDbRequest, validateChatDbResult, ValidationError } from '../index'

// ===========================================================================
// Contract registry completeness
// ===========================================================================

describe('chatDbContracts', () => {
  const expectedChannels = [
    // Original 14 commands
    'chatdb:fetch-messages',
    'chatdb:get-raw-topic',
    'chatdb:topic-exists',
    'chatdb:ensure-topic',
    'chatdb:append-message',
    'chatdb:update-message',
    'chatdb:update-message-and-blocks',
    'chatdb:delete-message',
    'chatdb:delete-messages',
    'chatdb:update-blocks',
    'chatdb:update-single-block',
    'chatdb:bulk-add-blocks',
    'chatdb:delete-blocks',
    'chatdb:clear-messages',
    // Phase 5.1A: segment + reorder + file-reference commands
    'chatdb:list-segments',
    'chatdb:upsert-segment',
    'chatdb:update-segment-metadata',
    'chatdb:delete-segment',
    'chatdb:replace-segment-membership',
    'chatdb:reorder-messages',
    'chatdb:list-file-refs-by-file',
    'chatdb:count-file-refs-by-file',
    'chatdb:list-blocks-by-file'
  ]

  it('has entries for all expected channels', () => {
    for (const channel of expectedChannels) {
      expect(chatDbContracts).toHaveProperty(channel)
    }
  })

  it('has exactly the expected number of contracts', () => {
    expect(Object.keys(chatDbContracts)).toHaveLength(expectedChannels.length)
  })

  it('every contract has allowedKeys, validate, and validateResult', () => {
    for (const [, contract] of Object.entries(chatDbContracts)) {
      expect(contract.allowedKeys).toBeInstanceOf(Set)
      expect(typeof contract.validate).toBe('function')
      expect(typeof contract.validateResult).toBe('function')
    }
  })
})

// ===========================================================================
// getContract
// ===========================================================================

describe('getContract', () => {
  it('returns contract for valid channel', () => {
    const contract = getContract('chatdb:fetch-messages')
    expect(contract).toBeDefined()
    expect(typeof contract.validate).toBe('function')
  })
})

// ===========================================================================
// Per-command validation: valid requests
// ===========================================================================

describe('validateChatDbRequest — valid payloads', () => {
  it('fetch-messages: { topicId }', () => {
    expect(() => validateChatDbRequest('chatdb:fetch-messages', { topicId: 'topic-1' })).not.toThrow()
  })

  it('get-raw-topic: { topicId }', () => {
    expect(() => validateChatDbRequest('chatdb:get-raw-topic', { topicId: 'topic-1' })).not.toThrow()
  })

  it('topic-exists: { topicId }', () => {
    expect(() => validateChatDbRequest('chatdb:topic-exists', { topicId: 'topic-1' })).not.toThrow()
  })

  it('ensure-topic: { topicId }', () => {
    expect(() => validateChatDbRequest('chatdb:ensure-topic', { topicId: 'topic-1' })).not.toThrow()
  })

  it('ensure-topic: { topicId, assistantId }', () => {
    expect(() =>
      validateChatDbRequest('chatdb:ensure-topic', {
        topicId: 'topic-1',
        assistantId: 'asst-1'
      })
    ).not.toThrow()
  })

  it('append-message: minimal', () => {
    expect(() =>
      validateChatDbRequest('chatdb:append-message', {
        topicId: 'topic-1',
        message: { id: 'msg-1' },
        blocks: []
      })
    ).not.toThrow()
  })

  it('append-message: with blocks and insertIndex', () => {
    expect(() =>
      validateChatDbRequest('chatdb:append-message', {
        topicId: 'topic-1',
        message: { id: 'msg-1', role: 'user', content: 'hello' },
        blocks: [{ id: 'blk-1', messageId: 'msg-1', type: 'text', content: 'hello' }],
        insertIndex: 0
      })
    ).not.toThrow()
  })

  it('update-message: partial updates', () => {
    expect(() =>
      validateChatDbRequest('chatdb:update-message', {
        topicId: 'topic-1',
        messageId: 'msg-1',
        updates: { content: 'updated', status: 'done' }
      })
    ).not.toThrow()
  })

  it('update-message: null clears field', () => {
    expect(() =>
      validateChatDbRequest('chatdb:update-message', {
        topicId: 'topic-1',
        messageId: 'msg-1',
        updates: { content: null }
      })
    ).not.toThrow()
  })

  it('update-message-and-blocks: minimal', () => {
    expect(() =>
      validateChatDbRequest('chatdb:update-message-and-blocks', {
        topicId: 'topic-1',
        messageUpdates: { id: 'msg-1' },
        blocksToUpdate: []
      })
    ).not.toThrow()
  })

  it('update-message-and-blocks: with blocks', () => {
    expect(() =>
      validateChatDbRequest('chatdb:update-message-and-blocks', {
        topicId: 'topic-1',
        messageUpdates: { id: 'msg-1', content: 'updated' },
        blocksToUpdate: [{ id: 'blk-1', messageId: 'msg-1', content: 'new' }]
      })
    ).not.toThrow()
  })

  it('delete-message: { topicId, messageId }', () => {
    expect(() =>
      validateChatDbRequest('chatdb:delete-message', {
        topicId: 'topic-1',
        messageId: 'msg-1'
      })
    ).not.toThrow()
  })

  it('delete-messages: { topicId, messageIds }', () => {
    expect(() =>
      validateChatDbRequest('chatdb:delete-messages', {
        topicId: 'topic-1',
        messageIds: ['msg-1', 'msg-2']
      })
    ).not.toThrow()
  })

  it('update-blocks: with blocks array', () => {
    expect(() =>
      validateChatDbRequest('chatdb:update-blocks', {
        blocks: [{ id: 'blk-1', messageId: 'msg-1' }]
      })
    ).not.toThrow()
  })

  it('update-blocks: empty array', () => {
    expect(() => validateChatDbRequest('chatdb:update-blocks', { blocks: [] })).not.toThrow()
  })

  it('update-single-block: { blockId, updates }', () => {
    expect(() =>
      validateChatDbRequest('chatdb:update-single-block', {
        blockId: 'blk-1',
        updates: { content: 'new content' }
      })
    ).not.toThrow()
  })

  it('bulk-add-blocks: with blocks array', () => {
    expect(() =>
      validateChatDbRequest('chatdb:bulk-add-blocks', {
        blocks: [{ id: 'blk-1', messageId: 'msg-1' }]
      })
    ).not.toThrow()
  })

  it('delete-blocks: { blockIds }', () => {
    expect(() =>
      validateChatDbRequest('chatdb:delete-blocks', {
        blockIds: ['blk-1', 'blk-2']
      })
    ).not.toThrow()
  })

  it('clear-messages: { topicId }', () => {
    expect(() =>
      validateChatDbRequest('chatdb:clear-messages', {
        topicId: 'topic-1'
      })
    ).not.toThrow()
  })

  // Phase 5.1A: segment commands
  it('list-segments: { topicId }', () => {
    expect(() => validateChatDbRequest('chatdb:list-segments', { topicId: 'topic-1' })).not.toThrow()
  })

  it('upsert-segment: minimal', () => {
    expect(() =>
      validateChatDbRequest('chatdb:upsert-segment', {
        segmentId: 'seg-1',
        topicId: 'topic-1',
        messageIds: []
      })
    ).not.toThrow()
  })

  it('upsert-segment: with name, messageIds, color', () => {
    expect(() =>
      validateChatDbRequest('chatdb:upsert-segment', {
        segmentId: 'seg-1',
        topicId: 'topic-1',
        name: 'My Segment',
        messageIds: ['msg-1', 'msg-2'],
        color: '#ff0000'
      })
    ).not.toThrow()
  })

  it('update-segment-metadata: { segmentId }', () => {
    expect(() =>
      validateChatDbRequest('chatdb:update-segment-metadata', {
        segmentId: 'seg-1'
      })
    ).not.toThrow()
  })

  it('update-segment-metadata: with name and color', () => {
    expect(() =>
      validateChatDbRequest('chatdb:update-segment-metadata', {
        segmentId: 'seg-1',
        name: 'Updated Name',
        color: '#00ff00'
      })
    ).not.toThrow()
  })

  it('delete-segment: { segmentId }', () => {
    expect(() => validateChatDbRequest('chatdb:delete-segment', { segmentId: 'seg-1' })).not.toThrow()
  })

  it('replace-segment-membership: { segmentId, messageIds }', () => {
    expect(() =>
      validateChatDbRequest('chatdb:replace-segment-membership', {
        segmentId: 'seg-1',
        messageIds: ['msg-1', 'msg-2', 'msg-3']
      })
    ).not.toThrow()
  })

  it('replace-segment-membership: empty messageIds', () => {
    expect(() =>
      validateChatDbRequest('chatdb:replace-segment-membership', {
        segmentId: 'seg-1',
        messageIds: []
      })
    ).not.toThrow()
  })

  // Phase 5.1A: message reorder
  it('reorder-messages: { topicId, messageIds }', () => {
    expect(() =>
      validateChatDbRequest('chatdb:reorder-messages', {
        topicId: 'topic-1',
        messageIds: ['msg-3', 'msg-1', 'msg-2']
      })
    ).not.toThrow()
  })

  // Phase 5.1A: file reference queries
  it('list-file-refs-by-file: { fileId }', () => {
    expect(() => validateChatDbRequest('chatdb:list-file-refs-by-file', { fileId: 'file-1' })).not.toThrow()
  })

  it('count-file-refs-by-file: { fileId }', () => {
    expect(() => validateChatDbRequest('chatdb:count-file-refs-by-file', { fileId: 'file-1' })).not.toThrow()
  })

  it('list-blocks-by-file: { fileId }', () => {
    expect(() => validateChatDbRequest('chatdb:list-blocks-by-file', { fileId: 'file-1' })).not.toThrow()
  })
})

// ===========================================================================
// Per-command validation: invalid requests
// ===========================================================================

describe('validateChatDbRequest — invalid payloads', () => {
  it('rejects non-object request', () => {
    expect(() => validateChatDbRequest('chatdb:fetch-messages', 'bad')).toThrow(ValidationError)
  })

  it('rejects null request', () => {
    expect(() => validateChatDbRequest('chatdb:fetch-messages', null)).toThrow(ValidationError)
  })

  it('rejects unknown properties', () => {
    expect(() =>
      validateChatDbRequest('chatdb:fetch-messages', {
        topicId: 't1',
        unknownProp: true
      })
    ).toThrow(ValidationError)
  })

  it('rejects missing topicId', () => {
    expect(() => validateChatDbRequest('chatdb:fetch-messages', {})).toThrow(ValidationError)
  })

  it('rejects empty topicId', () => {
    expect(() => validateChatDbRequest('chatdb:fetch-messages', { topicId: '' })).toThrow(ValidationError)
  })

  it('append-message: rejects missing message', () => {
    expect(() =>
      validateChatDbRequest('chatdb:append-message', {
        topicId: 't1',
        blocks: []
      })
    ).toThrow(ValidationError)
  })

  it('append-message: rejects message without id', () => {
    expect(() =>
      validateChatDbRequest('chatdb:append-message', {
        topicId: 't1',
        message: { role: 'user' },
        blocks: []
      })
    ).toThrow(ValidationError)
  })

  it('append-message: rejects block without id', () => {
    expect(() =>
      validateChatDbRequest('chatdb:append-message', {
        topicId: 't1',
        message: { id: 'm1' },
        blocks: [{ messageId: 'm1' }]
      })
    ).toThrow(ValidationError)
  })

  it('append-message: rejects non-integer insertIndex', () => {
    expect(() =>
      validateChatDbRequest('chatdb:append-message', {
        topicId: 't1',
        message: { id: 'm1' },
        blocks: [],
        insertIndex: 1.5
      })
    ).toThrow(ValidationError)
  })

  it('update-message: rejects non-object updates', () => {
    expect(() =>
      validateChatDbRequest('chatdb:update-message', {
        topicId: 't1',
        messageId: 'm1',
        updates: 'bad'
      })
    ).toThrow(ValidationError)
  })

  it('update-message-and-blocks: rejects messageUpdates without id', () => {
    expect(() =>
      validateChatDbRequest('chatdb:update-message-and-blocks', {
        topicId: 't1',
        messageUpdates: { content: 'x' },
        blocksToUpdate: []
      })
    ).toThrow(ValidationError)
  })

  it('delete-messages: rejects non-string array', () => {
    expect(() =>
      validateChatDbRequest('chatdb:delete-messages', {
        topicId: 't1',
        messageIds: [42]
      })
    ).toThrow(ValidationError)
  })

  it('delete-blocks: rejects non-array blockIds', () => {
    expect(() =>
      validateChatDbRequest('chatdb:delete-blocks', {
        blockIds: 'not-array'
      })
    ).toThrow(ValidationError)
  })

  it('rejects values with non-JSON-safe content (Date)', () => {
    expect(() =>
      validateChatDbRequest('chatdb:update-message', {
        topicId: 't1',
        messageId: 'm1',
        updates: { createdAt: new Date() }
      })
    ).toThrow(ValidationError)
  })

  it('rejects values with undefined in updates', () => {
    expect(() =>
      validateChatDbRequest('chatdb:update-message', {
        topicId: 't1',
        messageId: 'm1',
        updates: { content: undefined }
      })
    ).toThrow(ValidationError)
  })

  // Phase 5.1A: segment command invalid payloads
  it('list-segments: rejects missing topicId', () => {
    expect(() => validateChatDbRequest('chatdb:list-segments', {})).toThrow(ValidationError)
  })

  it('upsert-segment: rejects missing segmentId', () => {
    expect(() =>
      validateChatDbRequest('chatdb:upsert-segment', {
        topicId: 't1',
        messageIds: []
      })
    ).toThrow(ValidationError)
  })

  it('upsert-segment: rejects missing topicId', () => {
    expect(() =>
      validateChatDbRequest('chatdb:upsert-segment', {
        segmentId: 'seg-1',
        messageIds: []
      })
    ).toThrow(ValidationError)
  })

  it('upsert-segment: rejects non-array messageIds', () => {
    expect(() =>
      validateChatDbRequest('chatdb:upsert-segment', {
        segmentId: 'seg-1',
        topicId: 't1',
        messageIds: 'not-array'
      })
    ).toThrow(ValidationError)
  })

  it('upsert-segment: rejects non-string in messageIds', () => {
    expect(() =>
      validateChatDbRequest('chatdb:upsert-segment', {
        segmentId: 'seg-1',
        topicId: 't1',
        messageIds: [42]
      })
    ).toThrow(ValidationError)
  })

  it('update-segment-metadata: rejects missing segmentId', () => {
    expect(() => validateChatDbRequest('chatdb:update-segment-metadata', {})).toThrow(ValidationError)
  })

  it('delete-segment: rejects missing segmentId', () => {
    expect(() => validateChatDbRequest('chatdb:delete-segment', {})).toThrow(ValidationError)
  })

  it('replace-segment-membership: rejects missing segmentId', () => {
    expect(() =>
      validateChatDbRequest('chatdb:replace-segment-membership', {
        messageIds: []
      })
    ).toThrow(ValidationError)
  })

  it('replace-segment-membership: rejects non-array messageIds', () => {
    expect(() =>
      validateChatDbRequest('chatdb:replace-segment-membership', {
        segmentId: 'seg-1',
        messageIds: 'not-array'
      })
    ).toThrow(ValidationError)
  })

  it('reorder-messages: rejects missing topicId', () => {
    expect(() =>
      validateChatDbRequest('chatdb:reorder-messages', {
        messageIds: []
      })
    ).toThrow(ValidationError)
  })

  it('reorder-messages: rejects non-array messageIds', () => {
    expect(() =>
      validateChatDbRequest('chatdb:reorder-messages', {
        topicId: 't1',
        messageIds: 'not-array'
      })
    ).toThrow(ValidationError)
  })

  it('list-file-refs-by-file: rejects missing fileId', () => {
    expect(() => validateChatDbRequest('chatdb:list-file-refs-by-file', {})).toThrow(ValidationError)
  })

  it('count-file-refs-by-file: rejects missing fileId', () => {
    expect(() => validateChatDbRequest('chatdb:count-file-refs-by-file', {})).toThrow(ValidationError)
  })

  it('list-blocks-by-file: rejects missing fileId', () => {
    expect(() => validateChatDbRequest('chatdb:list-blocks-by-file', {})).toThrow(ValidationError)
  })
})

// ===========================================================================
// JSON round-trip: request survives JSON.stringify/parse
// ===========================================================================

describe('JSON round-trip', () => {
  it('append-message request survives round-trip', () => {
    const original = {
      topicId: 'topic-1',
      message: {
        id: 'msg-1',
        role: 'user',
        content: 'hello',
        blocks: ['blk-1'],
        createdAt: '2026-07-20T00:00:00Z',
        status: 'sent',
        overflow: { custom: 'data', nested: { a: [1, 2, 3] } }
      },
      blocks: [
        {
          id: 'blk-1',
          messageId: 'msg-1',
          type: 'text',
          content: 'hello',
          sortOrder: 0
        }
      ],
      insertIndex: 2
    }

    const roundTripped = JSON.parse(JSON.stringify(original))
    expect(() => validateChatDbRequest('chatdb:append-message', roundTripped)).not.toThrow()
    expect(roundTripped).toEqual(original)
  })

  it('update-message-and-blocks survives round-trip', () => {
    const original = {
      topicId: 'topic-1',
      messageUpdates: {
        id: 'msg-1',
        content: 'updated content',
        status: 'done',
        overflow: { model: 'gpt-4', tokens: 150 }
      },
      blocksToUpdate: [
        { id: 'blk-1', messageId: 'msg-1', content: 'new block content' },
        { id: 'blk-2', messageId: 'msg-1', type: 'image', content: null }
      ]
    }

    const roundTripped = JSON.parse(JSON.stringify(original))
    expect(() => validateChatDbRequest('chatdb:update-message-and-blocks', roundTripped)).not.toThrow()
    expect(roundTripped).toEqual(original)
  })

  it('fetch-messages response shape round-trips', () => {
    const response = {
      messages: [
        { id: 'msg-1', role: 'user', content: 'hello' },
        { id: 'msg-2', role: 'assistant', content: 'hi there' }
      ],
      blocks: [
        { id: 'blk-1', messageId: 'msg-1', type: 'text', content: 'hello' },
        { id: 'blk-2', messageId: 'msg-2', type: 'text', content: 'hi there' }
      ]
    }

    const roundTripped = JSON.parse(JSON.stringify(response))
    expect(roundTripped).toEqual(response)
  })
})

// ===========================================================================
// Contract allowedKeys completeness
// ===========================================================================

describe('contract allowedKeys', () => {
  it('fetch-messages has exactly topicId', () => {
    const keys = getContract('chatdb:fetch-messages').allowedKeys
    expect(keys).toEqual(new Set(['topicId']))
  })

  it('append-message has exactly topicId, message, blocks, insertIndex', () => {
    const keys = getContract('chatdb:append-message').allowedKeys
    expect(keys).toEqual(new Set(['topicId', 'message', 'blocks', 'insertIndex']))
  })

  it('update-message-and-blocks has exactly topicId, messageUpdates, blocksToUpdate', () => {
    const keys = getContract('chatdb:update-message-and-blocks').allowedKeys
    expect(keys).toEqual(new Set(['topicId', 'messageUpdates', 'blocksToUpdate']))
  })

  it('ensure-topic has exactly topicId, assistantId', () => {
    const keys = getContract('chatdb:ensure-topic').allowedKeys
    expect(keys).toEqual(new Set(['topicId', 'assistantId']))
  })
})

// ===========================================================================
// Block object messageId validation (Fix 1: DTO/validator contract)
// ===========================================================================

describe('block objects require messageId', () => {
  it('append-message: rejects block without messageId', () => {
    expect(() =>
      validateChatDbRequest('chatdb:append-message', {
        topicId: 't1',
        message: { id: 'm1' },
        blocks: [{ id: 'b1' }]
      })
    ).toThrow(ValidationError)
  })

  it('append-message: accepts block with id and messageId', () => {
    expect(() =>
      validateChatDbRequest('chatdb:append-message', {
        topicId: 't1',
        message: { id: 'm1' },
        blocks: [{ id: 'b1', messageId: 'm1' }]
      })
    ).not.toThrow()
  })

  it('append-message: rejects block with empty messageId', () => {
    expect(() =>
      validateChatDbRequest('chatdb:append-message', {
        topicId: 't1',
        message: { id: 'm1' },
        blocks: [{ id: 'b1', messageId: '' }]
      })
    ).toThrow(ValidationError)
  })

  it('update-message-and-blocks: rejects block without messageId', () => {
    expect(() =>
      validateChatDbRequest('chatdb:update-message-and-blocks', {
        topicId: 't1',
        messageUpdates: { id: 'm1' },
        blocksToUpdate: [{ id: 'b1', content: 'x' }]
      })
    ).toThrow(ValidationError)
  })

  it('update-message-and-blocks: accepts block with id and messageId', () => {
    expect(() =>
      validateChatDbRequest('chatdb:update-message-and-blocks', {
        topicId: 't1',
        messageUpdates: { id: 'm1' },
        blocksToUpdate: [{ id: 'b1', messageId: 'm1', content: 'x' }]
      })
    ).not.toThrow()
  })

  it('update-blocks: rejects block without messageId', () => {
    expect(() =>
      validateChatDbRequest('chatdb:update-blocks', {
        blocks: [{ id: 'b1' }]
      })
    ).toThrow(ValidationError)
  })

  it('update-blocks: accepts block with id and messageId', () => {
    expect(() =>
      validateChatDbRequest('chatdb:update-blocks', {
        blocks: [{ id: 'b1', messageId: 'm1' }]
      })
    ).not.toThrow()
  })

  it('bulk-add-blocks: rejects block without messageId', () => {
    expect(() =>
      validateChatDbRequest('chatdb:bulk-add-blocks', {
        blocks: [{ id: 'b1', type: 'text', content: 'x' }]
      })
    ).toThrow(ValidationError)
  })

  it('bulk-add-blocks: accepts block with id and messageId', () => {
    expect(() =>
      validateChatDbRequest('chatdb:bulk-add-blocks', {
        blocks: [{ id: 'b1', messageId: 'm1', type: 'text' }]
      })
    ).not.toThrow()
  })

  it('update-single-block: does NOT require messageId in updates patch', () => {
    // updates is a partial patch, not a full block — messageId is NOT required
    expect(() =>
      validateChatDbRequest('chatdb:update-single-block', {
        blockId: 'b1',
        updates: { content: 'new' }
      })
    ).not.toThrow()
  })
})

// ===========================================================================
// Result validation: positive cases (all commands)
// ===========================================================================

describe('validateChatDbResult — valid success envelopes', () => {
  it('fetch-messages: valid response with messages and blocks', () => {
    expect(() =>
      validateChatDbResult('chatdb:fetch-messages', {
        ok: true,
        value: {
          messages: [{ id: 'm1', role: 'user' }],
          blocks: [{ id: 'b1', messageId: 'm1', type: 'text' }]
        }
      })
    ).not.toThrow()
  })

  it('fetch-messages: valid empty response', () => {
    expect(() =>
      validateChatDbResult('chatdb:fetch-messages', {
        ok: true,
        value: { messages: [], blocks: [] }
      })
    ).not.toThrow()
  })

  it('get-raw-topic: null value (not found)', () => {
    expect(() => validateChatDbResult('chatdb:get-raw-topic', { ok: true, value: null })).not.toThrow()
  })

  it('get-raw-topic: object value with id and messages', () => {
    expect(() =>
      validateChatDbResult('chatdb:get-raw-topic', {
        ok: true,
        value: { id: 'topic-1', messages: [{ id: 'm1' }] }
      })
    ).not.toThrow()
  })

  it('topic-exists: boolean true', () => {
    expect(() => validateChatDbResult('chatdb:topic-exists', { ok: true, value: true })).not.toThrow()
  })

  it('topic-exists: boolean false', () => {
    expect(() => validateChatDbResult('chatdb:topic-exists', { ok: true, value: false })).not.toThrow()
  })

  it('ensure-topic: null value', () => {
    expect(() => validateChatDbResult('chatdb:ensure-topic', { ok: true, value: null })).not.toThrow()
  })

  it('append-message: null value', () => {
    expect(() => validateChatDbResult('chatdb:append-message', { ok: true, value: null })).not.toThrow()
  })

  it('update-message: null value', () => {
    expect(() => validateChatDbResult('chatdb:update-message', { ok: true, value: null })).not.toThrow()
  })

  it('update-message-and-blocks: null value', () => {
    expect(() => validateChatDbResult('chatdb:update-message-and-blocks', { ok: true, value: null })).not.toThrow()
  })

  it('delete-message: null value', () => {
    expect(() => validateChatDbResult('chatdb:delete-message', { ok: true, value: null })).not.toThrow()
  })

  it('delete-messages: null value', () => {
    expect(() => validateChatDbResult('chatdb:delete-messages', { ok: true, value: null })).not.toThrow()
  })

  it('update-blocks: null value', () => {
    expect(() => validateChatDbResult('chatdb:update-blocks', { ok: true, value: null })).not.toThrow()
  })

  it('update-single-block: null value', () => {
    expect(() => validateChatDbResult('chatdb:update-single-block', { ok: true, value: null })).not.toThrow()
  })

  it('bulk-add-blocks: null value', () => {
    expect(() => validateChatDbResult('chatdb:bulk-add-blocks', { ok: true, value: null })).not.toThrow()
  })

  it('delete-blocks: null value', () => {
    expect(() => validateChatDbResult('chatdb:delete-blocks', { ok: true, value: null })).not.toThrow()
  })

  it('clear-messages: null value', () => {
    expect(() => validateChatDbResult('chatdb:clear-messages', { ok: true, value: null })).not.toThrow()
  })

  // Phase 5.1A: segment commands
  it('list-segments: empty array', () => {
    expect(() => validateChatDbResult('chatdb:list-segments', { ok: true, value: [] })).not.toThrow()
  })

  it('list-segments: array with segments', () => {
    expect(() =>
      validateChatDbResult('chatdb:list-segments', {
        ok: true,
        value: [{ id: 'seg-1', topicId: 't1', name: 'Seg', messageIds: ['m1', 'm2'], createdAt: null, updatedAt: null }]
      })
    ).not.toThrow()
  })

  it('upsert-segment: segment wire value', () => {
    expect(() =>
      validateChatDbResult('chatdb:upsert-segment', {
        ok: true,
        value: {
          id: 'seg-1',
          topicId: 't1',
          name: 'Seg',
          messageIds: ['m1'],
          color: '#ff0000',
          createdAt: null,
          updatedAt: null
        }
      })
    ).not.toThrow()
  })

  it('update-segment-metadata: segment wire value', () => {
    expect(() =>
      validateChatDbResult('chatdb:update-segment-metadata', {
        ok: true,
        value: { id: 'seg-1', topicId: 't1', name: 'Updated', messageIds: [], createdAt: null, updatedAt: null }
      })
    ).not.toThrow()
  })

  it('delete-segment: null value', () => {
    expect(() => validateChatDbResult('chatdb:delete-segment', { ok: true, value: null })).not.toThrow()
  })

  it('replace-segment-membership: segment wire value', () => {
    expect(() =>
      validateChatDbResult('chatdb:replace-segment-membership', {
        ok: true,
        value: { id: 'seg-1', topicId: 't1', name: 'Seg', messageIds: ['m1'], createdAt: null, updatedAt: null }
      })
    ).not.toThrow()
  })

  it('replace-segment-membership: null (deleted)', () => {
    expect(() => validateChatDbResult('chatdb:replace-segment-membership', { ok: true, value: null })).not.toThrow()
  })

  // Phase 5.1A: message reorder
  it('reorder-messages: null value', () => {
    expect(() => validateChatDbResult('chatdb:reorder-messages', { ok: true, value: null })).not.toThrow()
  })

  // Phase 5.1A: file reference queries
  it('list-file-refs-by-file: empty array', () => {
    expect(() => validateChatDbResult('chatdb:list-file-refs-by-file', { ok: true, value: [] })).not.toThrow()
  })

  it('list-file-refs-by-file: array with refs', () => {
    expect(() =>
      validateChatDbResult('chatdb:list-file-refs-by-file', {
        ok: true,
        value: [
          { id: 'fr-1', blockId: 'b1', fileId: 'f1', fileName: 'test.pdf', filePath: null, fileType: null, count: 1 }
        ]
      })
    ).not.toThrow()
  })

  it('count-file-refs-by-file: number value', () => {
    expect(() => validateChatDbResult('chatdb:count-file-refs-by-file', { ok: true, value: 5 })).not.toThrow()
  })

  it('count-file-refs-by-file: zero', () => {
    expect(() => validateChatDbResult('chatdb:count-file-refs-by-file', { ok: true, value: 0 })).not.toThrow()
  })

  it('list-blocks-by-file: empty array', () => {
    expect(() => validateChatDbResult('chatdb:list-blocks-by-file', { ok: true, value: [] })).not.toThrow()
  })

  it('list-blocks-by-file: array with blocks', () => {
    expect(() =>
      validateChatDbResult('chatdb:list-blocks-by-file', {
        ok: true,
        value: [{ id: 'b1', messageId: 'm1', type: 'file' }]
      })
    ).not.toThrow()
  })
})

// ===========================================================================
// Result validation: valid failure envelopes
// ===========================================================================

describe('validateChatDbResult — valid failure envelopes', () => {
  const validFailure = {
    ok: false,
    error: { code: 'NOT_FOUND', message: 'Topic not found', retryable: false }
  }

  it('accepts valid failure for any command', () => {
    const channels = Object.keys(chatDbContracts) as Array<keyof typeof chatDbContracts>
    for (const channel of channels) {
      expect(() => validateChatDbResult(channel, { ...validFailure })).not.toThrow()
    }
  })

  it('accepts failure with details', () => {
    expect(() =>
      validateChatDbResult('chatdb:fetch-messages', {
        ok: false,
        error: {
          code: 'STORAGE_ERROR',
          message: 'Disk full',
          retryable: true,
          details: { path: '/data/db.sqlite' }
        }
      })
    ).not.toThrow()
  })
})

// ===========================================================================
// Result validation: negative cases (command-specific)
// ===========================================================================

describe('validateChatDbResult — invalid envelopes', () => {
  it('rejects void result with non-null value for ensure-topic', () => {
    expect(() => validateChatDbResult('chatdb:ensure-topic', { ok: true, value: 'unexpected' })).toThrow(
      ValidationError
    )
  })

  it('rejects void result with non-null value for append-message', () => {
    expect(() => validateChatDbResult('chatdb:append-message', { ok: true, value: 42 })).toThrow(ValidationError)
  })

  it('rejects void result with non-null value for delete-message', () => {
    expect(() => validateChatDbResult('chatdb:delete-message', { ok: true, value: {} })).toThrow(ValidationError)
  })

  it('rejects void result with non-null value for clear-messages', () => {
    expect(() => validateChatDbResult('chatdb:clear-messages', { ok: true, value: [] })).toThrow(ValidationError)
  })

  it('rejects topic-exists with non-boolean value', () => {
    expect(() => validateChatDbResult('chatdb:topic-exists', { ok: true, value: 'yes' })).toThrow(ValidationError)
    expect(() => validateChatDbResult('chatdb:topic-exists', { ok: true, value: 1 })).toThrow(ValidationError)
    expect(() => validateChatDbResult('chatdb:topic-exists', { ok: true, value: null })).toThrow(ValidationError)
  })

  it('rejects fetch-messages with non-array messages', () => {
    expect(() =>
      validateChatDbResult('chatdb:fetch-messages', {
        ok: true,
        value: { messages: 'bad', blocks: [] }
      })
    ).toThrow(ValidationError)
  })

  it('rejects fetch-messages with non-array blocks', () => {
    expect(() =>
      validateChatDbResult('chatdb:fetch-messages', {
        ok: true,
        value: { messages: [], blocks: 'bad' }
      })
    ).toThrow(ValidationError)
  })

  it('rejects fetch-messages with non-object element in messages', () => {
    expect(() =>
      validateChatDbResult('chatdb:fetch-messages', {
        ok: true,
        value: { messages: ['bad'], blocks: [] }
      })
    ).toThrow(ValidationError)
  })

  it('rejects fetch-messages with unknown key in value', () => {
    expect(() =>
      validateChatDbResult('chatdb:fetch-messages', {
        ok: true,
        value: { messages: [], blocks: [], extra: true }
      })
    ).toThrow(ValidationError)
  })

  it('rejects fetch-messages with null value instead of object', () => {
    expect(() => validateChatDbResult('chatdb:fetch-messages', { ok: true, value: null })).toThrow(ValidationError)
  })

  it('rejects get-raw-topic with non-null non-object value', () => {
    expect(() => validateChatDbResult('chatdb:get-raw-topic', { ok: true, value: 'bad' })).toThrow(ValidationError)
  })

  it('rejects get-raw-topic with object missing id', () => {
    expect(() =>
      validateChatDbResult('chatdb:get-raw-topic', {
        ok: true,
        value: { messages: [] }
      })
    ).toThrow(ValidationError)
  })

  it('rejects get-raw-topic with object missing messages', () => {
    expect(() =>
      validateChatDbResult('chatdb:get-raw-topic', {
        ok: true,
        value: { id: 't1' }
      })
    ).toThrow(ValidationError)
  })

  it('rejects get-raw-topic with unknown key in value', () => {
    expect(() =>
      validateChatDbResult('chatdb:get-raw-topic', {
        ok: true,
        value: { id: 't1', messages: [], extra: true }
      })
    ).toThrow(ValidationError)
  })

  it('rejects result with non-object ok=false error', () => {
    expect(() => validateChatDbResult('chatdb:fetch-messages', { ok: false, error: 'bad' })).toThrow(ValidationError)
  })

  it('rejects result with ok not boolean', () => {
    expect(() => validateChatDbResult('chatdb:fetch-messages', { ok: 1, value: null })).toThrow(ValidationError)
  })

  it('rejects success result with unknown envelope key', () => {
    expect(() => validateChatDbResult('chatdb:ensure-topic', { ok: true, value: null, extra: true })).toThrow(
      ValidationError
    )
  })

  it('rejects failure result with unknown envelope key', () => {
    expect(() =>
      validateChatDbResult('chatdb:ensure-topic', {
        ok: false,
        error: { code: 'ERR', message: 'm', retryable: false },
        extra: true
      })
    ).toThrow(ValidationError)
  })

  it('rejects failure with empty error code', () => {
    expect(() =>
      validateChatDbResult('chatdb:ensure-topic', {
        ok: false,
        error: { code: '', message: 'm', retryable: false }
      })
    ).toThrow(ValidationError)
  })

  it('rejects failure with empty error message', () => {
    expect(() =>
      validateChatDbResult('chatdb:ensure-topic', {
        ok: false,
        error: { code: 'ERR', message: '', retryable: false }
      })
    ).toThrow(ValidationError)
  })

  it('rejects failure with non-boolean retryable', () => {
    expect(() =>
      validateChatDbResult('chatdb:ensure-topic', {
        ok: false,
        error: { code: 'ERR', message: 'm', retryable: 'yes' }
      })
    ).toThrow(ValidationError)
  })

  it('rejects failure with unknown error key', () => {
    expect(() =>
      validateChatDbResult('chatdb:ensure-topic', {
        ok: false,
        error: { code: 'ERR', message: 'm', retryable: false, extra: true }
      })
    ).toThrow(ValidationError)
  })
})

// ===========================================================================
// Coverage consistency: every command must have both request and result validation
// ===========================================================================

describe('coverage consistency', () => {
  const allChannels = [
    // Original 14 commands
    'chatdb:fetch-messages',
    'chatdb:get-raw-topic',
    'chatdb:topic-exists',
    'chatdb:ensure-topic',
    'chatdb:append-message',
    'chatdb:update-message',
    'chatdb:update-message-and-blocks',
    'chatdb:delete-message',
    'chatdb:delete-messages',
    'chatdb:update-blocks',
    'chatdb:update-single-block',
    'chatdb:bulk-add-blocks',
    'chatdb:delete-blocks',
    'chatdb:clear-messages',
    // Phase 5.1A: segment + reorder + file-reference commands
    'chatdb:list-segments',
    'chatdb:upsert-segment',
    'chatdb:update-segment-metadata',
    'chatdb:delete-segment',
    'chatdb:replace-segment-membership',
    'chatdb:reorder-messages',
    'chatdb:list-file-refs-by-file',
    'chatdb:count-file-refs-by-file',
    'chatdb:list-blocks-by-file'
  ] as const

  it('every contract has validateResult (cannot silently omit result validation)', () => {
    for (const channel of allChannels) {
      const contract = getContract(channel)
      expect(typeof contract.validateResult).toBe('function')
    }
  })

  it('every contract has validate (cannot silently omit request validation)', () => {
    for (const channel of allChannels) {
      const contract = getContract(channel)
      expect(typeof contract.validate).toBe('function')
    }
  })

  it('contract count matches channel count (no orphaned or missing contracts)', () => {
    expect(Object.keys(chatDbContracts)).toHaveLength(allChannels.length)
  })

  it('all channels are tested for result validation (positive)', () => {
    // This test documents that all 23 channels have result validation tests above.
    // If a new channel is added, this list must be updated.
    const testedChannels = new Set(allChannels)
    for (const channel of Object.keys(chatDbContracts)) {
      expect(testedChannels.has(channel as (typeof allChannels)[number])).toBe(true)
    }
  })
})
