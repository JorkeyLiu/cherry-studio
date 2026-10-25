/**
 * Declared wire surface for portable persisted message result metadata.
 *
 * Guards that the ONE additive `resultMeta` container is accepted with strict
 * validation on every declared route (incremental upsert, dedicated stable
 * replace, latest v6 baseline entity) while historical v1-v5 entity shapes stay
 * byte-for-byte valid, and that a payload key can never outrun its field clock
 * (or a clock exist without its payload value).
 */
import { describe, expect, it } from 'vitest'

import {
  validateMessageBlockEntityStableReplace,
  validateMessageBlockEntityV6,
  validateMessageEntityStableReplace,
  validateMessageEntityV6
} from '../baselineWire'
import { validateSyncOperationStrict } from '../payloadFilter'

const CLOCK = { timestamp: 100, operationId: 'op-1' }

function messageEntity(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'm1',
    topicId: 't1',
    branchId: null,
    role: 'assistant',
    content: 'hi',
    status: 'success',
    askId: null,
    model: 'gpt-4o',
    modelId: 'openai/gpt-4o',
    assistantId: 'as-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    entityClock: CLOCK,
    fieldClocks: {
      role: CLOCK,
      content: CLOCK,
      status: CLOCK,
      askId: CLOCK,
      model: CLOCK,
      modelId: CLOCK,
      assistantId: CLOCK,
      createdAt: CLOCK,
      updatedAt: CLOCK
    },
    parentMembershipClock: CLOCK,
    ...extra
  }
}

function blockEntity(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'b1',
    messageId: 'm1',
    type: 'main_text',
    content: 'body',
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    assetIds: [],
    entityClock: CLOCK,
    fieldClocks: {
      type: CLOCK,
      content: CLOCK,
      status: CLOCK,
      createdAt: CLOCK,
      updatedAt: CLOCK,
      assetIds: CLOCK
    },
    parentMembershipClock: CLOCK,
    ...extra
  }
}

describe('v6 baseline entity carries the optional result container', () => {
  it('accepts the container with its required field clock', () => {
    const entity = messageEntity({
      resultMeta: { usage: { total_tokens: 12 }, useful: true },
      fieldClocks: { ...(messageEntity().fieldClocks as object), resultMeta: CLOCK }
    })
    expect(() => validateMessageEntityV6(entity, 'messages[0]')).not.toThrow()
    const block = blockEntity({
      resultMeta: { thinkingMs: 1500, language: 'ts' },
      fieldClocks: { ...(blockEntity().fieldClocks as object), resultMeta: CLOCK }
    })
    expect(() => validateMessageBlockEntityV6(block, 'messageBlocks[0]')).not.toThrow()
  })

  it('rejects a container without its clock and a clock without a container', () => {
    expect(() => validateMessageEntityV6(messageEntity({ resultMeta: null }), 'm')).toThrow(
      /missing fieldClock "resultMeta"/
    )
    expect(() =>
      validateMessageEntityV6(
        messageEntity({ fieldClocks: { ...(messageEntity().fieldClocks as object), resultMeta: CLOCK } }),
        'm'
      )
    ).toThrow(/clock without payload value/)
    expect(() =>
      validateMessageBlockEntityV6(
        blockEntity({
          resultMeta: { thinkingMs: -1 },
          fieldClocks: { ...(blockEntity().fieldClocks as object), resultMeta: CLOCK }
        }),
        'b'
      )
    ).toThrow(/thinkingMs/)
  })

  it('keeps historical entity shapes valid without the container', () => {
    expect(() => validateMessageEntityV6(messageEntity(), 'm')).not.toThrow()
    expect(() => validateMessageBlockEntityV6(blockEntity(), 'b')).not.toThrow()
  })

  it('stable replace accepts the container on both entity shapes', () => {
    const message = {
      ...messageEntity({
        resultMeta: { metrics: { completion_tokens: 4, time_completion_millsec: 800 } },
        fieldClocks: { ...(messageEntity().fieldClocks as object), resultMeta: CLOCK }
      })
    }
    delete (message as Record<string, unknown>).branchId
    expect(() => validateMessageEntityStableReplace(message, 'message')).not.toThrow()
    const block = {
      ...blockEntity({
        resultMeta: { error: { name: 'AI_APICallError', code: 'E_UPSTREAM' } },
        fieldClocks: { ...(blockEntity().fieldClocks as object), resultMeta: CLOCK }
      })
    }
    delete (block as Record<string, unknown>).assetIds
    delete (block as Record<string, unknown>).fieldClocks
    ;(block as Record<string, unknown>).fieldClocks = {
      type: CLOCK,
      content: CLOCK,
      status: CLOCK,
      createdAt: CLOCK,
      updatedAt: CLOCK,
      resultMeta: CLOCK
    }
    expect(() => validateMessageBlockEntityStableReplace(block, 'block')).not.toThrow()
  })
})

describe('incremental upsert validation', () => {
  const baseMessage = { id: 'm1', topicId: 't1' }
  const baseBlock = { id: 'b1', messageId: 'm1', type: 'main_text', assetIds: [] }

  function messageOp(payload: Record<string, unknown>): Record<string, unknown> {
    return {
      id: 'op-m',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm1',
      timestamp: 1,
      deviceId: 'dev',
      payload: { ...baseMessage, ...payload }
    }
  }

  function blockOp(payload: Record<string, unknown>): Record<string, unknown> {
    return {
      id: 'op-b',
      entityType: 'message_block',
      op: 'upsert',
      entityId: 'b1',
      timestamp: 1,
      deviceId: 'dev',
      payload: { ...baseBlock, ...payload }
    }
  }

  it('accepts a valid container, an explicit null clear and an omitted container', () => {
    expect(
      validateSyncOperationStrict(
        messageOp({
          resultMeta: { usage: { prompt_tokens: 3, total_tokens: 3 }, mentions: [{ id: 'a/b', name: 'B' }] }
        })
      )
    ).toBeNull()
    expect(validateSyncOperationStrict(messageOp({ resultMeta: null }))).toBeNull()
    expect(validateSyncOperationStrict(messageOp({ content: 'x' }))).toBeNull()
    expect(
      validateSyncOperationStrict(blockOp({ resultMeta: { thinkingMs: 42, translation: { targetLanguage: 'fr' } } }))
    ).toBeNull()
  })

  it('rejects invalid numeric values, unsafe keys and non-portable payload blobs', () => {
    expect(validateSyncOperationStrict(messageOp({ resultMeta: { usage: { prompt_tokens: 'x' } } }))).toMatch(
      /prompt_tokens/
    )
    expect(validateSyncOperationStrict(messageOp({ resultMeta: { usage: { prompt_tokens: -3 } } }))).toMatch(
      /prompt_tokens/
    )
    expect(validateSyncOperationStrict(messageOp({ resultMeta: { providerMetadata: {} } }))).toMatch(
      /unknown key "providerMetadata"/
    )
    expect(validateSyncOperationStrict(messageOp({ resultMeta: { traceId: 't' } }))).toMatch(/unknown key "traceId"/)
    expect(validateSyncOperationStrict(blockOp({ resultMeta: { error: { stack: 'secret' } } }))).toMatch(
      /unknown key "stack"/
    )
    expect(validateSyncOperationStrict(blockOp({ resultMeta: { rawMcpToolResponse: {} } }))).toMatch(
      /unknown key "rawMcpToolResponse"/
    )
    // Freeform error text and unsafe identifiers are refused on every route:
    // `message` left the portable schema; name/code/i18nKey must be safe tokens.
    expect(validateSyncOperationStrict(blockOp({ resultMeta: { error: { message: 'boom' } } }))).toMatch(
      /unknown key "message"/
    )
    expect(
      validateSyncOperationStrict(blockOp({ resultMeta: { error: { name: 'https://internal.example' } } }))
    ).toMatch(/error.name/)
    expect(validateSyncOperationStrict(blockOp({ resultMeta: { error: { code: 'sk-live' } } }))).toMatch(/error.code/)
    // A null mention is a structured validation error, never a TypeError.
    expect(validateSyncOperationStrict(messageOp({ resultMeta: { mentions: [null] } }))).toMatch(/mentions\[0\]/)
    expect(() => validateSyncOperationStrict(messageOp({ resultMeta: { mentions: [null] } }))).not.toThrow()
    // A generic `extra` blob is never a transport: unknown keys stay rejected.
    expect(validateSyncOperationStrict(messageOp({ extra: { usage: {} } }))).toMatch(/not allowlisted/)
  })
})
