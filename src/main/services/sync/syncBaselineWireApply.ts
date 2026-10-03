/**
 * Wire baseline direct apply adapter (receiver bootstrap).
 *
 * Validates a `sync-baseline-wire-v1/v2/v3/v4` envelope with the shared strict
 * `baselineWire` validator (exact keys/channel/digest, no copied rules) and
 * maps it to the normalized merge input consumed by the single merge core in
 * `syncBaselineApply.ts` (`mergeValidatedBaselineInTx`). No LWW/merge rules
 * are duplicated here; dense `sortOrder 0..n-1` materialization stays inside
 * the merge core as local projection only and never goes on the wire.
 *
 * v3 maps the branch inventory (branchId owner on messages, branch nodes,
 * topicBranch tombstones, branchSuffix frames) into the same merge input;
 * the core's branch-domain gate includes local branch rows in evaluation.
 * v4 additionally carries the assistant section (assistantConfigs +
 * assistantTombstones); it is returned as `assistant` for the caller to merge
 * in the SAME Tx via `mergeAssistantBaselineSectionInTx` (no bypass, no outbox).
 *
 * Transport-free: no relay/network/IPC/UI. The caller owns the SQLite
 * transaction boundary (e.g. bootstrap merge + cursor commit atomically).
 */

import { createHash } from 'node:crypto'

import { type SyncEnvelopeAny, validateEnvelope, ValidationError, verifyEnvelopeDigest } from '@shared/sync'
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
  assistant?: {
    configs: Array<{
      key: string
      kind: 'assistant' | 'defaults'
      id: string
      config: Record<string, unknown>
      entityClock: { timestamp: number; operationId: string }
      fieldClocks: Record<string, { timestamp: number; operationId: string }>
    }>
    tombstones: Array<{
      key: string
      kind: 'assistant' | 'defaults'
      id: string
      deletionClock: { timestamp: number; operationId: string | null }
      survivingEntityClock: { timestamp: number; operationId: string } | null
    }>
  }
} {
  let envelope: SyncEnvelopeAny
  try {
    envelope = validateEnvelope(envelopeUnknown) as SyncEnvelopeAny
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
  // v3 branch nodes (absent in v1/v2). Full-state identity + mutable state.
  // FK order: branches before branch-owned messages (messages.branchId FK).
  for (const b of ((payload as { branches?: unknown }).branches as Array<{
    id: string
    topicId: string
    parentBranchId: string | null
    anchorMessageId: string
    name: string | null
    createdAt: string | null
    updatedAt: string | null
    entityClock: { timestamp: number; operationId: string }
    fieldClocks: Record<string, { timestamp: number; operationId: string }>
  }>) ?? []) {
    entities.push({
      entityType: 'topic_branch',
      entityId: b.id,
      payload: {
        id: b.id,
        topicId: b.topicId,
        parentBranchId: b.parentBranchId,
        anchorMessageId: b.anchorMessageId,
        name: b.name,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt
      },
      entityClock: { timestamp: b.entityClock.timestamp, operationId: b.entityClock.operationId },
      fieldClocks: Object.entries(b.fieldClocks)
        .map(([field, clock]) => ({ field, timestamp: clock.timestamp, operationId: clock.operationId }))
        .sort((a, c) => (a.field < c.field ? -1 : a.field > c.field ? 1 : 0))
    })
  }
  for (const m of payload.messages) {
    // v3 carries the immutable owner branchId (null = main); v1/v2 payloads
    // have no branchId key (main route). Membership binds the owner.
    const branchId = (m as { branchId?: unknown }).branchId ?? null
    const ownerParent = typeof branchId === 'string' && branchId.length > 0 ? branchId : m.topicId
    entities.push({
      entityType: 'message',
      entityId: m.id,
      payload: {
        id: m.id,
        topicId: m.topicId,
        branchId: typeof branchId === 'string' && branchId.length > 0 ? branchId : null,
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
        parentId: ownerParent,
        timestamp: m.parentMembershipClock.timestamp,
        operationId: m.parentMembershipClock.operationId
      }
    })
  }
  // V5 fileAssets before media blocks (fileAssets first)
  for (const fa of ((payload as { fileAssets?: unknown }).fileAssets as Array<{
    id: string
    sha256: string
    byteLength: number
    extension: string
    mimeType: string
    originalName: string
    createdAt: string
    entityClock: { timestamp: number; operationId: string }
    fieldClocks: Record<string, { timestamp: number; operationId: string }>
  }>) ?? []) {
    entities.push({
      entityType: 'file_asset',
      entityId: fa.id,
      payload: {
        id: fa.id,
        sha256: fa.sha256,
        byteLength: fa.byteLength,
        extension: fa.extension,
        mimeType: fa.mimeType,
        originalName: fa.originalName,
        createdAt: fa.createdAt
      },
      entityClock: { timestamp: fa.entityClock.timestamp, operationId: fa.entityClock.operationId },
      fieldClocks: Object.entries(fa.fieldClocks)
        .map(([field, clock]) => ({ field, timestamp: clock.timestamp, operationId: clock.operationId }))
        .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0))
    })
  }
  for (const b of payload.messageBlocks) {
    const assetIds = (b as { assetIds?: unknown }).assetIds ?? []
    const payloadWithAsset: Record<string, unknown> = {
      id: b.id,
      messageId: b.messageId,
      type: b.type,
      content: b.content,
      status: b.status,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt
    }
    if (Array.isArray(assetIds)) payloadWithAsset['assetIds'] = [...(assetIds as string[])]
    else payloadWithAsset['assetIds'] = []
    entities.push({
      entityType: 'message_block',
      entityId: b.id,
      payload: payloadWithAsset,
      entityClock: { timestamp: b.entityClock.timestamp, operationId: b.entityClock.operationId },
      fieldClocks: Object.entries(b.fieldClocks as Record<string, unknown>)
        .map(([field, clock]) => ({
          field,
          timestamp: (clock as { timestamp: number }).timestamp,
          operationId: (clock as { operationId: string }).operationId
        }))
        .sort((a, b2) => (a.field < b2.field ? -1 : a.field > b2.field ? 1 : 0)),
      parentMembershipClock: {
        parentId: b.messageId,
        timestamp: b.parentMembershipClock.timestamp,
        operationId: b.parentMembershipClock.operationId
      }
    })
  }

  const tombstones: LocalSyncBaselineTombstone[] = payload.tombstones.map((t) => ({
    entityType:
      t.entityType === 'messageBlock'
        ? 'message_block'
        : t.entityType === 'topicBranch'
          ? 'topic_branch'
          : t.entityType === 'fileAsset'
            ? 'file_asset'
            : t.entityType,
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

  // Baseline v2 registers ride the wire with exactly the locked three keys;
  // v1 payloads carry none. No wire sortOrder, no fabricated diagnostics.
  const rawRegisters = (payload as { replacementRegisters?: unknown }).replacementRegisters
  const replacementRegisters =
    rawRegisters === undefined
      ? undefined
      : (
          rawRegisters as Array<{
            messageId: string
            replacementClock: { timestamp: number; operationId: string }
            activeBlockIds: string[]
          }>
        ).map((r) => ({
          messageId: r.messageId,
          timestamp: r.replacementClock.timestamp,
          operationId: r.replacementClock.operationId,
          activeBlockIds: [...r.activeBlockIds]
        }))

  const input: ValidatedBaselineMergeInput =
    replacementRegisters === undefined
      ? { entities, tombstones, orderFrames }
      : { entities, tombstones, orderFrames, replacementRegisters }
  // v4 assistant section (branch + assistant only, no attachments): strict-extract
  // for same-Tx merge via mergeAssistantBaselineSectionInTx. Older wires carry none.
  const rawAssistantConfigs = (payload as { assistantConfigs?: unknown }).assistantConfigs
  const rawAssistantTombstones = (payload as { assistantTombstones?: unknown }).assistantTombstones
  if (rawAssistantConfigs === undefined && rawAssistantTombstones === undefined) {
    return { input, watermark: envelope.watermark, channelId: envelope.channelId }
  }
  if (!Array.isArray(rawAssistantConfigs) || !Array.isArray(rawAssistantTombstones)) {
    fail('wire baseline assistant section malformed (v4 requires assistantConfigs + assistantTombstones arrays)')
  }
  return {
    input,
    watermark: envelope.watermark,
    channelId: envelope.channelId,
    assistant: {
      configs: rawAssistantConfigs as never,
      tombstones: rawAssistantTombstones as never
    }
  }
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
