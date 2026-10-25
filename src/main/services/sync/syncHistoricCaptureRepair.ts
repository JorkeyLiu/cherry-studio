/**
 * Narrow historic capture-error repair boundary: old transient-parent defer.
 *
 * Only the exact historic aggregate failure
 * `updateBlocks: sync closure: parent message <id> transient (pending), defer`
 * is ever eligible. Any other channel, status, or grammar is preserved.
 * The parent id is parsed for internal verification only and is never logged.
 *
 * Recovery requires authoritative proof that the once-deferred closure is now
 * fully captured: stable parent + owner, versioned clocks/membership for the
 * parent and every stable supported descendant, winning frames covering the
 * closure, no pending intent/job affecting it, and no tombstone/resend cover.
 * Anything unproven preserves the durable error. A closure containing stored
 * media additionally requires a bound current channel with every completed
 * attachment job on that channel; an unbound channel never proves media.
 */
import {
  isStableBlockStatus,
  isStableMessageStatus,
  isUnsupportedBlockForSync,
  RESULT_META_FIELD,
  SYNC_BLOCK_PATCH_FIELDS,
  SYNC_FILE_ASSET_PATCH_FIELDS,
  SYNC_MESSAGE_PATCH_FIELDS,
  SYNC_TOPIC_PATCH_FIELDS
} from '@shared/sync'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as schema from '../chatDb/schema'
import { validateOrdinaryIdStrict } from './syncFrameEvaluation'

export const HISTORIC_TRANSIENT_PARENT_DEFER_CHANNEL = 'updateBlocks'
const HISTORIC_PREFIX = 'updateBlocks: sync closure: parent message '
const HISTORIC_SUFFIX = ' transient (pending), defer'

function isValidUnicodeScalar(value: string): boolean {
  if (value.length === 0) return false
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp >= 0xd800 && cp <= 0xdfff) return false
  }
  return true
}

/**
 * Parse only the known historic transient-parent defer grammar.
 * Returns the parent message id for internal verification, never for logging.
 * Any malformed, unrecognized, or non-historic value returns null (preserve).
 */
export function parseHistoricTransientParentDeferError(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (!value.startsWith(HISTORIC_PREFIX) || !value.endsWith(HISTORIC_SUFFIX)) return null
  const inner = value.slice(HISTORIC_PREFIX.length, value.length - HISTORIC_SUFFIX.length)
  if (inner.length === 0 || inner.length > 256) return null
  if (/\s/.test(inner) || inner.includes(':')) return null
  if (!isValidUnicodeScalar(inner)) return null
  try {
    validateOrdinaryIdStrict(inner, 'historic-parent')
  } catch {
    return null
  }
  return inner
}

type Db = BetterSQLite3Database<typeof schema>

function parseBlockOverflow(extra: unknown): Record<string, unknown> {
  if (typeof extra !== 'string' || extra.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(extra)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {}
  return {}
}

function isPortableMediaType(type: unknown): boolean {
  const t = typeof type === 'string' ? type.toLowerCase() : ''
  return t === 'file' || t === 'image' || t === 'video'
}

function hasTombstone(db: Db, key: string): boolean {
  try {
    return !!db.select().from(schema.syncState).where(eq(schema.syncState.key, key)).get()
  } catch {
    return true
  }
}

function entityClockExists(db: Db, entityType: string, entityId: string): boolean {
  try {
    const rows = db.select().from(schema.syncEntityClock).where(eq(schema.syncEntityClock.entityType, entityType)).all()
    return rows.some((r) => r.entityId === entityId)
  } catch {
    return false
  }
}

function fieldSet(db: Db, entityType: string, entityId: string): Set<string> | null {
  try {
    const rows = db
      .select()
      .from(schema.syncFieldClock)
      .where(eq(schema.syncFieldClock.entityType, entityType))
      .all()
      .filter((r) => r.entityId === entityId)
    return new Set(rows.map((r) => r.field))
  } catch {
    return null
  }
}

function membershipOf(db: Db, childType: 'message' | 'message_block', childId: string): { parentId: string } | null {
  try {
    const row = db
      .select()
      .from(schema.syncMembershipClock)
      .where(eq(schema.syncMembershipClock.childEntityType, childType))
      .all()
      .find((r) => r.childEntityId === childId)
    return row ? { parentId: row.parentId } : null
  } catch {
    return null
  }
}

function frameChildIds(db: Db, kind: string, parentId: string): string[] | null {
  try {
    const row = db
      .select()
      .from(schema.syncParentOrderFrame)
      .where(eq(schema.syncParentOrderFrame.kind, kind))
      .all()
      .find((r) => r.parentId === parentId) as typeof schema.syncParentOrderFrame.$inferSelect | undefined
    if (!row) return null
    if (row.frameVersion !== 'parent-order-frame-v1') return null
    let parsed: unknown
    try {
      parsed = JSON.parse(row.orderedChildIdsJson)
    } catch {
      return null
    }
    if (!Array.isArray(parsed)) return null
    const out: string[] = []
    const seen = new Set<string>()
    for (const v of parsed as unknown[]) {
      if (typeof v !== 'string' || v.length === 0 || seen.has(v)) return null
      seen.add(v)
      out.push(v)
    }
    if (JSON.stringify(out) !== row.orderedChildIdsJson) return null
    return out
  } catch {
    return null
  }
}

export interface HistoricClosureProof {
  eligible: boolean
  reason: string
}

/**
 * Authoritative closure proof for the historic parent.
 * All reasons are stable codes without ids. False preserves the error.
 */
export function checkHistoricParentClosureProof(db: Db, parentMessageId: string): HistoricClosureProof {
  let parentRow: typeof schema.messages.$inferSelect | undefined
  try {
    parentRow = db.select().from(schema.messages).where(eq(schema.messages.id, parentMessageId)).get() as
      | typeof schema.messages.$inferSelect
      | undefined
  } catch {
    return { eligible: false, reason: 'parent-read-failed' }
  }
  if (!parentRow) return { eligible: false, reason: 'parent-missing' }
  if (!isStableMessageStatus(parentRow.status)) return { eligible: false, reason: 'parent-transient' }
  if (hasTombstone(db, `tombstone:message:${parentMessageId}`)) return { eligible: false, reason: 'parent-deleted' }
  try {
    const resend = db
      .select()
      .from(schema.syncResendAttempt)
      .where(eq(schema.syncResendAttempt.messageId, parentMessageId))
      .get()
    if (resend) return { eligible: false, reason: 'resend-covered' }
  } catch {}

  const topicId = typeof parentRow.topicId === 'string' ? parentRow.topicId : ''
  if (!topicId) return { eligible: false, reason: 'owner-missing' }
  const ownerBranch =
    typeof parentRow.branchId === 'string' && parentRow.branchId.length > 0 ? parentRow.branchId : null
  let topicRow: typeof schema.topics.$inferSelect | undefined
  try {
    topicRow = db.select().from(schema.topics).where(eq(schema.topics.id, topicId)).get() as
      | typeof schema.topics.$inferSelect
      | undefined
  } catch {
    return { eligible: false, reason: 'owner-read-failed' }
  }
  if (!topicRow) return { eligible: false, reason: 'owner-missing' }
  if (hasTombstone(db, `tombstone:topic:${topicId}`)) return { eligible: false, reason: 'owner-deleted' }
  if (ownerBranch !== null) {
    let branchRow: { topicId: string } | undefined
    try {
      branchRow = db.select().from(schema.topicBranches).where(eq(schema.topicBranches.id, ownerBranch)).get() as
        | { topicId: string }
        | undefined
    } catch {
      return { eligible: false, reason: 'owner-read-failed' }
    }
    if (!branchRow) return { eligible: false, reason: 'owner-missing' }
    if (branchRow.topicId !== topicId) return { eligible: false, reason: 'owner-mismatch' }
    if (hasTombstone(db, `tombstone:topic_branch:${ownerBranch}`)) return { eligible: false, reason: 'owner-deleted' }
    if (!entityClockExists(db, 'topic_branch', ownerBranch)) return { eligible: false, reason: 'branch-unversioned' }
  }

  if (!entityClockExists(db, 'message', parentMessageId)) return { eligible: false, reason: 'parent-unversioned' }
  const messageFields = fieldSet(db, 'message', parentMessageId)
  if (!messageFields) return { eligible: false, reason: 'parent-unversioned-field' }
  for (const f of SYNC_MESSAGE_PATCH_FIELDS as readonly string[]) {
    // The portable result container is an additive/optional declared field:
    // history captured before it existed stays fully versioned for this narrow
    // historic-repair eligibility proof (its presence/absence is neither a
    // version defect nor evidence of a partial closure).
    if (f === RESULT_META_FIELD) continue
    if (!messageFields.has(f)) return { eligible: false, reason: 'parent-unversioned-field' }
  }
  const messageMem = membershipOf(db, 'message', parentMessageId)
  if (!messageMem) return { eligible: false, reason: 'parent-unversioned-membership' }
  const expectedParent = ownerBranch ?? topicId
  if (messageMem.parentId !== expectedParent) return { eligible: false, reason: 'parent-membership-mismatch' }

  if (!entityClockExists(db, 'topic', topicId)) return { eligible: false, reason: 'topic-unversioned' }
  const topicFields = fieldSet(db, 'topic', topicId)
  if (!topicFields) return { eligible: false, reason: 'topic-unversioned-field' }
  for (const f of SYNC_TOPIC_PATCH_FIELDS as readonly string[]) {
    if (!topicFields.has(f)) return { eligible: false, reason: 'topic-unversioned-field' }
  }

  let blockRows: Array<typeof schema.messageBlocks.$inferSelect>
  try {
    blockRows = db
      .select()
      .from(schema.messageBlocks)
      .where(eq(schema.messageBlocks.messageId, parentMessageId))
      .all() as Array<typeof schema.messageBlocks.$inferSelect>
  } catch {
    return { eligible: false, reason: 'descendant-read-failed' }
  }
  const coveredIds: string[] = []
  let channelKey: string | null = null
  try {
    const chRow = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'sync:channelKey')).get() as
      | { value: string | null }
      | undefined
    channelKey = typeof chRow?.value === 'string' ? chRow.value : null
  } catch {
    channelKey = null
  }
  for (const brow of blockRows) {
    if (!isStableBlockStatus(brow.status)) return { eligible: false, reason: 'descendant-transient' }
    if (hasTombstone(db, `tombstone:message_block:${brow.id}`)) return { eligible: false, reason: 'descendant-deleted' }
    const overflow = parseBlockOverflow(brow.extra)
    if (isUnsupportedBlockForSync({ type: brow.type, overflow }))
      return { eligible: false, reason: 'descendant-unsupported' }
    if (!entityClockExists(db, 'message_block', brow.id)) return { eligible: false, reason: 'descendant-unversioned' }
    const bFields = fieldSet(db, 'message_block', brow.id)
    if (!bFields) return { eligible: false, reason: 'descendant-unversioned-field' }
    const required = ['type', 'content', 'status', 'createdAt', 'updatedAt'] as const
    for (const f of required) {
      if (!bFields.has(f)) return { eligible: false, reason: 'descendant-unversioned-field' }
    }
    const media = isPortableMediaType(brow.type)
    if (media) {
      if (!bFields.has('assetIds')) return { eligible: false, reason: 'descendant-unversioned-field' }
      let refs: Array<{ fileId: string }> = []
      try {
        refs = db
          .select({ fileId: schema.fileReferences.fileId })
          .from(schema.fileReferences)
          .where(eq(schema.fileReferences.blockId, brow.id))
          .all() as Array<{ fileId: string }>
      } catch {
        return { eligible: false, reason: 'descendant-media-refs-missing' }
      }
      const fileIds = [...new Set(refs.map((r) => r.fileId).filter((v) => typeof v === 'string' && v.length > 0))]
      if (fileIds.length === 0) return { eligible: false, reason: 'descendant-media-refs-missing' }
      for (const fid of fileIds) {
        let asset: { id: string } | undefined
        try {
          asset = db.select().from(schema.syncFileAsset).where(eq(schema.syncFileAsset.id, fid)).get() as
            | { id: string }
            | undefined
        } catch {
          return { eligible: false, reason: 'descendant-media-asset-missing' }
        }
        if (!asset) return { eligible: false, reason: 'descendant-media-asset-missing' }
        if (!entityClockExists(db, 'file_asset', fid))
          return { eligible: false, reason: 'descendant-media-asset-missing' }
        const faFields = fieldSet(db, 'file_asset', fid)
        if (!faFields) return { eligible: false, reason: 'descendant-media-asset-clock-missing' }
        for (const f of SYNC_FILE_ASSET_PATCH_FIELDS as readonly string[]) {
          if (!faFields.has(f)) return { eligible: false, reason: 'descendant-media-asset-clock-missing' }
        }
        try {
          const intent = db
            .select()
            .from(schema.syncAttachmentCaptureIntent)
            .where(eq(schema.syncAttachmentCaptureIntent.blockId, brow.id))
            .all()
            .filter((r) => r.fileId === fid)
          if (intent.length > 0) return { eligible: false, reason: 'intent-pending' }
        } catch {
          return { eligible: false, reason: 'intent-pending' }
        }
        try {
          const job = db
            .select()
            .from(schema.syncAttachmentJob)
            .where(eq(schema.syncAttachmentJob.assetId, fid))
            .get() as { state: string; channelId: string } | undefined
          if (!job || job.state !== 'completed') return { eligible: false, reason: 'job-pending' }
          if (channelKey === null || job.channelId !== channelKey) return { eligible: false, reason: 'job-pending' }
        } catch {
          return { eligible: false, reason: 'job-pending' }
        }
      }
    }
    const mem = membershipOf(db, 'message_block', brow.id)
    if (!mem) return { eligible: false, reason: 'descendant-unversioned-membership' }
    if (mem.parentId !== parentMessageId) return { eligible: false, reason: 'descendant-membership-mismatch' }
    coveredIds.push(brow.id)
  }

  const blockFrame = frameChildIds(db, 'messageBlock', parentMessageId)
  if (!blockFrame) return { eligible: false, reason: 'frame-missing' }
  const frameSet = new Set(blockFrame)
  const coveredSet = new Set(coveredIds)
  if (frameSet.size !== coveredSet.size) return { eligible: false, reason: 'frame-incomplete' }
  for (const id of coveredSet) {
    if (!frameSet.has(id)) return { eligible: false, reason: 'frame-incomplete' }
  }

  const topicFrame = frameChildIds(db, 'topicMessage', topicId)
  if (!topicFrame) return { eligible: false, reason: 'topic-frame-missing' }
  if (ownerBranch === null && !topicFrame.includes(parentMessageId))
    return { eligible: false, reason: 'topic-frame-incomplete' }

  if (
    !(SYNC_BLOCK_PATCH_FIELDS as readonly string[]).includes('assetIds') ||
    !(SYNC_MESSAGE_PATCH_FIELDS as readonly string[]).includes('status')
  ) {
    return { eligible: false, reason: 'validator-mismatch' }
  }
  return { eligible: true, reason: 'eligible' }
}
