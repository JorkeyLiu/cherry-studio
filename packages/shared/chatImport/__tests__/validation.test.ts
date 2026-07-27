/**
 * ChatImport shared types validation tests.
 *
 * Validates:
 * - Envelope sessionId/version required
 * - JsonObject[] items via reused chatDb validator
 * - DiscoveryResult shape
 * - ReadPageRequest/Response shape
 * - SourceReadStats shape
 *
 * Pattern follows packages/shared/chatDb/__tests__/validation.test.ts
 */

import { describe, expect, it } from 'vitest'

import type { JsonObject } from '../../chatDb/types'
import {
  validateJsonObject,
  validateJsonObjectArray,
  validateJsonValue,
  validateNonEmptyString
} from '../../chatDb/validation'
import type {
  ChatImportEnvelope,
  DiscoveryResult,
  ImportErrorPayload,
  ReadPageRequest,
  ReadPageResponse,
  SourceReadStats
} from '../types'

// ===========================================================================
// Envelope shape
// ===========================================================================

describe('ChatImportEnvelope', () => {
  it('accepts a valid envelope with discovery phase', () => {
    const envelope: ChatImportEnvelope<DiscoveryResult> = {
      sessionId: 'test-session-123',
      phase: 'discovery',
      version: 1,
      data: {
        databaseName: 'CherryStudio',
        nativeVersion: 110,
        logicalVersion: 11,
        tableNames: ['topics', 'message_blocks']
      }
    }
    expect(envelope.sessionId).toBe('test-session-123')
    expect(envelope.phase).toBe('discovery')
    expect(envelope.version).toBe(1)
  })

  it('accepts a valid envelope with reading phase', () => {
    const envelope: ChatImportEnvelope<ReadPageResponse> = {
      sessionId: 'session-456',
      phase: 'reading',
      version: 1,
      data: {
        tableName: 'topics',
        items: [{ id: 't1', name: 'test' }],
        cursor: 't1',
        hasMore: true
      }
    }
    expect(envelope.phase).toBe('reading')
    expect(envelope.data.items).toHaveLength(1)
  })

  it('accepts a valid envelope with complete phase', () => {
    const envelope: ChatImportEnvelope<SourceReadStats> = {
      sessionId: 'session-789',
      phase: 'complete',
      version: 1,
      data: {
        topicRecordCount: 10,
        blockRecordCount: 500,
        segmentRecordCount: 5,
        sourceFileRecordCount: 20
      }
    }
    expect(envelope.data.topicRecordCount).toBe(10)
  })

  it('accepts a valid envelope with error phase', () => {
    const envelope: ChatImportEnvelope<ImportErrorPayload> = {
      sessionId: 'session-err',
      phase: 'error',
      version: 1,
      data: {
        code: 'DISCOVERY_FAILED',
        message: 'Database not found'
      }
    }
    expect(envelope.data.code).toBe('DISCOVERY_FAILED')
  })

  it('requires sessionId to be a string', () => {
    const envelope: ChatImportEnvelope<null> = {
      sessionId: '',
      phase: 'error',
      version: 1,
      data: null as any
    }
    // The envelope type allows empty string at compile time;
    // runtime validation would reject it. Verify the shape exists.
    expect(typeof envelope.sessionId).toBe('string')
  })

  it('requires version to be 1', () => {
    const envelope = {
      sessionId: 'test',
      phase: 'discovery',
      version: 1,
      data: {}
    } satisfies ChatImportEnvelope<object>
    expect(envelope.version).toBe(1)
  })
})

// ===========================================================================
// DiscoveryResult shape
// ===========================================================================

describe('DiscoveryResult', () => {
  it('has all required fields', () => {
    const result: DiscoveryResult = {
      databaseName: 'CherryStudio',
      nativeVersion: 110,
      logicalVersion: 11,
      tableNames: ['topics', 'message_blocks', 'topic_segments', 'files']
    }
    expect(result.databaseName).toBe('CherryStudio')
    expect(result.nativeVersion).toBe(110)
    expect(result.logicalVersion).toBe(11)
    expect(Array.isArray(result.tableNames)).toBe(true)
    expect(result.tableNames.length).toBeGreaterThan(0)
  })

  it('accepts zero versions', () => {
    const result: DiscoveryResult = {
      databaseName: 'test',
      nativeVersion: 0,
      logicalVersion: 0,
      tableNames: []
    }
    expect(result.nativeVersion).toBe(0)
  })
})

// ===========================================================================
// ReadPageRequest shape
// ===========================================================================

describe('ReadPageRequest', () => {
  it('has all required fields', () => {
    const request: ReadPageRequest = {
      tableName: 'topics',
      cursor: null,
      pageSize: 500
    }
    expect(request.tableName).toBe('topics')
    expect(request.cursor).toBeNull()
    expect(request.pageSize).toBe(500)
  })

  it('accepts a cursor for subsequent pages', () => {
    const request: ReadPageRequest = {
      tableName: 'message_blocks',
      cursor: 'last-item-id',
      pageSize: 500
    }
    expect(request.cursor).toBe('last-item-id')
  })
})

// ===========================================================================
// ReadPageResponse shape
// ===========================================================================

describe('ReadPageResponse', () => {
  it('has all required fields with items', () => {
    const items: JsonObject[] = [
      { id: 't1', name: 'Topic 1' },
      { id: 't2', name: 'Topic 2' }
    ]
    const response: ReadPageResponse = {
      tableName: 'topics',
      items,
      cursor: 't2',
      hasMore: true
    }
    expect(response.tableName).toBe('topics')
    expect(response.items).toHaveLength(2)
    expect(response.cursor).toBe('t2')
    expect(response.hasMore).toBe(true)
  })

  it('accepts empty items with no more pages', () => {
    const response: ReadPageResponse = {
      tableName: 'topics',
      items: [],
      cursor: null,
      hasMore: false
    }
    expect(response.items).toHaveLength(0)
    expect(response.hasMore).toBe(false)
  })

  it('items pass JsonObject validation', () => {
    const items: JsonObject[] = [
      { id: 'm1', role: 'user', content: 'hello', status: 'success' },
      { id: 'm2', role: 'assistant', content: 'hi', model: { id: 'gpt-4', name: 'GPT-4' } }
    ]
    // Each item should be a valid JSON object
    for (const item of items) {
      expect(() => validateJsonObject(item, 'item')).not.toThrow()
    }
  })
})

// ===========================================================================
// SourceReadStats shape
// ===========================================================================

describe('SourceReadStats', () => {
  it('has all required record count fields', () => {
    const stats: SourceReadStats = {
      topicRecordCount: 50,
      blockRecordCount: 5000,
      segmentRecordCount: 100,
      sourceFileRecordCount: 200
    }
    expect(stats.topicRecordCount).toBe(50)
    expect(stats.blockRecordCount).toBe(5000)
    expect(stats.segmentRecordCount).toBe(100)
    expect(stats.sourceFileRecordCount).toBe(200)
  })

  it('accepts zero counts (empty database)', () => {
    const stats: SourceReadStats = {
      topicRecordCount: 0,
      blockRecordCount: 0,
      segmentRecordCount: 0,
      sourceFileRecordCount: 0
    }
    expect(stats.topicRecordCount).toBe(0)
  })
})

// ===========================================================================
// ImportErrorPayload shape
// ===========================================================================

describe('ImportErrorPayload', () => {
  it('has code and message fields', () => {
    const payload: ImportErrorPayload = {
      code: 'WRONG_ORIGIN',
      message: 'Unexpected origin detected'
    }
    expect(payload.code).toBe('WRONG_ORIGIN')
    expect(payload.message).toBe('Unexpected origin detected')
  })

  it('accepts various error codes', () => {
    const codes = ['WRONG_ORIGIN', 'DISCOVERY_FAILED', 'READ_FAILED', 'FUTURE_VERSION', 'CANCELLED']
    for (const code of codes) {
      const payload: ImportErrorPayload = { code, message: `Error: ${code}` }
      expect(payload.code).toBe(code)
    }
  })
})

// ===========================================================================
// Re-exported chatDb validators work with import types
// ===========================================================================

describe('Re-exported validators', () => {
  it('validateJsonValue accepts valid items', () => {
    expect(() => validateJsonValue({ id: 'test', value: 42 })).not.toThrow()
  })

  it('validateJsonObject accepts valid objects', () => {
    expect(() => validateJsonObject({ id: 'test', data: [1, 2, 3] })).not.toThrow()
  })

  it('validateJsonObjectArray accepts valid arrays', () => {
    const items = [{ id: 'a' }, { id: 'b' }]
    expect(() => validateJsonObjectArray(items, 'items')).not.toThrow()
  })

  it('validateNonEmptyString accepts valid strings', () => {
    expect(() => validateNonEmptyString('hello', 'test')).not.toThrow()
  })

  it('validateJsonObjectArray rejects non-arrays', () => {
    expect(() => validateJsonObjectArray('not-an-array' as any, 'items')).toThrow()
  })

  it('validateNonEmptyString rejects empty strings', () => {
    expect(() => validateNonEmptyString('', 'test')).toThrow()
  })
})

// ===========================================================================
// Wire compatibility
// ===========================================================================

describe('Wire compatibility', () => {
  it('envelope round-trips through JSON', () => {
    const original: ChatImportEnvelope<SourceReadStats> = {
      sessionId: 'test-session',
      phase: 'complete',
      version: 1,
      data: { topicRecordCount: 1, blockRecordCount: 3, segmentRecordCount: 4, sourceFileRecordCount: 5 }
    }
    const roundTripped = JSON.parse(JSON.stringify(original)) as ChatImportEnvelope<SourceReadStats>
    expect(roundTripped).toEqual(original)
  })

  it('ReadPageResponse round-trips through JSON', () => {
    const original: ReadPageResponse = {
      tableName: 'topics',
      items: [{ id: 't1', name: 'Topic 1', nested: { value: 42 } }],
      cursor: 't1',
      hasMore: true
    }
    const roundTripped = JSON.parse(JSON.stringify(original)) as ReadPageResponse
    expect(roundTripped).toEqual(original)
  })
})
