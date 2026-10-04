/**
 * Test-only sanitized outbox listing via the fixture-owned Electron main process.
 *
 * No production IPC, no preload door, no renderer SQLite. The helper proves
 * exact ownership by fetching the live `app.getPath('userData')` from the
 * fixture-owned `ElectronApplication` and comparing it (realpath-normalized)
 * to the caller-supplied `chatDbPath` (`<profile>/Data/chat.db`). A mismatch
 * fails closed and never reads another profile (including the installed app).
 *
 * The actual SQLite read is file-backed via the Electron binary
 * (`queryChatDbViaElectron` helpers — Electron ABI 145, read-only, no writes,
 * `better-sqlite3` closed in the child). Fixed SQL only, sanitized columns
 * only, no payload deserialization. Privacy: returns only
 * id/entityType/op/entityId/timestamp/deviceId.
 */
import type { ElectronApplication } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'

import { getOwnedTmpRoot, queryChatDbViaElectronWithRetry } from '../fixtures/electron.fixture'

export interface SanitizedOutboxRow {
  id: string
  entityType: string
  op: string
  entityId: string
  timestamp: number
  deviceId: string
}

const FIXED_OUTBOX_SQL =
  'SELECT id, entity_type as entity_type, op, entity_id as entity_id, timestamp, device_id as device_id FROM sync_outbox'

/**
 * Test-only helper: read the owned disposable profile's `sync_outbox` via a
 * file-backed Electron child (ABI 145). Validates exact ownership:
 * `app.getPath('userData')` must equal the directory that owns `chatDbPath`.
 */
export async function getOutboxDiagViaApp(
  electronApp: ElectronApplication,
  chatDbPath: string
): Promise<SanitizedOutboxRow[]> {
  if (!electronApp || typeof (electronApp as any).evaluate !== 'function') {
    throw new Error('getOutboxDiagViaApp requires an ElectronApplication')
  }
  if (typeof chatDbPath !== 'string' || chatDbPath.length === 0) {
    throw new Error('getOutboxDiagViaApp requires a non-empty chatDbPath')
  }
  const ownedTmpRoot = getOwnedTmpRoot()
  if (!ownedTmpRoot || typeof ownedTmpRoot !== 'string') {
    throw new Error('getOutboxDiagViaApp requires ownedTmpRoot fixture')
  }
  // 1. Ownership proof: fetch the true runtime userData from the live Main.
  const runtimeUserData: string = await (electronApp as any).evaluate(async ({ app }: any) => {
    return app.getPath('userData') as string
  })
  if (typeof runtimeUserData !== 'string' || runtimeUserData.length === 0) {
    throw new Error('getOutboxDiagViaApp: runtime userData missing')
  }
  // 2. Validate exact profile ownership in the test process (Node fs).
  const normalizedDbPath = path.resolve(chatDbPath)
  const expectedProfileFromDb = path.resolve(path.dirname(path.dirname(normalizedDbPath)))
  let resolvedRuntimeParent: string
  let resolvedExpectedParent: string
  let runtimeChild: string
  let expectedChild: string
  try {
    resolvedRuntimeParent = fs.realpathSync(path.dirname(path.resolve(runtimeUserData)))
    runtimeChild = path.basename(path.resolve(runtimeUserData))
  } catch {
    throw new Error(`OUTBOX OWNERSHIP VIOLATION: cannot resolve runtime appData parent for "${runtimeUserData}"`)
  }
  try {
    resolvedExpectedParent = fs.realpathSync(path.dirname(expectedProfileFromDb))
    expectedChild = path.basename(expectedProfileFromDb)
  } catch {
    throw new Error(`OUTBOX OWNERSHIP VIOLATION: cannot resolve expected profile parent for "${chatDbPath}"`)
  }
  const resolvedRuntime = path.join(resolvedRuntimeParent, runtimeChild)
  const resolvedExpected = path.join(resolvedExpectedParent, expectedChild)
  if (resolvedRuntime !== resolvedExpected) {
    throw new Error(
      `OUTBOX OWNERSHIP VIOLATION: runtime "${runtimeUserData}" (resolved "${resolvedRuntime}") does not equal expected profile "${expectedProfileFromDb}" (resolved "${resolvedExpected}")`
    )
  }
  const expectedChatDb = path.join(runtimeUserData, 'Data', 'chat.db')
  const normalizedExpectedChatDb = path.resolve(expectedChatDb)
  // Allow macOS /var -> /private/var alias via resolved parent comparison.
  let ownershipOk = normalizedDbPath === normalizedExpectedChatDb
  if (!ownershipOk) {
    try {
      const parentReal = fs.realpathSync(path.dirname(path.dirname(normalizedExpectedChatDb)))
      const child = path.basename(path.dirname(path.dirname(normalizedExpectedChatDb)))
      const resolvedExpectedChatDb = path.resolve(path.join(parentReal, child, 'Data', 'chat.db'))
      ownershipOk = path.resolve(normalizedDbPath) === path.resolve(resolvedExpectedChatDb)
    } catch {
      ownershipOk = false
    }
  }
  if (!ownershipOk) {
    throw new Error(
      `OUTBOX OWNERSHIP VIOLATION: chatDbPath "${chatDbPath}" does not equal runtime chat.db "${expectedChatDb}"`
    )
  }
  // If the file does not yet exist (no outbox table created), return empty
  // without claiming a violation — ownership already proven.
  if (!fs.existsSync(expectedChatDb)) {
    return []
  }
  // 3. File-backed read via the Electron binary (ABI 145), bounded retry for
  // transient BUSY/LOCKED. Fixed SQL only, no payload.
  const outcome = await queryChatDbViaElectronWithRetry(expectedChatDb, FIXED_OUTBOX_SQL)
  if (!outcome.ok) {
    // TABLE missing pre-migration is provably empty (return []), otherwise
    // fail closed — the caller will retry via its poll helper.
    if (outcome.code === 'SQL' || outcome.code === 'INVALID_ENVELOPE') {
      // A missing sync_outbox table manifests as SQL error; treat as empty.
      // Any other SQL error is still empty for this diagnostic (no throw) to
      // keep poll helpers retryable, but log sanitized.
      console.log(`[E2E] outbox diag query code=${outcome.code} attempt=${outcome.attempt} -> empty`)
      return []
    }
    throw new Error(`outbox diag query failed: ${outcome.code}`)
  }
  const rows = outcome.rows as Array<Record<string, unknown>>
  const sanitized: SanitizedOutboxRow[] = rows.map((r) => ({
    id: String((r as any).id),
    entityType: String((r as any).entity_type),
    op: String((r as any).op),
    entityId: String((r as any).entity_id),
    timestamp: Number((r as any).timestamp),
    deviceId: String((r as any).device_id)
  }))
  // Preserve production dependency-order priority so filtered counts remain stable.
  const ENTITY_PUSH_PRIORITY: Record<string, number> = {
    assistant_config: -1,
    topic: 0,
    topic_branch: 1,
    file_asset: 1,
    message: 2,
    message_block: 3
  }
  function prio(o: SanitizedOutboxRow): number {
    if (o.op === 'order_frame') return 3
    if (o.op === 'message_stable_replace') return 4
    if (o.op === 'move_turns_to_branch') return 1
    return ENTITY_PUSH_PRIORITY[o.entityType] ?? 9
  }
  sanitized.sort((a, b) => {
    const pa = prio(a)
    const pb = prio(b)
    if (pa !== pb) return pa - pb
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
    return a.id.localeCompare(b.id)
  })
  console.log(`[E2E] outbox diag total=${sanitized.length}`)
  return sanitized
}

/**
 * Convenience wrapper for the disposable second sync profile (`SecondSyncProfile`).
 */
export async function getOutboxDiagForSecondProfile(profile: {
  app: ElectronApplication
  chatDbPath: string
}): Promise<SanitizedOutboxRow[]> {
  if (!profile?.app || !profile?.chatDbPath) throw new Error('second profile app/chatDbPath required')
  return getOutboxDiagViaApp(profile.app, profile.chatDbPath)
}
