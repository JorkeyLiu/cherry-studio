/**
 * Disposable Chromium dev-origin IndexedDB seed ZIP generator for the L2
 * Cherry Studio import E2E (LOCK-DEV-1..8).
 *
 * Produces a REPRODUCIBLY generated disposable source ZIP containing only
 * the `IndexedDB/` origin tree and the `Local Storage/leveldb/` subtree of
 * a Chromium profile whose `CherryStudio` IndexedDB and `persist:cherry-studio`
 * Local Storage were created under the EXACT origin `http://localhost:5173`.
 *
 * Chromium naturally maps this origin to the LevelDB directory name
 * `http_localhost_5173.indexeddb.leveldb` — no rename, no copy, no
 * file__0 transformation (LOCK-DEV-1/2). Local Storage is a single shared
 * per-profile LevelDB (`Local Storage/leveldb`); the seed profile only ever
 * loads the dev origin, so that LevelDB holds no unrelated-origin data.
 *
 * The seed:
 *   1. Starts a minimal HTTP server on port 5173 serving a blank page
 *      (listens without host binding for dual-stack IPv4/IPv6 safety).
 *   2. Creates a disposable Electron profile and launches a mini Electron
 *      app (NOT the full Cherry app) whose BrowserWindow loads from
 *      `http://localhost:5173`.
 *   3. The seed page CREATES the CherryStudio IndexedDB with the correct
 *      Dexie v11 schema (native version 110) via raw onupgradeneeded,
 *      then seeds realistic data and padding records.
 *   4. The same page seeds the version-215 redux-persist
 *      `persist:cherry-studio` Local Storage payload in the REAL wire
 *      representation (LOCK-FF1: each slice value is a JSON string, exactly
 *      as `createPersistoid` writes it; minimal synthetic
 *      one-assistant/one-topic navigation metadata) and pads the Local
 *      Storage commit path so the payload is durably written before the
 *      graceful close finalizes the LevelDB flush (LOCK-D2).
 *   5. Closes the app (flushes both LevelDBs to disk).
 *   6. Asserts the origin directory is EXACTLY
 *      `http_localhost_5173.indexeddb.leveldb` under `IndexedDB/`, and that
 *      `Local Storage/leveldb` exists with a valid `CURRENT` marker.
 *   7. Zips ONLY the `IndexedDB/<origin>/` and `Local Storage/leveldb/`
 *      subtrees WITHOUT rename/copy — no unrelated roots/origins enter.
 *
 * LOCK-DEV-1: Origin must be exact `http://localhost:5173`.
 * LOCK-DEV-2: Directory must be exact `http_localhost_5173.indexeddb.leveldb`.
 * LOCK-DEV-8: No file__0 rename/copy; the ZIP contains the natural Chromium
 *             directory structure.
 * LOCK-D2:    Local Storage projection is `persist:cherry-studio` with
 *             redux-persist version 215 and minimal assistants/topic metadata.
 *
 * Port ownership: fails immediately if port 5173 is occupied by an unowned
 * process (LOCK-DEV-7). No broad process killing.
 *
 * Cleanup: ownership-scoped; removes disposable profile, mini-app, work
 * dirs, and stops the HTTP server. Cleanup failure throws (LOCK-T1).
 */
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import AdmZip from 'adm-zip'
import * as fs from 'fs'
import * as http from 'http'
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
/**
 * LOCK-DEV-1/2: Exact Chromium directory name for http://localhost:5173.
 * Chromium maps the origin by replacing `:` with `_` and `/` with `_`,
 * then appending `.indexeddb.leveldb`.
 */
export const DEV_ORIGIN_DIR = 'http_localhost_5173.indexeddb.leveldb'
/**
 * LOCK-PROD-8: ZIP root of the Local Storage LevelDB subtree production
 * selectively extracts for the navigation projection. Local Storage is a
 * single shared per-profile LevelDB; the disposable seed profile only ever
 * loads the dev origin, so this LevelDB holds no unrelated-origin data.
 */
export const DEV_LOCAL_STORAGE_ROOT = 'Local Storage/leveldb'

/** Production Dexie v11 table names required for discovery. */
export const SEED_REQUIRED_STORES = ['topics', 'message_blocks', 'topic_segments', 'files'] as const

/**
 * Required source IDs the seed must contain (LOCK scope). The import pipeline
 * persists topics/messages/message_blocks/topic_segments to the target DB;
 * `files` is count-diagnostic only (LOCK-D7) and stays source-side evidence.
 */
export const SOURCE_IDS = {
  topic: 't-e2e-dev-1',
  message: 'm-e2e-dev-1',
  block: 'b-e2e-dev-1',
  segment: 's-e2e-dev-1',
  file: 'f-e2e-dev-1'
} as const

// ---------------------------------------------------------------------------
// Local Storage projection constants (LOCK-D2)
//
// Deterministic expected UI metadata for the seeded navigation projection.
// Downstream projection/in-process-reload E2E specs assert the post-import
// UI against these exact values.
// ---------------------------------------------------------------------------

/** Exact redux-persist localStorage key (LOCK-PROD-2). */
export const SEED_PERSIST_KEY = 'persist:cherry-studio'

/** redux-persist version written by production (src/renderer/src/store/index.ts). */
export const SEED_PERSIST_VERSION = 215

/** Synthetic assistant id for the one-assistant projection. */
export const DEV_ASSISTANT_ID = 'a-e2e-dev-1'

/** Expected UI display name of the seeded assistant. */
export const DEV_ASSISTANT_NAME = 'Dev Origin Seed Assistant'

/** Expected UI emoji of the seeded assistant. */
export const DEV_ASSISTANT_EMOJI = '🧪'

/** Seeded topic id — EXACTLY the existing dev IndexedDB topic id (LOCK-D1). */
export const DEV_TOPIC_ID = SOURCE_IDS.topic

/** Expected UI display name of the seeded topic. */
export const DEV_TOPIC_NAME = 'Dev Origin Seed Topic'

/** Expected UI created-at of the seeded topic (matches IDB seed timestamps). */
export const DEV_TOPIC_CREATED_AT = '2026-07-31T00:00:00.000Z'

/** Expected UI updated-at of the seeded topic. */
export const DEV_TOPIC_UPDATED_AT = DEV_TOPIC_CREATED_AT

/** Seeded topic order within its assistant (single-topic list → 0). */
export const DEV_TOPIC_ORDER = 0

/**
 * Deterministic expected UI navigation metadata of the seeded projection.
 * Grouped for downstream E2E assertion ergonomics.
 */
export const DEV_NAV_METADATA = {
  persistKey: SEED_PERSIST_KEY,
  persistVersion: SEED_PERSIST_VERSION,
  assistant: { id: DEV_ASSISTANT_ID, name: DEV_ASSISTANT_NAME, emoji: DEV_ASSISTANT_EMOJI },
  topic: {
    id: DEV_TOPIC_ID,
    name: DEV_TOPIC_NAME,
    createdAt: DEV_TOPIC_CREATED_AT,
    updatedAt: DEV_TOPIC_UPDATED_AT,
    deletedAt: null,
    pinned: false,
    isNameManuallyEdited: true,
    order: DEV_TOPIC_ORDER
  }
} as const

/** Padding records in the import-ignored `settings` store (LevelDB flush). */
const PAD_SETTINGS_COUNT = 700
const PAD_SETTINGS_VALUE_BYTES = 12_000

/**
 * Local Storage LevelDB flush padding (LOCK-D2): the persist key is written
 * FIRST, then enough synthetic keys are appended to force a real committed
 * write batch through Chromium's debounced Local Storage commit path (the
 * LevelDB WAL) before the graceful app close finalizes the flush to disk.
 * The padding keys are removed before close so the disposable origin's Local
 * Storage holds only the minimal persist projection (removals are inert
 * tombstones). 4 MiB total stays well under the Chromium per-origin Local
 * Storage quota. The persist key's durability is finalized by the graceful
 * close (LevelDB WAL + OS flush on process exit); the observed `.ldb` count
 * is diagnostic only — production reads this subtree through Chromium, which
 * replays the WAL.
 */
const PAD_LS_KEYS = 8
const PAD_LS_VALUE_BYTES = 512 * 1024

const PROFILE_PREFIX = 'cherry-e2e-dev-seed-'

/** Exact port for the dev-origin HTTP server (LOCK-DEV-1). */
const DEV_PORT = 5173

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DevOriginSeedZipEvidence {
  /** Native IndexedDB version observed on the seed profile. */
  nativeVersion: number
  /** All object store names present (Dexie v11 schema). */
  stores: string[]
  /** Records inserted per store during seeding. */
  inserted: Array<{ store: string; id: string }>
  /** Keys read back per store after insertion (write-back verification). */
  verifiedKeys: Record<string, string[]>
  /** Message IDs embedded in the source topic record. */
  embeddedMessageIds: string[]
  /** Padding records written to the import-ignored settings store. */
  settingsRecordCount: number
  /**
   * LOCK-DEV-2: Origin directory name observed under IndexedDB/.
   * Must be EXACTLY `http_localhost_5173.indexeddb.leveldb`.
   */
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
  /**
   * LOCK-N8/N11: Readback evidence for explicit undefined own-properties.
   * After writing objects with explicit `undefined` fields to Chromium
   * IndexedDB, every representative field MUST read back as an own-property
   * with value strictly `undefined` (LOCK-F2 throws inside Chromium on any
   * other readback). The returned booleans are durable evidence of that
   * requirement being met.
   */
  readbackUndefinedEvidence: ReadbackUndefinedEvidence[]
  /** LOCK-D2: seeded redux-persist Local Storage key (exact persist:cherry-studio). */
  persistKey: string
  /** LOCK-D2: byte length of the seeded `persist:cherry-studio` payload. */
  persistPayloadLength: number
  /** LOCK-D2: whether the persist key read back byte-identical after seeding. */
  persistReadbackEqual: boolean
  /** LOCK-D2: synthetic padding keys written to force the LS LevelDB flush. */
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
   * `IndexedDB/<dev origin>/` or `Local Storage/leveldb/` — no unrelated
   * roots (Data/, chat.db, other origins) enter the container.
   */
  zipAllEntriesUnderAllowedRoots: boolean
}

/**
 * Evidence for a single explicit-undefined field's readback behavior.
 *
 * LOCK-C2: Cross-process evidence carries only durable booleans.
 * `actualValue: unknown` is replaced by `valueIsUndefined: boolean` because
 * `undefined` cannot safely survive Chromium structured-clone → Playwright
 * page.evaluate serialization. The Chromium page asserts own-property and
 * value-strictly-undefined locally, then returns boolean evidence.
 */
export interface ReadbackUndefinedEvidence {
  /** Which store the record was read from. */
  store: string
  /** The record's primary key. */
  recordId: string
  /** The field name that was written with explicit `undefined`. */
  field: string
  /** Whether the field is an own-property after Chromium IndexedDB readback. */
  hasOwnProperty: boolean
  /**
   * LOCK-C2: Whether the field's value is strictly `undefined` after readback.
   * Computed inside Chromium (where the value IS accessible) and returned as a
   * boolean so serialization never needs to carry `undefined`.
   */
  valueIsUndefined: boolean
}

export interface DisposableDevOriginSeedZip {
  /** Absolute path to the produced ZIP (contains IndexedDB/...). */
  zipPath: string
  /** Disposable `--user-data-dir` root for the seed profile. */
  profileDir: string
  /** Dev-suffixed app data dir (holds the Chromium IndexedDB tree). */
  profileDevDir: string
  /** Temp work directory owning the profile and ZIP. */
  workDir: string
  evidence: DevOriginSeedZipEvidence
  /** Remove all disposable artifacts. Idempotent; throws on
   *  unresolved owned resources (LOCK-T1). */
  cleanup(): Promise<void>
}

// ---------------------------------------------------------------------------
// Port ownership check (LOCK-DEV-7)
// ---------------------------------------------------------------------------

/**
 * Verify that port 5173 is not occupied. Attempts to bind to the port;
 * if the bind fails with EADDRINUSE, throws with a clear diagnostic.
 * No broad process killing — just a hard fail.
 *
 * Binds without specifying a host (defaults to `::` / all interfaces) for
 * dual-stack IPv4/IPv6 coverage.
 */
async function assertPortAvailable(port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const server = http.createServer()
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `[E2E] LOCK-DEV-7 VIOLATION: Port ${port} is already in use. ` +
              'A Vite dev server or another process owns this port. ' +
              'Stop the conflicting process before running the dev-origin E2E.'
          )
        )
      } else {
        reject(err)
      }
    })
    // No host argument → Node.js defaults to `::` (all interfaces, dual-stack).
    // This ensures the port check covers both IPv4 and IPv6 bindings.
    server.listen(port, () => {
      server.close(() => resolve())
    })
  })
}

// ---------------------------------------------------------------------------
// Minimal HTTP server (serves a blank page at http://localhost:5173)
// ---------------------------------------------------------------------------

/**
 * Start a minimal HTTP server on port 5173. The server serves a blank
 * HTML page — the only requirement is that the browser can load a page
 * at the exact origin `http://localhost:5173` so Chromium creates the
 * correct IndexedDB origin directory.
 *
 * Listens without host binding for dual-stack IPv4/IPv6 safety.
 */
async function startDevServer(port: number): Promise<http.Server> {
  return new Promise<http.Server>((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        '<!DOCTYPE html><html><head><title>Dev Origin Seed</title></head>' +
          '<body><p>Dev-origin seed page</p></body></html>'
      )
    })
    server.once('error', reject)
    // No host argument → defaults to `::` (all interfaces, dual-stack).
    server.listen(port, () => {
      server.removeListener('error', reject)
      resolve(server)
    })
  })
}

function stopDevServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
}

// ---------------------------------------------------------------------------
// Mini Electron app (BrowserWindow pointing at http://localhost:5173)
// ---------------------------------------------------------------------------

/**
 * Create a minimal Electron app directory with a package.json and main.js
 * that opens a BrowserWindow to `http://localhost:5173`. This is NOT the
 * full Cherry app — it exists solely to create a Chromium IndexedDB under
 * the correct dev origin.
 *
 * LOCK-DEV-1: The URL uses `localhost` (not `127.0.0.1`) to ensure the
 * Chromium origin maps to `http_localhost_5173.indexeddb.leveldb`.
 */
function createMiniAppDir(workDir: string): string {
  const appDir = path.join(workDir, 'mini-app')
  fs.mkdirSync(appDir, { recursive: true })

  fs.writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify({ name: 'dev-origin-seed', version: '0.0.0', main: 'main.js' }),
    'utf-8'
  )

  // The mini app opens a BrowserWindow to http://localhost:5173 and keeps
  // it open until the process is terminated. The window is hidden.
  // LOCK-DEV-1: Uses `localhost` for exact origin mapping.
  // Finding-1: Explicitly call app.setPath('userData', exact profileDevDir)
  // BEFORE app.whenReady() to guarantee consistent userData resolution
  // regardless of Electron's automatic 'Dev' suffix behavior.
  // The exact profileDevDir is passed via --e2e-user-data-path= custom arg.
  fs.writeFileSync(
    path.join(appDir, 'main.js'),
    `
const { app, BrowserWindow } = require('electron');

// Finding-1: setPath BEFORE whenReady — the exact userData dir must be
// explicit and match what the ZIP reader expects.
const userDataPathArg = process.argv.find(a => a.startsWith('--e2e-user-data-path='));
if (userDataPathArg) {
  const exactPath = userDataPathArg.split('=').slice(1).join('=');
  app.setPath('userData', exactPath);
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadURL('http://localhost:${DEV_PORT}');
});

app.on('window-all-closed', () => {
  app.quit();
});
`,
    'utf-8'
  )

  return appDir
}

// ---------------------------------------------------------------------------
// Seed profile launch
// ---------------------------------------------------------------------------

async function launchSeedApp(
  profileDir: string,
  profileDevDir: string,
  appDir: string,
  ownedTmpRoot: string
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [
      appDir,
      `--user-data-dir=${profileDir}`,
      `--e2e-user-data-path=${profileDevDir}`,
      '--no-sandbox',
      '--disable-gpu'
    ],
    env: {
      ...process.env,
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
        const url = win.url()
        return url.includes('localhost') || url.includes('127.0.0.1')
      } catch {
        return false
      }
    },
    timeout: 120000
  })
  // Wait for the page to fully load so IndexedDB is accessible.
  await page.waitForLoadState('domcontentloaded')
  // Wait a moment for Chromium to initialize IndexedDB subsystem.
  await page.waitForTimeout(1000)
  return { app, page }
}

/**
 * LOCK-F2: close the seed app, falling back to PRECISE exact-token
 * termination when `close()` fails.
 */
async function closeSeedApp(app: ElectronApplication | null, profileDir: string): Promise<void> {
  return closeElectronWithExactCleanup(profileDir, {
    close: () => (app ? app.close() : Promise.resolve()),
    terminateExactProcesses: (profile) =>
      terminateProcessesByUserDataDir(profile, null, { termGraceMs: 5000, settleMs: 2000, verifyMs: 3000 })
  })
}

// ---------------------------------------------------------------------------
// Seeding (runs inside the seed app renderer at http://localhost:5173)
//
// LOCK-DEV-2 FIX: The blank page does NOT naturally create the CherryStudio
// DB. The seed page MUST create it via onupgradeneeded with the correct
// Dexie v11 schema (native version 110) before inserting data.
// ---------------------------------------------------------------------------

interface SeedEvaluateResult {
  nativeVersion: number
  stores: string[]
  inserted: Array<{ store: string; id: string }>
  verifiedKeys: Record<string, string[]>
  embeddedMessageIds: string[]
  settingsRecordCount: number
  /** LOCK-N8/N11: Readback evidence for explicit undefined own-properties. */
  readbackUndefinedEvidence: ReadbackUndefinedEvidence[]
}

async function seedIndexedDb(page: Page): Promise<SeedEvaluateResult> {
  return page.evaluate(
    async ({ dbName, targetVersion, padCount, padBytes, ids }) => {
      // ------------------------------------------------------------------
      // Step 1: CREATE the CherryStudio DB with the full Dexie v11 schema.
      // On a blank page nobody creates the DB, so we must create it here
      // with onupgradeneeded at the target native version.
      // ------------------------------------------------------------------
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName, targetVersion)
        req.onupgradeneeded = () => {
          const db = req.result
          // Create all stores that exist at Dexie v11 (native version 110).
          // This matches the production schema in databases/index.ts version(11).

          // files: 'id, name, origin_name, path, size, ext, type, created_at, count'
          const files = db.createObjectStore('files', { keyPath: 'id' })
          files.createIndex('name', 'name', { unique: false })
          files.createIndex('origin_name', 'origin_name', { unique: false })
          files.createIndex('path', 'path', { unique: false })
          files.createIndex('size', 'size', { unique: false })
          files.createIndex('ext', 'ext', { unique: false })
          files.createIndex('type', 'type', { unique: false })
          files.createIndex('created_at', 'created_at', { unique: false })
          files.createIndex('count', 'count', { unique: false })

          // topics: '&id'
          db.createObjectStore('topics', { keyPath: 'id' })

          // settings: '&id, value'
          const settings = db.createObjectStore('settings', { keyPath: 'id' })
          settings.createIndex('value', 'value', { unique: false })

          // knowledge_notes: '&id, baseId, type, content, created_at, updated_at'
          const knowledgeNotes = db.createObjectStore('knowledge_notes', { keyPath: 'id' })
          knowledgeNotes.createIndex('baseId', 'baseId', { unique: false })
          knowledgeNotes.createIndex('type', 'type', { unique: false })
          knowledgeNotes.createIndex('content', 'content', { unique: false })
          knowledgeNotes.createIndex('created_at', 'created_at', { unique: false })
          knowledgeNotes.createIndex('updated_at', 'updated_at', { unique: false })

          // translate_history: '&id, sourceText, targetText, sourceLanguage, targetLanguage, createdAt'
          const translateHistory = db.createObjectStore('translate_history', { keyPath: 'id' })
          translateHistory.createIndex('sourceText', 'sourceText', { unique: false })
          translateHistory.createIndex('targetText', 'targetText', { unique: false })
          translateHistory.createIndex('sourceLanguage', 'sourceLanguage', { unique: false })
          translateHistory.createIndex('targetLanguage', 'targetLanguage', { unique: false })
          translateHistory.createIndex('createdAt', 'createdAt', { unique: false })

          // translate_languages: '&id, langCode'
          const translateLanguages = db.createObjectStore('translate_languages', { keyPath: 'id' })
          translateLanguages.createIndex('langCode', 'langCode', { unique: false })

          // quick_phrases: 'id'
          db.createObjectStore('quick_phrases', { keyPath: 'id' })

          // message_blocks: 'id, messageId, file.id'
          const messageBlocks = db.createObjectStore('message_blocks', { keyPath: 'id' })
          messageBlocks.createIndex('messageId', 'messageId', { unique: false })
          messageBlocks.createIndex('file.id', 'file.id', { unique: false })

          // topic_segments: 'id, topicId'
          const topicSegments = db.createObjectStore('topic_segments', { keyPath: 'id' })
          topicSegments.createIndex('topicId', 'topicId', { unique: false })
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })

      try {
        // ------------------------------------------------------------------
        // Step 2: Verify all required stores exist.
        // ------------------------------------------------------------------
        const stores = Array.from(db.objectStoreNames).sort()
        for (const required of ['topics', 'message_blocks', 'topic_segments', 'files']) {
          if (!stores.includes(required)) {
            throw new Error(`Seed profile missing store "${required}" (has ${stores.join(', ')})`)
          }
        }

        // ------------------------------------------------------------------
        // Step 3: Seed data — padding into settings (forces LevelDB flush),
        // then the source records into topics/message_blocks/topic_segments/files.
        // ------------------------------------------------------------------
        const createdAt = '2026-07-31T00:00:00.000Z'
        const records: Record<string, Record<string, unknown>> = {
          topics: {
            id: ids.topic,
            messages: [
              {
                id: ids.message,
                role: 'user',
                status: 'success',
                content: 'Disposable dev-origin seed message (synthetic, not a real user backup)',
                createdAt,
                topicId: ids.topic,
                blocks: [ids.block],
                // LOCK-N2/N8: Explicit undefined properties that replicate
                // upgradeToV7 Dexie structured-clone rows. These must be
                // stripped by cloneForWire before IPC to Main.
                assistantId: undefined,
                modelId: undefined,
                model: undefined,
                type: undefined,
                useful: undefined,
                askId: undefined,
                mentions: undefined,
                enabledMCPs: undefined,
                usage: undefined,
                metrics: undefined,
                multiModelMessageStyle: undefined,
                foldSelected: undefined
              }
            ],
            deletedAt: null
          },
          message_blocks: {
            id: ids.block,
            messageId: ids.message,
            type: 'text',
            status: 'success',
            content: 'Disposable dev-origin seed block (synthetic, not a real user backup)',
            createdAt,
            updatedAt: null,
            // LOCK-N2/N8: Explicit undefined field from upgradeToV7.
            error: undefined
          },
          topic_segments: {
            id: ids.segment,
            topicId: ids.topic,
            name: 'Dev-Origin Seed Segment',
            messageIds: [ids.message],
            createdAt,
            updatedAt: createdAt
          },
          files: { id: ids.file, name: 'dev-seed-file.txt', size: 0 }
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

        // Extract embedded message ids from the source topic record.
        const topicRecord = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
          const req = tx.db.transaction('topics', 'readonly').objectStore('topics').get(ids.topic)
          req.onsuccess = () => resolve(req.result as Record<string, unknown> | undefined)
          req.onerror = () => reject(req.error ?? new Error('topics readback failed'))
        })
        const embeddedMessageIds = Array.isArray(topicRecord?.messages)
          ? (topicRecord!.messages as Array<{ id: string }>).map((m) => m.id)
          : []

        // -------------------------------------------------------------------
        // LOCK-N8/N11/LOCK-F2: Readback verification for explicit undefined
        // own-properties. After writing objects with explicit `undefined`
        // fields to Chromium IndexedDB, every representative field MUST read
        // back as an own-property with value strictly `undefined`. Any other
        // readback throws precisely inside Chromium, so a false readback can
        // never pass the fixture.
        // -------------------------------------------------------------------
        const readbackUndefinedEvidence: Array<{
          store: string
          recordId: string
          field: string
          hasOwnProperty: boolean
          valueIsUndefined: boolean
        }> = []

        // LOCK-C3: Message fields written with explicit undefined (nested in
        // topic.messages[0]). Field names match the production Message type
        // exactly — `multiModelMessageStyle` is the canonical application name.
        const MESSAGE_UNDEFINED_FIELDS = [
          'assistantId',
          'modelId',
          'model',
          'type',
          'useful',
          'askId',
          'mentions',
          'enabledMCPs',
          'usage',
          'metrics',
          'multiModelMessageStyle',
          'foldSelected'
        ]
        if (Array.isArray(topicRecord?.messages) && topicRecord!.messages.length > 0) {
          const msg = topicRecord!.messages[0] as Record<string, unknown>
          for (const field of MESSAGE_UNDEFINED_FIELDS) {
            // LOCK-C2/F2: Require own-property AND value-strictly-undefined
            // INSIDE Chromium (where the value IS accessible). A readback
            // where Chromium stripped or mutated the explicit undefined
            // property is a hard fixture failure — throw precisely. Durable
            // booleans still cross the serialization boundary.
            const hop = Object.prototype.hasOwnProperty.call(msg, field)
            const valueIsUndefined = hop && msg[field] === undefined
            if (!hop || !valueIsUndefined) {
              throw new Error(
                `[E2E] LOCK-F2 READBACK VIOLATION: message field "${field}" on record ` +
                  `"${ids.message}" (store topics.messages[0]) must survive Chromium ` +
                  `IndexedDB readback as an explicit undefined own-property, but ` +
                  `hasOwnProperty=${String(hop)} valueIsUndefined=${String(valueIsUndefined)}`
              )
            }
            readbackUndefinedEvidence.push({
              store: 'topics.messages[0]',
              recordId: ids.message,
              field,
              hasOwnProperty: hop,
              valueIsUndefined
            })
          }
        } else {
          throw new Error(
            `[E2E] LOCK-F2 READBACK VIOLATION: source topic record "${ids.topic}" did not ` +
              `read back with a non-empty messages array — cannot produce message ` +
              `undefined-own-property evidence`
          )
        }

        // Block field written with explicit undefined (message_blocks store)
        const BLOCK_UNDEFINED_FIELDS = ['error']
        const blockRecord = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
          const req = tx.db.transaction('message_blocks', 'readonly').objectStore('message_blocks').get(ids.block)
          req.onsuccess = () => resolve(req.result as Record<string, unknown> | undefined)
          req.onerror = () => reject(req.error ?? new Error('message_blocks readback failed'))
        })
        if (blockRecord) {
          for (const field of BLOCK_UNDEFINED_FIELDS) {
            // LOCK-C2/F2: Same hard requirement — explicit undefined must
            // survive as an own-property, else throw precisely.
            const hop = Object.prototype.hasOwnProperty.call(blockRecord, field)
            const valueIsUndefined = hop && blockRecord[field] === undefined
            if (!hop || !valueIsUndefined) {
              throw new Error(
                `[E2E] LOCK-F2 READBACK VIOLATION: block field "${field}" on record ` +
                  `"${ids.block}" (store message_blocks) must survive Chromium IndexedDB ` +
                  `readback as an explicit undefined own-property, but ` +
                  `hasOwnProperty=${String(hop)} valueIsUndefined=${String(valueIsUndefined)}`
              )
            }
            readbackUndefinedEvidence.push({
              store: 'message_blocks',
              recordId: ids.block,
              field,
              hasOwnProperty: hop,
              valueIsUndefined
            })
          }
        } else {
          throw new Error(
            `[E2E] LOCK-F2 READBACK VIOLATION: block record "${ids.block}" did not read ` +
              `back from message_blocks — cannot produce block undefined-own-property evidence`
          )
        }

        console.log(
          `[E2E] LOCK-N8/N11 readback undefined evidence:`,
          JSON.stringify(readbackUndefinedEvidence, null, 2)
        )

        return {
          nativeVersion: targetVersion,
          stores,
          inserted,
          verifiedKeys,
          embeddedMessageIds,
          settingsRecordCount,
          readbackUndefinedEvidence
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
// Local Storage projection (LOCK-D2)
//
// The seed page also writes the version-215 redux-persist
// `persist:cherry-studio` payload. The payload carries the REAL redux-persist
// wire representation (LOCK-FF1): an outer JSON object whose `_persist` and
// `assistants` values are each the JSON string of that slice's state —
// exactly what `createPersistoid` writes with the default serializer
// (verified against the installed redux-persist@6.0.0 createPersistoid). The
// decoded synthetic nested-object shape would be a false-positive fixture.
// Only synthetic minimal navigation metadata is included — never assistant
// behavior configuration (LOCK-PROD-2).
// ---------------------------------------------------------------------------

/**
 * Tiny local mirror of redux-persist's default serializer
 * (`createPersistoid` `defaultSerialize` = `JSON.stringify`, verified against
 * the installed redux-persist@6.0.0 implementation). Deliberately duplicated
 * into the file-origin builder too — no renderer store is ever imported, and
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
 * REAL redux-persist wire representation (LOCK-FF1). The single assistant
 * carries one topic whose id EXACTLY matches the seeded IndexedDB topic
 * (`t-e2e-dev-1`); its name/timestamps are the exported expected-UI
 * constants. Topic/assistant order are positional in production (order 0 / 0).
 *
 * Exported so downstream projection E2E specs can assert the isolated
 * renderer's raw read is byte-identical to what the seed produced.
 */
export function buildDevOriginPersistPayload(): string {
  return serializePersistWire({
    _persist: { version: SEED_PERSIST_VERSION, rehydrated: true },
    assistants: {
      defaultAssistant: {},
      assistants: [
        {
          id: DEV_ASSISTANT_ID,
          name: DEV_ASSISTANT_NAME,
          emoji: DEV_ASSISTANT_EMOJI,
          topics: [
            {
              id: DEV_TOPIC_ID,
              assistantId: DEV_ASSISTANT_ID,
              name: DEV_TOPIC_NAME,
              createdAt: DEV_TOPIC_CREATED_AT,
              updatedAt: DEV_TOPIC_UPDATED_AT,
              deletedAt: null,
              pinned: false,
              isNameManuallyEdited: true
            }
          ]
        }
      ],
      tagsOrder: [],
      collapsedTags: {},
      presets: [],
      unifiedListOrder: []
    }
  })
}

/** Evidence returned by {@link seedLocalStorage} (cross-process safe JSON). */
interface LocalStorageSeedResult {
  /** Exact redux-persist key written. */
  persistKey: string
  /** Byte length of the seeded payload string. */
  persistPayloadLength: number
  /** Whether the persist key read back byte-identical after seeding. */
  persistReadbackEqual: boolean
  /** Padding keys actually written (may degrade on quota exhaustion). */
  paddingCount: number
}

/**
 * Seed Local Storage for the dev origin inside the seed app renderer:
 *   1. Write the exact `persist:cherry-studio` key.
 *   2. Pad with synthetic keys to force a real committed write batch through
 *      Chromium's debounced Local Storage commit path (LOCK-D2 flush). The
 *      durable disk state is finalized by the graceful app close afterwards.
 *   3. Read the persist key back and assert byte-identical round-trip.
 *   4. Remove the padding keys so the disposable origin's Local Storage
 *      contains only the minimal projection (tombstones are inert).
 *
 * Graceful app close afterwards flushes Local Storage LevelDB to disk.
 */
async function seedLocalStorage(page: Page): Promise<LocalStorageSeedResult> {
  return page.evaluate(
    async ({ persistKey, payload, padCount, padBytes }) => {
      // Step 1: exact persist key (LOCK-PROD-2 reads precisely this key).
      localStorage.setItem(persistKey, payload)

      // Step 2: force a real committed write batch through Chromium's
      // debounced Local Storage commit path (LOCK-D2 flush). On quota
      // exhaustion we degrade gracefully — the graceful-close flush still
      // durably commits the WAL.
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

      // Step 4: remove the padding keys (inert tombstones — the persist key
      // was written first and is never touched by removals).
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
        paddingCount
      }
    },
    {
      persistKey: SEED_PERSIST_KEY,
      payload: buildDevOriginPersistPayload(),
      padCount: PAD_LS_KEYS,
      padBytes: PAD_LS_VALUE_BYTES
    }
  )
}

// ---------------------------------------------------------------------------
// ZIP production + pre-flight
// ---------------------------------------------------------------------------

/**
 * Produce the seed ZIP from the disposable profile. Materializes EXACTLY two
 * Chromium subtrees (LOCK-PROD-8 selective extraction contract):
 *   - `IndexedDB/<dev origin>/`   (LOCK-DEV-2 exact directory, .ldb required)
 *   - `Local Storage/leveldb/`    (projection data; valid CURRENT marker)
 * Nothing else in the profile (Data/, GPUCache, Session Storage, other
 * origins) enters the ZIP.
 */
function produceSeedZip(
  profileDevDir: string,
  zipPath: string
): { originDir: string; ldbFileCount: number; localStorageLdbFileCount: number } {
  const idbDir = path.join(profileDevDir, 'IndexedDB')
  const originDir = path.join(idbDir, DEV_ORIGIN_DIR)
  const localStorageLeveldbDir = path.join(profileDevDir, 'Local Storage', 'leveldb')

  // LOCK-DEV-2: Assert the origin directory EXACTLY matches before proceeding.
  if (!fs.existsSync(originDir)) {
    throw new Error(
      `[E2E] LOCK-DEV-2 VIOLATION: Expected origin directory "${DEV_ORIGIN_DIR}" ` +
        `does not exist at ${originDir}. Chromium created: ` +
        `${fs.readdirSync(idbDir).join(', ') || '(empty)'}`
    )
  }

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

  // LOCK-D2: the seeded Local Storage LevelDB must exist with a valid
  // `CURRENT` marker (LevelDB openability). The persist key was written
  // inside the seed page, so absence means the write never committed.
  if (!fs.existsSync(localStorageLeveldbDir)) {
    throw new Error(
      `[E2E] LOCK-D2 VIOLATION: Expected Local Storage leveldb directory ` +
        `"${localStorageLeveldbDir}" does not exist — the persist:cherry-studio ` +
        `projection was seeded but Chromium did not materialize Local Storage. ` +
        `Profile Local Storage parent: ${fs.existsSync(path.join(profileDevDir, 'Local Storage')) ? 'exists' : 'absent'}`
    )
  }
  const lsFiles = fs.readdirSync(localStorageLeveldbDir)
  if (!lsFiles.includes('CURRENT')) {
    throw new Error(
      `[E2E] LOCK-D2 VIOLATION: Local Storage leveldb at ${localStorageLeveldbDir} ` +
        `has no CURRENT marker (invalid LevelDB): ${lsFiles.join(', ') || '(empty)'}`
    )
  }
  const localStorageLdbFileCount = lsFiles.filter((f) => f.endsWith('.ldb')).length

  const zip = new AdmZip()
  zip.addLocalFolder(idbDir, 'IndexedDB')
  zip.addLocalFolder(localStorageLeveldbDir, DEV_LOCAL_STORAGE_ROOT)
  zip.writeZip(zipPath)

  if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size === 0) {
    throw new Error(`Seed ZIP was not produced at ${zipPath}`)
  }
  return { originDir: DEV_ORIGIN_DIR, ldbFileCount, localStorageLdbFileCount }
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
 * Pre-flight the produced ZIP (LOCK-T4):
 * - EVERY `IndexedDB/` entry must live under the expected origin directory,
 *   and at least one `.ldb` table entry must exist inside that origin.
 * - The `Local Storage/leveldb/` subtree must be present with a `CURRENT`
 *   marker and at least one file entry (LOCK-D2).
 * - EVERY non-directory entry must live under exactly
 *   `IndexedDB/<origin>/` or `Local Storage/leveldb/` — no unrelated roots
 *   (Data/, chat.db, other origins) enter the container.
 */
async function preflightZipEntries(zipPath: string, originDirName: string): Promise<ZipPreflightResult> {
  const zip = new StreamZip.async({ file: zipPath })
  try {
    const entries = await zip.entries()
    const names = Object.keys(entries)
    const originPrefix = `IndexedDB/${originDirName}/`
    const localStoragePrefix = `${DEV_LOCAL_STORAGE_ROOT}/`
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

    // LOCK-D2: Local Storage subtree must be present and LevelDB-valid.
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

    // No unrelated roots: every FILE entry must be inside one of the two
    // accepted subtrees (directory entries are structural, ignored exactly
    // like production's isDirectory skip).
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
// LOCK-DEV-8: Verify no file__0 entries exist (no-rename enforcement)
// ---------------------------------------------------------------------------

/**
 * LOCK-DEV-8: Assert that the ZIP contains ZERO entries referencing the
 * file-origin directory `file__0.indexeddb.leveldb`. This proves no
 * rename/copy was performed — the ZIP contains only the natural dev-origin
 * Chromium directory structure.
 */
async function assertNoFileOriginEntries(zipPath: string): Promise<void> {
  const zip = new StreamZip.async({ file: zipPath })
  try {
    const entries = await zip.entries()
    const fileOriginEntries = Object.keys(entries).filter((n) => n.includes('file__0.indexeddb.leveldb'))
    if (fileOriginEntries.length > 0) {
      throw new Error(
        `[E2E] LOCK-DEV-8 VIOLATION: ZIP contains file-origin entries ` +
          `(possible rename/copy): ${fileOriginEntries.slice(0, 5).join(', ')}`
      )
    }
  } finally {
    await zip.close()
  }
}

// ---------------------------------------------------------------------------
// Owned-artifact cleanup (LOCK-T1)
//
// removeOwnedSeedArtifacts comes from run-ownership: it removes only the exact
// dirs/ZIP this seed created and verifies absence, throwing on any leftover.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a disposable dev-origin seed ZIP. Owns the HTTP server, seed
 * Electron app lifecycle, and temp artifacts. On ANY failure all owned
 * resources are cleaned up before the error propagates. Callers MUST call
 * `cleanup()` on the returned handle; cleanup failures throw (LOCK-T1).
 *
 * LOCK-DEV-7: Fails immediately if port 5173 is occupied.
 * LOCK-DEV-1/2: Origin is exactly `http://localhost:5173`.
 * LOCK-DEV-8: No file__0 rename/copy.
 * LOCK-D2: ZIP also carries the `Local Storage/leveldb` subtree seeded with
 *          the version-215 `persist:cherry-studio` minimal projection.
 */
export async function createDisposableDevOriginSeedZip(ownedTmpRoot: string): Promise<DisposableDevOriginSeedZip> {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const workDir = path.join(ownedTmpRoot, `${PROFILE_PREFIX}${unique}-work`)
  const profileDir = path.join(ownedTmpRoot, `${PROFILE_PREFIX}${unique}-profile`)
  const profileDevDir = profileDir + 'Dev'
  const zipPath = path.join(workDir, 'cherry-dev-origin-seed.zip')

  fs.mkdirSync(workDir, { recursive: true })
  fs.mkdirSync(profileDir, { recursive: true })
  validateProfileLaunchToken(ownedTmpRoot, profileDir)
  registerProfileLaunchToken(profileDir)

  let server: http.Server | null = null
  let appDir: string | null = null

  try {
    // LOCK-DEV-7: Port ownership check — fail if port 5173 is occupied.
    await assertPortAvailable(DEV_PORT)

    // Start minimal HTTP server at the exact origin.
    // No host binding → defaults to `::` (all interfaces, dual-stack IPv4/IPv6).
    server = await startDevServer(DEV_PORT)
    console.log(`[E2E] Dev-origin HTTP server started on port ${DEV_PORT}`)

    // Create mini Electron app directory.
    appDir = createMiniAppDir(workDir)

    const launched = await launchSeedApp(profileDir, profileDevDir, appDir, ownedTmpRoot)

    // Seed IndexedDB from the http://localhost:5173 renderer context.
    // LOCK-DEV-2 FIX: This CREATES the DB schema via onupgradeneeded.
    const seeded = await seedIndexedDb(launched.page)

    // LOCK-D2: seed the version-215 redux-persist `persist:cherry-studio`
    // Local Storage projection on the same dev origin, then let Chromium
    // batch-commit Local Storage before the graceful close.
    const lsSeeded = await seedLocalStorage(launched.page)
    await launched.page.waitForTimeout(1500)
    console.log(
      `[E2E] LOCK-D2 Local Storage projection seeded (key=${lsSeeded.persistKey}, ` +
        `payloadBytes=${lsSeeded.persistPayloadLength}, ` +
        `readbackEqual=${lsSeeded.persistReadbackEqual}, padding=${lsSeeded.paddingCount})`
    )

    // Close the app cleanly (flushes LevelDB) before inspecting/zipping.
    await closeSeedApp(launched.app, profileDir)
    await new Promise((resolve) => setTimeout(resolve, 1500))

    // Stop the HTTP server — no longer needed.
    await stopDevServer(server)
    server = null
    console.log(`[E2E] Dev-origin HTTP server stopped`)

    // LOCK-DEV-2: Produce ZIP and assert exact origin directory.
    const { originDir, ldbFileCount, localStorageLdbFileCount } = produceSeedZip(profileDevDir, zipPath)

    // Verify origin directory matches exactly (LOCK-DEV-2).
    if (originDir !== DEV_ORIGIN_DIR) {
      throw new Error(
        `[E2E] LOCK-DEV-2 VIOLATION: Origin directory "${originDir}" ` + `does not match expected "${DEV_ORIGIN_DIR}"`
      )
    }

    const preflight = await preflightZipEntries(zipPath, DEV_ORIGIN_DIR)

    // LOCK-DEV-8: Assert no file-origin entries (no rename/copy).
    await assertNoFileOriginEntries(zipPath)

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
        readbackUndefinedEvidence: seeded.readbackUndefinedEvidence,
        originDir,
        ldbFileCount,
        zipEntryCount: preflight.entryCount,
        zipAllEntriesUnderOrigin: preflight.allEntriesUnderOrigin,
        zipLdbEntryCount: preflight.ldbEntryCount,
        zipEntriesSample: preflight.sample,
        persistKey: lsSeeded.persistKey,
        persistPayloadLength: lsSeeded.persistPayloadLength,
        persistReadbackEqual: lsSeeded.persistReadbackEqual,
        localStoragePaddingCount: lsSeeded.paddingCount,
        localStorageLdbFileCount,
        zipHasLocalStorage: preflight.localStorageEntryCount > 0,
        zipLocalStorageEntryCount: preflight.localStorageEntryCount,
        zipLocalStorageEntriesSample: preflight.localStorageEntriesSample,
        zipAllEntriesUnderAllowedRoots: preflight.allEntriesUnderAllowedRoots
      },
      cleanup: async () => {
        const cleanupErrors: string[] = []

        // Stop HTTP server if still running.
        if (server) {
          try {
            await stopDevServer(server)
          } catch (err: any) {
            cleanupErrors.push(`HTTP server stop failed: ${err?.message ?? String(err)}`)
          }
          server = null
        }

        // Always close + exact-token terminate + final verify; only after
        // success remove nested seed artifacts and unregister the profile.
        try {
          await closeSeedApp(null, profileDir)
          const dirs = [workDir, profileDir, profileDevDir]
          if (appDir) dirs.push(appDir)
          await removeOwnedSeedArtifacts(dirs, zipPath)
          unregisterProfileLaunchToken(profileDir)
        } catch (err: any) {
          cleanupErrors.push(`Artifact cleanup preserved: ${err instanceof Error ? err.message : String(err)}`)
        }

        if (cleanupErrors.length > 0) {
          throw new Error(
            `Disposable dev-origin seed cleanup failed (${cleanupErrors.length}): ${cleanupErrors.join('; ')}`
          )
        }
      }
    }
  } catch (error) {
    // LOCK-F2: never delete owned artifacts while processes may still hold them.
    const cleanupErrors: string[] = []

    let cleaned = false
    try {
      await closeSeedApp(null, profileDir)
      cleaned = true
    } catch (err: any) {
      cleanupErrors.push(`seed app exact cleanup failed: ${err?.message ?? String(err)}`)
    }

    if (server) {
      try {
        await stopDevServer(server)
      } catch (err: any) {
        cleanupErrors.push(`HTTP server stop failed: ${err?.message ?? String(err)}`)
      }
    }

    if (cleaned) {
      try {
        const dirs = [workDir, profileDir, profileDevDir]
        if (appDir) dirs.push(appDir)
        await removeOwnedSeedArtifacts(dirs, zipPath)
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
