import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as schema from '../../../chatDb/schema'

export const SYNC_TEST_DEVICE_CODE = 'ABCD2345'
export const SYNC_TEST_DEVICE_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
export const SYNC_TEST_PAIRING_GENERATION = 'cc-1'

export interface SyncTestRegistrationOptions {
  deviceCode?: string
  deviceSecret?: string
  explicitDisconnect?: boolean
  pairingGeneration?: string
}

/**
 * Seed a coherent cc-1 registration for Main sync tests.
 *
 * MUST be called strictly after `syncService.clearAllForTests()` (which wipes
 * registration state). Writes a legal device code, a 64hex secret,
 * explicitDisconnect=false, and upserts `sync:pairingGeneration=cc-1`.
 * Uses only public config keys and `sync_state`; never touches production
 * private internals.
 */
export function seedRegisteredAttachedSyncService(
  configStore: Map<string, unknown>,
  db: BetterSQLite3Database<typeof schema>,
  opts: SyncTestRegistrationOptions = {}
): { deviceCode: string; deviceSecret: string } {
  const deviceCode = opts.deviceCode ?? SYNC_TEST_DEVICE_CODE
  const deviceSecret = opts.deviceSecret ?? SYNC_TEST_DEVICE_SECRET
  const explicitDisconnect = opts.explicitDisconnect ?? false
  const pairingGeneration = opts.pairingGeneration ?? SYNC_TEST_PAIRING_GENERATION
  configStore.set('sync:deviceCode', deviceCode)
  configStore.set('sync:deviceAuth', deviceSecret)
  configStore.set('sync:explicitDisconnect', explicitDisconnect)
  db.insert(schema.syncState)
    .values({ key: 'sync:pairingGeneration', value: pairingGeneration })
    .onConflictDoUpdate({ target: schema.syncState.key, set: { value: pairingGeneration } })
    .run()
  return { deviceCode, deviceSecret }
}
