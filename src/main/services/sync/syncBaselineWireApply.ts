/**
 * Wire baseline direct apply adapter (receiver bootstrap).
 *
 * Validates a `sync-baseline-wire-v1` envelope with the shared strict
 * `baselineWire` validator (exact keys/channel/digest, no copied rules) and
 * maps it to the normalized merge input consumed by the single merge core in
 * `syncBaselineApply.ts` (`mergeValidatedBaselineInTx`). No LWW/merge rules
 * are duplicated here; dense `sortOrder 0..n-1` materialization stays inside
 * the merge core as local projection only and never goes on the wire.
 *
 * Transport-free: no relay/network/IPC/UI. The caller owns the SQLite
 * transaction boundary (e.g. bootstrap merge + cursor commit atomically).
 */

import { createHash } from 'node:crypto'

import { type SyncEnvelope, validateEnvelope, ValidationError, verifyEnvelopeDigest } from '@shared/sync'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import type * as schema from '../chatDb/schema'
import type { LocalSyncBaselineEntity, LocalSyncBaselineOrderFrame, LocalSyncBaselineTombstone } from './syncBaseline'
import {
  type LocalSyncBaselineApplyResult,
  mergeValidatedBaselineInTx,
  SyncBaselineApplyError,
  type ValidatedBaselineMergeInput
} from './syncBaselineApply'

type BaselineTx = BetterSQLite3Database<typeof schema>

function fail(message: string, cause?: unknown): never {
  throw new SyncBaselineApplyError(message, cause === undefined ? undefined : { cause })
}

function hashHex(canonicalUtf8: Uint8Array): string {
  return createHash('sha256').update(canonicalUtf8).digest('hex')
}

/**
 * Validate a wire envelope strictly and map it to the normalized merge input.
 * Throws `SyncBaselineApplyError` fail-closed on any validation/digest/
 * mapping failure. Never fabricates local candidate diagnostics
 * (`pendingOutboxCount`, `observationBinding`, `observedLocalChannelKey`,
 * `observedLocalCursor`, `unversioned`/`excluded`/`orphan`/`aggregate`
 * counters, `reasons`); those local-only fields are never derived from wire.
 */
export function mapWireEnvelopeToMergeInput(envelopeUnknown: unknown): {
  input: ValidatedBaselineMergeInput
  watermark: number
  channelId: string
} {
  let envelope: SyncEnvelope
  try {
    envelope = validateEnvelope(envelopeUnknown)
  } catch (e) {
    if (e instanceof ValidationError) fail(`wire baseline envelope invalid: ${e.message}`, e)
    throw e instanceof Error ? e : new Error(String(e))
  }
  let digestOk = false
  try {
    digestOk = verifyEnvelopeDigest(envelope, hashHex)
  } catch (e) {
    if (e instanceof ValidationError) fail(`wire baseline digest verify failed validation: ${e.message}`, e)
    throw e instanceof Error ? e : new Error(String(e))
  }
  if (!digestOk) fail('wire baseline digest mismatch (tampered envelope)')

  const payload = envelope.payload
  const entities: LocalSyncBaselineEntity[] = []
  for (const t of payload.topics) {
    entities.push({
      entityType: 'topic',
      entityId: t.id,
      payload: {
        id: t.id,
        name: t.name,
        assistantId: t.assistantId,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        deletedAt: t.deletedAt,
        pinned: t.pinned,
        prompt: t.prompt,
        isNameManuallyEdited: t.isNameManuallyEdited
      },
      entityClock: { timestamp: t.entityClock.timestamp, operationId: t.entityClock.operationId },
      fieldClocks: Object.entries(t.fieldClocks)
        .map(([field, clock]) => ({ field, timestamp: clock.timestamp, operationId: clock.operationId }))
        .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0))
    })
  }
  for (const m of payload.messages) {
    entities.push({
      entityType: 'message',
      entityId: m.id,
      payload: {
        id: m.id,
        topicId: m.topicId,
        role: m.role,
        content: m.content,
        status: m.status,
        askId: m.askId,
        model: m.model,
        modelId: m.modelId,
        assistantId: m.assistantId,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt
      },
      entityClock: { timestamp: m.entityClock.timestamp, operationId: m.entityClock.operationId },
      fieldClocks: Object.entries(m.fieldClocks)
        .map(([field, clock]) => ({ field, timestamp: clock.timestamp, operationId: clock.operationId }))
        .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0)),
      parentMembershipClock: {
        parentId: m.topicId,
        timestamp: m.parentMembershipClock.timestamp,
        operationId: m.parentMembershipClock.operationId
      }
    })
  }
  for (const b of payload.messageBlocks) {
    entities.push({
      entityType: 'message_block',
      entityId: b.id,
      payload: {
        id: b.id,
        messageId: b.messageId,
        type: b.type,
        content: b.content,
        status: b.status,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt
      },
      entityClock: { timestamp: b.entityClock.timestamp, operationId: b.entityClock.operationId },
      fieldClocks: Object.entries(b.fieldClocks)
        .map(([field, clock]) => ({ field, timestamp: clock.timestamp, operationId: clock.operationId }))
        .sort((a, b2) => (a.field < b2.field ? -1 : a.field > b2.field ? 1 : 0)),
      parentMembershipClock: {
        parentId: b.messageId,
        timestamp: b.parentMembershipClock.timestamp,
        operationId: b.parentMembershipClock.operationId
      }
    })
  }

  const tombstones: LocalSyncBaselineTombstone[] = payload.tombstones.map((t) => ({
    entityType: t.entityType === 'messageBlock' ? 'message_block' : t.entityType,
    entityId: t.entityId,
    timestamp: t.deletionClock.timestamp,
    operationId: t.deletionClock.operationId,
    entityClock: t.survivingEntityClock
      ? { timestamp: t.survivingEntityClock.timestamp, operationId: t.survivingEntityClock.operationId }
      : null
  }))

  const orderFrames: LocalSyncBaselineOrderFrame[] = payload.orderFrames.map((f) => ({
    frameVersion: f.frameVersion,
    kind: f.kind,
    parentId: f.parentId,
    orderedChildIds: [...f.orderedChildIds],
    frameClock: { timestamp: f.frameClock.timestamp, operationId: f.frameClock.operationId }
  }))

  return { input: { entities, tombstones, orderFrames }, watermark: envelope.watermark, channelId: envelope.channelId }
}

/**
 * Validate a wire envelope and merge it inside the caller-owned transaction
 * via the shared merge core. Returns the envelope watermark N for the caller
 * to commit as `sync_state.cursor` in the SAME transaction.
 * Fails closed before any write when envelope/channel/digest/manifest/clock/
 * frame validation fails; on merge failure the caller transaction rolls back.
 */
export function applyWireSyncEnvelopeInTx(
  tx: BaselineTx,
  envelopeUnknown: unknown,
  opts?: { expectedChannelId?: string }
): { watermark: number; channelId: string; result: LocalSyncBaselineApplyResult } {
  const { input, watermark, channelId } = mapWireEnvelopeToMergeInput(envelopeUnknown)
  if (opts?.expectedChannelId !== undefined && channelId !== opts.expectedChannelId) {
    fail(`wire baseline channel mismatch: envelope ${channelId} vs local ${opts.expectedChannelId}`)
  }
  const result = mergeValidatedBaselineInTx(tx, input)
  return { watermark, channelId, result }
}
