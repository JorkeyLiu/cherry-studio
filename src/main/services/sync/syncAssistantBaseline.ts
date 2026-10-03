/**
 * Assistant-config baseline v4 section (branch + assistant only, no attachments).
 *
 * Transport-free helpers owned by the assistant unit:
 * - `readAssistantBaselineSection`: read mirror + entity/field clocks +
 *   explicit tombstones. Caller owns the Tx boundary; publish calls it under
 *   the held publish barrier (no local writes allowed), capture calls it in
 *   the same SQLite snapshot where required.
 * - `buildV4PayloadFromV3`: combine a projected V3 chat payload with the
 *   assistant section into a strict V4 payload (manifest recomputed, validated).
 * - `buildPublishEnvelopeV4`: assemble + digest + self-validate the V4 envelope.
 * - `extractAssistantSectionFromV4Envelope`: strict-extract the assistant
 *   section from a validated V4 envelope for merge (no LWW here).
 * - `mergeAssistantBaselineSectionInTx`: LWW merge of the assistant section
 *   in the caller's single Tx (no outbox mutation, no gate bypass — remote
 *   internal path never takes the publish barrier gate). Returns affected keys
 *   for post-commit broadcast.
 *
 * Topic `assistantId` references stay opaque: closure never requires the
 * referenced assistant to exist and never fabricates one.
 */

import { createHash } from 'node:crypto'

import {
  ASSISTANT_CONFIG_FIELD_CLOCK_KEYS_V4,
  type AssistantConfigEntityV4,
  type AssistantTombstoneV4,
  compareUtf8ByteLex,
  COMPLETENESS_COMPLETE,
  computeSyncDigest,
  DIGEST_SCHEME,
  INVENTORY_VERSION_V4,
  ORDER_FRAME_VERSION,
  PAYLOAD_SCHEMA_V4,
  SCOPE_V4,
  type SyncEnvelopeV4,
  type SyncPayloadV3,
  type SyncPayloadV4,
  validateEnvelopeV4,
  validatePayloadV4,
  verifyEnvelopeDigest,
  WIRE_VERSION_V4
} from '@shared/sync'
import { parseAssistantConfigKey } from '@shared/sync/assistantConfig'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as schema from '../chatDb/schema'
import type * as SyncTombstoneCodec from './syncTombstoneCodec'
import { parseSyncTombstoneValue } from './syncTombstoneCodec'

type BaselineTx = BetterSQLite3Database<typeof schema>

export class SyncAssistantBaselineError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions)
    this.name = 'SyncAssistantBaselineError'
  }
}

function fail(message: string, cause?: unknown): never {
  throw new SyncAssistantBaselineError(message, cause === undefined ? undefined : { cause })
}

function hashHex(canonicalUtf8: Uint8Array): string {
  return createHash('sha256').update(canonicalUtf8).digest('hex')
}

export interface AssistantBaselineSection {
  configs: AssistantConfigEntityV4[]
  tombstones: AssistantTombstoneV4[]
}

/**
 * Read the assistant baseline section. No writes. Missing 019 table means
 * zero rows (proven pre-019), never a fabrication. Malformed rows fail closed.
 */
export function readAssistantBaselineSection(tx: BaselineTx): AssistantBaselineSection {
  let mirrorRows: Array<{
    key: string
    kind: string
    entityId: string
    payloadJson: string
    projectionRevision?: number | null
  }> = []
  try {
    mirrorRows = tx
      .select({
        key: schema.syncAssistantConfigMirror.key,
        kind: schema.syncAssistantConfigMirror.kind,
        entityId: schema.syncAssistantConfigMirror.entityId,
        payloadJson: schema.syncAssistantConfigMirror.payloadJson
      })
      .from(schema.syncAssistantConfigMirror)
      .all() as unknown as typeof mirrorRows
  } catch (e) {
    if (e instanceof Error && /no such table/i.test(e.message)) return { configs: [], tombstones: [] }
    throw e
  }
  const entityClockById = new Map<string, { timestamp: number; operationId: string }>()
  try {
    const rows = tx
      .select()
      .from(schema.syncEntityClock)
      .where(eq(schema.syncEntityClock.entityType, 'assistant_config'))
      .all()
    for (const r of rows) entityClockById.set(r.entityId, { timestamp: r.timestamp, operationId: r.operationId })
  } catch (e) {
    if (e instanceof Error && /no such table/i.test(e.message)) {
      // No clocks: section stays empty-clocks which the projector rejects as
      // incomplete (fail closed) unless there are also zero rows.
      if (mirrorRows.length === 0) return { configs: [], tombstones: [] }
      fail('assistant baseline missing entity clocks (pre-005 database cannot publish v4)')
    }
    throw e
  }
  const fieldClocksById = new Map<string, Map<string, { timestamp: number; operationId: string }>>()
  try {
    const rows = tx
      .select()
      .from(schema.syncFieldClock)
      .where(eq(schema.syncFieldClock.entityType, 'assistant_config'))
      .all()
    for (const r of rows) {
      if (!ASSISTANT_CONFIG_FIELD_CLOCK_KEYS_V4.has(r.field)) continue
      let m = fieldClocksById.get(r.entityId)
      if (!m) {
        m = new Map()
        fieldClocksById.set(r.entityId, m)
      }
      if (!m.has(r.field)) m.set(r.field, { timestamp: r.timestamp, operationId: r.operationId })
    }
  } catch (e) {
    if (!(e instanceof Error && /no such table/i.test(e.message))) throw e
  }
  // Explicit tombstones from sync_state (never snapshot absence).
  const tombstones: AssistantTombstoneV4[] = []
  try {
    const rows = tx.select().from(schema.syncState).all()
    for (const row of rows) {
      const k = row.key as unknown
      if (typeof k !== 'string' || !k.startsWith('tombstone:assistant_config:')) continue
      const entityId = k.slice('tombstone:'.length)
      const parsedKey = parseAssistantConfigKey(entityId)
      if (!parsedKey) fail(`assistant baseline malformed tombstone key ${JSON.stringify(k).slice(0, 80)}`)
      if (row.value === null || row.value === undefined)
        fail(`assistant baseline malformed tombstone value for ${entityId}: missing`)
      let parsedClock: { timestamp: number; operationId: string | null }
      try {
        const c = parseSyncTombstoneValue(row.value)
        if (!c) fail(`assistant baseline malformed tombstone value for ${entityId}: missing`)
        parsedClock = c
      } catch (e) {
        fail(
          `assistant baseline malformed tombstone value for ${entityId}: ${e instanceof Error ? e.message : String(e)}`,
          e
        )
      }
      let surviving: { timestamp: number; operationId: string } | null = null
      const ec = entityClockById.get(entityId)
      if (ec) surviving = { timestamp: ec.timestamp, operationId: ec.operationId }
      tombstones.push({
        key: entityId,
        kind: parsedKey.kind,
        id: parsedKey.id,
        deletionClock: { timestamp: parsedClock.timestamp, operationId: parsedClock.operationId },
        survivingEntityClock: surviving
      })
    }
  } catch (e) {
    if (e instanceof SyncAssistantBaselineError) throw e
    throw e
  }
  const configs: AssistantConfigEntityV4[] = []
  for (const row of mirrorRows) {
    if (typeof row.key !== 'string' || typeof row.payloadJson !== 'string') {
      fail(`assistant baseline malformed mirror row ${String(row.key).slice(0, 80)}`)
    }
    // Deleted rows ride tombstones only, never the live array.
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(row.payloadJson) as Record<string, unknown>
    } catch (e) {
      fail(`assistant baseline unreadable mirror payload for ${row.key}`, e)
    }
    if ((payload as { deleted?: unknown }).deleted === true) continue
    const parsedKey = parseAssistantConfigKey(row.key)
    if (!parsedKey) fail(`assistant baseline malformed mirror key ${JSON.stringify(row.key).slice(0, 80)}`)
    const ec = entityClockById.get(row.key)
    if (!ec) fail(`assistant baseline missing entityClock for ${row.key} (unversioned rows cannot publish v4)`)
    const fieldMap = fieldClocksById.get(row.key) ?? new Map()
    const fieldClocks: Record<string, { timestamp: number; operationId: string }> = {}
    for (const [field, clock] of fieldMap)
      fieldClocks[field] = { timestamp: clock.timestamp, operationId: clock.operationId }
    // Every present mutable field must carry a clock (fully-clocked completion).
    const presentMutable = Object.keys(payload).filter((k) => ASSISTANT_CONFIG_FIELD_CLOCK_KEYS_V4.has(k))
    for (const k of presentMutable) {
      if (!(k in fieldClocks)) fail(`assistant baseline missing fieldClock ${k} for ${row.key}`)
    }
    configs.push({
      key: row.key,
      kind: parsedKey.kind,
      id: parsedKey.id,
      config: payload,
      entityClock: { timestamp: ec.timestamp, operationId: ec.operationId },
      fieldClocks
    })
  }
  configs.sort((a, b) => compareUtf8ByteLex(a.key, b.key))
  tombstones.sort((a, b) => compareUtf8ByteLex(a.key, b.key))
  return { configs, tombstones }
}

/** Combine a projected V3 chat payload with the assistant section into strict V4. */
export function buildV4PayloadFromV3(v3: SyncPayloadV3, section: AssistantBaselineSection): SyncPayloadV4 {
  const payload = {
    payloadSchema: PAYLOAD_SCHEMA_V4,
    inventoryVersion: INVENTORY_VERSION_V4,
    orderFrameVersion: ORDER_FRAME_VERSION,
    scope: SCOPE_V4,
    topics: (v3 as unknown as { topics: unknown }).topics,
    messages: (v3 as unknown as { messages: unknown }).messages,
    messageBlocks: (v3 as unknown as { messageBlocks: unknown }).messageBlocks,
    branches: (v3 as unknown as { branches: unknown }).branches,
    assistantConfigs: section.configs,
    tombstones: (v3 as unknown as { tombstones: unknown }).tombstones,
    assistantTombstones: section.tombstones,
    orderFrames: (v3 as unknown as { orderFrames: unknown }).orderFrames,
    replacementRegisters: (v3 as unknown as { replacementRegisters: unknown }).replacementRegisters,
    manifest: {
      payloadSchema: PAYLOAD_SCHEMA_V4,
      inventoryVersion: INVENTORY_VERSION_V4,
      orderFrameVersion: ORDER_FRAME_VERSION,
      scope: SCOPE_V4,
      liveCounts: {
        topic: (v3.manifest as unknown as { liveCounts: { topic: number } }).liveCounts.topic,
        message: (v3.manifest as unknown as { liveCounts: { message: number } }).liveCounts.message,
        messageBlock: (v3.manifest as unknown as { liveCounts: { messageBlock: number } }).liveCounts.messageBlock,
        branch: (v3.manifest as unknown as { liveCounts: { branch: number } }).liveCounts.branch,
        assistantConfig: section.configs.length
      },
      tombstoneCounts: {
        topic: (v3.manifest as unknown as { tombstoneCounts: { topic: number } }).tombstoneCounts.topic,
        message: (v3.manifest as unknown as { tombstoneCounts: { message: number } }).tombstoneCounts.message,
        messageBlock: (v3.manifest as unknown as { tombstoneCounts: { messageBlock: number } }).tombstoneCounts
          .messageBlock,
        topicBranch: (v3.manifest as unknown as { tombstoneCounts: { topicBranch: number } }).tombstoneCounts
          .topicBranch,
        assistantConfig: section.tombstones.length
      },
      frameCounts: (v3.manifest as unknown as { frameCounts: unknown }).frameCounts,
      replacementCount: (v3.manifest as unknown as { replacementCount: number }).replacementCount,
      completeness: COMPLETENESS_COMPLETE
    }
  }
  try {
    return validatePayloadV4(payload) as unknown as SyncPayloadV4
  } catch (e) {
    fail(`assistant v4 payload invalid: ${e instanceof Error ? e.message : String(e)}`, e)
  }
}

export function computeV4PayloadDigest(payload: SyncPayloadV4): string {
  return computeSyncDigest(payload as unknown as Parameters<typeof computeSyncDigest>[0], hashHex)
}

/** Assemble + digest + self-validate the V4 envelope (locked key order). */
export function buildPublishEnvelopeV4(
  v3payload: SyncPayloadV3,
  section: AssistantBaselineSection,
  channelId: string,
  watermarkN: number
): { envelope: SyncEnvelopeV4; digest: string } {
  if (typeof channelId !== 'string' || channelId.length === 0) fail('publish blocked: channel binding missing')
  if (!Number.isSafeInteger(watermarkN) || watermarkN < 0) fail('publish blocked: watermark N malformed')
  const payload = buildV4PayloadFromV3(v3payload, section)
  const digest = computeV4PayloadDigest(payload)
  const envelope = {
    wireVersion: WIRE_VERSION_V4,
    channelId,
    watermark: watermarkN,
    digestScheme: DIGEST_SCHEME,
    digest,
    payload
  }
  try {
    const validated = validateEnvelopeV4(envelope) as unknown as SyncEnvelopeV4
    const ok = verifyEnvelopeDigest(validated as unknown as Parameters<typeof verifyEnvelopeDigest>[0], hashHex)
    if (!ok) fail('publish blocked: v4 digest self-verify failed')
    return { envelope: validated, digest }
  } catch (e) {
    if (e instanceof SyncAssistantBaselineError) throw e
    fail(`publish blocked: v4 envelope invalid: ${e instanceof Error ? e.message : String(e)}`, e)
  }
}

/** Strict-extract the assistant section from a validated V4 envelope (no LWW here). */
export function extractAssistantSectionFromV4Envelope(envelopeUnknown: unknown): AssistantBaselineSection {
  let envelope: SyncEnvelopeV4
  try {
    envelope = validateEnvelopeV4(envelopeUnknown) as unknown as SyncEnvelopeV4
  } catch (e) {
    fail(`assistant v4 envelope invalid: ${e instanceof Error ? e.message : String(e)}`, e)
  }
  const payload = envelope.payload
  return {
    configs: [...(payload.assistantConfigs ?? [])],
    tombstones: [...(payload.assistantTombstones ?? [])]
  }
}

function compareLww(aTs: number, aId: string, bTs: number, bId: string): number {
  if (aTs !== bTs) return aTs < bTs ? -1 : 1
  if (aId === bId) return 0
  return aId < bId ? -1 : 1
}

/**
 * LWW merge of the assistant section in the caller's single Tx.
 * No outbox mutation (baseline convergence, not new intent), no publish-gate
 * (remote internal path). Full entity/field clocks + explicit tombstones.
 * Returns affected keys for post-commit broadcast.
 */
export function mergeAssistantBaselineSectionInTx(
  tx: BaselineTx,
  section: AssistantBaselineSection
): { merged: number; suppressed: number; affectedKeys: string[] } {
  let merged = 0
  let suppressed = 0
  const affectedKeys: string[] = []
  const readClock = (entityId: string): { timestamp: number; operationId: string } | null => {
    try {
      const row = tx
        .select()
        .from(schema.syncEntityClock)
        .where(eq(schema.syncEntityClock.entityType, 'assistant_config'))
        .all()
        .find((r) => r.entityId === entityId) as typeof schema.syncEntityClock.$inferSelect | undefined
      return row ? { timestamp: row.timestamp, operationId: row.operationId } : null
    } catch (e) {
      if (e instanceof Error && /no such table/i.test(e.message)) return null
      throw e
    }
  }
  const readFieldClocks = (entityId: string): Map<string, { timestamp: number; operationId: string }> => {
    const out = new Map<string, { timestamp: number; operationId: string }>()
    try {
      const rows = tx
        .select()
        .from(schema.syncFieldClock)
        .where(eq(schema.syncFieldClock.entityType, 'assistant_config'))
        .all()
        .filter((r) => r.entityId === entityId)
      for (const r of rows) {
        if (!ASSISTANT_CONFIG_FIELD_CLOCK_KEYS_V4.has(r.field)) continue
        if (!out.has(r.field)) out.set(r.field, { timestamp: r.timestamp, operationId: r.operationId })
      }
    } catch (e) {
      if (!(e instanceof Error && /no such table/i.test(e.message))) throw e
    }
    return out
  }
  const writeEntityClock = (entityId: string, timestamp: number, operationId: string): void => {
    tx.insert(schema.syncEntityClock)
      .values({ entityType: 'assistant_config', entityId, timestamp, operationId })
      .onConflictDoUpdate({
        target: [schema.syncEntityClock.entityType, schema.syncEntityClock.entityId],
        set: { timestamp, operationId }
      })
      .run()
  }
  const writeFieldClock = (entityId: string, field: string, timestamp: number, operationId: string): void => {
    try {
      tx.insert(schema.syncFieldClock)
        .values({ entityType: 'assistant_config', entityId, field, timestamp, operationId })
        .onConflictDoUpdate({
          target: [schema.syncFieldClock.entityType, schema.syncFieldClock.entityId, schema.syncFieldClock.field],
          set: { timestamp, operationId }
        })
        .run()
    } catch (e) {
      if (e instanceof Error && /no such table/i.test(e.message)) return
      throw e
    }
  }
  const readTombstone = (entityId: string): { timestamp: number; operationId: string | null } | null => {
    const key = `tombstone:assistant_config:${entityId.slice('assistant_config:'.length)}`
    const row = tx.select().from(schema.syncState).where(eq(schema.syncState.key, key)).get()
    if (!row) return null
    if (row.value === null || row.value === undefined) fail(`assistant merge malformed tombstone for ${entityId}`)
    const parsed = parseSyncTombstoneValue(row.value)
    if (!parsed) fail(`assistant merge malformed tombstone for ${entityId}`)
    return parsed
  }
  const writeTombstone = (entityId: string, timestamp: number, operationId: string | null): void => {
    const key = `tombstone:assistant_config:${entityId.slice('assistant_config:'.length)}`
    const existing = tx.select().from(schema.syncState).where(eq(schema.syncState.key, key)).get()
    if (existing) {
      if (existing.value === null || existing.value === undefined)
        fail(`assistant merge malformed tombstone for ${entityId}`)
      const parsed = parseSyncTombstoneValue(existing.value)
      if (parsed) {
        if (parsed.operationId === null || operationId === null) {
          if (parsed.timestamp >= timestamp) return
        } else if (compareLww(timestamp, operationId, parsed.timestamp, parsed.operationId) <= 0) return
      }
    }
    const { formatSyncTombstoneValue } = require('./syncTombstoneCodec') as typeof SyncTombstoneCodec
    const value = formatSyncTombstoneValue(timestamp, operationId)
    tx.insert(schema.syncState)
      .values({ key, value })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value } })
      .run()
  }
  // Tombstones first (delete-wins), then live configs with per-field LWW.
  for (const t of section.tombstones) {
    const key = t.key
    const existingClock = readClock(key)
    let wins = true
    if (existingClock) {
      if (t.deletionClock.operationId === null) wins = existingClock.timestamp <= t.deletionClock.timestamp
      else if (existingClock.timestamp !== t.deletionClock.timestamp)
        wins = existingClock.timestamp < t.deletionClock.timestamp
      else
        wins =
          compareLww(
            t.deletionClock.timestamp,
            t.deletionClock.operationId,
            existingClock.timestamp,
            existingClock.operationId
          ) >= 0
    }
    const localTomb = readTombstone(key)
    if (localTomb) {
      if (localTomb.operationId === null || t.deletionClock.operationId === null) {
        if (localTomb.timestamp >= t.deletionClock.timestamp) wins = false
      } else if (
        compareLww(
          t.deletionClock.timestamp,
          t.deletionClock.operationId,
          localTomb.timestamp,
          localTomb.operationId
        ) <= 0
      ) {
        wins = false
      }
    }
    if (!wins) {
      suppressed++
      continue
    }
    writeTombstone(key, t.deletionClock.timestamp, t.deletionClock.operationId)
    const tombPayload = { schemaVersion: 1, kind: t.kind, id: t.id, deleted: true }
    const now = Date.now()
    try {
      const existing = tx
        .select()
        .from(schema.syncAssistantConfigMirror)
        .where(eq(schema.syncAssistantConfigMirror.key, key))
        .get()
      if (!existing) {
        tx.insert(schema.syncAssistantConfigMirror)
          .values({
            key,
            kind: t.kind,
            entityId: t.id,
            payloadJson: JSON.stringify(tombPayload),
            version: 1,
            localMutationId: null,
            projectionRevision: 1,
            deleted: 1,
            updatedAt: now
          })
          .run()
      } else {
        tx.update(schema.syncAssistantConfigMirror)
          .set({
            payloadJson: JSON.stringify(tombPayload),
            version: (existing.version ?? 0) + 1,
            projectionRevision: (existing.projectionRevision ?? 0) + 1,
            deleted: 1,
            updatedAt: now
          })
          .where(eq(schema.syncAssistantConfigMirror.key, key))
          .run()
      }
    } catch (e) {
      if (e instanceof Error && /no such table/i.test(e.message))
        fail('assistant mirror unavailable: migration 019 not applied')
      throw e
    }
    merged++
    affectedKeys.push(key)
  }
  for (const c of section.configs) {
    // Own-tombstone delete-wins (a newer live may still resurrect).
    const ownTomb = readTombstone(c.key)
    if (ownTomb) {
      let suppressedByTomb = false
      if (ownTomb.operationId === null) suppressedByTomb = c.entityClock.timestamp <= ownTomb.timestamp
      else if (c.entityClock.timestamp !== ownTomb.timestamp)
        suppressedByTomb = c.entityClock.timestamp < ownTomb.timestamp
      else
        suppressedByTomb =
          compareLww(c.entityClock.timestamp, c.entityClock.operationId, ownTomb.timestamp, ownTomb.operationId) <= 0
      if (suppressedByTomb) {
        suppressed++
        continue
      }
    }
    let existing: typeof schema.syncAssistantConfigMirror.$inferSelect | undefined
    try {
      existing = tx
        .select()
        .from(schema.syncAssistantConfigMirror)
        .where(eq(schema.syncAssistantConfigMirror.key, c.key))
        .get()
    } catch (e) {
      if (e instanceof Error && /no such table/i.test(e.message))
        fail('assistant mirror unavailable: migration 019 not applied')
      throw e
    }
    if (existing && (existing.deleted ?? 0) === 1) {
      // Live vs tombstone row: entity-clock decides resurrection.
      const localClock = readClock(c.key)
      if (
        localClock &&
        compareLww(c.entityClock.timestamp, c.entityClock.operationId, localClock.timestamp, localClock.operationId) <=
          0
      ) {
        suppressed++
        continue
      }
    }
    const localFields = readFieldClocks(c.key)
    const winners: Array<{ field: string; value: unknown }> = []
    const incomingConfig = c.config
    for (const field of Object.keys(incomingConfig)) {
      if (!ASSISTANT_CONFIG_FIELD_CLOCK_KEYS_V4.has(field)) continue
      const incomingClock = (c.fieldClocks as Record<string, { timestamp: number; operationId: string }>)[field]
      if (!incomingClock) continue
      const prior = localFields.get(field)
      if (
        !prior ||
        compareLww(incomingClock.timestamp, incomingClock.operationId, prior.timestamp, prior.operationId) > 0
      ) {
        winners.push({ field, value: incomingConfig[field] })
      }
    }
    if (
      !existing &&
      winners.length === 0 &&
      Object.keys(incomingConfig).filter((k) => ASSISTANT_CONFIG_FIELD_CLOCK_KEYS_V4.has(k)).length > 0
    ) {
      // New row with no comparable local clocks: accept as union (initial seed).
      for (const field of Object.keys(incomingConfig)) {
        if (!ASSISTANT_CONFIG_FIELD_CLOCK_KEYS_V4.has(field)) continue
        const incomingClock = (c.fieldClocks as Record<string, { timestamp: number; operationId: string }>)[field]
        if (incomingClock) winners.push({ field, value: incomingConfig[field] })
      }
    }
    if (!existing) {
      const mergedPayload: Record<string, unknown> = { schemaVersion: 1, kind: c.kind, id: c.id }
      for (const w of winners) mergedPayload[w.field] = w.value
      const now = Date.now()
      tx.insert(schema.syncAssistantConfigMirror)
        .values({
          key: c.key,
          kind: c.kind,
          entityId: c.id,
          payloadJson: JSON.stringify(mergedPayload),
          version: 1,
          localMutationId: null,
          projectionRevision: 1,
          deleted: 0,
          updatedAt: now
        })
        .run()
      writeEntityClock(c.key, c.entityClock.timestamp, c.entityClock.operationId)
      for (const w of winners) {
        const clk = (c.fieldClocks as Record<string, { timestamp: number; operationId: string }>)[w.field]
        if (clk) writeFieldClock(c.key, w.field, clk.timestamp, clk.operationId)
      }
      merged++
      affectedKeys.push(c.key)
      continue
    }
    if (winners.length === 0) {
      suppressed++
      continue
    }
    const prevPayload = JSON.parse(existing.payloadJson) as Record<string, unknown>
    const nextPayload: Record<string, unknown> = { ...prevPayload, schemaVersion: 1, kind: c.kind, id: c.id }
    delete nextPayload.deleted
    for (const w of winners) nextPayload[w.field] = w.value
    tx.update(schema.syncAssistantConfigMirror)
      .set({
        payloadJson: JSON.stringify(nextPayload),
        version: (existing.version ?? 0) + 1,
        projectionRevision: (existing.projectionRevision ?? 0) + 1,
        deleted: 0,
        updatedAt: Date.now()
      })
      .where(eq(schema.syncAssistantConfigMirror.key, c.key))
      .run()
    const localClock = readClock(c.key)
    if (
      !localClock ||
      compareLww(c.entityClock.timestamp, c.entityClock.operationId, localClock.timestamp, localClock.operationId) > 0
    ) {
      writeEntityClock(c.key, c.entityClock.timestamp, c.entityClock.operationId)
    }
    for (const w of winners) {
      const clk = (c.fieldClocks as Record<string, { timestamp: number; operationId: string }>)[w.field]
      if (clk) writeFieldClock(c.key, w.field, clk.timestamp, clk.operationId)
    }
    merged++
    affectedKeys.push(c.key)
  }
  return { merged, suppressed, affectedKeys }
}
