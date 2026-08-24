/**
 * M8 Backup/restore L3 archive metadata health — Measurement-Only Diagnostic
 *
 * Inactive by default, exercises production BackupManager public backup/restore
 * paths in isolated synthetic mkdtemp roots and emits only the existing
 * schema-v1 benchmark artifact after all samples and parity gates pass.
 *
 * LOCK-001: diagnostic, read-only production-state measurement; only synthetic
 * writes inside fresh owned mkdtemp roots are permitted.
 * LOCK-002: Node main-native ABI 137, real better-sqlite3/archiver/StreamZip
 * and production backup/restore logic; mock only app.getPath/getVersion/relaunch/exit
 * and narrowly required services.
 * LOCK-004: restore lifecycle parity is fail-closed.
 */

import { createHash } from 'node:crypto'
import * as realFs from 'node:fs'
import { createRequire } from 'node:module'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterAll, beforeAll, bench, describe, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

vi.mock('@main/config', () => ({
  DATA_PATH: '/mock/data'
}))

const { mockGetPath, mockGetVersion, mockRelaunch, mockExit, mockChatDbService } = vi.hoisted(() => ({
  mockGetPath: vi.fn<(key: string) => string>((key: string) => {
    if (key === 'userData') return '/tmp/m8-default-userData'
    if (key === 'temp') return '/tmp'
    return '/mock'
  }),
  mockGetVersion: vi.fn(() => '1.0.0-test'),
  mockRelaunch: vi.fn(),
  mockExit: vi.fn(),
  mockChatDbService: {
    isInitialised: vi.fn(() => false),
    getBackup: vi.fn()
  }
}))

vi.mock('electron', () => ({
  app: {
    getPath: mockGetPath,
    getVersion: mockGetVersion,
    relaunch: mockRelaunch,
    exit: mockExit
  }
}))

vi.mock('../index', () => ({
  chatDbService: mockChatDbService
}))

vi.mock('../../WindowService', () => ({
  windowService: { getMainWindow: vi.fn(() => null) }
}))

vi.mock('../../WebDav', () => ({
  default: vi.fn().mockImplementation(() => ({
    putFileContents: vi.fn().mockResolvedValue(true),
    getDirectoryContents: vi.fn().mockResolvedValue([]),
    checkConnection: vi.fn().mockResolvedValue(true),
    createDirectory: vi.fn().mockResolvedValue(true),
    deleteFile: vi.fn().mockResolvedValue(true),
    getFileContents: vi.fn().mockResolvedValue(Buffer.from(''))
  }))
}))

vi.mock('../../S3Storage', () => ({
  default: vi.fn()
}))

import { loggerService } from '@logger'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type * as fsExtra from 'fs-extra'
import StreamZip from 'node-stream-zip'

import { BackupManager } from '../../BackupManager'
import { validateReadonlyChatDb } from '../../chatDbImport/promotion/readonlyDbValidation'
import { BetterSqlite3BackupAdapter, ChatDbBackup } from '../backup'
import { L3_PRODUCT, L3_PURPOSE } from '../l3ArchiveMetadata'
import { validateL3ArchiveMetadata } from '../l3ArchiveMetadata'
import { registerChatDbNormalize, runMigrations } from '../migration'
import * as schema from '../schema'
import {
  BENCH_RESULT_SCHEMA_VERSION,
  type BenchmarkResult,
  collectEnvironmentMetadata,
  emitBenchmarkResultAfterSuccessfulTasks
} from './benchResult'
import {
  assertBoundedDetail,
  assertFilesParityExactSet,
  assertM8SampleCounts,
  boundedDetail,
  buildM8Gates,
  buildM8Metrics,
  computeM8LogicalDigest,
  deterministicFileByte,
  fileLengthsForScenario,
  isProductionExcludedEntry,
  M8_L3_ARCHIVE_BENCH_ENV,
  M8_L3_ARCHIVE_BENCH_ID,
  M8_L3_ARCHIVE_BENCH_NAME,
  M8_L3_ARCHIVE_COMMAND,
  M8_MEASURE_ROUNDS,
  M8_SCENARIOS,
  M8_WARMUP_ROUNDS,
  type M8MetricSuffix,
  m8Scale,
  resolveM8L3ArchiveGate
} from './m8L3ArchiveHealth'

const logger = loggerService.withContext('M8L3ArchiveHealth')

// ---------------------------------------------------------------------------
// Env gate
// ---------------------------------------------------------------------------

const m8Enabled = resolveM8L3ArchiveGate(process.env[M8_L3_ARCHIVE_BENCH_ENV])

if (!m8Enabled) {
  describe('m8 L3 archive health diagnostic (on-demand, M8)', () => {
    bench.skip('m8 L3 archive health skipped — enable via pnpm bench:m8-l3-archive (M8_L3_ARCHIVE_BENCH=1)', () => {})
  })
} else {
  // -------------------------------------------------------------------------
  // Helpers (outside timed intervals)
  // -------------------------------------------------------------------------

  function assertDescendant(childReal: string, parentReal: string, context: string): void {
    const normalizedParent = parentReal.endsWith(realPath.sep) ? parentReal : parentReal + realPath.sep
    if (childReal !== parentReal && !childReal.startsWith(normalizedParent)) {
      throw new Error(`${context}: ${childReal} is not descendant of ${parentReal}`)
    }
  }

  function createDeterministicBuffer(fileIndex: number, length: number): Buffer {
    const buf = Buffer.alloc(length)
    for (let i = 0; i < length; i++) buf[i] = deterministicFileByte(fileIndex, i)
    return buf
  }

  function sha256Hex(buffers: Buffer[]): string {
    const h = createHash('sha256')
    for (const b of buffers) h.update(b)
    return h.digest('hex')
  }

  async function inspectArchive(
    archivePath: string,
    ownedRootReal: string
  ): Promise<{
    metadataBytes: number
    metadataJson: unknown
    entryCount: number
    rawEntryCount: number
    compressedBytes: number
    entries: string[]
  }> {
    const realArchive = realFs.realpathSync(archivePath)
    assertDescendant(realArchive, ownedRootReal, 'archive containment')
    const compressedBytes = realFs.statSync(realArchive).size
    const zip = new StreamZip.async({ file: realArchive })
    const entriesMap = await zip.entries()
    const entries = Object.keys(entriesMap)
    const rawEntryCount = await zip.entriesCount
    const entryCount = entries.length
    let metadataBytes = 0
    let metadataJson: unknown = null
    if (entries.includes('metadata.json')) {
      const data = await zip.entryData('metadata.json')
      metadataBytes = data.length
      metadataJson = JSON.parse(data.toString('utf8'))
    }
    await zip.close()
    return { metadataBytes, metadataJson, entryCount, rawEntryCount, compressedBytes, entries }
  }

  interface ExpectedParity {
    topics: number
    messages: number
    blocks: number
    filesBytes: number
    filesHash: string
    filesCount: number
    idbBytes: number
    idbHash: string
    lsBytes: number
    lsHash: string
  }

  function seedSampleFixture(
    scenario: (typeof M8_SCENARIOS)[number],
    sampleRoot: string,
    ownedRootReal: string
  ): { sqlite: Database.Database; expected: ExpectedParity; sourceDigest: string; cleanupSqlite: () => void } {
    const userDataDir = realPath.join(sampleRoot, 'user-data')
    const tempDir = realPath.join(sampleRoot, 'temp')
    const destDir = realPath.join(sampleRoot, 'destination')
    realFs.mkdirSync(userDataDir, { recursive: true })
    realFs.mkdirSync(tempDir, { recursive: true })
    realFs.mkdirSync(destDir, { recursive: true })

    const dataDir = realPath.join(userDataDir, 'Data')
    realFs.mkdirSync(dataDir, { recursive: true })

    // Mock electron paths for this sample — production-derived
    mockGetPath.mockImplementation((key: string) => {
      if (key === 'userData') return userDataDir
      if (key === 'temp') return tempDir
      return '/mock'
    })
    mockGetVersion.mockReturnValue('1.0.0-test')
    // Realpath containment checks before calls
    const realUserData = realFs.realpathSync(userDataDir)
    const realTemp = realFs.realpathSync(tempDir)
    const realDest = realFs.realpathSync(destDir)
    assertDescendant(realUserData, ownedRootReal, 'userData containment')
    assertDescendant(realTemp, ownedRootReal, 'temp containment')
    assertDescendant(realDest, ownedRootReal, 'destination containment')

    const chatDbPath = realPath.join(dataDir, 'chat.db')
    // realpath-check Data/chat.db parent before create
    assertDescendant(realPath.resolve(chatDbPath), ownedRootReal, 'chat.db path containment')
    const sqlite = new Database(chatDbPath)
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    sqlite.pragma('synchronous = NORMAL')
    sqlite.pragma('busy_timeout = 5000')
    registerChatDbNormalize(sqlite)
    runMigrations(drizzle(sqlite, { schema }), sqlite)

    const topics = scenario.topics
    const messages = scenario.messages
    const now = '2025-01-01T00:00:00.000Z'
    const insertTopic = sqlite.prepare('INSERT INTO topics (id, name, created_at) VALUES (?, ?, ?)')
    for (let t = 0; t < topics; t++) {
      insertTopic.run(`t${t}`, `Topic ${t}`, now)
    }
    const insertMessage = sqlite.prepare(
      'INSERT INTO messages (id, topic_id, role, content, status, created_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    const insertBlock = sqlite.prepare(
      'INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES (?, ?, ?, ?, ?)'
    )
    const tx = sqlite.transaction(() => {
      for (let m = 0; m < messages; m++) {
        const topicIdx = m % topics
        const msgId = `m${m}`
        insertMessage.run(msgId, `t${topicIdx}`, 'user', `content-${m}`, 'success', now, m)
        insertBlock.run(`b${m}`, msgId, 'main_text', `block-content-${m}`, 0)
      }
    })
    tx()

    const filesDir = realPath.join(dataDir, 'Files')
    realFs.mkdirSync(filesDir, { recursive: true })
    const lengths = fileLengthsForScenario(scenario.fileBytes, scenario.fileEntries)
    const filesBuffers: Buffer[] = []
    for (let i = 0; i < scenario.fileEntries; i++) {
      const buf = createDeterministicBuffer(i, lengths[i])
      filesBuffers.push(buf)
      const filePath = realPath.join(filesDir, `file-${i}.bin`)
      assertDescendant(realPath.resolve(filePath), ownedRootReal, 'Files entry containment')
      realFs.writeFileSync(filePath, buf)
    }
    const filesHash = sha256Hex(filesBuffers)
    const filesBytes = scenario.fileBytes

    const idbDir = realPath.join(userDataDir, 'IndexedDB', 'leveldb')
    realFs.mkdirSync(idbDir, { recursive: true })
    const idbBuf = createDeterministicBuffer(100, 4096)
    realFs.writeFileSync(realPath.join(idbDir, 'CURRENT'), idbBuf)
    const idbHash = sha256Hex([idbBuf])
    const idbBytes = idbBuf.length

    const lsDir = realPath.join(userDataDir, 'Local Storage', 'leveldb')
    realFs.mkdirSync(lsDir, { recursive: true })
    const lsBuf = createDeterministicBuffer(200, 4096)
    realFs.writeFileSync(realPath.join(lsDir, 'LOG'), lsBuf)
    const lsHash = sha256Hex([lsBuf])
    const lsBytes = lsBuf.length

    const adapter = new BetterSqlite3BackupAdapter(() => sqlite)
    const chatDbBackup = new ChatDbBackup(adapter)
    mockChatDbService.isInitialised.mockReturnValue(true)
    mockChatDbService.getBackup.mockReturnValue(chatDbBackup)

    const expected: ExpectedParity = {
      topics,
      messages,
      blocks: messages,
      filesBytes,
      filesHash,
      filesCount: scenario.fileEntries,
      idbBytes,
      idbHash,
      lsBytes,
      lsHash
    }

    const sourceDigest = computeM8LogicalDigest(sqlite as any)

    const cleanupSqlite = (): void => {
      try {
        sqlite.close()
      } catch {}
    }

    return { sqlite, expected, sourceDigest, cleanupSqlite }
  }

  // -------------------------------------------------------------------------
  // Measurement harness
  // -------------------------------------------------------------------------

  let m8BenchmarkResult: BenchmarkResult | null = null
  let m8HarnessError: Error | null = null

  beforeAll(async () => {
    const ownedRoot = realFs.realpathSync(realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'm8-l3-')))
    logger.info('M8 owned root created', { root: ownedRoot })
    let ownedRootCleanupDone = false
    const cleanupOwnedRoot = (): void => {
      if (ownedRootCleanupDone) return
      ownedRootCleanupDone = true
      try {
        realFs.rmSync(ownedRoot, { recursive: true, force: true })
      } catch {}
    }

    // Narrow test seam for production-derived extraction (LOCK-001)
    // Capture actual production mkdtemp extraction path via mutable CJS require seam (no production code change)
    const cjsRequire = createRequire(import.meta.url)
    const fsExtraCjs = cjsRequire('fs-extra') as typeof fsExtra
    const originalFsExtraMkdtemp = fsExtraCjs.mkdtemp.bind(fsExtraCjs)
    let capturedExtractionDir: string | null = null
    let capturedExtractionReal: string | null = null
    ;(fsExtraCjs as any).mkdtemp = async (prefix: string) => {
      const dir: string = await originalFsExtraMkdtemp(prefix)
      if (typeof prefix === 'string' && prefix.includes('extraction-')) {
        capturedExtractionDir = dir
        try {
          capturedExtractionReal = realFs.realpathSync(dir)
        } catch {
          capturedExtractionReal = dir
        }
        assertDescendant(capturedExtractionReal, ownedRoot, 'production extraction containment immediate')
      }
      return dir
    }

    const backupMsMap = new Map<M8MetricSuffix, number[]>()
    const restoreMsMap = new Map<M8MetricSuffix, number[]>()
    const metadataBytesMap = new Map<M8MetricSuffix, number[]>()
    const entryCountMap = new Map<M8MetricSuffix, number[]>()
    const compressedBytesMap = new Map<M8MetricSuffix, number[]>()
    for (const s of M8_SCENARIOS) {
      backupMsMap.set(s.suffix, [])
      restoreMsMap.set(s.suffix, [])
      metadataBytesMap.set(s.suffix, [])
      entryCountMap.set(s.suffix, [])
      compressedBytesMap.set(s.suffix, [])
    }

    const gateInputs: Record<string, any> = {}
    for (const s of M8_SCENARIOS) {
      gateInputs[s.suffix] = {
        metadataV7: { passed: false, detail: '' },
        archiveSafety: { passed: false, detail: '' },
        chatDbPresence: { passed: false, detail: '' },
        excludedAbsence: { passed: false, detail: '' },
        snapshotIntegrity: { passed: false, detail: '' },
        restoreParity: { passed: false, detail: '' },
        sampleCompleteness: { passed: false, detail: '' }
      }
    }

    try {
      for (const scenario of M8_SCENARIOS) {
        const suffix = scenario.suffix
        let perScenarioParityFailed = false
        let perScenarioMetadataFailed = false
        let perScenarioSnapshotFailed = false
        let perScenarioArchiveSafetyFailed = false
        let perScenarioExcludedFailed = false
        let perScenarioChatDbPresenceFailed = false

        const scenarioDir = realPath.join(ownedRoot, `scenario-${suffix}`)
        realFs.mkdirSync(scenarioDir, { recursive: true })
        const scenarioDirReal = realFs.realpathSync(scenarioDir)
        assertDescendant(scenarioDirReal, ownedRoot, 'scenario dir containment')

        const totalSamples = M8_WARMUP_ROUNDS + M8_MEASURE_ROUNDS
        for (let sampleIdx = 0; sampleIdx < totalSamples; sampleIdx++) {
          const isWarmup = sampleIdx < M8_WARMUP_ROUNDS
          const sampleRoot = realPath.join(scenarioDir, `sample-${sampleIdx}`)
          realFs.mkdirSync(sampleRoot, { recursive: true })
          const sampleRootReal = realFs.realpathSync(sampleRoot)
          assertDescendant(sampleRootReal, scenarioDirReal, 'sample root containment')
          assertDescendant(sampleRootReal, ownedRoot, 'sample root owned containment')

          let sqliteCleanup: (() => void) | null = null
          let sourceDigest: string | null = null
          try {
            const seeded = seedSampleFixture(scenario, sampleRootReal, ownedRoot)
            const { expected, cleanupSqlite } = seeded
            sourceDigest = seeded.sourceDigest
            sqliteCleanup = cleanupSqlite

            const bm = new BackupManager()
            const destDir = realPath.join(sampleRootReal, 'destination')
            const destDirReal = realFs.realpathSync(destDir)
            assertDescendant(destDirReal, ownedRoot, 'destination containment pre-backup')
            const fileName = `backup-${suffix}-${sampleIdx}.zip`
            const archivePath = realPath.join(destDirReal, fileName)
            assertDescendant(realPath.resolve(archivePath), ownedRoot, 'archive path containment')

            mockRelaunch.mockClear()
            mockExit.mockClear()

            const backupStart = performance.now()
            const returnedPath = await bm.backup(null as any, fileName, destDirReal, false)
            const backupMs = performance.now() - backupStart

            const realReturned = realFs.realpathSync(returnedPath)
            assertDescendant(realReturned, destDirReal, 'returned archive containment')
            if (!realFs.existsSync(archivePath)) throw new Error(`archive not found at ${archivePath}`)

            const inspected = await inspectArchive(archivePath, ownedRoot)

            // Generic metadata validation
            const metadataValidation = validateL3ArchiveMetadata(inspected.metadataJson)
            const genericMetadataPass = metadataValidation === null
            // Explicit v7 product/purpose check (finding 5)
            let explicitV7Pass = false
            if (genericMetadataPass && inspected.metadataJson && typeof inspected.metadataJson === 'object') {
              const m = inspected.metadataJson as Record<string, unknown>
              explicitV7Pass = m.version === 7 && m.product === L3_PRODUCT && m.purpose === L3_PURPOSE
            }
            const metadataV7Passed = genericMetadataPass && explicitV7Pass
            if (!metadataV7Passed) perScenarioMetadataFailed = true

            // Archive safety: traversal, absolute, NUL, plus zip duplicate check
            const duplicateEntries = inspected.rawEntryCount !== inspected.entryCount
            const archiveSafetyPassed =
              !duplicateEntries &&
              !inspected.entries.some(
                (e) => e.includes('..') || e.startsWith('/') || e.includes('\0') || e.includes('\\')
              )
            if (!archiveSafetyPassed) perScenarioArchiveSafetyFailed = true

            // Authoritative chat.db presence: exactly one Data/chat.db, no duplicates
            const chatDbEntries = inspected.entries.filter((e) => e === 'Data/chat.db')
            const chatDbPresencePassed = chatDbEntries.length === 1 && inspected.entries.includes('Data/chat.db')
            if (!chatDbPresencePassed) perScenarioChatDbPresenceFailed = true

            // Excluded absence: cover full production set including chat.db-wal/shm/backup and promotion artifacts
            // chat.db itself is NOT excluded; we check excluded set separately
            const excludedAbsencePassed = !inspected.entries.some((e) => isProductionExcludedEntry(e))
            // Also ensure no duplicate entries and no authoritative duplicate beyond the one
            const noDuplicateAuthoritative =
              inspected.rawEntryCount === inspected.entryCount && chatDbEntries.length === 1
            const excludedFullPass = excludedAbsencePassed && noDuplicateAuthoritative
            if (!excludedFullPass) perScenarioExcludedFailed = true

            // Snapshot integrity: independent pre-staging validation via read-only production-compatible path
            // Extract archived Data/chat.db to a temp file under owned root and validate
            let snapshotIntegrityPassed = false
            let extractedSnapshotPath: string | null = null
            try {
              const zip2 = new StreamZip.async({ file: archivePath })
              const tmpSnapshot = realPath.join(sampleRootReal, `snapshot-${sampleIdx}.db`)
              assertDescendant(realPath.resolve(tmpSnapshot), ownedRoot, 'snapshot temp containment')
              await zip2.extract('Data/chat.db', tmpSnapshot)
              await zip2.close()
              extractedSnapshotPath = tmpSnapshot
              const validation = validateReadonlyChatDb(tmpSnapshot, 2)
              snapshotIntegrityPassed = validation === null
            } catch {
              snapshotIntegrityPassed = false
            } finally {
              if (extractedSnapshotPath) {
                try {
                  realFs.unlinkSync(extractedSnapshotPath)
                } catch {}
              }
            }
            if (!snapshotIntegrityPassed) perScenarioSnapshotFailed = true

            // Pre-staging failures must be zero relaunch/exit (LOCK-004)
            const preStagingFailed =
              !archiveSafetyPassed ||
              !metadataV7Passed ||
              !chatDbPresencePassed ||
              !excludedFullPass ||
              !snapshotIntegrityPassed
            if (preStagingFailed) {
              if (mockRelaunch.mock.calls.length !== 0 || mockExit.mock.calls.length !== 0) {
                throw new Error(
                  `pre-staging failure must have 0 relaunch/exit but got ${mockRelaunch.mock.calls.length}/${mockExit.mock.calls.length}`
                )
              }
              if (!isWarmup) perScenarioParityFailed = true
              // Do not proceed to restore on pre-staging failure for this sample
              if (!isWarmup) {
                // Still need to count as failure; abort harness
                throw new Error(
                  `pre-staging validation failed for ${suffix} sample ${sampleIdx}: metadataV7=${metadataV7Passed} safety=${archiveSafetyPassed} chatDb=${chatDbPresencePassed} excluded=${excludedFullPass} snapshot=${snapshotIntegrityPassed}`
                )
              } else {
                throw new Error(`warmup pre-staging failed for ${suffix}`)
              }
            }

            if (!isWarmup) {
              backupMsMap.get(suffix)!.push(backupMs)
              metadataBytesMap.get(suffix)!.push(inspected.metadataBytes)
              entryCountMap.get(suffix)!.push(inspected.entryCount)
              compressedBytesMap.get(suffix)!.push(inspected.compressedBytes)
              if (
                !metadataV7Passed ||
                !chatDbPresencePassed ||
                !excludedFullPass ||
                !archiveSafetyPassed ||
                !snapshotIntegrityPassed
              ) {
                perScenarioParityFailed = true
              }
            }

            // Capture source digest before backup closes source DB; keep for digest parity inside callback
            const sourceDigestForRestore = sourceDigest
            // Reset extraction capture before restore (per-sample)
            capturedExtractionDir = null
            capturedExtractionReal = null

            sqliteCleanup()
            sqliteCleanup = null

            mockRelaunch.mockClear()
            mockExit.mockClear()

            const expectedForRestore = expected

            const restoreStart = performance.now()
            try {
              await bm.restore(null as any, archivePath, {
                preExitCleanup: async () => {
                  // --- Canonical containment enforcement (LOCK-001) ---
                  // Require observed production-derived extraction path (fail closed if missing/escapes)
                  if (!capturedExtractionReal || !capturedExtractionDir) {
                    throw new Error('required observed extraction path missing — fail closed')
                  }
                  assertDescendant(capturedExtractionReal, ownedRoot, 'production extraction canonical containment')
                  assertDescendant(capturedExtractionReal, sampleRootReal, 'production extraction sample containment')
                  // Extraction dir is deleted by production before callback; verify cleanup happened or still contained
                  if (realFs.existsSync(capturedExtractionDir)) {
                    const stillReal = realFs.realpathSync(capturedExtractionDir)
                    assertDescendant(stillReal, ownedRoot, 'extraction still present containment')
                  }

                  // Explicit metadata v7/product/purpose inside callback (Finding 4)
                  const meta = inspected.metadataJson as Record<string, unknown> | null
                  if (!meta || meta.version !== 7 || meta.product !== L3_PRODUCT || meta.purpose !== L3_PURPOSE) {
                    throw new Error('callback metadata v7 product/purpose mismatch')
                  }

                  const userDataDir = realFs.realpathSync(realPath.join(sampleRootReal, 'user-data'))
                  assertDescendant(userDataDir, ownedRoot, 'userData staged canonical containment')
                  const stagedDataRestore = realPath.join(userDataDir, 'Data.restore')
                  const stagedIdbRestore = realPath.join(userDataDir, 'IndexedDB.restore')
                  const stagedLsRestore = realPath.join(userDataDir, 'Local Storage.restore')
                  // Realpath-check staged .restore dirs before parity (production-derived, canonical)
                  for (const p of [stagedDataRestore, stagedIdbRestore, stagedLsRestore]) {
                    if (!realFs.existsSync(p)) throw new Error('staged .restore missing before canonical check')
                    const canonical = realFs.realpathSync(p)
                    assertDescendant(canonical, ownedRoot, 'staged .restore canonical containment')
                    assertDescendant(canonical, sampleRootReal, 'staged .restore sample canonical containment')
                  }

                  if (!realFs.existsSync(stagedDataRestore)) throw new Error('Data.restore missing after staging')
                  const stagedDbPath = realPath.join(stagedDataRestore, 'chat.db')
                  if (!realFs.existsSync(stagedDbPath)) throw new Error('staged chat.db missing')
                  const stagedDbReal = realFs.realpathSync(stagedDbPath)
                  assertDescendant(stagedDbReal, ownedRoot, 'staged chat.db canonical containment')
                  assertDescendant(stagedDbReal, sampleRootReal, 'staged chat.db sample containment')

                  const validation = validateReadonlyChatDb(stagedDbPath, 2)
                  if (validation !== null)
                    throw new Error(
                      `staged chat.db validation failed gate ${validation.gate} code ${validation.safeCode}`
                    )

                  const stagedSqlite = new Database(stagedDbPath, { readonly: true })
                  try {
                    // Canonical numeric-ID digest parity comparing seeded source and staged DB
                    const stagedDigest = computeM8LogicalDigest(stagedSqlite as any)
                    if (stagedDigest !== sourceDigestForRestore)
                      throw new Error('db parity digest mismatch source vs staged')
                  } finally {
                    stagedSqlite.close()
                  }

                  const stagedFilesDir = realPath.join(stagedDataRestore, 'Files')
                  if (!realFs.existsSync(stagedFilesDir)) throw new Error('staged Files missing')
                  const stagedFilesDirReal = realFs.realpathSync(stagedFilesDir)
                  assertDescendant(stagedFilesDirReal, ownedRoot, 'staged Files canonical containment')
                  assertDescendant(stagedFilesDirReal, sampleRootReal, 'staged Files sample containment')
                  const allEntries = realFs.readdirSync(stagedFilesDirReal)
                  // Require every entry to be regular file and complete set; fail closed on missing/unexpected
                  for (const entry of allEntries) {
                    const entryPath = realPath.join(stagedFilesDirReal, entry)
                    const entryReal = realFs.realpathSync(entryPath)
                    assertDescendant(entryReal, ownedRoot, 'staged file entry canonical containment')
                    const stat = realFs.statSync(entryReal)
                    if (!stat.isFile()) throw new Error('files parity expected regular file')
                  }
                  const filesSorted = [...allEntries].sort((a, b) => {
                    const ai = Number.parseInt(a.slice(5), 10)
                    const bi = Number.parseInt(b.slice(5), 10)
                    return ai - bi
                  })
                  const filesBufs: Buffer[] = []
                  for (const f of filesSorted) {
                    const p = realPath.join(stagedFilesDirReal, f)
                    const buf = realFs.readFileSync(p)
                    filesBufs.push(buf)
                  }
                  // Exact sorted expected set, byte count, SHA-256 over complete listing
                  assertFilesParityExactSet(
                    allEntries,
                    filesBufs,
                    expectedForRestore.filesCount,
                    expectedForRestore.filesBytes,
                    expectedForRestore.filesHash
                  )

                  if (!realFs.existsSync(stagedIdbRestore)) throw new Error('IndexedDB.restore missing')
                  const idbSentinelPath = realPath.join(stagedIdbRestore, 'leveldb', 'CURRENT')
                  if (!realFs.existsSync(idbSentinelPath)) throw new Error('IndexedDB sentinel missing')
                  const idbReal = realFs.realpathSync(idbSentinelPath)
                  assertDescendant(idbReal, ownedRoot, 'idb sentinel canonical containment')
                  const idbBuf = realFs.readFileSync(idbReal)
                  if (idbBuf.length !== expectedForRestore.idbBytes)
                    throw new Error(`idb bytes ${idbBuf.length} != ${expectedForRestore.idbBytes}`)
                  if (sha256Hex([idbBuf]) !== expectedForRestore.idbHash) throw new Error('idb hash mismatch')

                  if (!realFs.existsSync(stagedLsRestore)) throw new Error('Local Storage.restore missing')
                  const lsSentinelPath = realPath.join(stagedLsRestore, 'leveldb', 'LOG')
                  if (!realFs.existsSync(lsSentinelPath)) throw new Error('Local Storage sentinel missing')
                  const lsReal = realFs.realpathSync(lsSentinelPath)
                  assertDescendant(lsReal, ownedRoot, 'ls sentinel canonical containment')
                  const lsBuf = realFs.readFileSync(lsReal)
                  if (lsBuf.length !== expectedForRestore.lsBytes)
                    throw new Error(`ls bytes ${lsBuf.length} != ${expectedForRestore.lsBytes}`)
                  if (sha256Hex([lsBuf]) !== expectedForRestore.lsHash) throw new Error('ls hash mismatch')

                  const PROMOTION_EXCLUDED = new Set([
                    'chat-import-candidates',
                    'promotion-journal.json',
                    'promotion-journal.json.staging',
                    'rollback-snapshot.json',
                    'rollback-snapshot.json.staging',
                    'files-rollback-snapshot',
                    'files-rollback-snapshot.staging',
                    'files-rollback-snapshot.old',
                    'files-promote-staging',
                    'files-catalog-snapshot.json',
                    'files-catalog-snapshot.json.staging'
                  ])
                  for (const excl of PROMOTION_EXCLUDED) {
                    const exclPath = realPath.join(stagedDataRestore, excl)
                    if (realFs.existsSync(exclPath)) throw new Error(`staged Data.restore contains excluded ${excl}`)
                    // canonical containment for excluded check path
                    const exclReal = (() => {
                      try {
                        return realFs.realpathSync(exclPath)
                      } catch {
                        return realPath.resolve(exclPath)
                      }
                    })()
                    assertDescendant(exclReal, ownedRoot, 'promotion excluded canonical containment')
                  }

                  // Note: chat.db-wal/shm are transient coordination files that may appear after opening the staged DB; they are not archive exclusion failures.
                  for (const wal of ['chat.db.backup']) {
                    if (realFs.existsSync(realPath.join(stagedDataRestore, wal)))
                      throw new Error(`staged Data.restore contains excluded ${wal}`)
                  }
                }
              })
              const restoreMs = performance.now() - restoreStart

              if (mockRelaunch.mock.calls.length !== 1 || mockExit.mock.calls.length !== 1) {
                throw new Error(
                  `restore lifecycle parity failed: relaunch ${mockRelaunch.mock.calls.length} exit ${mockExit.mock.calls.length} expected 1 each`
                )
              }

              if (!isWarmup) {
                restoreMsMap.get(suffix)!.push(restoreMs)
              }
            } catch (restoreError) {
              if (mockRelaunch.mock.calls.length !== 0 || mockExit.mock.calls.length !== 0) {
                throw new Error(
                  `restore failure must have zero relaunch/exit but got relaunch ${mockRelaunch.mock.calls.length} exit ${mockExit.mock.calls.length}: ${String(restoreError)}`
                )
              }
              if (!isWarmup) {
                perScenarioParityFailed = true
              }
              throw restoreError
            }
          } finally {
            if (sqliteCleanup) {
              try {
                sqliteCleanup()
              } catch {}
            }
            try {
              realFs.rmSync(sampleRootReal, { recursive: true, force: true })
            } catch {}
            mockGetPath.mockReset()
            mockChatDbService.isInitialised.mockReset()
            mockChatDbService.getBackup.mockReset()
          }
        }

        const backupSamples = backupMsMap.get(suffix)!
        const restoreSamples = restoreMsMap.get(suffix)!
        const sampleComplete = backupSamples.length === M8_MEASURE_ROUNDS && restoreSamples.length === M8_MEASURE_ROUNDS
        const detailBase = `scenario ${suffix} samples ${M8_MEASURE_ROUNDS}`
        gateInputs[suffix].sampleCompleteness = {
          passed: sampleComplete,
          detail: boundedDetail(
            sampleComplete
              ? `${detailBase} complete`
              : `${detailBase} incomplete ${backupSamples.length}/${M8_MEASURE_ROUNDS}`
          )
        }
        const metadataPassed = !perScenarioMetadataFailed && sampleComplete
        const archiveSafetyPassed = !perScenarioArchiveSafetyFailed && sampleComplete
        const chatDbPresencePassed = !perScenarioChatDbPresenceFailed && sampleComplete
        const excludedPassed = !perScenarioExcludedFailed && sampleComplete
        const snapshotPassed = !perScenarioSnapshotFailed && sampleComplete
        const restoreParityPassed = !perScenarioParityFailed && sampleComplete

        gateInputs[suffix].metadataV7 = {
          passed: metadataPassed,
          detail: boundedDetail(metadataPassed ? `${detailBase} metadata v7 pass` : `${detailBase} metadata v7 fail`)
        }
        gateInputs[suffix].archiveSafety = {
          passed: archiveSafetyPassed,
          detail: boundedDetail(
            archiveSafetyPassed ? `${detailBase} archive safety pass` : `${detailBase} archive safety fail`
          )
        }
        gateInputs[suffix].chatDbPresence = {
          passed: chatDbPresencePassed,
          detail: boundedDetail(
            chatDbPresencePassed ? `${detailBase} chat.db presence pass` : `${detailBase} chat.db presence fail`
          )
        }
        gateInputs[suffix].excludedAbsence = {
          passed: excludedPassed,
          detail: boundedDetail(
            excludedPassed ? `${detailBase} excluded absence pass` : `${detailBase} excluded absence fail`
          )
        }
        gateInputs[suffix].snapshotIntegrity = {
          passed: snapshotPassed,
          detail: boundedDetail(
            snapshotPassed ? `${detailBase} snapshot integrity pass` : `${detailBase} snapshot integrity fail`
          )
        }
        gateInputs[suffix].restoreParity = {
          passed: restoreParityPassed,
          detail: boundedDetail(
            restoreParityPassed ? `${detailBase} restore parity pass` : `${detailBase} restore parity fail`
          )
        }
        for (const k of Object.keys(gateInputs[suffix])) {
          assertBoundedDetail(gateInputs[suffix][k].detail)
        }

        if (!sampleComplete) {
          throw new Error(
            `sample completeness failed for ${suffix}: backup ${backupSamples.length} restore ${restoreSamples.length} expected ${M8_MEASURE_ROUNDS}`
          )
        }
        if (
          perScenarioParityFailed ||
          perScenarioMetadataFailed ||
          perScenarioSnapshotFailed ||
          perScenarioArchiveSafetyFailed ||
          perScenarioExcludedFailed ||
          perScenarioChatDbPresenceFailed
        ) {
          throw new Error(`parity/metadata failed for ${suffix}`)
        }
      }

      const samplesByScenario = new Map<M8MetricSuffix, any>()
      for (const s of M8_SCENARIOS) {
        const suffix = s.suffix
        samplesByScenario.set(suffix, {
          backupMs: backupMsMap.get(suffix)!,
          restoreMs: restoreMsMap.get(suffix)!,
          metadataBytes: metadataBytesMap.get(suffix)!,
          archiveEntryCount: entryCountMap.get(suffix)!,
          archiveCompressedBytes: compressedBytesMap.get(suffix)!
        })
      }

      const backupCompletenessMap = new Map<string, readonly number[]>()
      const restoreCompletenessMap = new Map<string, readonly number[]>()
      for (const s of M8_SCENARIOS) {
        backupCompletenessMap.set(s.suffix, backupMsMap.get(s.suffix)!)
        restoreCompletenessMap.set(s.suffix, restoreMsMap.get(s.suffix)!)
      }
      assertM8SampleCounts(backupCompletenessMap, M8_MEASURE_ROUNDS)
      assertM8SampleCounts(restoreCompletenessMap, M8_MEASURE_ROUNDS)

      const metrics = buildM8Metrics(samplesByScenario)
      const gates = buildM8Gates(gateInputs as any)

      for (const m of metrics) {
        if (!Number.isFinite(m.value)) throw new Error(`metric ${m.id} non-finite ${m.value}`)
      }
      for (const g of gates) {
        if (g.detail) assertBoundedDetail(g.detail)
        if (typeof g.passed !== 'boolean') throw new Error(`gate ${g.id} passed not boolean`)
      }

      m8BenchmarkResult = {
        schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
        benchmark: {
          id: M8_L3_ARCHIVE_BENCH_ID,
          name: M8_L3_ARCHIVE_BENCH_NAME,
          scale: m8Scale()
        },
        environment: collectEnvironmentMetadata({ command: M8_L3_ARCHIVE_COMMAND }),
        metrics,
        gates
      }

      logger.info('M8 L3 Archive Health completed', {
        scenarios: M8_SCENARIOS.map(
          (s) => `${s.label} topics=${s.topics} msgs=${s.messages} files=${s.fileEntries}/${s.fileBytes}`
        ).join(' | '),
        rounds: `${M8_WARMUP_ROUNDS} warmup + ${M8_MEASURE_ROUNDS} measured per scenario`
      })
    } catch (error) {
      m8HarnessError = error instanceof Error ? error : new Error(String(error))
      logger.error('M8 harness failed', m8HarnessError)
      throw error
    } finally {
      try {
        ;(fsExtraCjs as any).mkdtemp = originalFsExtraMkdtemp
      } catch {}
      cleanupOwnedRoot()
    }
  }, 120000)

  describe('m8 L3 archive health — backup/restore (synthetic, directional L3)', () => {
    bench(
      'backup/restore health placeholder (real harness measured in beforeAll)',
      async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 1))
      },
      { warmupIterations: 1, iterations: 1 }
    )
  })

  afterAll((suite) => {
    if (m8HarnessError) {
      logger.error('M8 harness error, no artifact emitted', m8HarnessError)
      return
    }
    if (!m8BenchmarkResult) {
      logger.error('M8 harness: no result built, no artifact emitted')
      return
    }
    const artifactPath = emitBenchmarkResultAfterSuccessfulTasks(suite as any, m8BenchmarkResult)
    if (artifactPath !== null) {
      logger.info('M8 result artifact emitted', { artifactPath })
    } else {
      logger.info('M8 harness: bench tasks not all passed, no artifact emitted')
    }
  })
}
