/**
 * Phase 0 — Device identity & sync metadata management
 *
 * Persists deviceId, lastSyncSeq, and lastSyncTimestamp using the
 * existing Dexie `settings` table (key-value store) to avoid adding
 * extra schema tables.
 */

import { loggerService } from '@logger'
import db from '@renderer/databases'
import { v4 as uuidv4 } from 'uuid'

import type { SyncMeta } from './types'

const logger = loggerService.withContext('SyncMeta')

const SYNC_META_KEY = 'sync_meta'

/** Read the full SyncMeta document from the settings table. */
async function getSyncMeta(): Promise<SyncMeta | null> {
  try {
    const row = await db.settings.get(SYNC_META_KEY)
    if (!row) return null
    return row.value as SyncMeta
  } catch (err) {
    logger.error('Failed to read sync meta', err as Error)
    return null
  }
}

/** Persist (upsert) the full SyncMeta document. */
async function setSyncMeta(meta: SyncMeta): Promise<void> {
  try {
    await db.settings.put({ id: SYNC_META_KEY, value: meta })
  } catch (err) {
    logger.error('Failed to write sync meta', err as Error)
    throw err
  }
}

/**
 * Get-or-create the device identity.
 * On first call a UUID v4 is generated and stored.
 */
export async function getDeviceId(): Promise<string> {
  const meta = await getSyncMeta()
  if (meta?.deviceId) return meta.deviceId

  const deviceId = uuidv4()
  const newMeta: SyncMeta = {
    id: SYNC_META_KEY,
    deviceId,
    lastSyncSeq: 0,
    lastSyncTimestamp: 0
  }
  await setSyncMeta(newMeta)
  logger.info(`Generated new deviceId: ${deviceId}`)
  return deviceId
}

/** Return the stored deviceId without creating one. */
export async function peekDeviceId(): Promise<string | null> {
  const meta = await getSyncMeta()
  return meta?.deviceId ?? null
}

/** Read the last pulled sequence number. Defaults to 0. */
export async function getLastSyncSeq(): Promise<number> {
  const meta = await getSyncMeta()
  return meta?.lastSyncSeq ?? 0
}

/** Persist the last pulled sequence number. */
export async function setLastSyncSeq(seq: number): Promise<void> {
  const meta = (await getSyncMeta()) ?? {
    id: SYNC_META_KEY,
    deviceId: uuidv4(),
    lastSyncSeq: 0,
    lastSyncTimestamp: 0
  }
  meta.lastSyncSeq = seq
  await setSyncMeta(meta)
}

/** Read the timestamp of the last successful sync. */
export async function getLastSyncTimestamp(): Promise<number> {
  const meta = await getSyncMeta()
  return meta?.lastSyncTimestamp ?? 0
}

/** Update the last successful sync timestamp to now. */
export async function touchLastSyncTimestamp(): Promise<void> {
  const meta = (await getSyncMeta()) ?? {
    id: SYNC_META_KEY,
    deviceId: uuidv4(),
    lastSyncSeq: 0,
    lastSyncTimestamp: 0
  }
  meta.lastSyncTimestamp = Date.now()
  await setSyncMeta(meta)
}

/** Full reset of sync metadata (dangerous — only for testing / manual reset). */
export async function resetSyncMeta(): Promise<void> {
  await db.settings.delete(SYNC_META_KEY)
  logger.warn('Sync metadata has been reset')
}
