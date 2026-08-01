/**
 * Disposable Chromium dev-origin IndexedDB seed ZIP generator for the L2
 * Cherry Studio import E2E (LOCK-DEV-1..8).
 *
 * Produces a REPRODUCIBLY generated disposable source ZIP containing only
 * the `IndexedDB/` tree of a Chromium profile whose `CherryStudio`
 * IndexedDB was created under the EXACT origin `http://localhost:5173`.
 *
 * Chromium naturally maps this origin to the LevelDB directory name
 * `http_localhost_5173.indexeddb.leveldb` — no rename, no copy, no
 * file__0 transformation (LOCK-DEV-1/2).
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
 *   4. Closes the app (flushes LevelDB to disk).
 *   5. Asserts the origin directory is EXACTLY
 *      `http_localhost_5173.indexeddb.leveldb` under `IndexedDB/`.
 *   6. Zips the `IndexedDB/` subtree WITHOUT rename/copy.
 *
 * LOCK-DEV-1: Origin must be exact `http://localhost:5173`.
 * LOCK-DEV-2: Directory must be exact `http_localhost_5173.indexeddb.leveldb`.
 * LOCK-DEV-8: No file__0 rename/copy; the ZIP contains the natural Chromium
 *             directory structure.
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

/** Padding records in the import-ignored `settings` store (LevelDB flush). */
const PAD_SETTINGS_COUNT = 700
const PAD_SETTINGS_VALUE_BYTES = 12_000

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
            content: 'Disposable dev-origin seed block (synthetic, not a real user backup)',
            createdAt,
            updatedAt: null
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

        return {
          nativeVersion: targetVersion,
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
  const originDir = path.join(idbDir, DEV_ORIGIN_DIR)

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

  const zip = new AdmZip()
  zip.addLocalFolder(idbDir, 'IndexedDB')
  zip.writeZip(zipPath)

  if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size === 0) {
    throw new Error(`Seed ZIP was not produced at ${zipPath}`)
  }
  return { originDir: DEV_ORIGIN_DIR, ldbFileCount }
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
 * must exist inside that origin.
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

    // Close the app cleanly (flushes LevelDB) before inspecting/zipping.
    await closeSeedApp(launched.app, profileDir)
    await new Promise((resolve) => setTimeout(resolve, 1500))

    // Stop the HTTP server — no longer needed.
    await stopDevServer(server)
    server = null
    console.log(`[E2E] Dev-origin HTTP server stopped`)

    // LOCK-DEV-2: Produce ZIP and assert exact origin directory.
    const { originDir, ldbFileCount } = produceIndexedDbZip(profileDevDir, zipPath)

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
        originDir,
        ldbFileCount,
        zipEntryCount: preflight.entryCount,
        zipAllEntriesUnderOrigin: preflight.allEntriesUnderOrigin,
        zipLdbEntryCount: preflight.ldbEntryCount,
        zipEntriesSample: preflight.sample
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
