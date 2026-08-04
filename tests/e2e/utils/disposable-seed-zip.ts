/**
 * Disposable Chromium IndexedDB + Local Storage seed ZIP generator for the L2
 * Cherry Studio import E2E (LOCK-621/623/624 + LOCK-E1..E5).
 *
 * Produces a REPRODUCIBLY generated disposable source ZIP containing only the
 * `IndexedDB/` tree and the `Local Storage/leveldb/` tree of a Chromium
 * profile whose `CherryStudio` IndexedDB was created by the real app +
 * production Dexie (native version 110, v11 schema) and whose file-origin
 * Local Storage carries the deterministic `persist:cherry-studio` navigation
 * projection (LOCK-E3) in the REAL redux-persist wire representation
 * (LOCK-FF1: each persisted slice value is a JSON string, exactly as
 * `createPersistoid` writes it).
 *
 * Accuracy rules:
 * - The ZIP is explicitly a synthetic disposable seed, NEVER a historical user
 *   backup. Every artifact carries a unique disposable token.
 * - The seed profile is launched with a unique `--user-data-dir` under the OS
 *   temp dir, is closed/flushed before zipping, and is removed afterwards.
 * - Only the `IndexedDB/` + `Local Storage/leveldb/` subtrees are zipped (the
 *   exact trees the isolated reader opens via `session.fromPath`); no `Data/`
 *   blobs and no other roots enter the container (LOCK-E2).
 *
 * IndexedDB LevelDB flush (Layer 4 `.ldb` requirement of the production zip
 * intake):
 * - A tiny IndexedDB never writes `.ldb` table files (the memtable stays in
 *   the WAL `*.log`). To be a genuine, intake-compatible profile the seed
 *   writes padding records into the import-IGNORED `settings` store (the
 *   import only pages topics/message_blocks/topic_segments/files), forcing the
 *   LevelDB memtable to flush into at least one `.ldb` file on close.
 *
 * Local Storage projection (LOCK-E3/E4):
 * - Written through the real Chromium renderer `localStorage` API under the
 *   exact file:// origin, so Chromium produces a genuine `Local Storage/leveldb`
 *   backing store. The app's redux-persist writer is paused (`persist/PAUSE`)
 *   and drained before the deterministic payload is written, so the seeded
 *   projection can never be overwritten by the app's own state; the read-back
 *   is verified in-renderer. Synthetic padding keys then push the Local
 *   Storage LevelDB memtable past the write-buffer limit so the persist key is
 *   durably materialized in a table (`.ldb`) file, and are removed before
 *   close (inert tombstones). App close flushes the backing store to disk
 *   before zipping.
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

// ---------------------------------------------------------------------------
// Local Storage projection constants (LOCK-E3/E4)
//
// Deterministic expected navigation metadata for the seeded
// `persist:cherry-studio` projection. Downstream projection E2E specs assert
// the post-import UI against these exact values; the focused unit test proves
// the payload shape is the version-215 redux-persist contract.
// ---------------------------------------------------------------------------

/** Exact redux-persist localStorage key (LOCK-PROD-2 reads precisely this). */
export const SEED_PERSIST_KEY = 'persist:cherry-studio'

/** redux-persist version written by production (src/renderer/src/store/index.ts). */
export const SEED_PERSIST_VERSION = 215

/** Chromium profile Local Storage root name (LOCK-E2 exact roots). */
export const SEED_LOCAL_STORAGE_ROOT = 'Local Storage'

/** Zipped Local Storage subtree (production intake selection prefix). */
export const SEED_LOCAL_STORAGE_LEVELDB_DIR = 'Local Storage/leveldb'

/**
 * Two source assistants in deterministic order (LOCK-E4). The FIRST assistant
 * owns the visible imported topic (t-e2e-1, the single IDB topic with the
 * historical message); the SECOND assistant owns the deleted-topic metadata
 * record (t-e2e-del-1). Assistant order in the array is the source order the
 * projection carries (order 0 / 1).
 */
export const PROJECTION_ASSISTANTS = {
  first: { id: 'a-e2e-1', name: 'Seed Assistant', emoji: '🤖' },
  second: { id: 'a-e2e-2', name: 'Second Assistant', emoji: '✨' }
} as const

/**
 * DELIBERATELY STALE inner `assistantId` on the visible topic (LOCK-E4): the
 * topic sits inside the a-e2e-1 container but its redundant inner assistantId
 * points at no fixture assistant. The pipeline owns grouping by the OUTER
 * container (LOCK-PROD-2); existing canonicalization unit tests
 * (`navigationProjection.test.ts`) consume exactly this mismatch safely.
 */
export const STALE_TOPIC_ASSISTANT_ID = 'a-e2e-stale'

/**
 * Topic metadata records in the seeded projection (LOCK-E3/E4).
 *
 * - `visible`: t-e2e-1 — EXACTLY the IDB topic id (SOURCE_IDS.topic); carries
 *   the name/timestamps/pinned/isNameManuallyEdited facts the post-import UI
 *   asserts. DeletedAt is null (active).
 * - `deleted`: t-e2e-del-1 — deleted-topic metadata (deletedAt set). It has NO
 *   IndexedDB row (the IDB row count is kept stable at one topic to avoid
 *   churning the genuine spec's candidate-ready counts), so the projection
 *   drops it as `ls-topic-missing-in-idb` (LOCK-PROD-3). Documented
 *   limitation: a deleted topic that SURVIVES into the projection would
 *   require a second IDB row; the fixture exposes the deleted facts here for
 *   the spec session to assert at the source-payload level.
 */
export const PROJECTION_TOPICS = {
  visible: {
    id: SOURCE_IDS.topic,
    assistantId: STALE_TOPIC_ASSISTANT_ID,
    name: 'Seed Topic',
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T01:00:00.000Z',
    deletedAt: null,
    pinned: true,
    isNameManuallyEdited: true
  },
  deleted: {
    id: 't-e2e-del-1',
    assistantId: PROJECTION_ASSISTANTS.second.id,
    name: 'Deleted Topic',
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T12:00:00.000Z',
    deletedAt: '2026-07-31T00:00:00.000Z',
    pinned: false,
    isNameManuallyEdited: false
  }
} as const

/**
 * Local Storage LevelDB flush padding (LOCK-E2/E3): the persist key is written
 * FIRST, then enough synthetic keys are appended to push the LevelDB memtable
 * past the 4 MiB write-buffer limit so a table (.ldb) file is written and the
 * persist key is durably materialized before the graceful-close flush. The
 * padding keys are removed before close so the disposable origin's Local
 * Storage holds only the minimal persist projection (removals are inert
 * tombstones). 4 MiB total stays well under the Chromium per-origin quota.
 */
const PAD_LS_KEYS = 8
const PAD_LS_VALUE_BYTES = 512 * 1024

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
  /** LOCK-E3: seeded redux-persist Local Storage key (exact persist:cherry-studio). */
  persistKey: string
  /** LOCK-E3: byte length of the seeded `persist:cherry-studio` payload. */
  persistPayloadLength: number
  /** LOCK-E3: whether the persist key read back byte-identical after seeding. */
  persistReadbackEqual: boolean
  /** LOCK-E3: redux-persist version parsed back from the seeded payload. */
  persistVersion: number | null
  /** LOCK-E3: assistant records present in the seeded payload. */
  projectionAssistantCount: number
  /** LOCK-E3: topic metadata records present in the seeded payload. */
  projectionTopicCount: number
  /** LOCK-E2: synthetic padding keys written to force the LS LevelDB flush. */
  localStoragePaddingCount: number
  /** Number of LevelDB table files (.ldb) under Local Storage/leveldb after close. */
  localStorageLdbFileCount: number
  /** Whether the produced ZIP contains the Local Storage/leveldb subtree. */
  zipHasLocalStorage: boolean
  /** Number of Local Storage/leveldb file entries in the produced ZIP. */
  zipLocalStorageEntryCount: number
  /** Local Storage/leveldb entry names from the produced ZIP (pre-flight sample). */
  zipLocalStorageEntriesSample: string[]
  /**
   * True when EVERY non-directory ZIP entry lives under exactly
   * `IndexedDB/<file origin>/` or `Local Storage/leveldb/` — no unrelated
   * roots (Data/, chat.db, other origins) enter the container (LOCK-E2).
   */
  zipAllEntriesUnderAllowedRoots: boolean
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
// Local Storage projection (LOCK-E3/E4)
//
// The seed page also writes the version-215 redux-persist
// `persist:cherry-studio` payload through the REAL Chromium renderer
// localStorage API under the exact file:// origin, so Chromium materializes a
// genuine `Local Storage/leveldb` backing store. The payload carries the REAL
// redux-persist wire representation (LOCK-FF1): an outer JSON object whose
// `_persist` and `assistants` values are each the JSON string of that slice's
// state — exactly what `createPersistoid` writes with the default serializer
// (verified against the installed redux-persist@6.0.0 createPersistoid). The
// decoded synthetic nested-object shape would be a false-positive fixture.
// Only synthetic minimal navigation metadata is included — never assistant
// behavior configuration (LOCK-PROD-2).
// ---------------------------------------------------------------------------

/**
 * Tiny local mirror of redux-persist's default serializer
 * (`createPersistoid` `defaultSerialize` = `JSON.stringify`, verified against
 * the installed redux-persist@6.0.0 implementation). Deliberately duplicated
 * into the dev-origin builder too — no renderer store is ever imported, and
 * sharing across builders would require editing a third file (LOCK-FF1 scope).
 */
function serializePersistSlice(slice: unknown): string {
  return JSON.stringify(slice)
}

/**
 * Serialize a staged slice map to the exact redux-persist wire value: every
 * persisted slice (including `_persist`) is JSON-stringified individually,
 * then the whole staged map is JSON-stringified — byte-identical to what
 * `createPersistoid.writeStagedState` writes to localStorage (LOCK-FF1).
 */
function serializePersistWire(staged: Record<string, unknown>): string {
  const encoded: Record<string, string> = {}
  for (const [key, slice] of Object.entries(staged)) {
    encoded[key] = serializePersistSlice(slice)
  }
  return JSON.stringify(encoded)
}

/**
 * Decode a raw redux-persist wire value back into its slice map: outer JSON
 * parse, then an inner JSON parse of each string-valued slice (LOCK-FF1).
 * Exported for the focused tests to assert the raw wire representation
 * round-trips to the expected structures. Throws on malformed input.
 */
export function parsePersistWireValue(raw: string): Record<string, unknown> {
  const root = JSON.parse(raw) as Record<string, unknown>
  const decoded: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(root)) {
    decoded[key] = typeof value === 'string' ? (JSON.parse(value) as unknown) : value
  }
  return decoded
}

/**
 * Build the deterministic version-215 `persist:cherry-studio` payload in the
 * REAL redux-persist wire representation (LOCK-FF1). Two assistant records in
 * source order; the first carries the visible topic t-e2e-1 (EXACTLY the IDB
 * topic id) with a DELIBERATELY STALE inner `assistantId` (LOCK-E4 — the
 * outer container owns grouping, LOCK-PROD-2), and the second carries the
 * deleted-topic metadata record (t-e2e-del-1, deletedAt set, LS-only).
 * Topic/assistant order are positional in production. Deterministic:
 * byte-identical on every call.
 *
 * Exported so downstream projection E2E specs can assert the isolated
 * renderer's raw read is byte-identical to what the seed produced, and so the
 * focused unit test can verify the exact wire shape.
 */
export function buildSeedPersistedState(): string {
  return serializePersistWire({
    _persist: { version: SEED_PERSIST_VERSION, rehydrated: true },
    assistants: {
      defaultAssistant: {},
      assistants: [
        {
          id: PROJECTION_ASSISTANTS.first.id,
          name: PROJECTION_ASSISTANTS.first.name,
          emoji: PROJECTION_ASSISTANTS.first.emoji,
          prompt: '',
          type: 'assistant',
          topics: [{ ...PROJECTION_TOPICS.visible, messages: [] }]
        },
        {
          id: PROJECTION_ASSISTANTS.second.id,
          name: PROJECTION_ASSISTANTS.second.name,
          emoji: PROJECTION_ASSISTANTS.second.emoji,
          prompt: '',
          type: 'assistant',
          topics: [{ ...PROJECTION_TOPICS.deleted, messages: [] }]
        }
      ],
      tagsOrder: [],
      collapsedTags: {},
      presets: [],
      unifiedListOrder: []
    }
  })
}

/** Evidence returned by {@link seedLocalStorageProjection} (cross-process safe JSON). */
export interface LocalStorageSeedResult {
  /** Exact redux-persist key written. */
  persistKey: string
  /** Byte length of the seeded payload string. */
  persistPayloadLength: number
  /** Whether the persist key read back byte-identical after seeding. */
  persistReadbackEqual: boolean
  /** redux-persist version parsed back from the read-back payload. */
  persistVersion: number | null
  /** Assistant records present in the read-back payload. */
  assistantCount: number
  /** Topic metadata records present in the read-back payload. */
  topicCount: number
  /** Padding keys actually written (may degrade on quota exhaustion). */
  paddingCount: number
}

/**
 * Seed Local Storage for the file origin inside the seed app renderer
 * (LOCK-E3/E4):
 *   0. Pause the app's own redux-persist writer (`persist/PAUSE`) and drain
 *      any already-scheduled write. The seed app IS the real Cherry app whose
 *      redux-persist also writes `persist:cherry-studio`; while paused the
 *      persistoid never queues further keys, so the deterministic payload can
 *      never be overwritten by the app's own state before close.
 *   1. Write the exact `persist:cherry-studio` key.
 *   2. Pad the LevelDB memtable past the write-buffer limit so a table (.ldb)
 *      file durably holds the persist key (LOCK-E2 flush).
 *   3. Read the persist key back and assert byte-identical round-trip.
 *   4. Remove the padding keys so the disposable origin's Local Storage
 *      contains only the minimal projection (tombstones are inert).
 *
 * Graceful app close afterwards flushes Local Storage LevelDB to disk.
 */
async function seedLocalStorageProjection(page: Page): Promise<LocalStorageSeedResult> {
  const payload = buildSeedPersistedState()
  return page.evaluate(
    async ({ persistKey, payload, padCount, padBytes }) => {
      // Step 0: halt the app's own redux-persist writer and drain any write
      // already scheduled before the pause (LOCK-E3: the seeded payload must
      // be the LAST value written for this key).
      ;(window as { store?: { dispatch?: (action: { type: string }) => void } }).store?.dispatch?.({
        type: 'persist/PAUSE'
      })
      await new Promise((resolve) => setTimeout(resolve, 300))

      // Step 1: exact persist key (LOCK-PROD-2 reads precisely this key).
      localStorage.setItem(persistKey, payload)

      // Step 2: force the LevelDB memtable past the write-buffer limit so a
      // table (.ldb) file is written while the persist key is still the most
      // recent write. On quota exhaustion we degrade gracefully — the
      // graceful-close flush still durably commits the WAL.
      const padValue = 'x'.repeat(padBytes)
      let paddingCount = 0
      try {
        for (let i = 0; i < padCount; i++) {
          localStorage.setItem(`__cherry_e2e_pad_${String(i).padStart(4, '0')}`, `${i}:${padValue}`)
          paddingCount++
        }
      } catch {
        // QuotaExceededError or similar — stop padding, keep going.
      }

      // Step 3: byte-identical readback of the exact key.
      const readback = localStorage.getItem(persistKey)
      const persistReadbackEqual = readback === payload

      let persistVersion: number | null = null
      let assistantCount = 0
      let topicCount = 0
      if (persistReadbackEqual && readback !== null) {
        try {
          // LOCK-FF1: the REAL redux-persist wire representation — the outer
          // value JSON-stringifies each persisted slice (including
          // `_persist`), so both `_persist` and `assistants` parse to strings
          // that must be JSON-parsed again to reach the expected metadata.
          const parsed = JSON.parse(readback) as { _persist?: unknown; assistants?: unknown }
          const persistMeta =
            typeof parsed._persist === 'string' ? (JSON.parse(parsed._persist) as { version?: unknown }) : null
          persistVersion = typeof persistMeta?.version === 'number' ? persistMeta.version : null
          const slice =
            typeof parsed.assistants === 'string' ? (JSON.parse(parsed.assistants) as { assistants?: unknown[] }) : null
          const list: unknown[] = Array.isArray(slice?.assistants) ? slice.assistants : []
          assistantCount = list.length
          topicCount = list.reduce<number>((count, assistant) => {
            const topics = (assistant as { topics?: unknown } | null)?.topics
            return count + (Array.isArray(topics) ? topics.length : 0)
          }, 0)
        } catch {
          // Malformed read-back leaves the parsed evidence null/zero.
        }
      }

      // Step 4: remove the padding keys (inert tombstones; the persist key
      // already lives in a table file and is never touched by removals).
      try {
        for (let i = 0; i < paddingCount; i++) {
          localStorage.removeItem(`__cherry_e2e_pad_${String(i).padStart(4, '0')}`)
        }
      } catch {
        // Removal failure is inert — padding keys are never read by import.
      }

      return {
        persistKey,
        persistPayloadLength: payload.length,
        persistReadbackEqual,
        persistVersion,
        assistantCount,
        topicCount,
        paddingCount
      }
    },
    { persistKey: SEED_PERSIST_KEY, payload, padCount: PAD_LS_KEYS, padBytes: PAD_LS_VALUE_BYTES }
  )
}

// ---------------------------------------------------------------------------
// ZIP production + pre-flight
// ---------------------------------------------------------------------------

export interface ProduceSeedZipResult {
  /** Origin directory name observed under IndexedDB/. */
  originDir: string
  /** Number of LevelDB table files (.ldb) present after close (on disk). */
  ldbFileCount: number
  /** Number of LevelDB table files (.ldb) under Local Storage/leveldb after close. */
  localStorageLdbFileCount: number
}

/**
 * Produce the disposable source ZIP from the closed/flushed seed profile.
 * Materializes EXACTLY two Chromium subtrees (LOCK-E2 selective-extraction
 * contract):
 *   - `IndexedDB/file__0.indexeddb.leveldb/`   (file origin, .ldb required)
 *   - `Local Storage/leveldb/`                  (projection data; valid CURRENT)
 * Nothing else in the profile (Data/, GPUCache, Session Storage, other
 * origins) enters the ZIP.
 *
 * Exported for the focused unit test, which drives it against synthetic
 * profile directories (no Electron needed).
 */
export function produceSeedZip(profileDevDir: string, zipPath: string): ProduceSeedZipResult {
  const idbDir = path.join(profileDevDir, 'IndexedDB')
  const originDir = path.join(idbDir, SEED_ORIGIN_DIR)
  const localStorageLeveldbDir = path.join(profileDevDir, SEED_LOCAL_STORAGE_LEVELDB_DIR)

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

  // LOCK-E3: the seeded Local Storage LevelDB must exist with a valid
  // `CURRENT` marker (LevelDB openability). The persist key was written
  // inside the seed page, so absence means the write never committed.
  if (!fs.existsSync(localStorageLeveldbDir)) {
    throw new Error(
      `Seed Local Storage leveldb directory "${localStorageLeveldbDir}" does not exist — ` +
        `the ${SEED_PERSIST_KEY} projection was seeded but Chromium did not materialize ` +
        `Local Storage. Profile Local Storage parent: ` +
        `${fs.existsSync(path.join(profileDevDir, 'Local Storage')) ? 'exists' : 'absent'}`
    )
  }
  const lsFiles = fs.readdirSync(localStorageLeveldbDir)
  if (!lsFiles.includes('CURRENT')) {
    throw new Error(
      `Seed Local Storage leveldb at ${localStorageLeveldbDir} has no CURRENT marker ` +
        `(invalid LevelDB): ${lsFiles.join(', ') || '(empty)'}`
    )
  }
  const localStorageLdbFileCount = lsFiles.filter((f) => f.endsWith('.ldb')).length

  const zip = new AdmZip()
  zip.addLocalFolder(idbDir, 'IndexedDB')
  zip.addLocalFolder(localStorageLeveldbDir, SEED_LOCAL_STORAGE_LEVELDB_DIR)
  zip.writeZip(zipPath)

  if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size === 0) {
    throw new Error(`Seed ZIP was not produced at ${zipPath}`)
  }
  return { originDir: SEED_ORIGIN_DIR, ldbFileCount, localStorageLdbFileCount }
}

interface ZipPreflightResult {
  entryCount: number
  allEntriesUnderOrigin: boolean
  ldbEntryCount: number
  sample: string[]
  localStorageEntryCount: number
  localStorageLdbEntryCount: number
  localStorageEntriesSample: string[]
  allEntriesUnderAllowedRoots: boolean
}

/**
 * Pre-flight the produced ZIP (LOCK-T4/LOCK-E2):
 * - EVERY `IndexedDB/` entry must live under the expected origin directory,
 *   and at least one `.ldb` table entry must exist inside that origin.
 * - The `Local Storage/leveldb/` subtree must be present with a `CURRENT`
 *   marker and at least one file entry (LOCK-E3).
 * - EVERY non-directory entry must live under exactly
 *   `IndexedDB/<origin>/` or `Local Storage/leveldb/` — no unrelated roots
 *   (Data/, chat.db, other origins) enter the container (LOCK-E2).
 * Throws on violation; the returned evidence is what the spec asserts.
 */
async function preflightZipEntries(zipPath: string, originDirName: string): Promise<ZipPreflightResult> {
  const zip = new StreamZip.async({ file: zipPath })
  try {
    const entries = await zip.entries()
    const names = Object.keys(entries)
    const originPrefix = `IndexedDB/${originDirName}/`
    const localStoragePrefix = `${SEED_LOCAL_STORAGE_LEVELDB_DIR}/`
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

    // LOCK-E3: Local Storage subtree must be present and LevelDB-valid.
    const localStorageEntries = names.filter((n) => n.startsWith(localStoragePrefix))
    if (localStorageEntries.length === 0) {
      throw new Error(
        `Seed ZIP has no Local Storage leveldb entries under ${localStoragePrefix} — ` +
          'production intake selects this subtree for the navigation projection'
      )
    }
    if (!localStorageEntries.some((n) => n === `${localStoragePrefix}CURRENT`)) {
      throw new Error(
        `Seed ZIP Local Storage leveldb has no CURRENT marker: ` +
          `${localStorageEntries.slice(0, 8).join(', ') || '(empty)'}`
      )
    }
    const localStorageLdbEntryCount = localStorageEntries.filter((n) => n.endsWith('.ldb')).length

    // LOCK-E2: no unrelated roots — every FILE entry must be inside one of
    // the two accepted subtrees (directory entries are structural, ignored
    // exactly like production's isDirectory skip).
    const fileEntries = names.filter((n) => !n.endsWith('/'))
    const outsideAllowedRoots = fileEntries.filter(
      (n) => !n.startsWith(originPrefix) && !n.startsWith(localStoragePrefix)
    )
    if (outsideAllowedRoots.length > 0) {
      throw new Error(
        `Seed ZIP has entries outside the allowed roots ` +
          `(${originPrefix} | ${localStoragePrefix}): ${outsideAllowedRoots.slice(0, 5).join(', ')}`
      )
    }

    return {
      entryCount: names.length,
      allEntriesUnderOrigin: indexedDbEntries.length > 0 && outsideOrigin.length === 0,
      ldbEntryCount,
      sample: names.slice(0, 12),
      localStorageEntryCount: localStorageEntries.length,
      localStorageLdbEntryCount,
      localStorageEntriesSample: localStorageEntries.slice(0, 8),
      allEntriesUnderAllowedRoots: fileEntries.length > 0 && outsideAllowedRoots.length === 0
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
 * (launch → seed IndexedDB + Local Storage projection → close/flush) and its
 * temp artifacts. On ANY failure the seed app is closed and the temp
 * profile/work dirs are removed before the error propagates. Callers MUST
 * call `cleanup()` on the returned handle; cleanup failures throw (LOCK-T1).
 *
 * LOCK-E2: ZIP carries exactly `IndexedDB/` + `Local Storage/leveldb/` — no
 * `Data/` blobs, no other roots.
 * LOCK-E3: Local Storage carries the deterministic version-215
 *          `persist:cherry-studio` navigation projection (two fixture
 *          assistants + topic metadata, including the deleted-topic record).
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

    // LOCK-E3: seed the version-215 redux-persist `persist:cherry-studio`
    // Local Storage navigation projection on the same file origin, then let
    // Chromium batch-commit Local Storage before the graceful close.
    const lsSeeded = await seedLocalStorageProjection(launched.page)
    await launched.page.waitForTimeout(1500)
    console.log(
      `[E2E] Local Storage projection seeded (key=${lsSeeded.persistKey}, ` +
        `payloadBytes=${lsSeeded.persistPayloadLength}, ` +
        `readbackEqual=${lsSeeded.persistReadbackEqual}, ` +
        `persistVersion=${lsSeeded.persistVersion}, ` +
        `assistants=${lsSeeded.assistantCount}, topics=${lsSeeded.topicCount}, ` +
        `padding=${lsSeeded.paddingCount})`
    )

    // Close the app cleanly (flushes IndexedDB + Local Storage LevelDB)
    // before inspecting/zipping.
    await closeSeedApp(launched.app, profileDir)
    await new Promise((resolve) => setTimeout(resolve, 1500))

    const { originDir, ldbFileCount, localStorageLdbFileCount } = produceSeedZip(profileDevDir, zipPath)
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
        zipEntriesSample: preflight.sample,
        persistKey: lsSeeded.persistKey,
        persistPayloadLength: lsSeeded.persistPayloadLength,
        persistReadbackEqual: lsSeeded.persistReadbackEqual,
        persistVersion: lsSeeded.persistVersion,
        projectionAssistantCount: lsSeeded.assistantCount,
        projectionTopicCount: lsSeeded.topicCount,
        localStoragePaddingCount: lsSeeded.paddingCount,
        localStorageLdbFileCount,
        zipHasLocalStorage: preflight.localStorageEntryCount > 0,
        zipLocalStorageEntryCount: preflight.localStorageEntryCount,
        zipLocalStorageEntriesSample: preflight.localStorageEntriesSample,
        zipAllEntriesUnderAllowedRoots: preflight.allEntriesUnderAllowedRoots
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
