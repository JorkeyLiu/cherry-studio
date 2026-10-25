/**
 * Portable persisted MESSAGE RESULT metadata — end-to-end field convergence.
 *
 * Source capture (aggregate write → sanitized container in the outbox) →
 * receiver apply on a second database (persisted into `messages.extra` /
 * `message_blocks.extra`) → read-back, plus atomic-container LWW (newer wins,
 * stale replay suppressed, explicit null clears), local-only overflow
 * preservation, the dedicated stable-replace unit, and v6 baseline apply.
 *
 * Nothing provider-bound may cross: connection ids, credentials, pricing,
 * raw provider/tool/image payloads, error stacks/URLs and citation targets stay
 * local (usage/metrics/thinking duration and display identity converge).
 */
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')
vi.mock('@main/config', () => ({ DATA_PATH: '/tmp' }))

const configStore = new Map<string, unknown>()
vi.mock('@main/services/ConfigManager', () => ({
  configManager: {
    get: (k: string, def?: unknown) => (configStore.has(k) ? configStore.get(k) : def),
    set: (k: string, v: unknown) => configStore.set(k, v)
  },
  ConfigKeys: {}
}))

import { createHash } from 'node:crypto'

import type { JsonObject } from '@shared/chatDb'
import { IpcChannel } from '@shared/IpcChannel'
import {
  COMPLETENESS_COMPLETE,
  computeSyncDigest,
  DIGEST_SCHEME,
  INVENTORY_VERSION_V6,
  ORDER_FRAME_VERSION,
  PAYLOAD_SCHEMA_V6,
  SCOPE_V6,
  WIRE_VERSION_V6
} from '@shared/sync'

import { chatDbService } from '../../chatDb'
import { ChatDbAggregateService } from '../../chatDb/ChatDbAggregateService'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { handleChatDbSuccessForSync } from '../chatDbHook'
import { captureLocalSyncBaselineCandidate } from '../syncBaseline'
import { applyWireSyncEnvelopeInTx, mapWireEnvelopeToMergeInput } from '../syncBaselineWireApply'
import { adoptReceiverExclusiveInTx } from '../syncReceiverUnion'
import { syncService } from '../SyncService'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>
let aggregate: ChatDbAggregateService

const T0 = 1_700_000_000_000

function hashHex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

function bindPrimary(): void {
  ;(chatDbService as any).sqlite = sqlite
  ;(chatDbService as any).db = db
  aggregate = new ChatDbAggregateService(db)
}

function openSecond(): { sqlite: Database.Database; db: BetterSQLite3Database<typeof schema> } {
  const s2 = openInMemory()
  const d2 = drizzle(s2, { schema })
  runMigrations(d2 as any, s2)
  return { sqlite: s2, db: d2 }
}

function withDb(target: { sqlite: Database.Database; db: BetterSQLite3Database<typeof schema> }, fn: () => void): void {
  const prevSqlite = (chatDbService as any).sqlite
  const prevDb = (chatDbService as any).db
  ;(chatDbService as any).sqlite = target.sqlite
  ;(chatDbService as any).db = target.db
  try {
    fn()
  } finally {
    ;(chatDbService as any).sqlite = prevSqlite
    ;(chatDbService as any).db = prevDb
  }
}

function seedTopicMessageBlock(now: string): void {
  sqlite
    .prepare(`INSERT INTO topics (id, name, created_at, updated_at, extra) VALUES (?,?,?,?,?)`)
    .run('t1', 'T', now, now, null)
  sqlite
    .prepare(
      `INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
    )
    .run('m1', 't1', 'assistant', 'answer', 'success', now, now, 0)
  sqlite
    .prepare(
      `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
    )
    .run('b-thinking', 'm1', 'thinking', 'thinking text', 'success', now, now, 0)
}

function seedSecondTopic(second: { sqlite: Database.Database }, now: string): void {
  second.sqlite
    .prepare(`INSERT INTO topics (id, name, created_at, updated_at, extra) VALUES (?,?,?,?,?)`)
    .run('t1', 'T', now, now, null)
}

function readExtra(target: { sqlite: Database.Database }, table: 'messages' | 'message_blocks', id: string): any {
  const row = target.sqlite.prepare(`SELECT extra FROM ${table} WHERE id=?`).get(id) as
    | { extra: string | null }
    | undefined
  return row?.extra ? JSON.parse(row.extra) : null
}

function outboxOps(): Array<Record<string, unknown>> {
  return syncService.listOutbox() as unknown as Array<Record<string, unknown>>
}

function latestOutboxFor(entityType: string, entityId: string): Record<string, unknown> {
  const matches = outboxOps().filter((op) => op.entityType === entityType && op.entityId === entityId)
  expect(matches.length).toBeGreaterThan(0)
  return matches[matches.length - 1]
}

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
  sqlite = openInMemory()
  db = drizzle(sqlite, { schema })
  runMigrations(db as any, sqlite)
  bindPrimary()
  syncService.clearAllForTests()
})

afterEach(() => {
  try {
    sqlite.close()
  } catch {}
  ;(chatDbService as any).sqlite = null
  ;(chatDbService as any).db = null
})

describe('incremental capture → outbox → receiver apply', () => {
  it('converges usage/metrics/mentions/model display snapshot and block thinking duration', () => {
    const now = new Date(T0).toISOString()
    seedTopicMessageBlock(now)
    const second = openSecond()
    try {
      seedSecondTopic(second, now)
      // Source writes assistant result metadata exactly like the renderer DTO.
      expect(
        aggregate.updateMessage('t1', 'm1', {
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
          metrics: { completion_tokens: 7, time_completion_millsec: 900, time_first_token_millsec: 120 },
          mentions: [{ id: 'openai/gpt-4o', name: 'GPT-4o', provider: 'device-local-provider', apiKey: 'sk-live' }],
          useful: true,
          model: {
            id: 'openai/gpt-4o',
            name: 'GPT-4o',
            group: 'OpenAI',
            provider: 'device-local-provider',
            apiHost: 'https://internal.example',
            apiKey: 'sk-live',
            pricing: { input_per_million_tokens: 3, currencySymbol: '$' }
          },
          providerMetadata: { openai: { cached: 4 } },
          traceId: 'trace-local'
        } as unknown as JsonObject).ok
      ).toBe(true)
      expect(
        aggregate.updateSingleBlock('b-thinking', {
          thinking_millsec: 1500,
          metadata: { prompt: 'p', generateImageResponse: { images: [] } },
          extraFile: { path: '/Users/me/secret.png' }
        } as unknown as JsonObject).ok
      ).toBe(true)

      const messageOp = latestOutboxFor('message', 'm1')
      const blockOp = latestOutboxFor('message_block', 'b-thinking')
      const messageMeta = (messageOp.payload as Record<string, any>).resultMeta
      const blockMeta = (blockOp.payload as Record<string, any>).resultMeta
      expect(messageMeta).toMatchObject({
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        metrics: { completion_tokens: 7, time_completion_millsec: 900, time_first_token_millsec: 120 },
        mentions: [{ id: 'openai/gpt-4o', name: 'GPT-4o' }],
        useful: true,
        model: { id: 'openai/gpt-4o', name: 'GPT-4o', group: 'OpenAI' }
      })
      expect(blockMeta).toEqual({ thinkingMs: 1500 })
      // No connection binding / credential / raw provider blob crosses the wire.
      for (const forbidden of [
        'device-local-provider',
        'sk-live',
        'internal.example',
        'pricing',
        'providerMetadata',
        'traceId',
        '/Users/me'
      ]) {
        expect(JSON.stringify(messageMeta)).not.toContain(forbidden)
        expect(JSON.stringify(blockMeta)).not.toContain(forbidden)
      }
      expect(Object.keys(messageMeta)).not.toContain('providerMetadata')

      // Receiver: message first (block parent), then block.
      withDb(second, () => {
        expect(syncService.applyIncomingOperation(messageOp as any)).toBe(true)
        expect(syncService.applyIncomingOperation(blockOp as any)).toBe(true)
      })
      const receiverMessageExtra = readExtra(second, 'messages', 'm1')
      expect(receiverMessageExtra).toMatchObject({
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        metrics: { completion_tokens: 7, time_completion_millsec: 900 },
        mentions: [{ id: 'openai/gpt-4o', name: 'GPT-4o' }],
        useful: true,
        model: { id: 'openai/gpt-4o', name: 'GPT-4o', group: 'OpenAI' }
      })
      expect(receiverMessageExtra.model.provider).toBeUndefined()
      expect(readExtra(second, 'message_blocks', 'b-thinking')).toMatchObject({ thinking_millsec: 1500 })
      // The sender keeps its own complete local overflow (never destroyed).
      const senderExtra = readExtra({ sqlite }, 'messages', 'm1')
      expect(senderExtra.model).toMatchObject({ provider: 'device-local-provider' })
    } finally {
      try {
        second.sqlite.close()
      } catch {}
      bindPrimary()
    }
  })

  it('preserves receiver-only local overflow keys when a container wins, and never transmits them back', () => {
    const now = new Date(T0).toISOString()
    seedTopicMessageBlock(now)
    const second = openSecond()
    try {
      seedSecondTopic(second, now)
      // Receiver already owns local-only overflow for the same message.
      second.sqlite
        .prepare(`INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order, extra)
                  VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(
          'm1',
          't1',
          'assistant',
          'answer',
          'success',
          now,
          now,
          0,
          JSON.stringify({ traceId: 'local-only', providerMetadata: { x: 1 } })
        )
      const op: any = {
        id: 'op-meta-1',
        entityType: 'message',
        op: 'upsert',
        entityId: 'm1',
        timestamp: T0,
        deviceId: 'dev-a',
        payload: { id: 'm1', topicId: 't1', resultMeta: { usage: { total_tokens: 9 }, useful: false } }
      }
      withDb(second, () => {
        expect(syncService.applyIncomingOperation(op)).toBe(true)
      })
      const extra = readExtra(second, 'messages', 'm1')
      expect(extra.usage).toEqual({ total_tokens: 9 })
      expect(extra.useful).toBe(false)
      expect(extra.traceId).toBe('local-only')
      expect(extra.providerMetadata).toEqual({ x: 1 })
    } finally {
      try {
        second.sqlite.close()
      } catch {}
      bindPrimary()
    }
  })

  it('applies atomic-container LWW: newer wins, stale replay is suppressed, explicit null clears', () => {
    const now = new Date(T0).toISOString()
    seedTopicMessageBlock(now)
    const base = { entityType: 'message', op: 'upsert', entityId: 'm1', deviceId: 'dev-a' }
    const newer: any = {
      ...base,
      id: 'op-newer',
      timestamp: T0 + 20,
      payload: { id: 'm1', topicId: 't1', resultMeta: { usage: { total_tokens: 20 }, useful: true } }
    }
    const stale: any = {
      ...base,
      id: 'op-stale',
      timestamp: T0 + 10,
      payload: { id: 'm1', topicId: 't1', resultMeta: { usage: { total_tokens: 10 } } }
    }
    expect(syncService.applyIncomingOperation(newer)).toBe(true)
    expect(syncService.applyIncomingOperation(stale)).toBe(false)
    expect(readExtra({ sqlite }, 'messages', 'm1').usage).toEqual({ total_tokens: 20 })
    // Replay of the very same operation is consumed once (no second write).
    expect(syncService.applyIncomingOperation(newer)).toBe(false)
    // Explicit null clears the portable subset at a later clock.
    const clear: any = {
      ...base,
      id: 'op-clear',
      timestamp: T0 + 30,
      payload: { id: 'm1', topicId: 't1', resultMeta: null }
    }
    expect(syncService.applyIncomingOperation(clear)).toBe(true)
    expect(readExtra({ sqlite }, 'messages', 'm1')).toBeNull()
  })

  it('omitting the container preserves the receiver value (no intent never wipes)', () => {
    const now = new Date(T0).toISOString()
    seedTopicMessageBlock(now)
    const withMeta: any = {
      id: 'op-with-meta',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm1',
      timestamp: T0 + 5,
      deviceId: 'dev-a',
      payload: { id: 'm1', topicId: 't1', resultMeta: { usage: { total_tokens: 4 } } }
    }
    const contentOnly: any = {
      id: 'op-content-only',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm1',
      timestamp: T0 + 6,
      deviceId: 'dev-b',
      payload: { id: 'm1', topicId: 't1', content: 'edited' }
    }
    expect(syncService.applyIncomingOperation(withMeta)).toBe(true)
    expect(syncService.applyIncomingOperation(contentOnly)).toBe(true)
    const extra = readExtra({ sqlite }, 'messages', 'm1')
    expect(extra.usage).toEqual({ total_tokens: 4 })
    expect((sqlite.prepare('SELECT content FROM messages WHERE id=?').get('m1') as any).content).toBe('edited')
  })
})

describe('coherent clear semantics (full capture variants + receiver)', () => {
  /** Simulate a row whose portable container was already published once. */
  function mintSyncedContainer(extra: Record<string, unknown>): void {
    sqlite.prepare('UPDATE messages SET extra=? WHERE id=?').run(JSON.stringify(extra), 'm1')
    sqlite
      .prepare(
        'INSERT INTO sync_field_clock (entity_type, entity_id, field, timestamp, operation_id) VALUES (?,?,?,?,?)'
      )
      .run('message', 'm1', 'resultMeta', T0 + 1, 'op-seed-result-meta')
  }

  it('hook full capture omits an empty container that was never synced and nulls one that was', () => {
    const now = new Date(T0).toISOString()
    seedTopicMessageBlock(now)
    // Never-synced row: no speculative null, the field is simply absent.
    handleChatDbSuccessForSync(IpcChannel.ChatDb_AppendMessage, { topicId: 't1', message: { id: 'm1' }, blocks: [] })
    const omission = latestOutboxFor('message', 'm1').payload as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(omission, 'resultMeta')).toBe(false)
    expect(syncService.hasResultMetaFieldClock('message', 'm1')).toBe(false)

    // Previously synced row: a full capture of the now-empty state is a clear.
    mintSyncedContainer({ usage: { total_tokens: 12 } })
    handleChatDbSuccessForSync(IpcChannel.ChatDb_AppendMessage, { topicId: 't1', message: { id: 'm1' }, blocks: [] })
    expect((latestOutboxFor('message', 'm1').payload as Record<string, unknown>).resultMeta).toEqual({
      usage: { total_tokens: 12 }
    })
    sqlite.prepare('UPDATE messages SET extra=? WHERE id=?').run(JSON.stringify({ traceId: 'local-trace' }), 'm1')
    handleChatDbSuccessForSync(IpcChannel.ChatDb_AppendMessage, { topicId: 't1', message: { id: 'm1' }, blocks: [] })
    const cleared = latestOutboxFor('message', 'm1').payload as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(cleared, 'resultMeta')).toBe(true)
    expect(cleared.resultMeta).toBeNull()
    // The clear carries a real clock (payload never outruns its field clock).
    expect(syncService.hasResultMetaFieldClock('message', 'm1')).toBe(true)
  })

  it('a captured null clear removes the peer portable subset and preserves unrelated local extra', () => {
    const now = new Date(T0).toISOString()
    seedTopicMessageBlock(now)
    const second = openSecond()
    try {
      seedSecondTopic(second, now)
      second.sqlite
        .prepare(`INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order, extra)
                  VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(
          'm1',
          't1',
          'assistant',
          'answer',
          'success',
          now,
          now,
          0,
          JSON.stringify({ usage: { total_tokens: 99 }, receiverOnly: 'keep' })
        )
      mintSyncedContainer({ usage: { total_tokens: 12 } })
      sqlite.prepare('UPDATE messages SET extra=? WHERE id=?').run(JSON.stringify({ traceId: 'local-trace' }), 'm1')
      handleChatDbSuccessForSync(IpcChannel.ChatDb_AppendMessage, { topicId: 't1', message: { id: 'm1' }, blocks: [] })
      const clearOp = latestOutboxFor('message', 'm1')
      expect((clearOp.payload as Record<string, unknown>).resultMeta).toBeNull()
      withDb(second, () => {
        expect(syncService.applyIncomingOperation(clearOp as any)).toBe(true)
      })
      const receiverExtra = readExtra(second, 'messages', 'm1')
      expect(receiverExtra.usage).toBeUndefined()
      expect(receiverExtra.receiverOnly).toBe('keep')
      // The sender's own local-only overflow is never destroyed by a capture.
      expect(readExtra({ sqlite }, 'messages', 'm1')).toEqual({ traceId: 'local-trace' })
    } finally {
      try {
        second.sqlite.close()
      } catch {}
      bindPrimary()
    }
  })

  it('aggregate capture clears the container when the last portable value is emptied', () => {
    const now = new Date(T0).toISOString()
    seedTopicMessageBlock(now)
    const second = openSecond()
    try {
      seedSecondTopic(second, now)
      withDb(second, () => {
        second.sqlite
          .prepare(`INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order, extra)
                    VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(
            'm1',
            't1',
            'assistant',
            'answer',
            'success',
            now,
            now,
            0,
            JSON.stringify({ mentions: [{ id: 'openai/gpt-4o', name: 'GPT-4o' }], receiverOnly: 'keep' })
          )
      })
      // 1) Publish the mention display snapshot.
      expect(
        aggregate.updateMessage('t1', 'm1', {
          mentions: [{ id: 'openai/gpt-4o', name: 'GPT-4o' }]
        } as unknown as JsonObject).ok
      ).toBe(true)
      const published = latestOutboxFor('message', 'm1')
      expect((published.payload as Record<string, unknown>).resultMeta).toEqual({
        mentions: [{ id: 'openai/gpt-4o', name: 'GPT-4o' }]
      })
      // 2) Empty post-state container (last portable value cleared locally).
      expect(aggregate.updateMessage('t1', 'm1', { mentions: [] } as unknown as JsonObject).ok).toBe(true)
      const cleared = latestOutboxFor('message', 'm1')
      expect(cleared.payload).not.toBe(published.payload)
      expect(Object.prototype.hasOwnProperty.call(cleared.payload, 'resultMeta')).toBe(true)
      expect((cleared.payload as Record<string, unknown>).resultMeta).toBeNull()
      expect(syncService.hasResultMetaFieldClock('message', 'm1')).toBe(true)
      // 3) Receiver: the peer portable subset is removed, local-only extra stays.
      withDb(second, () => {
        expect(syncService.applyIncomingOperation(published as any)).toBe(true)
        expect(syncService.applyIncomingOperation(cleared as any)).toBe(true)
      })
      const receiverExtra = readExtra(second, 'messages', 'm1')
      expect(receiverExtra.mentions).toBeUndefined()
      expect(receiverExtra.receiverOnly).toBe('keep')
    } finally {
      try {
        second.sqlite.close()
      } catch {}
      bindPrimary()
    }
  })
})

describe('dedicated stable replace carries the container', () => {
  const clock = (ts: number, operationId: string): Record<string, unknown> => ({ timestamp: ts, operationId })
  const MESSAGE_FIELDS = [
    'role',
    'content',
    'status',
    'askId',
    'model',
    'modelId',
    'assistantId',
    'createdAt',
    'updatedAt'
  ]
  const BLOCK_FIELDS = ['type', 'content', 'status', 'createdAt', 'updatedAt']

  function fieldClocks(keys: string[], ts: number, opId: string): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const key of keys) out[key] = clock(ts, opId)
    return out
  }

  it('materializes message metrics and block thinking duration on the receiver', () => {
    const now = new Date(T0).toISOString()
    seedTopicMessageBlock(now)
    const ts = T0 + 100
    const opId = 'op-replace-meta'
    const op: any = {
      id: opId,
      entityType: 'message',
      op: 'message_stable_replace',
      entityId: 'm1',
      timestamp: ts,
      deviceId: 'dev-a',
      payload: {
        replaceVersion: 'message-stable-replace-v1',
        messageId: 'm1',
        replacementClock: clock(ts, opId),
        message: {
          id: 'm1',
          topicId: 't1',
          role: 'assistant',
          content: 'replaced',
          status: 'success',
          askId: null,
          model: 'gpt-4o',
          modelId: 'openai/gpt-4o',
          assistantId: null,
          createdAt: now,
          updatedAt: now,
          resultMeta: {
            metrics: { completion_tokens: 5, time_completion_millsec: 700 },
            model: { id: 'openai/gpt-4o', name: 'GPT-4o' }
          },
          entityClock: clock(ts, opId),
          fieldClocks: { ...fieldClocks(MESSAGE_FIELDS, ts, opId), resultMeta: clock(ts, opId) },
          parentMembershipClock: clock(ts - 50, 'seed-m1')
        },
        messageBlocks: [
          {
            id: 'b-thinking',
            messageId: 'm1',
            type: 'thinking',
            content: 'thinking text',
            status: 'success',
            createdAt: now,
            updatedAt: now,
            resultMeta: { thinkingMs: 2500, language: 'text' },
            entityClock: clock(ts, opId),
            fieldClocks: { ...fieldClocks(BLOCK_FIELDS, ts, opId), resultMeta: clock(ts, opId) },
            parentMembershipClock: clock(ts - 50, 'seed-m1')
          }
        ],
        activeBlockIds: ['b-thinking'],
        topicFrame: {
          frameVersion: ORDER_FRAME_VERSION,
          kind: 'topicMessage',
          parentId: 't1',
          orderedChildIds: ['m1'],
          frameClock: clock(ts, opId)
        },
        messageFrame: {
          frameVersion: ORDER_FRAME_VERSION,
          kind: 'messageBlock',
          parentId: 'm1',
          orderedChildIds: ['b-thinking'],
          frameClock: clock(ts, opId)
        }
      }
    }
    expect(syncService.applyIncomingOperation(op)).toBe(true)
    expect(readExtra({ sqlite }, 'messages', 'm1')).toMatchObject({
      metrics: { completion_tokens: 5, time_completion_millsec: 700 },
      model: { id: 'openai/gpt-4o', name: 'GPT-4o' }
    })
    expect(readExtra({ sqlite }, 'message_blocks', 'b-thinking')).toMatchObject({
      thinking_millsec: 2500,
      language: 'text'
    })
  })

  it('stable replace with an explicit null clears the receiver portable subset (same clear semantics)', () => {
    const now = new Date(T0).toISOString()
    seedTopicMessageBlock(now)
    sqlite
      .prepare('UPDATE messages SET extra=? WHERE id=?')
      .run(JSON.stringify({ usage: { total_tokens: 5 }, traceId: 'keep' }), 'm1')
    const ts = T0 + 200
    const opId = 'op-replace-clear'
    const op: any = {
      id: opId,
      entityType: 'message',
      op: 'message_stable_replace',
      entityId: 'm1',
      timestamp: ts,
      deviceId: 'dev-a',
      payload: {
        replaceVersion: 'message-stable-replace-v1',
        messageId: 'm1',
        replacementClock: clock(ts, opId),
        message: {
          id: 'm1',
          topicId: 't1',
          role: 'assistant',
          content: 'replaced',
          status: 'success',
          askId: null,
          model: 'gpt-4o',
          modelId: 'openai/gpt-4o',
          assistantId: null,
          createdAt: now,
          updatedAt: now,
          resultMeta: null,
          entityClock: clock(ts, opId),
          fieldClocks: { ...fieldClocks(MESSAGE_FIELDS, ts, opId), resultMeta: clock(ts, opId) },
          parentMembershipClock: clock(ts - 50, 'seed-m1')
        },
        messageBlocks: [
          {
            id: 'b-thinking',
            messageId: 'm1',
            type: 'thinking',
            content: 'thinking text',
            status: 'success',
            createdAt: now,
            updatedAt: now,
            entityClock: clock(ts, opId),
            fieldClocks: fieldClocks(BLOCK_FIELDS, ts, opId),
            parentMembershipClock: clock(ts - 50, 'seed-m1')
          }
        ],
        activeBlockIds: ['b-thinking'],
        topicFrame: {
          frameVersion: ORDER_FRAME_VERSION,
          kind: 'topicMessage',
          parentId: 't1',
          orderedChildIds: ['m1'],
          frameClock: clock(ts, opId)
        },
        messageFrame: {
          frameVersion: ORDER_FRAME_VERSION,
          kind: 'messageBlock',
          parentId: 'm1',
          orderedChildIds: ['b-thinking'],
          frameClock: clock(ts, opId)
        }
      }
    }
    expect(syncService.applyIncomingOperation(op)).toBe(true)
    const extra = readExtra({ sqlite }, 'messages', 'm1')
    expect(extra.usage).toBeUndefined()
    expect(extra.traceId).toBe('keep')
  })
})

describe('v6 baseline apply persists the container', () => {
  function v6Envelope(payload: Record<string, unknown>): Record<string, unknown> {
    const digest = computeSyncDigest(payload as never, hashHex)
    return {
      wireVersion: WIRE_VERSION_V6,
      channelId: 'ch-meta',
      watermark: 11,
      digestScheme: DIGEST_SCHEME,
      digest,
      payload
    }
  }

  function v6Payload(): Record<string, unknown> {
    const tClock = { timestamp: 10, operationId: 'wtop10' }
    const mClock = { timestamp: 11, operationId: 'wmsg11' }
    const bClock = { timestamp: 12, operationId: 'wblk12' }
    const fTop = { timestamp: 13, operationId: 'wfrm13' }
    const fBlk = { timestamp: 14, operationId: 'wfrm14' }
    const messageFieldClocks: Record<string, unknown> = {
      role: mClock,
      content: mClock,
      status: mClock,
      askId: mClock,
      model: mClock,
      modelId: mClock,
      assistantId: mClock,
      createdAt: mClock,
      updatedAt: mClock,
      resultMeta: mClock
    }
    return {
      payloadSchema: PAYLOAD_SCHEMA_V6,
      inventoryVersion: INVENTORY_VERSION_V6,
      orderFrameVersion: ORDER_FRAME_VERSION,
      scope: SCOPE_V6,
      topics: [
        {
          id: 'wt1',
          name: 'Wire Topic',
          assistantId: null,
          createdAt: null,
          updatedAt: null,
          deletedAt: null,
          pinned: null,
          prompt: null,
          isNameManuallyEdited: null,
          entityClock: tClock,
          fieldClocks: {
            name: tClock,
            assistantId: tClock,
            createdAt: tClock,
            updatedAt: tClock,
            deletedAt: tClock,
            pinned: tClock,
            prompt: tClock,
            isNameManuallyEdited: tClock
          }
        }
      ],
      messages: [
        {
          id: 'wm1',
          topicId: 'wt1',
          branchId: null,
          role: 'assistant',
          content: 'hi',
          status: 'success',
          askId: null,
          model: 'gpt-4o',
          modelId: 'openai/gpt-4o',
          assistantId: null,
          createdAt: null,
          updatedAt: null,
          resultMeta: { usage: { prompt_tokens: 2, total_tokens: 4 }, useful: true },
          entityClock: mClock,
          fieldClocks: messageFieldClocks,
          parentMembershipClock: mClock
        }
      ],
      messageBlocks: [
        {
          id: 'wb1',
          messageId: 'wm1',
          type: 'thinking',
          content: 'body',
          status: 'success',
          createdAt: null,
          updatedAt: null,
          assetIds: [],
          resultMeta: { thinkingMs: 900 },
          entityClock: bClock,
          fieldClocks: {
            type: bClock,
            content: bClock,
            status: bClock,
            createdAt: bClock,
            updatedAt: bClock,
            assetIds: bClock,
            resultMeta: bClock
          },
          parentMembershipClock: bClock
        }
      ],
      branches: [],
      assistantConfigs: [],
      fileAssets: [],
      topicReferences: [],
      tombstones: [],
      assistantTombstones: [],
      orderFrames: [
        {
          frameVersion: ORDER_FRAME_VERSION,
          kind: 'topicMessage',
          parentId: 'wt1',
          orderedChildIds: ['wm1'],
          frameClock: fTop
        },
        {
          frameVersion: ORDER_FRAME_VERSION,
          kind: 'messageBlock',
          parentId: 'wm1',
          orderedChildIds: ['wb1'],
          frameClock: fBlk
        }
      ],
      replacementRegisters: [],
      manifest: {
        payloadSchema: PAYLOAD_SCHEMA_V6,
        inventoryVersion: INVENTORY_VERSION_V6,
        orderFrameVersion: ORDER_FRAME_VERSION,
        scope: SCOPE_V6,
        liveCounts: {
          topic: 1,
          message: 1,
          messageBlock: 1,
          branch: 0,
          assistantConfig: 0,
          fileAsset: 0,
          topicReference: 0
        },
        tombstoneCounts: {
          topic: 0,
          message: 0,
          messageBlock: 0,
          topicBranch: 0,
          fileAsset: 0,
          assistantConfig: 0,
          topicReference: 0
        },
        frameCounts: { topicMessage: 1, messageBlock: 1, branchSuffix: 0 },
        replacementCount: 0,
        completeness: COMPLETENESS_COMPLETE
      }
    }
  }

  it('merges the v6 entity container into the persisted extra columns', () => {
    const envelope = v6Envelope(v6Payload())
    db.transaction((tx) => {
      applyWireSyncEnvelopeInTx(tx as never, envelope, { expectedChannelId: 'ch-meta' })
    })
    expect(readExtra({ sqlite }, 'messages', 'wm1')).toMatchObject({
      usage: { prompt_tokens: 2, total_tokens: 4 },
      useful: true
    })
    expect(readExtra({ sqlite }, 'message_blocks', 'wb1')).toMatchObject({ thinking_millsec: 900 })
  })

  it('fails closed when the container is present without its field clock', () => {
    const payload = v6Payload()
    const message = (payload.messages as Array<Record<string, unknown>>)[0]
    const clocks = { ...(message.fieldClocks as Record<string, unknown>) }
    delete clocks.resultMeta
    message.fieldClocks = clocks
    // The strict validator rejects the shape before any digest/apply work, so
    // the envelope can never even be sealed.
    expect(() => v6Envelope(payload)).toThrow(/missing fieldClock "resultMeta"/)
    expect(sqlite.prepare('SELECT id FROM messages WHERE id=?').get('wm1')).toBeUndefined()
  })
})

describe('adoption keeps the container portable (seed holder + receiver union)', () => {
  const MSG_FIELDS = ['role', 'content', 'status', 'askId', 'model', 'modelId', 'assistantId', 'createdAt', 'updatedAt']
  const BLK_FIELDS = ['type', 'content', 'status', 'createdAt', 'updatedAt', 'assetIds']
  const TOP_FIELDS = [
    'name',
    'assistantId',
    'createdAt',
    'updatedAt',
    'deletedAt',
    'pinned',
    'prompt',
    'isNameManuallyEdited'
  ]

  function seedUnversionedLocal(
    target: { sqlite: Database.Database },
    ids: {
      topicId: string
      messageId: string
      blockId: string
      messageExtra: string | null
      blockExtra: string | null
    }
  ): void {
    const now = new Date(T0).toISOString()
    target.sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at, extra) VALUES (?,?,?,?,?)`)
      .run(ids.topicId, 'Adopted', now, now, null)
    target.sqlite
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(ids.messageId, ids.topicId, 'assistant', 'answer', 'success', now, now, 0, ids.messageExtra)
    target.sqlite
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(ids.blockId, ids.messageId, 'thinking', 'reasoning', 'success', now, now, 0, ids.blockExtra)
  }

  function wirePayloads(opts: { withContainer: boolean }): Record<string, unknown> {
    const clock = (ts: number, operationId: string) => ({ timestamp: ts, operationId })
    const tClock = clock(10, 'wtop10')
    const mClock = clock(11, 'wmsg11')
    const bClock = clock(12, 'wblk12')
    const clocks = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, mClock]))
    const message: Record<string, unknown> = {
      id: 'wt1-m1',
      topicId: 'wt1',
      branchId: null,
      role: 'assistant',
      content: 'peer',
      status: 'success',
      askId: null,
      model: 'gpt-4o',
      modelId: 'openai/gpt-4o',
      assistantId: null,
      createdAt: null,
      updatedAt: null,
      entityClock: mClock,
      fieldClocks: clocks(MSG_FIELDS),
      parentMembershipClock: mClock
    }
    const block: Record<string, unknown> = {
      id: 'wt1-b1',
      messageId: 'wt1-m1',
      type: 'thinking',
      content: 'peer reasoning',
      status: 'success',
      createdAt: null,
      updatedAt: null,
      assetIds: [],
      entityClock: bClock,
      fieldClocks: clocks(BLK_FIELDS),
      parentMembershipClock: bClock
    }
    if (opts.withContainer) {
      message.resultMeta = { usage: { prompt_tokens: 2, total_tokens: 4 } }
      ;(message.fieldClocks as Record<string, unknown>).resultMeta = mClock
      block.resultMeta = { thinkingMs: 300 }
      ;(block.fieldClocks as Record<string, unknown>).resultMeta = bClock
    }
    return {
      payloadSchema: PAYLOAD_SCHEMA_V6,
      inventoryVersion: INVENTORY_VERSION_V6,
      orderFrameVersion: ORDER_FRAME_VERSION,
      scope: SCOPE_V6,
      topics: [
        {
          id: 'wt1',
          name: 'Peer Topic',
          assistantId: null,
          createdAt: null,
          updatedAt: null,
          deletedAt: null,
          pinned: null,
          prompt: null,
          isNameManuallyEdited: null,
          entityClock: tClock,
          fieldClocks: Object.fromEntries(TOP_FIELDS.map((k) => [k, tClock]))
        }
      ],
      messages: [message],
      messageBlocks: [block],
      branches: [],
      assistantConfigs: [],
      fileAssets: [],
      topicReferences: [],
      tombstones: [],
      assistantTombstones: [],
      orderFrames: [
        {
          frameVersion: ORDER_FRAME_VERSION,
          kind: 'topicMessage',
          parentId: 'wt1',
          orderedChildIds: ['wt1-m1'],
          frameClock: clock(13, 'wfrm13')
        },
        {
          frameVersion: ORDER_FRAME_VERSION,
          kind: 'messageBlock',
          parentId: 'wt1-m1',
          orderedChildIds: ['wt1-b1'],
          frameClock: clock(14, 'wfrm14')
        }
      ],
      replacementRegisters: [],
      manifest: {
        payloadSchema: PAYLOAD_SCHEMA_V6,
        inventoryVersion: INVENTORY_VERSION_V6,
        orderFrameVersion: ORDER_FRAME_VERSION,
        scope: SCOPE_V6,
        liveCounts: {
          topic: 1,
          message: 1,
          messageBlock: 1,
          branch: 0,
          assistantConfig: 0,
          fileAsset: 0,
          topicReference: 0
        },
        tombstoneCounts: {
          topic: 0,
          message: 0,
          messageBlock: 0,
          topicBranch: 0,
          fileAsset: 0,
          assistantConfig: 0,
          topicReference: 0
        },
        frameCounts: { topicMessage: 1, messageBlock: 1, branchSuffix: 0 },
        replacementCount: 0,
        completeness: COMPLETENESS_COMPLETE
      }
    }
  }

  function envelope(payload: Record<string, unknown>): Record<string, unknown> {
    return {
      wireVersion: WIRE_VERSION_V6,
      channelId: 'ch-meta',
      watermark: 21,
      digestScheme: DIGEST_SCHEME,
      digest: computeSyncDigest(payload as never, hashHex),
      payload
    }
  }

  function fieldClockFields(entityType: string, entityId: string): string[] {
    return (
      sqlite
        .prepare(`SELECT field FROM sync_field_clock WHERE entity_type=? AND entity_id=? ORDER BY field`)
        .all(entityType, entityId) as Array<{ field: string }>
    ).map((r) => r.field)
  }

  it('declares the sanitized container for adoptable (unversioned) rows only, and never a null shell', () => {
    const withMeta = {
      topicId: 'ad-t1',
      messageId: 'ad-m1',
      blockId: 'ad-b1',
      messageExtra: JSON.stringify({ usage: { prompt_tokens: 9, total_tokens: 12 }, useful: true, apiKey: 'sk-live' }),
      blockExtra: JSON.stringify({ thinking_millsec: 1250, error: { name: 'E', stack: '/Users/me/x' } })
    }
    seedUnversionedLocal({ sqlite }, withMeta)
    seedUnversionedLocal(
      { sqlite },
      {
        topicId: 'ad-t2',
        messageId: 'ad-m2',
        blockId: 'ad-b2',
        messageExtra: null,
        blockExtra: null
      }
    )

    const plain = captureLocalSyncBaselineCandidate(db as never)
    const plainMessage = plain.entities.find((e) => e.entityId === 'ad-m1')!
    expect(Object.prototype.hasOwnProperty.call(plainMessage.payload, 'resultMeta')).toBe(false)

    const adopting = captureLocalSyncBaselineCandidate(db as never, { adoptionResultMeta: true })
    const adoptedMessage = adopting.entities.find((e) => e.entityId === 'ad-m1')!
    const adoptedBlock = adopting.entities.find((e) => e.entityId === 'ad-b1')!
    expect(adoptedMessage.payload.resultMeta).toEqual({ usage: { prompt_tokens: 9, total_tokens: 12 }, useful: true })
    expect(adoptedBlock.payload.resultMeta).toEqual({ thinkingMs: 1250, error: { name: 'E' } })
    // No local metadata => no declared container at all (never a minted null).
    const emptyMessage = adopting.entities.find((e) => e.entityId === 'ad-m2')!
    const emptyBlock = adopting.entities.find((e) => e.entityId === 'ad-b2')!
    expect(Object.prototype.hasOwnProperty.call(emptyMessage.payload, 'resultMeta')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(emptyBlock.payload, 'resultMeta')).toBe(false)
  })

  it('mints the container field clock with the adoption enqueue (payload never outruns clocks)', () => {
    seedUnversionedLocal(
      { sqlite },
      {
        topicId: 'ad-t3',
        messageId: 'ad-m3',
        blockId: 'ad-b3',
        messageExtra: JSON.stringify({ metrics: { time_thinking_millsec: 640 } }),
        blockExtra: null
      }
    )
    const adopting = captureLocalSyncBaselineCandidate(db as never, { adoptionResultMeta: true })
    const message = adopting.entities.find((e) => e.entityId === 'ad-m3')!
    expect(message.payload.resultMeta).toEqual({ metrics: { time_thinking_millsec: 640 } })
    const opId = syncService.enqueueUpsertInTx(db as never, 'message', 'ad-m3', message.payload, T0 + 500, 'dev-adopt')
    expect(opId).toBeTruthy()
    expect(fieldClockFields('message', 'ad-m3')).toContain('resultMeta')
    const op = syncService.listOutbox().find((o) => (o as { entityId: string }).entityId === 'ad-m3') as unknown as {
      payload: Record<string, unknown>
    }
    expect(op.payload.resultMeta).toEqual({ metrics: { time_thinking_millsec: 640 } })
  })

  it('receiver union adopts exclusive local history with its container and clock when the peer declares it', () => {
    seedUnversionedLocal(
      { sqlite },
      {
        topicId: 'lt1',
        messageId: 'lm1',
        blockId: 'lb1',
        messageExtra: JSON.stringify({ usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }),
        blockExtra: JSON.stringify({ thinking_millsec: 2200 })
      }
    )
    db.transaction((tx) => {
      const mapped = mapWireEnvelopeToMergeInput(envelope(wirePayloads({ withContainer: true })))
      adoptReceiverExclusiveInTx(tx as never, mapped.input, 'dev-union')
    })
    const messageOp = syncService
      .listOutbox()
      .find(
        (o) => (o as { entityId: string }).entityId === 'lm1' && (o as { entityType: string }).entityType === 'message'
      ) as unknown as { payload: Record<string, unknown> }
    expect(messageOp.payload.resultMeta).toEqual({
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }
    })
    expect(fieldClockFields('message', 'lm1')).toContain('resultMeta')
    expect(fieldClockFields('message_block', 'lb1')).toContain('resultMeta')
    const blockOp = syncService.listOutbox().find((o) => (o as { entityId: string }).entityId === 'lb1') as unknown as {
      payload: Record<string, unknown>
    }
    expect(blockOp.payload.resultMeta).toEqual({ thinkingMs: 2200 })
  })

  it('receiver union keeps the container local-only when the peer channel cannot carry it', () => {
    seedUnversionedLocal(
      { sqlite },
      {
        topicId: 'lt2',
        messageId: 'lm2',
        blockId: 'lb2',
        messageExtra: JSON.stringify({ usage: { prompt_tokens: 5, total_tokens: 5 } }),
        blockExtra: JSON.stringify({ thinking_millsec: 410 })
      }
    )
    db.transaction((tx) => {
      const mapped = mapWireEnvelopeToMergeInput(envelope(wirePayloads({ withContainer: false })))
      adoptReceiverExclusiveInTx(tx as never, mapped.input, 'dev-union')
    })
    const messageOp = syncService
      .listOutbox()
      .find((o) => (o as { entityId: string }).entityId === 'lm2') as unknown as { payload: Record<string, unknown> }
    expect(Object.prototype.hasOwnProperty.call(messageOp.payload, 'resultMeta')).toBe(false)
    expect(fieldClockFields('message', 'lm2')).not.toContain('resultMeta')
    // The local row keeps its own overflow untouched: nothing is erased locally.
    expect(readExtra({ sqlite }, 'messages', 'lm2')).toMatchObject({ usage: { prompt_tokens: 5, total_tokens: 5 } })
  })

  it('receiver union same-ID container divergence fails closed with zero writes', () => {
    // Byte-identical rows except the portable container: only `resultMeta` may
    // be the divergence that fails the union closed.
    seedUnversionedLocal(
      { sqlite },
      {
        topicId: 'wt1',
        messageId: 'wt1-m1',
        blockId: 'wt1-b1',
        messageExtra: JSON.stringify({ usage: { prompt_tokens: 99, total_tokens: 99 } }),
        blockExtra: JSON.stringify({ thinking_millsec: 999 })
      }
    )
    sqlite
      .prepare(`UPDATE topics SET name=?, created_at=NULL, updated_at=NULL, extra=? WHERE id=?`)
      .run('Peer Topic', JSON.stringify({ pinned: null, prompt: null, isNameManuallyEdited: null }), 'wt1')
    sqlite
      .prepare(`UPDATE messages SET content=?, model=?, model_id=?, created_at=NULL, updated_at=NULL WHERE id=?`)
      .run('peer', 'gpt-4o', 'openai/gpt-4o', 'wt1-m1')
    sqlite
      .prepare(`UPDATE message_blocks SET content=?, created_at=NULL, updated_at=NULL WHERE id=?`)
      .run('peer reasoning', 'wt1-b1')
    expect(() =>
      db.transaction((tx) => {
        const mapped = mapWireEnvelopeToMergeInput(envelope(wirePayloads({ withContainer: true })))
        adoptReceiverExclusiveInTx(tx as never, mapped.input, 'dev-union')
      })
    ).toThrow(/same-ID value divergence for message\/wt1-m1 field resultMeta/)
    expect(syncService.listOutbox().length).toBe(0)
    expect(fieldClockFields('message', 'wt1-m1')).toEqual([])
  })
})
