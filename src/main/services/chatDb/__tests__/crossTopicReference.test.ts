/**
 * Cross-topic history references (Reference/Copy = Reference).
 *
 * Covers the bounded Main portion: live shared stable-ID prefix (no
 * duplication), readonly foreign prefix with a writable target suffix,
 * missing-source degradation, live source name, invalidation metadata,
 * recursion/cycle guard, target branch composition, and atomic creation.
 */

import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')
vi.mock('@main/config', () => ({ DATA_PATH: '/mock/data' }))

import { isSuccess } from '@shared/chatDb'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { runMigrations } from '../migration'
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-ref-'))
}
function rmrf(dir: string): void {
  realFs.rmSync(dir, { recursive: true, force: true })
}
function openTestDb(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  return db
}
function wrapDrizzle(sqlite: Database.Database): BetterSQLite3Database<typeof schema> {
  return drizzle(sqlite, { schema })
}
let counter = 0
function uid(): string {
  return `r${++counter}-${Date.now()}`
}
function okValue<T>(result: { ok: boolean; value?: T; error?: unknown }): T {
  if (!isSuccess(result as any)) throw new Error(`Expected success, got: ${JSON.stringify((result as any).error)}`)
  return (result as any).value as T
}
function makeMessageJson(topicId: string, overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `m-${uid()}`,
    topicId,
    role: 'user',
    content: 'Hello',
    status: 'success',
    createdAt: new Date().toISOString(),
    ...overrides
  }
}

describe('cross-topic history references', () => {
  let sqlite: Database.Database
  let db: BetterSQLite3Database<typeof schema>
  let agg: ChatDbAggregateService
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir()
    const dbPath = realPath.join(tmpDir, 'chat.db')
    sqlite = openTestDb(dbPath)
    db = wrapDrizzle(sqlite)
    runMigrations(db, sqlite)
    agg = new ChatDbAggregateService(db, sqlite)
  })

  afterEach(() => {
    sqlite.close()
    rmrf(tmpDir)
  })

  /** Seed a topic with N plain user messages; returns their stable ids in order. */
  function seedTopic(topicId: string, n: number): string[] {
    const ids: string[] = []
    for (let i = 0; i < n; i++) {
      const msg = makeMessageJson(topicId, { id: `m-${i}-${uid()}`, content: `msg-${i}` })
      ids.push(msg.id as string)
      const r = agg.appendMessage(topicId, msg as any, [])
      if (!r.ok) throw new Error(`seed append failed: ${JSON.stringify(r)}`)
    }
    return ids
  }

  it('creates a target topic with a live shared stable-ID prefix and no duplicated rows', () => {
    const source = `t-src-${uid()}`
    const target = `t-ref-${uid()}`
    const sourceIds = seedTopic(source, 4)

    const res = agg.createReferencedTopic(source, null, target, sourceIds[2], 'assistant-1')
    expect(res.ok).toBe(true)
    const value = okValue(res)
    expect(value.topicId).toBe(target)
    expect(value.reference.sourceTopicId).toBe(source)
    expect(value.reference.sourceBranchId).toBe(null)
    expect(value.reference.anchorMessageId).toBe(sourceIds[2])

    // Effective route = source prefix (3) under canonical source ids/topicId.
    const fetched = okValue(agg.fetchMessages(target))
    expect(fetched.messages.map((m) => (m as any).id)).toEqual(sourceIds.slice(0, 3))
    for (const m of fetched.messages) {
      expect((m as any).topicId).toBe(source)
    }
    // No duplication: the target has no owned message rows at all.
    const targetOwned = sqlite.prepare('SELECT COUNT(*) AS n FROM messages WHERE topic_id = ?').get(target) as {
      n: number
    }
    expect(targetOwned.n).toBe(0)
    // Relation row exists, non-cascade to source.
    const rel = sqlite.prepare('SELECT * FROM topic_references WHERE target_topic_id = ?').get(target) as any
    expect(rel.source_topic_id).toBe(source)
  })

  it('keeps the foreign prefix read-only and the target suffix writable (main/main branchId null)', () => {
    const source = `t-src-${uid()}`
    const target = `t-ref-${uid()}`
    const sourceIds = seedTopic(source, 2)
    okValue(agg.createReferencedTopic(source, null, target, sourceIds[1]))

    // Foreign prefix message is immutable through the target main route.
    const badUpdate = agg.updateMessage(target, sourceIds[0], { content: 'hacked' })
    expect(badUpdate.ok).toBe(false)
    const badDelete = agg.deleteMessage(target, sourceIds[0])
    expect(badDelete.ok).toBe(false)

    // Target-owned suffix message is writable.
    const ownMsg = makeMessageJson(target, { id: `m-own-${uid()}`, content: 'suffix' })
    okValue(agg.appendMessage(target, ownMsg as any, []))
    const goodUpdate = agg.updateMessage(target, ownMsg.id as string, { content: 'suffix-edited' })
    expect(goodUpdate.ok).toBe(true)

    // Window capability excludes the foreign prefix and includes the owned row.
    const win = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: target, limit: 50 }))
    expect(win.window.returnedCount).toBe(3)
    expect(new Set(win.mutableMessageIds)).toEqual(new Set([ownMsg.id as string]))
    expect(win.reference?.status).toBe('available')
    expect(win.reference?.boundaryMessageId).toBe(sourceIds[1])
  })

  it('omits the prefix and marks metadata missing when the source is trashed/hard-deleted or the anchor is gone', () => {
    const source = `t-src-${uid()}`
    const target = `t-ref-${uid()}`
    const sourceIds = seedTopic(source, 3)
    okValue(agg.createReferencedTopic(source, null, target, sourceIds[2]))
    const ownMsg = makeMessageJson(target, { id: `m-own-${uid()}`, content: 'suffix' })
    okValue(agg.appendMessage(target, ownMsg as any, []))

    // Soft-delete source: prefix omitted, status missing, suffix survives.
    okValue(agg.softDeleteTopic(source))
    let win = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: target, limit: 50 }))
    expect(win.reference?.status).toBe('missing')
    expect(win.reference?.boundaryMessageId).toBe(null)
    expect(win.window.returnedCount).toBe(1)
    expect((win.messages[0] as any).id).toBe(ownMsg.id)

    // Restore source: prefix resolves again.
    okValue(agg.restoreTopic(source))
    win = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: target, limit: 50 }))
    expect(win.reference?.status).toBe('available')
    expect(win.window.returnedCount).toBe(4)

    // Hard-delete source: target topic + suffix survive; relation degrades.
    okValue(agg.hardDeleteTopic(source))
    const targetTopic = sqlite.prepare('SELECT id FROM topics WHERE id = ?').get(target)
    expect(targetTopic).toBeTruthy()
    win = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: target, limit: 50 }))
    expect(win.reference?.status).toBe('missing')
    expect(win.window.returnedCount).toBe(1)

    // Deleted endpoint: the captured boundary advances to the nearest
    // surviving prefix message, so the reference keeps the shorter live prefix
    // and the target's own suffix is untouched.
    const source2 = `t-src2-${uid()}`
    const target2 = `t-ref2-${uid()}`
    const ids2 = seedTopic(source2, 3)
    okValue(agg.createReferencedTopic(source2, null, target2, ids2[2]))
    const own2 = { id: `m-ref-own-${uid()}`, content: 'suffix' }
    okValue(agg.appendMessage(target2, makeMessageJson(target2, own2) as any, []))
    okValue(agg.deleteMessage(source2, ids2[2]))
    let win2 = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: target2, limit: 50 }))
    expect(win2.reference?.status).toBe('available')
    expect(win2.reference?.boundaryMessageId).toBe(ids2[1])
    expect((win2.messages as Array<{ id: string }>).map((m) => m.id)).toEqual([ids2[0], ids2[1], own2.id])

    // Deleting every prefix message leaves no boundary to advance to: the
    // prefix is absent while the target topic and its own suffix survive (the
    // relation is never deleted by a source mutation).
    okValue(agg.deleteMessages(source2, [ids2[0], ids2[1]]))
    win2 = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: target2, limit: 50 }))
    expect(win2.reference?.status).toBe('missing')
    expect(win2.window.returnedCount).toBe(1)
    expect((win2.messages as Array<{ id: string }>)[0].id).toBe(own2.id)
  })

  it('exposes the live authoritative source name (never a copied display name)', () => {
    const source = `t-src-${uid()}`
    const target = `t-ref-${uid()}`
    const ids = seedTopic(source, 2)
    okValue(agg.createReferencedTopic(source, null, target, ids[1], undefined, 'Target Display'))

    // Target topic name is its own (not the source name).
    const targetTopic = sqlite.prepare('SELECT name FROM topics WHERE id = ?').get(target) as any
    expect(targetTopic.name).toBe('Target Display')

    okValue(agg.updateTopicMetadata(source, 'Renamed Source', undefined, undefined, undefined, undefined, undefined))
    const win = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: target, limit: 50 }))
    expect(win.reference?.sourceName).toBe('Renamed Source')
  })

  it('composes target intra-topic branches atop the referenced base (existing resolver)', () => {
    const source = `t-src-${uid()}`
    const target = `t-ref-${uid()}`
    const sourceIds = seedTopic(source, 2)
    okValue(agg.createReferencedTopic(source, null, target, sourceIds[1]))
    const own1 = makeMessageJson(target, { id: `m-own1-${uid()}`, role: 'user' })
    okValue(agg.appendMessage(target, own1 as any, []))

    // Target branch anchored on a target-owned suffix message.
    const branchRes = okValue(agg.createBranch(target, null, own1.id as string, 'b1'))
    const branchId = branchRes.branch.id
    okValue(
      agg.appendMessage(
        target,
        makeMessageJson(target, { id: `m-own2-${uid()}`, role: 'assistant' }) as any,
        [],
        undefined,
        undefined,
        { branchId }
      )
    )

    const branchWindow = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: target, branchId, limit: 50 }))
    expect(branchWindow.window.returnedCount).toBe(4)
    // Foreign prefix present in the branch route too.
    expect((branchWindow.messages[0] as any).topicId).toBe(source)
  })

  it('terminates recursively (nested references) and guards cycles', () => {
    const a = `t-a-${uid()}`
    const b = `t-b-${uid()}`
    const c = `t-c-${uid()}`
    const aIds = seedTopic(a, 3)
    okValue(agg.createReferencedTopic(a, null, b, aIds[2]))
    // Nested: c references b (whose route includes a's live prefix).
    const bWindow = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: b, limit: 50 }))
    const bBoundary = bWindow.reference!.boundaryMessageId!
    okValue(agg.createReferencedTopic(b, null, c, bBoundary))
    const cWin = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: c, limit: 50 }))
    expect(cWin.window.returnedCount).toBe(3)
    expect(cWin.reference?.status).toBe('available')
    // c's foreign prefix is A's messages (canonical source topic).
    expect((cWin.messages[0] as any).topicId).toBe(a)

    // Cycle: make A reference C directly (raw relation), then resolve A safely.
    sqlite
      .prepare(
        'INSERT INTO topic_references (target_topic_id, source_topic_id, source_branch_id, anchor_message_id, created_at, updated_at, extra) VALUES (?, ?, NULL, ?, ?, ?, NULL)'
      )
      .run(a, c, aIds[0], new Date().toISOString(), new Date().toISOString())
    // Must terminate and not throw (cycle guarded to 'missing'/best-effort).
    const aWin = agg.fetchMessagesWindow({ kind: 'latest', topicId: a, limit: 50 })
    expect(aWin.ok).toBe(true)
  })

  it('is atomic: an invalid anchor leaves no orphan target topic or relation', () => {
    const source = `t-src-${uid()}`
    const target = `t-ref-${uid()}`
    seedTopic(source, 2)
    const bad = agg.createReferencedTopic(source, null, target, 'no-such-anchor')
    expect(bad.ok).toBe(false)
    expect(sqlite.prepare('SELECT id FROM topics WHERE id = ?').get(target)).toBeUndefined()
    expect(
      sqlite.prepare('SELECT target_topic_id FROM topic_references WHERE target_topic_id = ?').get(target)
    ).toBeUndefined()
  })

  it('allows insert at the exact foreign fork endpoint but never at an earlier foreign message', () => {
    const source = `t-src-${uid()}`
    const target = `t-ref-${uid()}`
    const sourceIds = seedTopic(source, 3)
    okValue(agg.createReferencedTopic(source, null, target, sourceIds[2]))

    // Insert after the exact foreign endpoint (fork boundary) succeeds at suffix start.
    const okInsert = agg.insertMessagesAfterAnchor(target, sourceIds[2], [
      { message: makeMessageJson(target, { id: `m-new-${uid()}` }) as any, blocks: [] }
    ])
    expect(okInsert.ok).toBe(true)

    // Insert after an earlier foreign message is rejected.
    const badInsert = agg.insertMessagesAfterAnchor(target, sourceIds[0], [
      { message: makeMessageJson(target, { id: `m-new2-${uid()}` }) as any, blocks: [] }
    ])
    expect(badInsert.ok).toBe(false)
  })

  it('leaves the legacy cross-topic clone (branchMessagesToTopic) unchanged and independent', () => {
    const source = `t-src-${uid()}`
    const clone = `t-clone-${uid()}`
    const sourceIds = seedTopic(source, 3)
    const res = agg.branchMessagesToTopic(source, clone, sourceIds[1], 'assistant-1')
    expect(res.ok).toBe(true)
    // Clone owns fresh copies (not a reference) and has no relation row.
    const cloned = okValue(agg.fetchMessages(clone))
    expect(cloned.messages.length).toBe(2)
    for (const m of cloned.messages) {
      expect((m as any).topicId).toBe(clone)
      expect(sourceIds).not.toContain((m as any).id)
    }
    const rel = sqlite.prepare('SELECT target_topic_id FROM topic_references WHERE target_topic_id = ?').get(clone)
    expect(rel).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // Effective-history reads on a reference target
  // -------------------------------------------------------------------------

  it('resolveContextClosure detail:anchor resolves a reference target main route against the effective foreign prefix', () => {
    const source = `t-src-${uid()}`
    const target = `t-ref-${uid()}`
    const sourceIds = seedTopic(source, 3)
    okValue(agg.createReferencedTopic(source, null, target, sourceIds[1]))
    const own = makeMessageJson(target, { id: `m-own-${uid()}`, role: 'user' })
    okValue(agg.appendMessage(target, own as any, []))

    // Full closure (effective route) and the bounded anchor path must agree.
    const cases: Array<Record<string, unknown>> = [
      { topicId: target, intent: 'establish', contextCount: 2 },
      { topicId: target, intent: 'establish', contextCount: 2, currentAnchorGroupKey: sourceIds[0] },
      { topicId: target, intent: 'reanchor-default', contextCount: 1 },
      { topicId: target, intent: 'reanchor-default', contextCount: null },
      { topicId: target, intent: 'move', messageId: sourceIds[0] },
      { topicId: target, intent: 'move', messageId: own.id },
      { topicId: target, intent: 'move', groupKey: sourceIds[0] }
    ]
    for (const req of cases) {
      const closure = okValue(agg.resolveContextClosure({ ...(req as any) })) as {
        resolvedAnchorGroupKey: string | null
        changed: boolean
      }
      const anchor = okValue(agg.resolveContextClosure({ ...(req as any), detail: 'anchor' })) as {
        resolvedAnchorGroupKey: string | null
        changed: boolean
      }
      expect(anchor, `mismatch for ${JSON.stringify(req)}`).toEqual({
        resolvedAnchorGroupKey: closure.resolvedAnchorGroupKey,
        changed: closure.changed
      })
    }

    // A foreign-prefix message is addressable through the effective route
    // (the old target-owned bounded scan would miss it).
    const foreign = okValue(
      agg.resolveContextClosure({ topicId: target, intent: 'move', messageId: sourceIds[0], detail: 'anchor' })
    ) as { resolvedAnchorGroupKey: string | null }
    expect(foreign.resolvedAnchorGroupKey).toBe(sourceIds[0])
  })

  it('getRawTopic returns the effective main route (foreign prefix) and degrades to owned rows when the source is gone', () => {
    const source = `t-src-${uid()}`
    const target = `t-ref-${uid()}`
    const sourceIds = seedTopic(source, 3)
    okValue(agg.createReferencedTopic(source, null, target, sourceIds[2]))
    const own = makeMessageJson(target, { id: `m-own-${uid()}`, role: 'user' })
    okValue(agg.appendMessage(target, own as any, []))

    const raw = okValue(agg.getRawTopic(target))!
    expect((raw.messages as any[]).map((m) => m.id)).toEqual([...sourceIds, own.id])
    // Canonical source rows are shared (stable ids/topicId), never copied.
    expect((raw.messages[0] as any).topicId).toBe(source)

    okValue(agg.softDeleteTopic(source))
    const rawMissing = okValue(agg.getRawTopic(target))!
    expect((rawMissing.messages as any[]).map((m) => m.id)).toEqual([own.id])
  })

  // -------------------------------------------------------------------------
  // Block-only writes carry no inherent route: an explicit target address
  // must reject foreign-prefix rows while canonical source writes stay intact.
  // -------------------------------------------------------------------------

  it('block writes addressed through a reference target reject foreign-prefix rows but leave canonical source writes intact', () => {
    const source = `t-src-${uid()}`
    const target = `t-ref-${uid()}`
    const sourceMsg = makeMessageJson(source, { id: `m-src-${uid()}`, role: 'user' })
    const srcBlock = {
      id: `b-src-${uid()}`,
      messageId: sourceMsg.id as string,
      type: 'main_text',
      content: 'orig',
      status: 'success',
      createdAt: new Date().toISOString()
    }
    okValue(agg.appendMessage(source, sourceMsg as any, [srcBlock as any]))
    okValue(agg.createReferencedTopic(source, null, target, sourceMsg.id as string))

    // Addressed as the TARGET: every block channel fails closed on the
    // foreign-prefix row (no partial write).
    const badUpdate = agg.updateSingleBlock(srcBlock.id, { content: 'hacked' }, undefined, {
      topicId: target,
      branchId: null
    })
    expect(badUpdate.ok).toBe(false)
    const badBlocks = agg.updateBlocks([{ ...srcBlock, content: 'x' } as any], undefined, {
      topicId: target,
      branchId: null
    })
    expect(badBlocks.ok).toBe(false)
    const badBulk = agg.bulkAddBlocks([{ ...srcBlock, id: `b-new-${uid()}` } as any], {
      topicId: target,
      branchId: null
    })
    expect(badBulk.ok).toBe(false)
    const badDelete = agg.deleteBlocks([srcBlock.id], { topicId: target, branchId: null })
    expect(badDelete.ok).toBe(false)

    // Foreign row untouched.
    expect(sqlite.prepare('SELECT content FROM message_blocks WHERE id = ?').get(srcBlock.id)).toEqual({
      content: 'orig'
    })

    // Canonical source stream (no addressed context) still writes the source row.
    expect(agg.updateSingleBlock(srcBlock.id, { content: 'source-edit' }).ok).toBe(true)
    expect(sqlite.prepare('SELECT content FROM message_blocks WHERE id = ?').get(srcBlock.id)).toEqual({
      content: 'source-edit'
    })
    // An explicit SOURCE address also succeeds.
    expect(
      agg.updateSingleBlock(srcBlock.id, { content: 'source-edit-2' }, undefined, {
        topicId: source,
        branchId: null
      }).ok
    ).toBe(true)

    // A target-owned suffix block write through the target address succeeds.
    const ownMsg = makeMessageJson(target, { id: `m-own-${uid()}`, role: 'user' })
    const ownBlock = {
      id: `b-own-${uid()}`,
      messageId: ownMsg.id as string,
      type: 'main_text',
      content: 'own',
      status: 'success',
      createdAt: new Date().toISOString()
    }
    okValue(agg.appendMessage(target, ownMsg as any, [ownBlock as any]))
    expect(
      agg.updateSingleBlock(ownBlock.id, { content: 'own-edit' }, undefined, { topicId: target, branchId: null }).ok
    ).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Invalidation fan-out (aggregate side)
  // -------------------------------------------------------------------------

  it('listReferenceTargets returns the bounded transitive dependents (target-of-target)', () => {
    const a = `t-a-${uid()}`
    const b = `t-b-${uid()}`
    const c = `t-c-${uid()}`
    const aIds = seedTopic(a, 3)
    okValue(agg.createReferencedTopic(a, null, b, aIds[2]))
    const bWin = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: b, limit: 50 }))
    okValue(agg.createReferencedTopic(b, null, c, bWin.reference!.boundaryMessageId!))

    const fromA = okValue(agg.listReferenceTargets(a))
    expect(fromA.targetTopicIds).toEqual([b, c].sort())
    // A leaf target has no dependents.
    expect(okValue(agg.listReferenceTargets(c)).targetTopicIds).toEqual([])
    // Deterministic, unique.
    expect(okValue(agg.listReferenceTargets(a)).targetTopicIds).toEqual(fromA.targetTopicIds)
  })

  it('degrades to missing (no throw, suffix survives) when the captured source branch is removed', () => {
    const source = `t-src-${uid()}`
    const target = `t-ref-${uid()}`
    const base = makeMessageJson(source, { id: `m-base-${uid()}`, role: 'user' })
    okValue(agg.appendMessage(source, base as any, []))
    const branchRes = okValue(agg.createBranch(source, null, base.id as string, 'SB'))
    const sourceBranchId = branchRes.branch.id
    const branchMsg = makeMessageJson(source, { id: `m-branch-${uid()}`, role: 'user' })
    okValue(agg.appendMessage(source, branchMsg as any, [], undefined, undefined, { branchId: sourceBranchId } as any))
    okValue(agg.createReferencedTopic(source, sourceBranchId, target, branchMsg.id as string))
    const own = makeMessageJson(target, { id: `m-own-${uid()}`, role: 'user' })
    okValue(agg.appendMessage(target, own as any, []))

    // Effective prefix present before removal.
    const before = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: target, limit: 50 }))
    expect(before.reference?.status).toBe('available')

    okValue(agg.deleteBranch(source, sourceBranchId))
    const win = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: target, limit: 50 }))
    expect(win.reference?.status).toBe('missing')
    expect((win.messages as any[]).map((m) => m.id)).toEqual([own.id])
    // getRawTopic tolerates the same missing source route.
    expect((okValue(agg.getRawTopic(target))!.messages as any[]).map((m) => m.id)).toEqual([own.id])
  })
})
