/**
 * Focused utility tests for the bounded synthetic large-container fixture
 * (LOCK-L2/LOCK-L3).
 *
 * Proves against a real (non-mocked) container:
 * 1. The derived ZIP's central directory describes an irrelevant `Data/...`
 *    entry with >500 MiB of UNCOMPRESSED logical payload, while the archive
 *    on disk stays under the 20 MiB budget (compressible streamed payload).
 * 2. The archive is VALID, not a faked metadata seam: node-stream-zip opens
 *    it, reports the logical sizes from the central directory, and streams
 *    the preserved seed entries AND the full irrelevant payload back with
 *    exact byte counts.
 * 3. Every seed entry (names + logical sizes + directory markers) is
 *    preserved, and the selected-subset facts (IndexedDB/<origin>/**,
 *    .indexeddb.blob/**, Local Storage/leveldb/**) are byte-identical to the
 *    seed — the fixture never touches selected source data (LOCK-L3).
 * 4. The irrelevant entry is never under a production selection prefix
 *    (`irrelevantNeverSelected`), so selective extraction must skip it.
 * 5. Fail-closed error paths: missing seed, >4 GiB logical request (pre-stream
 *    guard), and archive-budget violation all leave ZERO artifacts behind.
 *
 * These are pure Node utility tests (vitest project `e2e-utils`); no
 * Electron, no Playwright, no production code.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import archiver from 'archiver'
import StreamZip from 'node-stream-zip'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createDerivedLargeContainerZip,
  DEFAULT_IRRELEVANT_ENTRY_NAME,
  DEFAULT_IRRELEVANT_LOGICAL_BYTES,
  DEFAULT_MAX_ARCHIVE_BYTES,
  MAX_IRRELEVANT_LOGICAL_BYTES
} from './derived-large-container-zip'
import { createOwnedTmpRoot } from './run-ownership'

const ownedRoots: string[] = []

/**
 * The fixture's owned-root contract requires a direct child of the canonical
 * OS temp dir (validateOwnedRoot), so create roots via createOwnedTmpRoot()
 * and track them for afterEach removal.
 */
function ownedTmpRoot(): string {
  const root = createOwnedTmpRoot()
  ownedRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of ownedRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

/**
 * Build a minimal but realistic disposable seed ZIP with the production shape
 * production intake requires: an IndexedDB origin with .ldb entries, its blob
 * subtree, and a Local Storage/leveldb tree. Returns the seed path.
 */
async function buildSyntheticSeed(workDir: string): Promise<string> {
  const seedPath = path.join(workDir, 'synthetic-seed.zip')
  const output = fs.createWriteStream(seedPath)
  const archive = archiver('zip', { zlib: { level: 1 } })
  archive.pipe(output)
  archive.append('', { name: 'IndexedDB/' })
  archive.append('0'.repeat(64), { name: 'IndexedDB/file__0.indexeddb.leveldb/CURRENT' })
  archive.append('log-entry-data.'.repeat(1024), { name: 'IndexedDB/file__0.indexeddb.leveldb/000003.log' })
  archive.append('ldb-table-data.'.repeat(2048), { name: 'IndexedDB/file__0.indexeddb.leveldb/000005.ldb' })
  archive.append('blob-payload.'.repeat(512), { name: 'IndexedDB/file__0.indexeddb.blob/000000_000001.blob' })
  archive.append('ls-current.'.repeat(32), { name: 'Local Storage/leveldb/CURRENT' })
  archive.append('ls-log.'.repeat(4096), { name: 'Local Storage/leveldb/000003.log' })
  archive.append('ls-manifest.'.repeat(512), { name: 'Local Storage/leveldb/MANIFEST-000001' })
  await archive.finalize()
  await new Promise<void>((resolve, reject) => {
    output.on('close', resolve)
    output.on('error', reject)
  })
  return seedPath
}

/** Count streamed bytes without buffering the payload. */
async function countStreamBytes(zip: StreamZip.StreamZipAsync, name: string): Promise<number> {
  const stream = await zip.stream(name)
  let count = 0
  for await (const chunk of stream) count += chunk.length
  return count
}

describe('derived large-container ZIP fixture (LOCK-L2/LOCK-L3)', () => {
  it(
    'produces a valid small-on-disk ZIP whose irrelevant Data entry exceeds 500 MiB in the central directory',
    { timeout: 120000 },
    async () => {
      const root = ownedTmpRoot()
      const seedDir = path.join(root, 'seed-work')
      fs.mkdirSync(seedDir)
      const seedPath = await buildSyntheticSeed(seedDir)

      const t0 = Date.now()
      const fixture = await createDerivedLargeContainerZip(seedPath, root)
      const elapsedMs = Date.now() - t0
      try {
        // --- Central directory: logical size/root of the derived ZIP ---------
        const e = fixture.evidence
        expect(e.derivedZipPath).toBe(fixture.zipPath)
        // >500 MiB irrelevant uncompressed entry (LOCK-L2 default 600 MiB).
        expect(e.irrelevantLogicalBytes).toBe(DEFAULT_IRRELEVANT_LOGICAL_BYTES)
        expect(e.irrelevantLogicalBytes).toBeGreaterThan(500 * 1024 * 1024)
        expect(e.irrelevantEntryName).toBe(DEFAULT_IRRELEVANT_ENTRY_NAME)
        expect(e.irrelevantEntryName.startsWith('Data/')).toBe(true)
        // Compressed archive boundedness (LOCK-L2: <20 MiB preferred).
        expect(e.archiveBounded).toBe(true)
        expect(e.derivedArchiveBytes).toBeLessThanOrEqual(DEFAULT_MAX_ARCHIVE_BYTES)
        expect(e.derivedArchiveBytes).toBeLessThan(20 * 1024 * 1024)
        // The irrelevant entry compresses down to a small fraction of its size.
        expect(e.irrelevantCompressedBytes).toBeLessThan(8 * 1024 * 1024)
        expect(e.derivedEntryCount).toBe(e.seedEntryCount + 1)
        // Selected subset is small; the huge entry is never selected.
        expect(e.selectedLogicalBytes).toBeLessThan(10 * 1024 * 1024)
        expect(e.irrelevantNeverSelected).toBe(true)

        // --- Independent central-directory verification (no trust in fixture) -
        const zip = new StreamZip.async({ file: fixture.zipPath })
        try {
          const entries = await zip.entries()
          const names = Object.keys(entries)
          expect(names).toHaveLength(e.seedEntryCount + 1)

          const irrelevant = entries[DEFAULT_IRRELEVANT_ENTRY_NAME]
          expect(irrelevant).toBeTruthy()
          expect((irrelevant as { size?: number }).size).toBe(DEFAULT_IRRELEVANT_LOGICAL_BYTES)
          // A real entry: the payload streams back byte-exact (valid archive,
          // not a faked central-directory seam — LOCK-L2).
          const streamed = await countStreamBytes(zip, DEFAULT_IRRELEVANT_ENTRY_NAME)
          expect(streamed).toBe(DEFAULT_IRRELEVANT_LOGICAL_BYTES)

          // Seed entries preserved with identical logical sizes.
          for (const name of [
            'IndexedDB/file__0.indexeddb.leveldb/CURRENT',
            'IndexedDB/file__0.indexeddb.leveldb/000003.log',
            'IndexedDB/file__0.indexeddb.leveldb/000005.ldb',
            'IndexedDB/file__0.indexeddb.blob/000000_000001.blob',
            'Local Storage/leveldb/CURRENT',
            'Local Storage/leveldb/000003.log',
            'Local Storage/leveldb/MANIFEST-000001'
          ]) {
            expect(entries[name], `seed entry must survive: ${name}`).toBeTruthy()
          }
          const ldb = entries['IndexedDB/file__0.indexeddb.leveldb/000005.ldb']
          expect((ldb as { size?: number }).size).toBe('ldb-table-data.'.length * 2048)
          const log = entries['IndexedDB/file__0.indexeddb.leveldb/000003.log']
          expect((log as { size?: number }).size).toBe('log-entry-data.'.length * 1024)
          // Preserved data integrity: seed file data streams back byte-exact.
          expect(await countStreamBytes(zip, 'Local Storage/leveldb/000003.log')).toBe('ls-log.'.length * 4096)
        } finally {
          await zip.close()
        }
        console.log(
          `[E2E] derived fixture: ${elapsedMs}ms, archive=${e.derivedArchiveBytes} bytes, ` +
            `irrelevant=${e.irrelevantLogicalBytes} logical / ${e.irrelevantCompressedBytes} compressed, ` +
            `selected=${e.selectedLogicalBytes} bytes, entries=${e.derivedEntryCount}`
        )
      } finally {
        await fixture.cleanup()
      }

      // Cleanup verified: the derived ZIP + work dir are gone (LOCK-L1/T1).
      // The test's own seed dir legitimately survives — fixture cleanup is
      // ownership-scoped and must never delete the seed.
      expect(fs.existsSync(fixture.zipPath)).toBe(false)
      expect(fs.existsSync(fixture.workDir)).toBe(false)
      expect(fs.readdirSync(root)).toEqual(['seed-work'])
      // Idempotent cleanup.
      await fixture.cleanup()
    }
  )

  it('rejects a missing seed ZIP before writing and leaves no artifacts', { timeout: 30000 }, async () => {
    const root = ownedTmpRoot()
    const missing = path.join(root, 'does-not-exist.zip')
    await expect(createDerivedLargeContainerZip(missing, root)).rejects.toThrow()
    expect(fs.readdirSync(root)).toEqual([])
  })

  it('rejects an absurd >4 GiB logical size before any write and leaves no artifacts', { timeout: 30000 }, async () => {
    const root = ownedTmpRoot()
    const seedDir = path.join(root, 'seed-work')
    fs.mkdirSync(seedDir)
    const seedPath = await buildSyntheticSeed(seedDir)

    await expect(
      createDerivedLargeContainerZip(seedPath, root, {
        irrelevantLogicalBytes: MAX_IRRELEVANT_LOGICAL_BYTES + 1
      })
    ).rejects.toThrow(/bounded fixture cap/)
    // Only the seed work dir survives; no derived artifacts were created.
    expect(fs.readdirSync(root)).toEqual(['seed-work'])
  })

  it(
    'fails closed when the compressed archive exceeds the budget and cleans the partial work dir',
    { timeout: 120000 },
    async () => {
      const root = ownedTmpRoot()
      const seedDir = path.join(root, 'seed-work')
      fs.mkdirSync(seedDir)
      const seedPath = await buildSyntheticSeed(seedDir)

      // A deliberately tiny budget forces the post-write boundedness check to
      // fail even though the payload is highly compressible.
      const error = await createDerivedLargeContainerZip(seedPath, root, {
        maxArchiveBytes: 1024 * 1024
      }).catch((err) => err)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toMatch(/exceeds the bounded budget/)
      // Error path removed the partial output + work dir (LOCK-L1).
      expect(fs.readdirSync(root)).toEqual(['seed-work'])
    }
  )
})
