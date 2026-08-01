/**
 * Disposable Chromium IndexedDB seed ZIP generator for the L2 Cherry Studio
 * import E2E (LOCK-621/623/624).
 *
 * Produces a REPRODUCIBLY generated disposable source ZIP containing only the
 * `IndexedDB/` tree of a Chromium profile whose `CherryStudio` IndexedDB was
 * created by the real app + production Dexie (native version 110, v11 schema).
 *
 * Accuracy rules:
 * - The ZIP is explicitly a synthetic disposable seed, NEVER a historical user
 *   backup. Every artifact carries a unique disposable token.
 * - The seed profile is launched with a unique `--user-data-dir` under the OS
 *   temp dir, is closed/flushed before zipping, and is removed afterwards.
 * - Only the `IndexedDB/` subtree is zipped (the exact tree the isolated
 *   reader opens via `session.fromPath`).
 *
 * LevelDB flush (Layer 4 `.ldb` requirement of the production zip intake):
 * - A tiny IndexedDB never writes `.ldb` table files (the memtable stays in
 *   the WAL `*.log`). To be a genuine, intake-compatible profile the seed
 *   writes padding records into the import-IGNORED `settings` store (the
 *   import only pages topics/message_blocks/topic_segments/files), forcing the
 *   LevelDB memtable to flush into at least one `.ldb` file on close.
 */
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import AdmZip from 'adm-zip'
import * as fs from 'fs'
import * as path from 'path'
import StreamZip from 'node-stream-zip'

import { closeElectronWithExactCleanup } from './electron-cleanup'
import { registerProfileLaunchToken, unregisterProfileLaunchToken } from '../fixtures/electron.fixture'
import { terminateProcessesByUserDataDir } from './process-cleanup'
import { removeOwnedSeedArtifacts, validateProfileLaunchToken } from './run-ownership'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SEED_DB_NAME = 'CherryStudio'
/** Dexie logical v11 × 10 (production schema, native IndexedDB version). */
export const SEED_NATIVE_VERSION = 110
/** Observed file:// origin mapping (Phase 4.0 spike + E2E experiment). */
export const SEED_ORIGIN_DIR = 'file__0.indexeddb.leveldb'
/** Production Dexie v11 table names required for discovery. */
export const SEED_REQUIRED_STORES = ['topics', 'message_blocks', 'topic_segments', 'files'] as const

/**
 * Required source IDs the seed must contain (LOCK scope). The import pipeline
 * persists topics/messages/message_blocks/topic_segments to the target DB;
 * `files` is count-diagnostic only (LOCK-D7) and stays source-side evidence.
 */
export const SOURCE_IDS = {
  topic: 't-e2e-1',
  message: 'm-e2e-1',
  block: 'b-e2e-1',
  segment: 's-e2e-1',
  file: 'f-e2e-1'
} as const

/** Padding records in the import-ignored `settings` store (LevelDB flush). */
const PAD_SETTINGS_COUNT = 700
const PAD_SETTINGS_VALUE_BYTES = 12_000

const PROFILE_PREFIX = 'cherry-e2e-seed-'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SeedZipEvidence {
  /** Native IndexedDB version observed on the seed profile. */
  nativeVersion: number
  /** All object store names present (Dexie v11 schema). */
  stores: string[]
  /** Records inserted per store during seeding. */
  inserted: Array<{ store: string; id: string }>
  /** Keys read back per store after insertion (write-back verification). */
  verifiedKeys: Record<string, string[]>
  /** Message IDs embedded in the source topic record (m-e2e-1). */
  embeddedMessageIds: string[]
  /** Padding records written to the import-ignored settings store. */
  settingsRecordCount: number
  /** Origin directory name observed under IndexedDB/. */
  originDir: string
  /** Number of LevelDB table files (.ldb) present after close (on disk). */
  ldbFileCount: number
  /** Total entry count in the produced ZIP (pre-flight). */
  zipEntryCount: number
  /** True when EVERY IndexedDB/ ZIP entry lives under the expected origin. */
  zipAllEntriesUnderOrigin: boolean
  /** Number of .ldb table entries inside the expected origin in the ZIP. */
  zipLdbEntryCount: number
  /** Entry names listed from the produced ZIP (pre-flight sample). */
  zipEntriesSample: string[]
}

export interface DisposableSeedZip {
  /** Absolute path to the produced ZIP (contains IndexedDB/...). */
  zipPath: string
  /** Disposable `--user-data-dir` root for the seed profile. */
  profileDir: string
  /** Dev-suffixed app data dir (holds the Chromium IndexedDB tree). */
  profileDevDir: string
  /** Temp work directory owning the profile and ZIP. */
  workDir: string
  evidence: SeedZipEvidence
  /** Remove the disposable profile + ZIP/work dirs. Idempotent; throws on
   *  unresolved owned resources (LOCK-T1 — cleanup failure is a test failure). */
  cleanup(): Promise<void>
}

// ---------------------------------------------------------------------------
// Seed profile launch
// ---------------------------------------------------------------------------

async function launchSeedApp(
  profileDir: string,
  ownedTmpRoot: string
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${profileDir}`, '--no-sandbox', '--disable-gpu'],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      ELECTRON_RUN_AS_NODE: '',
      TMPDIR: ownedTmpRoot,
      TMP: ownedTmpRoot,
      TEMP: ownedTmpRoot
    },
    timeout: 120000
  })
  const page = await app.waitForEvent('window', {
    predicate: async (win) => {
      try {
        return (await win.title()).includes('Cherry')
      } catch {
        return false
      }
    },
    timeout: 120000
  })
  await page.waitForSelector('#root', { state: 'attached', timeout: 60000 })
  await page.waitForFunction(() => typeof (window as any).store !== 'undefined', { timeout: 30000 })
  return { app, page }
}

/**
 * LOCK-F2: close the seed app, falling back to PRECISE exact-token
 * termination of its disposable profile process when `close()` fails. The
 * handle is captured at launch, so it is never lost. Owned artifacts are only
 * ever deleted after the app is closed or its exact `--user-data-dir` process
 * is verified gone; any failure to reach that state propagates.
 */
async function closeSeedApp(app: ElectronApplication | null, profileDir: string): Promise<void> {
  return closeElectronWithExactCleanup(profileDir, {
    close: () => (app ? app.close() : Promise.resolve()),
    terminateExactProcesses: (profile) =>
      terminateProcessesByUserDataDir(profile, null, { termGraceMs: 5000, settleMs: 2000, verifyMs: 3000 })
  })
}

// ---------------------------------------------------------------------------
// Seeding (runs inside the seed app renderer)
// ---------------------------------------------------------------------------

interface SeedEvaluateResult {
  nativeVersion: number
  stores: string[]
  inserted: Array<{ store: string; id: string }>
  verifiedKeys: Record<string, string[]>
  embeddedMessageIds: string[]
  settingsRecordCount: number
}

async function seedIndexedDb(page: Page): Promise<SeedEvaluateResult> {
  return page.evaluate(
    async ({ dbName, targetVersion, padCount, padBytes, ids }) => {
      const waitForDb = async (target: number, timeoutMs: number): Promise<{ version: number }> => {
        const start = Date.now()
        for (;;) {
          const dbs = await indexedDB.databases()
          const cherry = dbs.find((d) => d.name === dbName)
          if (cherry) {
            const version = cherry.version
            if (version === target) return { version }
            if (version !== undefined && version > target) {
              throw new Error(`Seed DB native version ${version} exceeds expected ${target}`)
            }
          }
          if (Date.now() - start > timeoutMs) {
            throw new Error(`Timed out waiting for ${dbName} at native version ${target}: ${JSON.stringify(dbs)}`)
          }
          await new Promise((r) => setTimeout(r, 200))
        }
      }

      const openDb = (): Promise<IDBDatabase> =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open(dbName)
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })

      const cherry = await waitForDb(targetVersion, 60000)
      const db = await openDb()
      try {
        const stores = Array.from(db.objectStoreNames).sort()
        for (const required of ['topics', 'message_blocks', 'topic_segments', 'files']) {
          if (!stores.includes(required)) {
            throw new Error(`Seed profile missing store "${required}" (has ${stores.join(', ')})`)
          }
        }

        const createdAt = '2026-07-31T00:00:00.000Z'
        const records: Record<string, Record<string, unknown>> = {
          topics: {
            id: ids.topic,
            messages: [
              {
                id: ids.message,
                role: 'user',
                status: 'success',
                content: 'Disposable seed message (synthetic, not a real user backup)',
                createdAt,
                topicId: ids.topic,
                blocks: [ids.block]
              }
            ],
            deletedAt: null
          },
          message_blocks: {
            id: ids.block,
            messageId: ids.message,
            type: 'text',
            status: 'success',
            content: 'Disposable seed block (synthetic, not a real user backup)',
            createdAt,
            updatedAt: null
          },
          topic_segments: {
            id: ids.segment,
            topicId: ids.topic,
            name: 'Seed Segment',
            messageIds: [ids.message],
            createdAt,
            updatedAt: createdAt
          },
          files: { id: ids.file, name: 'seed-file.txt', size: 0 }
        }

        // Padding into the import-ignored settings store: forces the LevelDB
        // memtable past the write-buffer limit so at least one .ldb is written.
        const padStr = 'x'.repeat(padBytes)
        const padTx = db.transaction(['settings'], 'readwrite')
        await new Promise<void>((resolve, reject) => {
          for (let i = 0; i < padCount; i++) {
            padTx
              .objectStore('settings')
              .add({ id: `pad-settings-${String(i).padStart(4, '0')}`, value: { i, blob: padStr } })
          }
          padTx.oncomplete = () => resolve()
          padTx.onerror = () => reject(padTx.error ?? new Error('padding transaction failed'))
          padTx.onabort = () => reject(padTx.error ?? new Error('padding transaction aborted'))
        })

        const tx = db.transaction(Object.keys(records), 'readwrite')
        const inserted: Array<{ store: string; id: string }> = []
        await new Promise<void>((resolve, reject) => {
          for (const [store, rec] of Object.entries(records)) {
            const req = tx.objectStore(store).add(rec)
            req.onsuccess = () => inserted.push({ store, id: rec.id as string })
            req.onerror = () => reject(req.error ?? new Error(`add to ${store} failed`))
          }
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error ?? new Error('seed transaction failed'))
          tx.onabort = () => reject(tx.error ?? new Error('seed transaction aborted'))
        })

        // Write-back verification: re-read primary keys per store.
        const verifiedKeys: Record<string, string[]> = {}
        for (const store of ['topics', 'message_blocks', 'topic_segments', 'files']) {
          verifiedKeys[store] = await new Promise<string[]>((resolve, reject) => {
            const req = tx.db.transaction(store, 'readonly').objectStore(store).getAllKeys()
            req.onsuccess = () => resolve(req.result as string[])
            req.onerror = () => reject(req.error ?? new Error(`readback of ${store} failed`))
          })
        }

        const settingsRecordCount = await new Promise<number>((resolve, reject) => {
          const req = tx.db.transaction('settings', 'readonly').objectStore('settings').count()
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error ?? new Error('settings count failed'))
        })

        // Extract embedded message ids from the source topic record (m-e2e-1).
        const topicRecord = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
          const req = tx.db.transaction('topics', 'readonly').objectStore('topics').get(ids.topic)
          req.onsuccess = () => resolve(req.result as Record<string, unknown> | undefined)
          req.onerror = () => reject(req.error ?? new Error('topics readback failed'))
        })
        const embeddedMessageIds = Array.isArray(topicRecord?.messages)
          ? (topicRecord!.messages as Array<{ id: string }>).map((m) => m.id)
          : []

        return {
          nativeVersion: cherry.version,
          stores,
          inserted,
          verifiedKeys,
          embeddedMessageIds,
          settingsRecordCount
        }
      } finally {
        db.close()
      }
    },
    {
      dbName: SEED_DB_NAME,
      targetVersion: SEED_NATIVE_VERSION,
      padCount: PAD_SETTINGS_COUNT,
      padBytes: PAD_SETTINGS_VALUE_BYTES,
      ids: SOURCE_IDS
    }
  )
}

// ---------------------------------------------------------------------------
// ZIP production + pre-flight
// ---------------------------------------------------------------------------

function produceIndexedDbZip(profileDevDir: string, zipPath: string): { originDir: string; ldbFileCount: number } {
  const idbDir = path.join(profileDevDir, 'IndexedDB')
  const originDir = path.join(idbDir, SEED_ORIGIN_DIR)

  let ldbFileCount = 0
  try {
    const files = fs.readdirSync(originDir)
    ldbFileCount = files.filter((f) => f.endsWith('.ldb')).length
  } catch {
    ldbFileCount = 0
  }
  if (ldbFileCount < 1) {
    throw new Error(
      `Seed IndexedDB has no .ldb files under ${originDir}; ` +
        'the LevelDB memtable never flushed (production intake Layer 4 would reject this ZIP)'
    )
  }

  const zip = new AdmZip()
  zip.addLocalFolder(idbDir, 'IndexedDB')
  zip.writeZip(zipPath)

  if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size === 0) {
    throw new Error(`Seed ZIP was not produced at ${zipPath}`)
  }
  return { originDir, ldbFileCount }
}

interface ZipPreflightResult {
  entryCount: number
  allEntriesUnderOrigin: boolean
  ldbEntryCount: number
  sample: string[]
}

/**
 * Pre-flight the produced ZIP (LOCK-T4): EVERY `IndexedDB/` entry must live
 * under the expected origin directory, and at least one `.ldb` table entry
 * must exist inside that origin (production intake Layer 4 requirement).
 * Throws on violation; the returned evidence is what the spec asserts.
 */
async function preflightZipEntries(zipPath: string, originDirName: string): Promise<ZipPreflightResult> {
  const zip = new StreamZip.async({ file: zipPath })
  try {
    const entries = await zip.entries()
    const names = Object.keys(entries)
    const originPrefix = `IndexedDB/${originDirName}/`
    const indexedDbEntries = names.filter((n) => n.startsWith('IndexedDB/'))
    const outsideOrigin = indexedDbEntries.filter((n) => !n.startsWith(originPrefix))
    if (outsideOrigin.length > 0) {
      throw new Error(
        `Seed ZIP has entries outside the expected origin: ` +
          `${outsideOrigin.slice(0, 5).join(', ')} (origin prefix: ${originPrefix})`
      )
    }
    const ldbEntryCount = indexedDbEntries.filter((n) => n.endsWith('.ldb')).length
    if (ldbEntryCount < 1) {
      throw new Error(
        `Seed ZIP has no .ldb table entry inside ${originPrefix} — ` + `production intake Layer 4 would reject this ZIP`
      )
    }
    return {
      entryCount: names.length,
      allEntriesUnderOrigin: indexedDbEntries.length > 0 && outsideOrigin.length === 0,
      ldbEntryCount,
      sample: names.slice(0, 12)
    }
  } finally {
    await zip.close()
  }
}

// ---------------------------------------------------------------------------
// Owned-artifact cleanup (LOCK-624/T1)
//
// removeOwnedSeedArtifacts comes from run-ownership: it removes only the exact
// dirs/ZIP this seed created and verifies absence, throwing on any leftover.
// ---------------------------------------------------------------------------

/**
 * Generate a disposable seed ZIP. Owns the seed Electron app lifecycle
 * (launch → seed → close/flush) and its temp artifacts. On ANY failure the
 * seed app is closed and the temp profile/work dirs are removed before the
 * error propagates. Callers MUST call `cleanup()` on the returned handle;
 * cleanup failures throw (LOCK-T1).
 */
export async function createDisposableSeedZip(ownedTmpRoot: string): Promise<DisposableSeedZip> {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  // Distinct directories: the work dir owns the produced ZIP, the profile dir
  // is the Electron --user-data-dir root (app data lands in <profileDir>Dev).
  const workDir = path.join(ownedTmpRoot, `${PROFILE_PREFIX}${unique}-work`)
  const profileDir = path.join(ownedTmpRoot, `${PROFILE_PREFIX}${unique}-profile`)
  const profileDevDir = profileDir + 'Dev'
  const zipPath = path.join(workDir, 'cherry-source-seed.zip')

  fs.mkdirSync(workDir, { recursive: true })
  fs.mkdirSync(profileDir, { recursive: true })
  validateProfileLaunchToken(ownedTmpRoot, profileDir)
  registerProfileLaunchToken(profileDir)

  try {
    const launched = await launchSeedApp(profileDir, ownedTmpRoot)
    const seeded = await seedIndexedDb(launched.page)

    // Close the app cleanly (flushes LevelDB) before inspecting/zipping.
    await closeSeedApp(launched.app, profileDir)
    await new Promise((resolve) => setTimeout(resolve, 1500))

    const { originDir, ldbFileCount } = produceIndexedDbZip(profileDevDir, zipPath)
    const preflight = await preflightZipEntries(zipPath, SEED_ORIGIN_DIR)

    return {
      zipPath,
      profileDir,
      profileDevDir,
      workDir,
      evidence: {
        nativeVersion: seeded.nativeVersion,
        stores: seeded.stores,
        inserted: seeded.inserted,
        verifiedKeys: seeded.verifiedKeys,
        embeddedMessageIds: seeded.embeddedMessageIds,
        settingsRecordCount: seeded.settingsRecordCount,
        originDir,
        ldbFileCount,
        zipEntryCount: preflight.entryCount,
        zipAllEntriesUnderOrigin: preflight.allEntriesUnderOrigin,
        zipLdbEntryCount: preflight.ldbEntryCount,
        zipEntriesSample: preflight.sample
      },
      cleanup: async () => {
        // Always close + exact-token terminate + final verify; only after
        // success remove nested seed artifacts and unregister the profile.
        await closeSeedApp(null, profileDir)
        await removeOwnedSeedArtifacts([workDir, profileDir, profileDevDir], zipPath)
        unregisterProfileLaunchToken(profileDir)
      }
    }
  } catch (error) {
    // LOCK-F2: never delete owned artifacts while the seed process may still
    // hold the disposable profile. Close the app — or precisely terminate its
    // exact-token process — BEFORE owned-artifact deletion. Close/terminate
    // and artifact-cleanup failures combine with, never mask, the original
    // error, and cleanup failure propagates.
    const cleanupErrors: string[] = []
    let cleaned = false
    try {
      await closeSeedApp(null, profileDir)
      cleaned = true
    } catch (err: any) {
      cleanupErrors.push(`seed app exact cleanup failed: ${err?.message ?? String(err)}`)
    }
    if (cleaned) {
      try {
        await removeOwnedSeedArtifacts([workDir, profileDir, profileDevDir], zipPath)
        unregisterProfileLaunchToken(profileDir)
      } catch (cleanupErr: any) {
        cleanupErrors.push(
          `owned artifact cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
        )
      }
    } else {
      cleanupErrors.push('owned seed artifacts preserved because exact-profile cleanup did not succeed')
    }
    if (cleanupErrors.length > 0) {
      const original = error instanceof Error ? error.message : String(error)
      throw new Error(`${original} (seed cleanup also failed: ${cleanupErrors.join('; ')})`)
    }
    throw error
  }
}
