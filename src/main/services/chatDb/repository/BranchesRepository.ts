/**
 * BranchesRepository — CRUD + tree queries for topic-internal branch nodes.
 *
 * One row per internal branch node inside a single logical topic
 * (migration 016). The main route is addressed by `branchId = null` and has
 * NO row — never create a fake root row.
 *
 * - Names live on the branch row (`topic_branches.name`); Topic.name stays
 *   the logical topic name.
 * - Branches are local-only: repositories never mint sync intent; the
 *   aggregate suppresses capture for branch-owned rows.
 * - Deletion is subtree-scoped and orchestrated by the aggregate (owned
 *   messages/blocks/file refs + descendant rows); the FK cascades
 *   (self-CASCADE + messages.branch_id CASCADE) are the backstop.
 */

import { and, asc, eq, isNull } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import { topicBranchToRowPatch } from '../domain/mappers'
import type { EntityPatchInput, TopicBranchData } from '../domain/types'
import { topicBranches } from '../schema'
import {
  type AffectedCount,
  assertNoIdentityChange,
  buildColumnMap,
  found,
  fromDrizzleResult,
  type GetResult,
  notFound,
  toInsertValues,
  toUpdateValues
} from './helpers'

const COLUMN_MAP = buildColumnMap([
  ['id', 'id'],
  ['topicId', 'topic_id'],
  ['parentBranchId', 'parent_branch_id'],
  ['anchorMessageId', 'anchor_message_id'],
  ['name', 'name'],
  ['createdAt', 'created_at'],
  ['updatedAt', 'updated_at']
])

/** Maximum branch ancestry depth (cycle/depth protection for route assembly). */
export const MAX_BRANCH_DEPTH = 32

export class BranchesRepository {
  constructor(private db: BetterSQLite3Database<any>) {}

  getById(id: string): GetResult<TopicBranchData> {
    const row = this.db.select().from(topicBranches).where(eq(topicBranches.id, id)).get()
    if (!row) return notFound()
    return found(fromDrizzleResult<TopicBranchData>(row, 'topic_branches', (row as any).id))
  }

  exists(id: string): boolean {
    const row = this.db.select({ id: topicBranches.id }).from(topicBranches).where(eq(topicBranches.id, id)).get()
    return row !== undefined
  }

  /**
   * All branch nodes of one logical topic in deterministic order
   * (createdAt ASC, id ASC). Never includes a main-route row (none exists).
   */
  listByTopic(topicId: string): TopicBranchData[] {
    return this.db
      .select()
      .from(topicBranches)
      .where(eq(topicBranches.topicId, topicId))
      .orderBy(asc(topicBranches.createdAt), asc(topicBranches.id))
      .all()
      .map((r) => fromDrizzleResult<TopicBranchData>(r, 'topic_branches', (r as any).id))
  }

  /**
   * Direct child branches of one parent route in deterministic order
   * (createdAt ASC, id ASC). `parentBranchId = null` addresses the level-1
   * branches forked from the main route.
   */
  listChildren(topicId: string, parentBranchId: string | null): TopicBranchData[] {
    const parentPredicate =
      parentBranchId === null ? isNull(topicBranches.parentBranchId) : eq(topicBranches.parentBranchId, parentBranchId)
    return this.db
      .select()
      .from(topicBranches)
      .where(and(eq(topicBranches.topicId, topicId), parentPredicate))
      .orderBy(asc(topicBranches.createdAt), asc(topicBranches.id))
      .all()
      .map((r) => fromDrizzleResult<TopicBranchData>(r, 'topic_branches', (r as any).id))
  }

  /** Direct children of a branch node regardless of topic (subtree walks). */
  listChildrenOf(branchId: string): TopicBranchData[] {
    return this.db
      .select()
      .from(topicBranches)
      .where(eq(topicBranches.parentBranchId, branchId))
      .orderBy(asc(topicBranches.createdAt), asc(topicBranches.id))
      .all()
      .map((r) => fromDrizzleResult<TopicBranchData>(r, 'topic_branches', (r as any).id))
  }

  /**
   * Ancestry chain for a branch, leaf-first (self excluded). Cycle-guarded
   * and depth-bounded: stops at MAX_BRANCH_DEPTH or on a repeated node.
   * Returns [] for unknown branches.
   */
  ancestorsOf(branchId: string): TopicBranchData[] {
    const chain: TopicBranchData[] = []
    const seen = new Set<string>([branchId])
    let current: string | null = branchId
    for (let depth = 0; depth < MAX_BRANCH_DEPTH && current !== null; depth++) {
      const row = this.db.select().from(topicBranches).where(eq(topicBranches.id, current)).get()
      if (!row) break
      const data = fromDrizzleResult<TopicBranchData>(row, 'topic_branches', (row as any).id)
      if (current !== branchId) chain.push(data)
      const parent = data.parentBranchId
      if (parent === null) break
      if (seen.has(parent)) break
      seen.add(parent)
      current = parent
    }
    return chain
  }

  /**
   * Breadcrumb path for a route: root-first branch nodes from the level-1
   * ancestor down to the addressed branch. [] for the main route.
   */
  pathFor(branchId: string | null): TopicBranchData[] {
    if (branchId === null) return []
    return this.ancestorsOf(branchId)
      .reverse()
      .concat(
        (() => {
          const self = this.getById(branchId)
          return self.found ? [self.data] : []
        })()
      )
  }

  /**
   * Transitive descendant branch IDs of a subtree root (self excluded).
   * BFS with cycle guard. Returns [] for unknown roots.
   */
  collectSubtreeIds(rootId: string): string[] {
    if (!this.exists(rootId)) return []
    const out: string[] = []
    const seen = new Set<string>([rootId])
    const queue: string[] = [rootId]
    for (let guard = 0; guard < 4096 && queue.length > 0; guard++) {
      const current = queue.shift()!
      const children = this.listChildrenOf(current)
      for (const child of children) {
        if (seen.has(child.id)) continue
        seen.add(child.id)
        out.push(child.id)
        queue.push(child.id)
      }
    }
    return out
  }

  create(data: TopicBranchData): TopicBranchData {
    const values = toInsertValues(data)
    this.db
      .insert(topicBranches)
      .values(values as any)
      .run()
    return (this.getById(data.id) as any).data
  }

  /**
   * Rename a branch (name-only mutation; identity columns rejected).
   */
  rename(id: string, name: string): AffectedCount {
    const current = this.db.select().from(topicBranches).where(eq(topicBranches.id, id)).get()
    if (!current) return { affected: 0 }
    const patch: EntityPatchInput<TopicBranchData> = { name, updatedAt: new Date().toISOString() }
    assertNoIdentityChange(patch as Record<string, unknown>, 'topicBranches', { id })
    const rowPatch = topicBranchToRowPatch(patch)
    const values = toUpdateValues((current as any).extra ?? null, rowPatch, COLUMN_MAP)
    this.db
      .update(topicBranches)
      .set(values as any)
      .where(eq(topicBranches.id, id))
      .run()
    return { affected: 1 }
  }

  /**
   * Delete branch rows for a subtree (root + descendants). Owned messages
   * follow via messages.branch_id CASCADE; callers delete owned rows first
   * when file cleanup or sync suppression must observe them.
   */
  deleteSubtreeRows(branchIds: string[]): AffectedCount {
    if (branchIds.length === 0) return { affected: 0 }
    let total = 0
    for (const id of branchIds) {
      total += this.db.delete(topicBranches).where(eq(topicBranches.id, id)).run().changes
    }
    return { affected: total }
  }
}
