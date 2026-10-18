/**
 * Around-window group boundaries on main, branch, and reference routes.
 *
 * The viewport counting unit is one complete rendered group (consecutive
 * assistant messages sharing a non-empty askId; every other message is a
 * singleton). An `around` read must always return the anchor's ENTIRE group —
 * the members before the anchor and after it — plus the nearest complete
 * beyond groups, and `hasMoreBefore` / `hasMoreAfter` may only describe whole
 * groups that fall outside the returned window.
 *
 * The main route resolves through the bounded SQL chunk-scan path; branch
 * routes and cross-topic reference targets resolve the effective route in
 * memory and then window it. Both paths must agree exactly, so every case
 * below asserts the expected window literally and then compares the branch /
 * reference reads against the same expectation (main semantics are the
 * reference behaviour).
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
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-win-group-parity-'))
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
let counter = 0
function uid(): string {
  return `gp${++counter}-${Date.now()}`
}
function okValue<T>(result: { ok: boolean; value?: T; error?: unknown }): T {
  if (!isSuccess(result as any)) throw new Error(`Expected success, got: ${JSON.stringify((result as any).error)}`)
  return (result as any).value as T
}

interface AroundCase {
  anchor: string
  before: number
  after: number
}
interface ExpectedWindow {
  ids: string[]
  hasMoreBefore: boolean
  hasMoreAfter: boolean
}

describe('ChatDbAggregateService — around group boundaries on main, branch, and reference routes', () => {
  let tmpDir: string
  let sqlite: Database.Database
  let db: BetterSQLite3Database<typeof schema>
  let agg: ChatDbAggregateService

  beforeEach(() => {
    tmpDir = makeTempDir()
    sqlite = openTestDb(realPath.join(tmpDir, 'test.db'))
    db = drizzle(sqlite, { schema })
    runMigrations(db, sqlite)
    agg = new ChatDbAggregateService(db, sqlite)
  })
  afterEach(() => {
    try {
      sqlite.close()
    } catch {}
    rmrf(tmpDir)
  })

  function append(topicId: string, id: string, role: string, askId?: string, branchId?: string): string {
    const message: Record<string, unknown> = {
      id,
      topicId,
      role,
      content: `content-${id}`,
      status: 'success',
      createdAt: '2026-01-01T00:00:00.000Z'
    }
    if (askId) message.askId = askId
    const block: Record<string, unknown> = {
      id: `blk-${id}`,
      messageId: id,
      type: 'main_text',
      content: `block-${id}`,
      status: 'success',
      createdAt: '2026-01-01T00:00:00.000Z'
    }
    const res = agg.appendMessage(
      topicId,
      message as any,
      [block as any],
      undefined,
      undefined,
      branchId ? { branchId } : undefined
    )
    expect(res.ok, `append ${id}`).toBe(true)
    return id
  }

  function around(topicId: string, branchId: string | undefined, c: AroundCase): any {
    return okValue(
      agg.fetchMessagesWindow({
        kind: 'around',
        topicId,
        branchId,
        anchorMessageId: c.anchor,
        before: c.before,
        after: c.after
      })
    )
  }

  function expectWindow(read: any, label: string, expected: ExpectedWindow): void {
    expect(read.window.kind, `${label} kind`).toBe('around')
    expect(
      read.messages.map((m: any) => m.id),
      `${label} order`
    ).toEqual(expected.ids)
    expect(read.window.returnedCount, `${label} returnedCount`).toBe(expected.ids.length)
    expect(read.window.hasMoreBefore, `${label} hasMoreBefore`).toBe(expected.hasMoreBefore)
    expect(read.window.hasMoreAfter, `${label} hasMoreAfter`).toBe(expected.hasMoreAfter)
    expect(read.window.firstMessageId, `${label} firstMessageId`).toBe(expected.ids[0] ?? null)
    expect(read.window.lastMessageId, `${label} lastMessageId`).toBe(expected.ids[expected.ids.length - 1] ?? null)
  }

  function expectMutable(read: any, label: string, ids: string[]): void {
    expect(new Set(read.mutableMessageIds as string[]), `${label} mutableMessageIds`).toEqual(new Set(ids))
  }

  it('matches main-route group boundaries on branch and reference routes (mixed groups)', () => {
    const topic = `t-mix-${uid()}`
    const target = `t-mix-ref-${uid()}`
    const askA = `askA-${uid()}`
    const askB = `askB-${uid()}`
    const u1 = append(topic, `u1-${uid()}`, 'user')
    const a1 = append(topic, `a1-${uid()}`, 'assistant', askA)
    const a2 = append(topic, `a2-${uid()}`, 'assistant', askA)
    const a3 = append(topic, `a3-${uid()}`, 'assistant', askA)
    const u2 = append(topic, `u2-${uid()}`, 'user')
    const b1 = append(topic, `b1-${uid()}`, 'assistant', askB)
    const b2 = append(topic, `b2-${uid()}`, 'assistant', askB)
    const u3 = append(topic, `u3-${uid()}`, 'user')
    // main route groups: [u1] [a1,a2,a3] [u2] [b1,b2] [u3]

    // Branch anchored at the owned tail, no suffix → effective route = main route.
    const branchId = okValue(agg.createBranch(topic, null, u3, 'tail')).branch.id
    // Reference target captured at the same tail → prefix = the whole source route.
    okValue(agg.createReferencedTopic(topic, null, target, u3))

    const cases: Array<{ c: AroundCase; expected: ExpectedWindow; label: string }> = [
      {
        c: { anchor: a1, before: 1, after: 1 },
        expected: { ids: [u1, a1, a2, a3, u2], hasMoreBefore: false, hasMoreAfter: true },
        label: 'group head'
      },
      {
        c: { anchor: a3, before: 1, after: 1 },
        expected: { ids: [u1, a1, a2, a3, u2], hasMoreBefore: false, hasMoreAfter: true },
        label: 'group tail'
      },
      {
        c: { anchor: u1, before: 2, after: 1 },
        expected: { ids: [u1, a1, a2, a3], hasMoreBefore: false, hasMoreAfter: true },
        label: 'route head'
      },
      {
        c: { anchor: u2, before: 1, after: 1 },
        expected: { ids: [a1, a2, a3, u2, b1, b2], hasMoreBefore: true, hasMoreAfter: true },
        label: 'interior singleton'
      },
      {
        c: { anchor: b2, before: 1, after: 1 },
        expected: { ids: [u2, b1, b2, u3], hasMoreBefore: true, hasMoreAfter: false },
        label: 'tail group'
      },
      {
        c: { anchor: u3, before: 1, after: 2 },
        expected: { ids: [b1, b2, u3], hasMoreBefore: true, hasMoreAfter: false },
        label: 'route tail'
      }
    ]

    for (const { c, expected, label } of cases) {
      const main = around(topic, undefined, c)
      expectWindow(main, `main ${label}`, expected)
      // Every returned main row is owned by the addressed main route.
      expectMutable(main, `main ${label}`, expected.ids)

      const branch = around(topic, branchId, c)
      expectWindow(branch, `branch ${label}`, expected)
      // The branch owns no suffix row here: the shared prefix is a read-only reference.
      expectMutable(branch, `branch ${label}`, [])

      const reference = around(target, undefined, c)
      expectWindow(reference, `reference ${label}`, expected)
      // The foreign prefix is never mutable through the target route.
      expectMutable(reference, `reference ${label}`, [])
      expect(reference.reference?.status).toBe('available')
    }
  })

  it('returns the complete anchor group when the whole route is that one group', () => {
    // Main-route reference shape: two consecutive assistant rows, one askId group.
    const plain = `t-one-main-${uid()}`
    const askOne = `askOne-${uid()}`
    const p1 = append(plain, `p1-${uid()}`, 'assistant', askOne)
    const p2 = append(plain, `p2-${uid()}`, 'assistant', askOne)

    // Branch route whose one group spans the fork anchor: prefix row + owned suffix row.
    const forked = `t-one-branch-${uid()}`
    const askFork = `askFork-${uid()}`
    const m1 = append(forked, `m1-${uid()}`, 'assistant', askFork)
    const branchId = okValue(agg.createBranch(forked, null, m1, 'fork')).branch.id
    const m2 = append(forked, `m2-${uid()}`, 'assistant', askFork, branchId)

    // Reference target of a single-group source: prefix = the whole source route.
    const source = `t-one-src-${uid()}`
    const target = `t-one-ref-${uid()}`
    const askSrc = `askSrc-${uid()}`
    const s1 = append(source, `s1-${uid()}`, 'assistant', askSrc)
    const s2 = append(source, `s2-${uid()}`, 'assistant', askSrc)
    okValue(agg.createReferencedTopic(source, null, target, s2))

    const wholeGroup: ExpectedWindow = { ids: [p1, p2], hasMoreBefore: false, hasMoreAfter: false }

    // Main route (SQL path): anchor at the group head and at the group tail.
    const mainHead = around(plain, undefined, { anchor: p1, before: 2, after: 2 })
    expectWindow(mainHead, 'main one-group head', wholeGroup)
    const mainTail = around(plain, undefined, { anchor: p2, before: 1, after: 1 })
    expectWindow(mainTail, 'main one-group tail', wholeGroup)
    expectMutable(mainHead, 'main one-group head', [p1, p2])

    // Branch route (in-memory path): the single group spans the fork anchor.
    const branchExpected: ExpectedWindow = { ids: [m1, m2], hasMoreBefore: false, hasMoreAfter: false }
    expectWindow(around(forked, branchId, { anchor: m1, before: 2, after: 2 }), 'branch one-group head', branchExpected)
    expectWindow(around(forked, branchId, { anchor: m2, before: 1, after: 1 }), 'branch one-group tail', branchExpected)
    expectMutable(around(forked, branchId, { anchor: m1, before: 2, after: 2 }), 'branch one-group head', [m2])
    // The same topic's main route holds only the pre-fork row.
    expectWindow(around(forked, undefined, { anchor: m1, before: 2, after: 2 }), 'forked main route', {
      ids: [m1],
      hasMoreBefore: false,
      hasMoreAfter: false
    })

    // Reference target (in-memory path): one group, no owned suffix.
    const refExpected: ExpectedWindow = { ids: [s1, s2], hasMoreBefore: false, hasMoreAfter: false }
    expectWindow(
      around(target, undefined, { anchor: s1, before: 2, after: 2 }),
      'reference one-group head',
      refExpected
    )
    expectWindow(
      around(target, undefined, { anchor: s2, before: 1, after: 1 }),
      'reference one-group tail',
      refExpected
    )
    // Source main route agrees for the same shape.
    expectWindow(around(source, undefined, { anchor: s1, before: 2, after: 2 }), 'source main one-group head', {
      ids: [s1, s2],
      hasMoreBefore: false,
      hasMoreAfter: false
    })
  })

  it('keeps anchor-group members on both sides of the fork boundary in a mixed topology', () => {
    const askFork = `askFork-${uid()}`
    // Main route: anchor row plus a post-fork row that stays out of the branch route.
    const topic = `t-fork-mix-${uid()}`
    const a1 = append(topic, `a1-${uid()}`, 'assistant', askFork)
    const mainTail = append(topic, `mt-${uid()}`, 'user')
    const branchId = okValue(agg.createBranch(topic, null, a1, 'fork')).branch.id
    const a2 = append(topic, `a2-${uid()}`, 'assistant', askFork, branchId)
    const u3 = append(topic, `u3-${uid()}`, 'user', undefined, branchId)
    // branch route groups: [a1,a2] (spans the fork anchor) + [u3]

    const forkWindow: ExpectedWindow = { ids: [a1, a2, u3], hasMoreBefore: false, hasMoreAfter: false }
    expectWindow(around(topic, branchId, { anchor: a2, before: 1, after: 1 }), 'branch group tail', forkWindow)
    expectWindow(around(topic, branchId, { anchor: a1, before: 1, after: 1 }), 'branch group head', forkWindow)
    expectMutable(around(topic, branchId, { anchor: a2, before: 1, after: 1 }), 'branch group tail', [a2, u3])

    // Main-route semantics for the same topology shape, materialized on main only.
    const plain = `t-fork-plain-${uid()}`
    const q1 = append(plain, `q1-${uid()}`, 'assistant', askFork)
    const q2 = append(plain, `q2-${uid()}`, 'assistant', askFork)
    const q3 = append(plain, `q3-${uid()}`, 'user')
    expectWindow(around(plain, undefined, { anchor: q2, before: 1, after: 1 }), 'main group tail', {
      ids: [q1, q2, q3],
      hasMoreBefore: false,
      hasMoreAfter: false
    })
    expectWindow(around(plain, undefined, { anchor: q1, before: 1, after: 1 }), 'main group head', {
      ids: [q1, q2, q3],
      hasMoreBefore: false,
      hasMoreAfter: false
    })

    // The main route of the forked topic keeps its own grouping (a1 is a singleton
    // there: a2 is branch-owned) and never leaks the branch-owned suffix.
    expectWindow(around(topic, undefined, { anchor: a1, before: 1, after: 1 }), 'forked main route', {
      ids: [a1, mainTail],
      hasMoreBefore: false,
      hasMoreAfter: false
    })
  })

  it('expands by whole beyond groups only and reports per-side boundary counts (branch + reference suffix)', () => {
    const askA = `askA-${uid()}`
    const askB = `askB-${uid()}`
    const topic = `t-count-${uid()}`
    const u1 = append(topic, `u1-${uid()}`, 'user')
    const a1 = append(topic, `a1-${uid()}`, 'assistant', askA)
    const a2 = append(topic, `a2-${uid()}`, 'assistant', askA)
    const mainTail = append(topic, `mt-${uid()}`, 'user')
    const branchId = okValue(agg.createBranch(topic, null, a2, 'base')).branch.id
    const b1 = append(topic, `b1-${uid()}`, 'assistant', askB, branchId)
    const b2 = append(topic, `b2-${uid()}`, 'assistant', askB, branchId)
    // branch route groups: [u1] [a1,a2] [b1,b2]

    // after: one beyond group, then both, expanding by one COMPLETE group.
    expectWindow(around(topic, branchId, { anchor: u1, before: 1, after: 1 }), 'branch after=1', {
      ids: [u1, a1, a2],
      hasMoreBefore: false,
      hasMoreAfter: true
    })
    expectWindow(around(topic, branchId, { anchor: u1, before: 1, after: 2 }), 'branch after=2', {
      ids: [u1, a1, a2, b1, b2],
      hasMoreBefore: false,
      hasMoreAfter: false
    })

    // before: one beyond group, then both (anchor group at the route tail).
    expectWindow(around(topic, branchId, { anchor: b1, before: 1, after: 1 }), 'branch before=1', {
      ids: [a1, a2, b1, b2],
      hasMoreBefore: true,
      hasMoreAfter: false
    })
    expectWindow(around(topic, branchId, { anchor: b1, before: 2, after: 1 }), 'branch before=2', {
      ids: [u1, a1, a2, b1, b2],
      hasMoreBefore: false,
      hasMoreAfter: false
    })
    expectMutable(around(topic, branchId, { anchor: b1, before: 2, after: 1 }), 'branch full route', [b1, b2])
    const mainTailRead = around(topic, undefined, { anchor: mainTail, before: 2, after: 1 })
    expectWindow(mainTailRead, 'main tail row', {
      ids: [u1, a1, a2, mainTail],
      hasMoreBefore: false,
      hasMoreAfter: false
    })
    // Branch-owned rows are not visible on the main route, so they are not mutable there.
    expectMutable(mainTailRead, 'main tail row', [u1, a1, a2, mainTail])

    // Reference target with an owned suffix: same counting rules, foreign prefix read-only.
    const source = `t-count-src-${uid()}`
    const target = `t-count-ref-${uid()}`
    const askS = `askS-${uid()}`
    const askT = `askT-${uid()}`
    const s1 = append(source, `s1-${uid()}`, 'user')
    const s2 = append(source, `s2-${uid()}`, 'assistant', askS)
    const s3 = append(source, `s3-${uid()}`, 'assistant', askS)
    const s4 = append(source, `s4-${uid()}`, 'user')
    okValue(agg.createReferencedTopic(source, null, target, s3))
    const t1 = append(target, `t1-${uid()}`, 'user')
    const t2 = append(target, `t2-${uid()}`, 'assistant', askT)
    const t3 = append(target, `t3-${uid()}`, 'assistant', askT)
    // target route groups: [s1] [s2,s3] [t1] [t2,t3]

    const refHead = around(target, undefined, { anchor: s3, before: 1, after: 1 })
    expectWindow(refHead, 'reference foreign group tail', {
      ids: [s1, s2, s3, t1],
      hasMoreBefore: false,
      hasMoreAfter: true
    })
    expectMutable(refHead, 'reference foreign group tail', [t1])

    expectWindow(around(target, undefined, { anchor: t1, before: 1, after: 1 }), 'reference owned singleton', {
      ids: [s2, s3, t1, t2, t3],
      hasMoreBefore: true,
      hasMoreAfter: false
    })

    const refAnchorGroupTail = around(target, undefined, { anchor: t2, before: 1, after: 1 })
    expectWindow(refAnchorGroupTail, 'reference owned group head', {
      ids: [t1, t2, t3],
      hasMoreBefore: true,
      hasMoreAfter: false
    })
    expectMutable(refAnchorGroupTail, 'reference owned group head', [t1, t2, t3])

    // Source main route keeps its own grouping and full empty-tail behaviour.
    expectWindow(around(source, undefined, { anchor: s3, before: 1, after: 1 }), 'source main group tail', {
      ids: [s1, s2, s3, s4],
      hasMoreBefore: false,
      hasMoreAfter: false
    })
  })
})
