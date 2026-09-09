/**
 * Fifth-audit blocker regressions (LOCK-PERSONAL-001/004/006).
 * - Fail-closed capture context: enabled infra errors propagate (never false).
 * - Stable-child parent closure never emits a transient assistant parent.
 * - Config-generation boundary cancels stale in-flight sync() cycles.
 * - Every production-loaded locale is truthful and carries required keys.
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

import { configManager } from '@main/services/ConfigManager'
import { eq } from 'drizzle-orm'

import { chatDbService } from '../../chatDb'
import { ChatDbAggregateService } from '../../chatDb/ChatDbAggregateService'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { handleChatDbSuccessForSync } from '../chatDbHook'
import { syncService, SyncStaleConfigError } from '../SyncService'
import { seedRegisteredAttachedSyncService } from './helpers/syncTestRegistration'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

function msgJson(id: string, topicId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    topicId,
    role: 'user',
    content: 'hi',
    status: 'success',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra
  } as Record<string, unknown>
}

function blockJson(id: string, messageId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    messageId,
    type: 'text',
    content: 'body',
    status: 'success',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra
  } as Record<string, unknown>
}

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
  configStore.set('sync:token', '')
  sqlite = openInMemory()
  db = drizzle(sqlite, { schema })
  runMigrations(db as any, sqlite)
  ;(chatDbService as any).sqlite = sqlite
  ;(chatDbService as any).db = db
  syncService.clearAllForTests()
  seedRegisteredAttachedSyncService(configStore, db)
})

afterEach(() => {
  try {
    sqlite.close()
  } catch {}
  ;(chatDbService as any).sqlite = null
  ;(chatDbService as any).db = null
  vi.restoreAllMocks()
})

describe('blocker 1: enabled capture-context failures fail closed (never false)', () => {
  it('isCaptureEnabled throws on config infrastructure failure; confirmed-disabled stays the only false', () => {
    expect(syncService.isCaptureEnabled()).toBe(true)
    const spy = vi.spyOn(configManager, 'get').mockImplementation(() => {
      throw new Error('config-store-boom')
    })
    try {
      expect(() => syncService.isCaptureEnabled()).toThrow(/config-store-boom/)
    } finally {
      spy.mockRestore()
    }
    configStore.set('sync:enabled', false)
    expect(syncService.isCaptureEnabled()).toBe(false)
  })

  it('isTracked/isKnown Tx checks propagate infra errors but tolerate genuinely absent tables', () => {
    const throwingTx = {
      select: () => {
        throw new Error('infra-boom')
      }
    } as never
    expect(() => syncService.isTrackedEntityInTx(throwingTx, 'topic', 't-x')).toThrow(/infra-boom/)
    expect(() => syncService.isKnownEntityInTx(throwingTx, 'message', 'm-x')).toThrow(/infra-boom/)
    // Pre-migration database without sync tables: truthful miss, not a failure.
    const bare = openInMemory()
    try {
      const bareDb = drizzle(bare, { schema })
      expect(syncService.isTrackedEntityInTx(bareDb as never, 'topic', 't-x')).toBe(false)
      expect(syncService.isKnownEntityInTx(bareDb as never, 'topic', 't-x')).toBe(false)
    } finally {
      bare.close()
    }
  })

  it('aggregate tracked-read failure rolls back the mutation with a durable capture error', () => {
    const agg = new ChatDbAggregateService(db, sqlite)
    expect(agg.ensureTopic('t-read-fail', 'a1', 'T').ok).toBe(true)
    const spy = vi.spyOn(syncService, 'isTrackedEntityInTx').mockImplementation(() => {
      throw new Error('clock-read-boom')
    })
    try {
      const res = agg.appendMessage('t-read-fail', msgJson('m-read-fail', 't-read-fail') as any, [])
      expect(res.ok).toBe(false)
      expect(sqlite.prepare('SELECT id FROM messages WHERE id=?').get('m-read-fail')).toBeUndefined()
      const cap = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastCaptureError')).get()
      expect(cap?.value).toMatch(/clock-read-boom/)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('blocker 2: parent closure never emits a transient assistant parent (LOCK-PERSONAL-004)', () => {
  it('aggregate stable-block capture under a transient parent rolls back with a durable deferral error', () => {
    const agg = new ChatDbAggregateService(db, sqlite)
    expect(agg.ensureTopic('t-pc', 'a1', 'T').ok).toBe(true)
    // Transient assistant stub commits locally but captures nothing.
    const stub = agg.appendMessage(
      't-pc',
      msgJson('m-pc', 't-pc', { role: 'assistant', status: 'streaming', content: 'partial' }) as any,
      []
    )
    expect(stub.ok).toBe(true)
    const outboxAfterStub = syncService.listOutbox()
    expect(outboxAfterStub.some((o) => o.entityId === 'm-pc')).toBe(false)
    // A stable block for the still-transient parent must not emit the parent.
    const res = agg.updateMessageAndBlocks('t-pc', { id: 'm-pc' } as any, [
      blockJson('b-pc', 'm-pc', { status: 'success' }) as any
    ])
    expect(res.ok).toBe(false)
    const ops = syncService.listOutbox()
    expect(ops.some((o) => o.entityId === 'm-pc')).toBe(false)
    expect(ops.some((o) => o.entityId === 'b-pc')).toBe(false)
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-pc')).toBeUndefined()
    const cap = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastCaptureError')).get()
    expect(cap?.value).toMatch(/transient|defer/i)
  })

  it('post-commit hook defers a stable block under a transient parent without emitting it', async () => {
    const { IpcChannel } = await import('@shared/IpcChannel')
    const agg = new ChatDbAggregateService(db, sqlite)
    // Build rows with capture disabled so no intent exists for either entity.
    configStore.set('sync:enabled', false)
    expect(agg.ensureTopic('t-hk', 'a1', 'T').ok).toBe(true)
    expect(
      agg.appendMessage(
        't-hk',
        msgJson('m-hk', 't-hk', { role: 'assistant', status: 'streaming', content: 'partial' }) as any,
        [blockJson('b-hk', 'm-hk', { status: 'success' }) as any]
      ).ok
    ).toBe(true)
    configStore.set('sync:enabled', true)
    // Track only the topic so message closure must attempt a parent capture.
    syncService.recordUpsert('topic', 't-hk', { id: 't-hk', name: 'T' }, Date.now() - 10)
    const before = syncService.listOutbox().length
    handleChatDbSuccessForSync(IpcChannel.ChatDb_UpdateSingleBlock, { blockId: 'b-hk' })
    const ops = syncService.listOutbox()
    expect(ops.length).toBe(before)
    expect(ops.some((o) => o.entityType === 'message' && o.entityId === 'm-hk')).toBe(false)
    const cap = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastCaptureError')).get()
    expect(cap?.value).toMatch(/parent closure unavailable|transient/i)
  })
})

describe('blocker 3: config generation cancels stale in-flight sync (LOCK-PERSONAL-001)', () => {
  it('setConfig bumps the generation only on disable/endpoint/token transitions', () => {
    const g0 = syncService.getConfigGeneration()
    syncService.setConfig({})
    expect(syncService.getConfigGeneration()).toBe(g0)
    syncService.setConfig({ token: 'rotated' })
    expect(syncService.getConfigGeneration()).toBe(g0 + 1)
    syncService.setConfig({ token: 'rotated' })
    expect(syncService.getConfigGeneration()).toBe(g0 + 1)
    syncService.setConfig({ enabled: false })
    expect(syncService.getConfigGeneration()).toBe(g0 + 2)
  })

  it('mid-flight token rotation aborts before stale outbox clears or cursor/status writes', async () => {
    const { syncClient } = await import('../SyncClient')
    syncService.recordUpsert('topic', 't-stale', { id: 't-stale', name: 'S' }, Date.now())
    const outboxBefore = syncService.listOutbox().length
    expect(outboxBefore).toBeGreaterThan(0)
    const pushMock = vi.spyOn(syncClient, 'push').mockImplementation(async (_ep, _tok, req) => {
      // Simulate a disable/endpoint/token transition racing the in-flight push.
      syncService.setConfig({ token: 'rotated-mid-flight' })
      return { cursor: 0, acceptedIds: (req.operations as Array<{ id: string }>).map((o) => o.id) } as never
    })
    const pullMock = vi.spyOn(syncClient, 'pull').mockResolvedValue({ operations: [], cursor: 0 } as never)
    try {
      await expect(syncService.sync()).rejects.toBeInstanceOf(SyncStaleConfigError)
      // No post-transition effects: outbox retained, cursor unmoved, no stale status.
      expect(syncService.listOutbox().length).toBe(outboxBefore)
      const cur = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
      expect(cur?.value ?? '0').toBe('0')
      expect(pullMock).not.toHaveBeenCalled()
      expect(syncService.getStatus().lastSyncAt).toBeNull()
    } finally {
      pushMock.mockRestore()
      pullMock.mockRestore()
    }
  })

  it('automatic drain stops (no retry) when the cycle is invalidated by a config change', async () => {
    const { SyncAutoService } = await import('../syncAuto')
    let calls = 0
    const svc = new SyncAutoService({
      getConfig: () => ({ endpoint: 'http://127.0.0.1:9', token: 't', enabled: true }),
      isAttached: () => true,
      getCredentials: () => ({
        deviceCode: 'ABCD2345',
        deviceSecret: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
      }),
      runSync: async () => {
        calls += 1
        throw new SyncStaleConfigError()
      },
      createSubscriber: () => ({ start: () => {}, stop: () => {}, isActive: () => false }) as never
    })
    svc.start()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(calls).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(calls).toBe(1)
    svc.stopSync()
  })
})

describe('blocker 4: every production-loaded locale is truthful and complete', () => {
  it('all locales describe automatic sync, stable checkpoints, unsupported reorder, and carry conflict/capture keys', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const base = path.join(__dirname, '../../../../renderer/src/i18n')
    const files = [
      ...['en-us', 'zh-cn', 'zh-tw'].map((l) => path.join(base, 'locales', `${l}.json`)),
      ...['de-de', 'el-gr', 'es-es', 'fr-fr', 'ja-jp', 'pt-pt', 'ro-ro', 'ru-ru', 'vi-vn'].map((l) =>
        path.join(base, 'translate', `${l}.json`)
      )
    ]
    expect(files.length).toBe(12)
    for (const f of files) {
      const json = JSON.parse(fs.readFileSync(f, 'utf-8'))
      const sync = json.settings?.sync as Record<string, string> | undefined
      expect(sync, f).toBeTruthy()
      const isZh = f.includes('zh-cn') || f.includes('zh-tw')
      if (isZh) {
        expect(sync!.help, f).toMatch(/自动个人多设备同步|自動個人多裝置同步/)
        expect(sync!.help, f).not.toMatch(/仅手动同步|僅手動同步/)
        expect(sync!.scope_note, f).toMatch(/稳定检查点|穩定檢查點/)
        expect(sync!.scope_note, f).toMatch(/重排|排序/)
        expect(sync!.scope_note, f).toMatch(/不支持|不支援/)
      } else {
        expect(sync!.help, f).toMatch(/automatic personal/i)
        expect(sync!.help, f).not.toMatch(/manual sync only/i)
        expect(sync!.scope_note, f).toMatch(/stable checkpoint/i)
        expect(sync!.scope_note, f).toMatch(/reorder.*unsupported|unsupported.*reorder/i)
      }
      expect(sync!.capture_error, f).toBeTruthy()
      expect(sync!.conflicts_pending, f).toBeTruthy()
    }
  })
})
