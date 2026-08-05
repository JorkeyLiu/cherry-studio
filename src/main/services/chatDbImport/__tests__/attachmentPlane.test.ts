/**
 * attachmentPlane tests (LOCK-FIX-1..9) — candidate Files extraction +
 * durable Dexie catalog handoff + degraded attachment statistics.
 *
 * IMPORTANT: main.setup.ts globally mocks node:fs, node:os, node:path. We
 * override with real implementations using importActual inside vi.mock
 * factories (same pattern as zipIntake.test.ts). node-stream-zip is mocked
 * so each payload's stream can be controlled deterministically (healthy,
 * truncated, oversized, read-error, overflow) without crafting raw ZIPs.
 */

import * as realCrypto from 'node:crypto'
import type * as NodeFs from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mutable fs wrapper: properties can be overridden per-test to simulate
// deterministic I/O failures. `default` points to itself so `import fs
// from 'node:fs'` resolves to the mutable object.
const { fsMock } = vi.hoisted(() => {
  const actual = require('node:fs') as typeof NodeFs
  const fsMock: any = { ...actual }
  fsMock.default = fsMock
  return { fsMock }
})

vi.mock('node:fs', () => fsMock)

vi.mock('node:os', async () => {
  const actual = await vi.importActual('node:os')
  return { ...actual, default: actual }
})

vi.mock('node:path', async () => {
  const actual = await vi.importActual('node:path')
  return { ...actual, default: actual }
})

// Deterministic node-stream-zip double: per-test entries map + stream impl.
// The fake mirrors the library's per-entry CEN surface the plane reads:
// `name`, `size`, `crc` (central-directory CRC), `flags` (bit 3 = data
// descriptor). `payloadFor` lets entries() auto-fill the central-directory
// CRC from the test payload so existing tests exercise the plane's real
// CRC-32 verification path without hand-maintaining CRCs.
const { streamZipMock } = vi.hoisted(() => {
  const config: {
    entriesMap: Record<string, { name: string; size: number; crc?: number; flags?: number }>
    streamImpl: null | ((name: string) => NodeJS.ReadableStream & { destroy?: (e?: Error) => void })
    payloadFor: null | ((name: string) => Buffer)
    failOnOpen: boolean
    openCount: number
    closeCount: number
  } = {
    entriesMap: {},
    streamImpl: null,
    payloadFor: null,
    failOnOpen: false,
    openCount: 0,
    closeCount: 0
  }
  class FakeStreamZip {
    static async = FakeStreamZip
    constructor(_opts: unknown) {
      if (config.failOnOpen) {
        throw new Error('synthetic open failure')
      }
      config.openCount += 1
    }
    async entries(): Promise<Record<string, { name: string; size: number; crc?: number; flags?: number }>> {
      // Auto-fill the central-directory CRC from the configured payload when
      // the test did not pin one explicitly (LOCK-CORR-2: the plane compares
      // its streamed CRC against this value).
      for (const key of Object.keys(config.entriesMap)) {
        const entry = config.entriesMap[key]
        if (entry.crc === undefined && config.payloadFor) {
          const payload = config.payloadFor(key)
          if (payload) entry.crc = zlib.crc32(payload) >>> 0
        }
      }
      return config.entriesMap
    }
    async stream(name: string): Promise<NodeJS.ReadableStream> {
      if (!config.streamImpl) {
        throw new Error('no stream impl configured')
      }
      return config.streamImpl(name)
    }
    async close(): Promise<void> {
      config.closeCount += 1
    }
  }
  return { streamZipMock: { config, FakeStreamZip } }
})

vi.mock('node-stream-zip', () => ({ default: { async: streamZipMock.FakeStreamZip } }))

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import zlib from 'node:zlib'

import type { AttachmentPlane } from '../attachmentPlane'
import { FILES_CATALOG_VERSION } from '../attachmentPlane'
import { createAttachmentPlane, FILES_CATALOG_FILENAME, readAndValidateCatalog } from '../attachmentPlane'
import type { SourceFileRow } from '../importDataPlane'

describe('attachmentPlane', () => {
  let tempDir: string

  function makePlane(overrides: Partial<Parameters<typeof createAttachmentPlane>[0]> = {}) {
    const filesDir = path.join(tempDir, 'candidate', 'Files')
    return createAttachmentPlane({
      sessionId: 'session-1',
      zipPath: path.join(tempDir, 'source.zip'),
      filesInventory: { entries: [], totalUncompressedBytes: 0 },
      candidateFilesDir: filesDir,
      catalogPath: path.join(tempDir, 'candidate', FILES_CATALOG_FILENAME),
      now: () => 1_700_000_000_000,
      ...overrides
    })
  }

  /** Set the inventory to one entry per (name, size). */
  function setInventory(plane: AttachmentPlane, entries: Array<[string, number]>) {
    ;(plane as unknown as { filesInventory: unknown }).filesInventory = {
      entries: entries.map(([entryName, size]) => ({ entryName, size })),
      totalUncompressedBytes: entries.reduce((a, [, s]) => a + s, 0)
    }
  }

  /** Configure the fake StreamZip for the given payload bytes. */
  function setStream(
    entriesMap: Record<string, { name: string; size: number; crc?: number; flags?: number }>,
    payload: Buffer
  ) {
    streamZipMock.config.entriesMap = entriesMap
    streamZipMock.config.streamImpl = () => Readable.from([payload])
    streamZipMock.config.payloadFor = () => payload
    streamZipMock.config.failOnOpen = false
  }

  function sourceFileRow(overrides: Partial<SourceFileRow> = {}): SourceFileRow {
    return {
      id: 'file-1',
      name: 'file-1.png',
      origin_name: 'photo.png',
      path: '/Users/source/Data/Files/file-1.png',
      size: 5,
      ext: '.png',
      type: 'image',
      created_at: '2020-01-01T00:00:00.000Z',
      count: 1,
      ...overrides
    }
  }

  /** A full zeroed degraded-count block (all known categories). */
  function degradedFixture(): Record<string, number> {
    return {
      missingPayload: 0,
      missingCatalogRow: 0,
      metadataMismatch: 0,
      payloadReadFailure: 0,
      lostContent: 0,
      invalidTargetName: 0,
      duplicateCatalogRow: 0
    }
  }

  /** A full zeroed skipped-count block (all known categories). */
  function skippedFixture(): Record<string, number> {
    return { payloadWithoutCatalog: 0 }
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-plane-test-'))
    streamZipMock.config.entriesMap = {}
    streamZipMock.config.streamImpl = null
    streamZipMock.config.payloadFor = null
    streamZipMock.config.failOnOpen = false
    streamZipMock.config.openCount = 0
    streamZipMock.config.closeCount = 0
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  describe('constants / format', () => {
    it('catalog handoff version is 1 (FILES_CATALOG_VERSION)', () => {
      expect(FILES_CATALOG_VERSION).toBe(1)
    })

    it('catalog filename is files-catalog.json', () => {
      expect(FILES_CATALOG_FILENAME).toBe('files-catalog.json')
    })
  })

  describe('healthy reconciliation (LOCK-FIX-2/5/6)', () => {
    it('extracts a byte-identical payload and writes a normalized catalog row (no source path)', async () => {
      const plane = makePlane()
      setInventory(plane, [['Data/Files/file-1.png', 5]])
      const payload = Buffer.from('hello')
      setStream({ 'Data/Files/file-1.png': { name: 'Data/Files/file-1.png', size: 5 } }, payload)
      const expectedSha = realCrypto.createHash('sha256').update(payload).digest('hex')

      const stats = await plane.finalize({
        sourceFileRows: [sourceFileRow()],
        referenceCounts: [['file-1', 2]]
      })

      expect(stats.healthyFileCount).toBe(1)
      expect(stats.catalogRowCount).toBe(1)
      expect(stats.extractedBytes).toBe(5)
      expect(stats.degraded.missingPayload).toBe(0)
      expect(stats.skipped.payloadWithoutCatalog).toBe(0)

      // Byte-identical payload at the canonical candidate path.
      const written = fs.readFileSync(path.join(tempDir, 'candidate', 'Files', 'file-1.png'))
      expect(written.equals(payload)).toBe(true)

      const catalog = plane.getCatalog()
      expect(catalog?.rows).toHaveLength(1)
      const row = catalog?.rows[0]
      expect(row).toEqual({
        id: 'file-1',
        name: 'file-1.png',
        origin_name: 'photo.png',
        size: 5,
        sha256: expectedSha,
        ext: '.png',
        type: 'image',
        created_at: '2020-01-01T00:00:00.000Z',
        // LOCK-FIX-6: rebuilt count = reference multiplicity (2), not the
        // source count (1).
        count: 2,
        // LOCK-FIX-6: candidate-relative path — the source absolute path
        // is never retained in the handoff.
        path: 'Files/file-1.png'
      })
      expect(row?.path).not.toContain('/Users/source')
      expect(JSON.stringify(catalog)).not.toContain('/Users/source')
    })

    it('imports an unreferenced but consistent catalog file (LOCK-FIX-5: catalog+payload imports even unreferenced)', async () => {
      const plane = makePlane()
      setInventory(plane, [['Data/Files/orphan.bin', 3]])
      setStream({ 'Data/Files/orphan.bin': { name: 'Data/Files/orphan.bin', size: 3 } }, Buffer.from('abc'))

      const stats = await plane.finalize({
        sourceFileRows: [
          sourceFileRow({ id: 'orphan', name: 'orphan.bin', ext: '.bin', origin_name: 'orphan.bin', size: 3 })
        ],
        referenceCounts: []
      })

      expect(stats.healthyFileCount).toBe(1)
      const row = plane.getCatalog()?.rows[0]
      // Unreferenced: count falls back to the source count (LOCK-FIX-6).
      expect(row?.count).toBe(1)
    })

    it('normalizes an unreferenced healthy row with source count 0 to target count 1 (survives startup orphan cleanup)', async () => {
      const plane = makePlane()
      setInventory(plane, [['Data/Files/orphan.bin', 3]])
      setStream({ 'Data/Files/orphan.bin': { name: 'Data/Files/orphan.bin', size: 3 } }, Buffer.from('abc'))

      const stats = await plane.finalize({
        sourceFileRows: [
          sourceFileRow({ id: 'orphan', name: 'orphan.bin', ext: '.bin', origin_name: 'orphan.bin', size: 3, count: 0 })
        ],
        referenceCounts: []
      })

      expect(stats.healthyFileCount).toBe(1)
      // A source count of 0 is floored at 1 — a count of 0 would be removed
      // by startup orphan cleanup (count <= 0).
      expect(plane.getCatalog()?.rows[0]?.count).toBe(1)
      // The durable handoff stays self-consistent with the normalized count
      // (the catalog must still validate on read-back).
      expect(readAndValidateCatalog(path.join(tempDir, 'candidate', FILES_CATALOG_FILENAME))?.rows[0]?.count).toBe(1)
    })

    it('defaults an unreferenced healthy row with an absent source count (null) to target count 1', async () => {
      const plane = makePlane()
      setInventory(plane, [['Data/Files/orphan.bin', 3]])
      setStream({ 'Data/Files/orphan.bin': { name: 'Data/Files/orphan.bin', size: 3 } }, Buffer.from('abc'))

      await plane.finalize({
        sourceFileRows: [
          sourceFileRow({
            id: 'orphan',
            name: 'orphan.bin',
            ext: '.bin',
            origin_name: 'orphan.bin',
            size: 3,
            count: null
          })
        ],
        referenceCounts: []
      })

      expect(plane.getCatalog()?.rows[0]?.count).toBe(1)
    })

    it('preserves a positive valid source count for an unreferenced healthy row', async () => {
      const plane = makePlane()
      setInventory(plane, [['Data/Files/orphan.bin', 3]])
      setStream({ 'Data/Files/orphan.bin': { name: 'Data/Files/orphan.bin', size: 3 } }, Buffer.from('abc'))

      await plane.finalize({
        sourceFileRows: [
          sourceFileRow({ id: 'orphan', name: 'orphan.bin', ext: '.bin', origin_name: 'orphan.bin', size: 3, count: 3 })
        ],
        referenceCounts: []
      })

      expect(plane.getCatalog()?.rows[0]?.count).toBe(3)
    })

    it('normalizes a negative-invalid source count for an unreferenced healthy row to 1', async () => {
      const plane = makePlane()
      setInventory(plane, [['Data/Files/orphan.bin', 3]])
      setStream({ 'Data/Files/orphan.bin': { name: 'Data/Files/orphan.bin', size: 3 } }, Buffer.from('abc'))

      await plane.finalize({
        sourceFileRows: [
          sourceFileRow({
            id: 'orphan',
            name: 'orphan.bin',
            ext: '.bin',
            origin_name: 'orphan.bin',
            size: 3,
            count: -1
          })
        ],
        referenceCounts: []
      })

      expect(plane.getCatalog()?.rows[0]?.count).toBe(1)
    })

    it('reference multiplicity dominates any source count for a healthy row', async () => {
      const plane = makePlane()
      setInventory(plane, [['Data/Files/file-1.png', 5]])
      setStream({ 'Data/Files/file-1.png': { name: 'Data/Files/file-1.png', size: 5 } }, Buffer.from('hello'))

      await plane.finalize({
        // A zero source count must NOT leak into the target row — the rebuilt
        // reference multiplicity (2) is authoritative.
        sourceFileRows: [sourceFileRow({ count: 0 })],
        referenceCounts: [['file-1', 2]]
      })

      expect(plane.getCatalog()?.rows[0]?.count).toBe(2)
    })

    it('healthy orphan survival semantics: unreferenced healthy rows always keep target count >= 1', async () => {
      // OrphanCleanupService removes rows with count <= 0 at startup, so a
      // healthy imported catalog+payload row with zero message references
      // must keep a target count >= 1 to survive the next startup while
      // positive source counts stay preserved.
      const plane = makePlane()
      setInventory(plane, [
        ['Data/Files/orphan0.bin', 3],
        ['Data/Files/orphanNull.bin', 3],
        ['Data/Files/kept.bin', 3]
      ])
      const payloads: Record<string, Buffer> = {
        'Data/Files/orphan0.bin': Buffer.from('abc'),
        'Data/Files/orphanNull.bin': Buffer.from('def'),
        'Data/Files/kept.bin': Buffer.from('ghi')
      }
      streamZipMock.config.entriesMap = {
        'Data/Files/orphan0.bin': { name: 'Data/Files/orphan0.bin', size: 3 },
        'Data/Files/orphanNull.bin': { name: 'Data/Files/orphanNull.bin', size: 3 },
        'Data/Files/kept.bin': { name: 'Data/Files/kept.bin', size: 3 }
      }
      streamZipMock.config.streamImpl = (name: string) => Readable.from([payloads[name]])
      streamZipMock.config.payloadFor = (name: string) => payloads[name]

      const stats = await plane.finalize({
        sourceFileRows: [
          sourceFileRow({
            id: 'orphan0',
            name: 'orphan0.bin',
            ext: '.bin',
            origin_name: 'orphan0.bin',
            size: 3,
            count: 0
          }),
          sourceFileRow({
            id: 'orphanNull',
            name: 'orphanNull.bin',
            ext: '.bin',
            origin_name: 'orphanNull.bin',
            size: 3,
            count: null
          }),
          sourceFileRow({ id: 'kept', name: 'kept.bin', ext: '.bin', origin_name: 'kept.bin', size: 3, count: 5 })
        ],
        referenceCounts: []
      })

      expect(stats.healthyFileCount).toBe(3)
      const counts = plane.getCatalog()?.rows.map((r) => r.count) ?? []
      expect(counts).toEqual([1, 1, 5])
      for (const count of counts) {
        expect(count).toBeGreaterThanOrEqual(1)
      }
    })

    it('accepts a legitimate empty extension (no-extension file)', async () => {
      const plane = makePlane()
      setInventory(plane, [['Data/Files/noext', 3]])
      setStream({ 'Data/Files/noext': { name: 'Data/Files/noext', size: 3 } }, Buffer.from('abc'))

      const stats = await plane.finalize({
        sourceFileRows: [sourceFileRow({ id: 'noext', name: 'noext', ext: '', size: 3, origin_name: 'noext' })],
        referenceCounts: []
      })

      expect(stats.healthyFileCount).toBe(1)
      expect(plane.getCatalog()?.rows[0]?.ext).toBe('')
      expect(plane.getCatalog()?.rows[0]?.path).toBe('Files/noext')
    })

    it('computes the streaming SHA-256 over a large payload without whole-file buffering', async () => {
      const plane = makePlane()
      // 1 MiB pseudo-random payload (deterministic seed bytes).
      const payload = realCrypto.createHash('sha256').update('seed').digest().subarray(0, 0)
      const big = Buffer.allocUnsafe(1024 * 1024)
      for (let i = 0; i < big.length; i++) {
        big[i] = (i * 31 + 7) & 0xff
      }
      setInventory(plane, [['Data/Files/big.bin', big.length]])
      setStream({ 'Data/Files/big.bin': { name: 'Data/Files/big.bin', size: big.length } }, big)

      const stats = await plane.finalize({
        sourceFileRows: [sourceFileRow({ id: 'big', name: 'big.bin', ext: '.bin', size: big.length })],
        referenceCounts: []
      })

      expect(stats.healthyFileCount).toBe(1)
      const expectedSha = realCrypto.createHash('sha256').update(big).digest('hex')
      expect(plane.getCatalog()?.rows[0]?.sha256).toBe(expectedSha)
      expect(payload.length).toBe(0) // sanity: no payload buffer retained
      const written = fs.readFileSync(path.join(tempDir, 'candidate', 'Files', 'big.bin'))
      expect(written.equals(big)).toBe(true)
    })
  })

  describe('degraded classification (LOCK-FIX-4/5)', () => {
    it('degrades a referenced payload missing from the ZIP (no row, no fake file)', async () => {
      const plane = makePlane()
      setInventory(plane, [])
      setStream({}, Buffer.alloc(0))

      const stats = await plane.finalize({
        sourceFileRows: [sourceFileRow()],
        referenceCounts: [['file-1', 1]]
      })

      expect(stats.degraded.missingPayload).toBe(1)
      expect(stats.healthyFileCount).toBe(0)
      expect(plane.getCatalog()?.rows).toHaveLength(0)
      expect(fs.existsSync(path.join(tempDir, 'candidate', 'Files', 'file-1.png'))).toBe(false)
    })

    it('degrades a referenced fileId with no catalog row (LOCK-FIX-4 missingCatalogRow)', async () => {
      const plane = makePlane()
      setInventory(plane, [])
      setStream({}, Buffer.alloc(0))

      const stats = await plane.finalize({
        sourceFileRows: [],
        referenceCounts: [['ref-only-file', 3]]
      })

      expect(stats.degraded.missingCatalogRow).toBe(1)
      expect(stats.referencedFileIdCount).toBe(1)
      expect(stats.healthyFileCount).toBe(0)
    })

    it('degrades a metadata disagreement (catalog size differs from physical authority)', async () => {
      const plane = makePlane()
      setInventory(plane, [['Data/Files/file-1.png', 5]])
      setStream({ 'Data/Files/file-1.png': { name: 'Data/Files/file-1.png', size: 5 } }, Buffer.from('hello'))

      const stats = await plane.finalize({
        sourceFileRows: [sourceFileRow({ size: 99 })],
        referenceCounts: [['file-1', 1]]
      })

      expect(stats.degraded.metadataMismatch).toBe(1)
      expect(stats.healthyFileCount).toBe(0)
      // No catalog row and no fake file are created (LOCK-FIX-4).
      expect(plane.getCatalog()?.rows).toHaveLength(0)
      expect(fs.existsSync(path.join(tempDir, 'candidate', 'Files', 'file-1.png'))).toBe(false)
    })

    it('treats an absent/invalid source size as "no claim" — physical size wins (LOCK-FIX-6)', async () => {
      const plane = makePlane()
      setInventory(plane, [['Data/Files/file-1.png', 5]])
      setStream({ 'Data/Files/file-1.png': { name: 'Data/Files/file-1.png', size: 5 } }, Buffer.from('hello'))

      const stats = await plane.finalize({
        sourceFileRows: [sourceFileRow({ size: null })],
        referenceCounts: []
      })

      expect(stats.healthyFileCount).toBe(1)
      expect(plane.getCatalog()?.rows[0]?.size).toBe(5)
    })

    it('degrades a truncated payload as lostContent and continues the batch', async () => {
      const plane = makePlane()
      setInventory(plane, [
        ['Data/Files/trunc.bin', 100],
        ['Data/Files/ok.bin', 2]
      ])
      // First payload streams only 90 bytes (claimed 100) → lostContent.
      // Second payload streams exactly its claimed bytes → healthy.
      const payloads: Record<string, Buffer> = {
        'Data/Files/trunc.bin': Buffer.alloc(90, 1),
        'Data/Files/ok.bin': Buffer.from('ok')
      }
      streamZipMock.config.entriesMap = {
        'Data/Files/trunc.bin': { name: 'Data/Files/trunc.bin', size: 100 },
        'Data/Files/ok.bin': { name: 'Data/Files/ok.bin', size: 2 }
      }
      streamZipMock.config.streamImpl = (name: string) => Readable.from([payloads[name]])
      streamZipMock.config.payloadFor = (name: string) => payloads[name]

      const stats = await plane.finalize({
        sourceFileRows: [
          sourceFileRow({ id: 'trunc', name: 'trunc.bin', ext: '.bin', size: 100 }),
          sourceFileRow({ id: 'ok', name: 'ok.bin', ext: '.bin', size: 2 })
        ],
        referenceCounts: []
      })

      expect(stats.degraded.lostContent).toBe(1)
      expect(stats.healthyFileCount).toBe(1)
      // The degraded payload left no partial file behind; the healthy one exists.
      expect(fs.existsSync(path.join(tempDir, 'candidate', 'Files', 'trunc.bin'))).toBe(false)
      expect(fs.readFileSync(path.join(tempDir, 'candidate', 'Files', 'ok.bin'), 'utf8')).toBe('ok')
    })

    it('degrades an oversized-per-claim payload as payloadReadFailure and continues', async () => {
      const plane = makePlane()
      setInventory(plane, [['Data/Files/over.bin', 10]])
      setStream({ 'Data/Files/over.bin': { name: 'Data/Files/over.bin', size: 10 } }, Buffer.alloc(110, 2))

      const stats = await plane.finalize({
        sourceFileRows: [sourceFileRow({ id: 'over', name: 'over.bin', ext: '.bin', size: 10 })],
        referenceCounts: []
      })

      expect(stats.degraded.payloadReadFailure).toBe(1)
      expect(stats.healthyFileCount).toBe(0)
      expect(fs.existsSync(path.join(tempDir, 'candidate', 'Files', 'over.bin'))).toBe(false)
    })

    it('degrades a stream read/CRC error as payloadReadFailure (parser safely continues)', async () => {
      const plane = makePlane()
      setInventory(plane, [['Data/Files/bad.bin', 5]])
      streamZipMock.config.entriesMap = { 'Data/Files/bad.bin': { name: 'Data/Files/bad.bin', size: 5 } }
      streamZipMock.config.streamImpl = () => {
        const r = new Readable()
        r._read = () => {
          r.destroy(new Error('synthetic crc mismatch'))
        }
        return r
      }

      const stats = await plane.finalize({
        sourceFileRows: [sourceFileRow({ id: 'bad', name: 'bad.bin', ext: '.bin', size: 5 })],
        referenceCounts: []
      })

      expect(stats.degraded.payloadReadFailure).toBe(1)
      expect(stats.healthyFileCount).toBe(0)
    })

    it('skips ZIP payloads matching no catalog row (payload without catalog/ref skips, LOCK-FIX-5)', async () => {
      const plane = makePlane()
      setInventory(plane, [
        ['Data/Files/file-1.png', 5],
        ['Data/Files/stray.bin', 4]
      ])
      const payloads: Record<string, Buffer> = {
        'Data/Files/file-1.png': Buffer.from('hello'),
        'Data/Files/stray.bin': Buffer.from('stray')
      }
      streamZipMock.config.entriesMap = {
        'Data/Files/file-1.png': { name: 'Data/Files/file-1.png', size: 5 },
        'Data/Files/stray.bin': { name: 'Data/Files/stray.bin', size: 4 }
      }
      streamZipMock.config.streamImpl = (name: string) => Readable.from([payloads[name]])
      streamZipMock.config.payloadFor = (name: string) => payloads[name]

      const stats = await plane.finalize({
        sourceFileRows: [sourceFileRow()],
        referenceCounts: []
      })

      expect(stats.healthyFileCount).toBe(1)
      expect(stats.skipped.payloadWithoutCatalog).toBe(1)
      // The stray payload is never materialized.
      expect(fs.existsSync(path.join(tempDir, 'candidate', 'Files', 'stray.bin'))).toBe(false)
    })

    it('degrades an unsafe id/ext target name without building a path (LOCK-FIX-6)', async () => {
      const plane = makePlane()
      setInventory(plane, [])
      setStream({}, Buffer.alloc(0))

      const stats = await plane.finalize({
        sourceFileRows: [sourceFileRow({ id: '../evil', ext: '.png' })],
        referenceCounts: []
      })

      expect(stats.degraded.invalidTargetName).toBe(1)
      expect(stats.healthyFileCount).toBe(0)
      // The traversal-shaped target name was never turned into a file.
      expect(fs.existsSync(path.join(tempDir, 'candidate', 'Files', '..evil.png'))).toBe(false)
      expect(fs.readdirSync(path.join(tempDir, 'candidate', 'Files')).length).toBe(0)
    })

    it('degrades duplicate source catalog rows count-only (first row wins)', async () => {
      const plane = makePlane()
      setInventory(plane, [['Data/Files/file-1.png', 5]])
      setStream({ 'Data/Files/file-1.png': { name: 'Data/Files/file-1.png', size: 5 } }, Buffer.from('hello'))

      const stats = await plane.finalize({
        sourceFileRows: [sourceFileRow(), sourceFileRow({ size: 999 })],
        referenceCounts: [['file-1', 1]]
      })

      expect(stats.degraded.duplicateCatalogRow).toBe(1)
      expect(stats.healthyFileCount).toBe(1)
      expect(plane.getCatalog()?.rows[0]?.size).toBe(5)
    })

    it('degrades an entry that disappeared from the reopened central directory (LOCK-CORR-4)', async () => {
      // The intake inventory claims the payload, but the reopened ZIP's
      // central directory no longer has it (archive changed mid-import).
      // This is a payload-level degrade — NEVER fatal (LOCK-CORR-4).
      const plane = makePlane()
      setInventory(plane, [['Data/Files/file-1.png', 5]])
      setStream({}, Buffer.alloc(0))

      const stats = await plane.finalize({
        sourceFileRows: [sourceFileRow()],
        referenceCounts: [['file-1', 1]]
      })

      expect(stats.degraded.payloadReadFailure).toBe(1)
      expect(stats.healthyFileCount).toBe(0)
      expect(plane.getCatalog()?.rows).toHaveLength(0)
      // No partial/fake file was materialized.
      expect(fs.existsSync(path.join(tempDir, 'candidate', 'Files', 'file-1.png'))).toBe(false)
    })

    it('degrades a per-entry stream-open failure instead of failing the archive (LOCK-CORR-4)', async () => {
      // The entry IS in the reopened central directory, but opening its
      // stream fails (e.g. the entry vanished between the CEN parse and the
      // stream open). Payload-level degrade — the parser can safely continue
      // with other entries; only archive open/CEN failures are fatal.
      const plane = makePlane()
      setInventory(plane, [
        ['Data/Files/bad.bin', 5],
        ['Data/Files/ok.bin', 2]
      ])
      const payloads: Record<string, Buffer> = {
        'Data/Files/bad.bin': Buffer.from('hello'),
        'Data/Files/ok.bin': Buffer.from('ok')
      }
      streamZipMock.config.entriesMap = {
        'Data/Files/bad.bin': { name: 'Data/Files/bad.bin', size: 5 },
        'Data/Files/ok.bin': { name: 'Data/Files/ok.bin', size: 2 }
      }
      streamZipMock.config.streamImpl = (name: string) => {
        if (name === 'Data/Files/bad.bin') {
          throw new Error('Entry not found') // library-style stream-open error
        }
        return Readable.from([payloads[name]])
      }
      streamZipMock.config.payloadFor = (name: string) => payloads[name]

      const stats = await plane.finalize({
        sourceFileRows: [
          sourceFileRow({ id: 'bad', name: 'bad.bin', ext: '.bin', size: 5 }),
          sourceFileRow({ id: 'ok', name: 'ok.bin', ext: '.bin', size: 2 })
        ],
        referenceCounts: []
      })

      expect(stats.degraded.payloadReadFailure).toBe(1)
      expect(stats.healthyFileCount).toBe(1)
      expect(fs.readFileSync(path.join(tempDir, 'candidate', 'Files', 'ok.bin'), 'utf8')).toBe('ok')
    })

    it('degrades a central-directory CRC mismatch as payloadReadFailure (LOCK-CORR-2)', async () => {
      // The streamed bytes decompress to exactly the claimed size, so
      // node-stream-zip's size/CRC verify (if any) would pass — only the
      // plane's OWN streaming CRC-32 vs the central-directory CRC catches it.
      const plane = makePlane()
      setInventory(plane, [
        ['Data/Files/corrupt.bin', 5],
        ['Data/Files/ok.bin', 2]
      ])
      const payloads: Record<string, Buffer> = {
        'Data/Files/corrupt.bin': Buffer.from('hello'),
        'Data/Files/ok.bin': Buffer.from('ok')
      }
      streamZipMock.config.entriesMap = {
        // CEN declares a WRONG CRC for this payload (corruption).
        'Data/Files/corrupt.bin': { name: 'Data/Files/corrupt.bin', size: 5, crc: 0xdeadbeef >>> 0 },
        'Data/Files/ok.bin': { name: 'Data/Files/ok.bin', size: 2 }
      }
      streamZipMock.config.streamImpl = (name: string) => Readable.from([payloads[name]])
      streamZipMock.config.payloadFor = (name: string) => payloads[name]

      const stats = await plane.finalize({
        sourceFileRows: [
          sourceFileRow({ id: 'corrupt', name: 'corrupt.bin', ext: '.bin', size: 5 }),
          sourceFileRow({ id: 'ok', name: 'ok.bin', ext: '.bin', size: 2 })
        ],
        referenceCounts: []
      })

      expect(stats.degraded.payloadReadFailure).toBe(1)
      expect(stats.healthyFileCount).toBe(1)
      // The corrupted payload left no row and no partial file.
      expect(plane.getCatalog()?.rows[0]?.id).toBe('ok')
      expect(fs.existsSync(path.join(tempDir, 'candidate', 'Files', 'corrupt.bin'))).toBe(false)
      expect(fs.readFileSync(path.join(tempDir, 'candidate', 'Files', 'ok.bin'), 'utf8')).toBe('ok')
    })

    it('verifies the streamed CRC for a bit-3 data-descriptor entry (LOCK-CORR-2)', async () => {
      // The real backup writer (archiver) emits data-descriptor (bit 3)
      // entries for which node-stream-zip SKIPS its own EntryVerifyStream.
      // The plane's streaming CRC-32 must still match the CEN CRC.
      const plane = makePlane()
      setInventory(plane, [['Data/Files/file-1.png', 5]])
      setStream(
        { 'Data/Files/file-1.png': { name: 'Data/Files/file-1.png', size: 5, flags: 0x08 } },
        Buffer.from('hello')
      )

      const stats = await plane.finalize({
        sourceFileRows: [sourceFileRow()],
        referenceCounts: []
      })

      expect(stats.healthyFileCount).toBe(1)
      expect(fs.readFileSync(path.join(tempDir, 'candidate', 'Files', 'file-1.png'), 'utf8')).toBe('hello')
    })
  })

  describe('fatal classes (LOCK-FIX-3)', () => {
    it('rejects an ambiguous payload per file ID atomically (AMBIGUOUS_PAYLOAD)', async () => {
      const plane = makePlane()
      // Two distinct entries resolve to the same basename file-1.png.
      setInventory(plane, [
        ['Data/Files/file-1.png', 5],
        ['Data/Files/sub/file-1.png', 5]
      ])
      setStream({}, Buffer.alloc(0))

      await expect(
        plane.finalize({
          sourceFileRows: [sourceFileRow()],
          referenceCounts: []
        })
      ).rejects.toMatchObject({ code: 'AMBIGUOUS_PAYLOAD' })
    })

    it('rejects a hard-cap overflow during streaming atomically (FILES_PAYLOAD_OVERFLOW)', async () => {
      const plane = makePlane({ singleEntryCapBytes: 10, cumulativeCapBytes: 100 })
      setInventory(plane, [['Data/Files/huge.bin', 20]])
      setStream({ 'Data/Files/huge.bin': { name: 'Data/Files/huge.bin', size: 20 } }, Buffer.alloc(20, 3))

      await expect(
        plane.finalize({
          sourceFileRows: [sourceFileRow({ id: 'huge', name: 'huge.bin', ext: '.bin', size: 20 })],
          referenceCounts: []
        })
      ).rejects.toMatchObject({ code: 'FILES_PAYLOAD_OVERFLOW' })
    })

    it('fails closed when the source ZIP cannot be reopened (FILES_EXTRACTION_FAILED)', async () => {
      const plane = makePlane()
      setInventory(plane, [['Data/Files/file-1.png', 5]])
      streamZipMock.config.entriesMap = { 'Data/Files/file-1.png': { name: 'Data/Files/file-1.png', size: 5 } }
      streamZipMock.config.failOnOpen = true

      await expect(
        plane.finalize({
          sourceFileRows: [sourceFileRow()],
          referenceCounts: []
        })
      ).rejects.toMatchObject({ code: 'FILES_EXTRACTION_FAILED' })
    })

    it('aborts on cancellation without writing a catalog (CANCELLED)', async () => {
      const plane = makePlane()
      setInventory(plane, [['Data/Files/file-1.png', 5]])
      setStream({ 'Data/Files/file-1.png': { name: 'Data/Files/file-1.png', size: 5 } }, Buffer.from('hello'))

      await expect(
        plane.finalize({
          sourceFileRows: [sourceFileRow()],
          referenceCounts: [],
          shouldAbort: () => true
        })
      ).rejects.toMatchObject({ code: 'CANCELLED' })

      expect(fs.existsSync(path.join(tempDir, 'candidate', FILES_CATALOG_FILENAME))).toBe(false)
    })

    it('finalize is exact-once', async () => {
      const plane = makePlane()
      setInventory(plane, [])
      setStream({}, Buffer.alloc(0))
      await plane.finalize({ sourceFileRows: [], referenceCounts: [] })
      await expect(plane.finalize({ sourceFileRows: [], referenceCounts: [] })).rejects.toMatchObject({
        code: 'CANDIDATE_STATE_UNRECOVERABLE'
      })
    })
  })

  describe('LOCK-CORR audit corrections (F1/F4)', () => {
    it('reopens + parses the ZIP exactly once per finalize, sharing the handle across payloads (LOCK-CORR-3/F4)', async () => {
      const plane = makePlane()
      setInventory(plane, [
        ['Data/Files/a.bin', 3],
        ['Data/Files/b.bin', 3],
        ['Data/Files/c.bin', 3]
      ])
      const payloads: Record<string, Buffer> = {
        'Data/Files/a.bin': Buffer.from('aaa'),
        'Data/Files/b.bin': Buffer.from('bbb'),
        'Data/Files/c.bin': Buffer.from('ccc')
      }
      streamZipMock.config.entriesMap = {
        'Data/Files/a.bin': { name: 'Data/Files/a.bin', size: 3 },
        'Data/Files/b.bin': { name: 'Data/Files/b.bin', size: 3 },
        'Data/Files/c.bin': { name: 'Data/Files/c.bin', size: 3 }
      }
      streamZipMock.config.streamImpl = (name: string) => Readable.from([payloads[name]])
      streamZipMock.config.payloadFor = (name: string) => payloads[name]

      const stats = await plane.finalize({
        sourceFileRows: [
          sourceFileRow({ id: 'a', name: 'a.bin', ext: '.bin', size: 3 }),
          sourceFileRow({ id: 'b', name: 'b.bin', ext: '.bin', size: 3 }),
          sourceFileRow({ id: 'c', name: 'c.bin', ext: '.bin', size: 3 })
        ],
        referenceCounts: []
      })

      expect(stats.healthyFileCount).toBe(3)
      // ONE constructor (reopen) + ONE entries() (CEN parse) for the whole
      // finalize — never per-payload (F4). Closed exactly once.
      expect(streamZipMock.config.openCount).toBe(1)
      expect(streamZipMock.config.closeCount).toBe(1)
    })

    it('does not open the ZIP at all when no payload needs extraction', async () => {
      const plane = makePlane()
      setInventory(plane, [])
      setStream({}, Buffer.alloc(0))

      const stats = await plane.finalize({
        sourceFileRows: [sourceFileRow()], // catalog row without payload → degrade
        referenceCounts: []
      })

      expect(stats.degraded.missingPayload).toBe(1)
      expect(streamZipMock.config.openCount).toBe(0)
      expect(streamZipMock.config.closeCount).toBe(0)
    })

    it('closes the shared archive exactly once on a fatal streaming path', async () => {
      // The archive is opened lazily for the payload; streaming then trips a
      // hard-cap overflow (fatal). The finally must close the ONE opened
      // handle exactly once.
      const plane = makePlane({ singleEntryCapBytes: 10, cumulativeCapBytes: 100 })
      setInventory(plane, [['Data/Files/huge.bin', 20]])
      setStream({ 'Data/Files/huge.bin': { name: 'Data/Files/huge.bin', size: 20 } }, Buffer.alloc(20, 3))

      await expect(
        plane.finalize({
          sourceFileRows: [sourceFileRow({ id: 'huge', name: 'huge.bin', ext: '.bin', size: 20 })],
          referenceCounts: []
        })
      ).rejects.toMatchObject({ code: 'FILES_PAYLOAD_OVERFLOW' })

      expect(streamZipMock.config.openCount).toBe(1)
      expect(streamZipMock.config.closeCount).toBe(1)
    })

    it('cancels immediately before durable catalog publication (LOCK-CORR-1/F1)', async () => {
      const plane = makePlane()
      setInventory(plane, [['Data/Files/file-1.png', 5]])
      setStream({ 'Data/Files/file-1.png': { name: 'Data/Files/file-1.png', size: 5 } }, Buffer.from('hello'))
      const payloadPath = path.join(tempDir, 'candidate', 'Files', 'file-1.png')

      // The payload is fully extracted before the plane publishes the
      // catalog. shouldAbort flips true as soon as the payload exists on
      // disk — i.e. AT the pre-publication recheck (LOCK-CORR-1) — so the
      // durable catalog is never written and no candidate-ready state is
      // reachable from the plane.
      const statsPromise = plane.finalize({
        sourceFileRows: [sourceFileRow()],
        referenceCounts: [],
        shouldAbort: () => fs.existsSync(payloadPath)
      })

      await expect(statsPromise).rejects.toMatchObject({ code: 'CANCELLED' })
      // No durable catalog publication happened on the cancelled session.
      expect(fs.existsSync(path.join(tempDir, 'candidate', FILES_CATALOG_FILENAME))).toBe(false)
      expect(plane.getCatalog()).toBeNull()
      expect(plane.getStats()).toBeNull()
      // The shared archive was closed exactly once even though finalize
      // aborted mid-publication.
      expect(streamZipMock.config.openCount).toBe(1)
      expect(streamZipMock.config.closeCount).toBe(1)
    })
  })

  describe('durable catalog handoff (LOCK-FIX-2/6)', () => {
    it('writes a durable catalog that validates on read-back', async () => {
      const plane = makePlane()
      setInventory(plane, [['Data/Files/file-1.png', 5]])
      setStream({ 'Data/Files/file-1.png': { name: 'Data/Files/file-1.png', size: 5 } }, Buffer.from('hello'))

      await plane.finalize({
        sourceFileRows: [sourceFileRow()],
        referenceCounts: [['file-1', 1]]
      })

      const catalogPath = path.join(tempDir, 'candidate', FILES_CATALOG_FILENAME)
      expect(fs.existsSync(catalogPath)).toBe(true)
      const parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
      expect(parsed.version).toBe(1)
      expect(parsed.sessionId).toBe('session-1')
      expect(parsed.rows).toHaveLength(1)
      // The durable artifact is re-validable through the same validator.
      expect(readAndValidateCatalog(catalogPath)).not.toBeNull()
    })

    it('readAndValidateCatalog rejects unsafe handoff content (traversal paths)', () => {
      const catalogPath = path.join(tempDir, 'bad-catalog.json')
      fs.writeFileSync(
        catalogPath,
        JSON.stringify({
          version: 1,
          sessionId: 's',
          createdAt: '2020-01-01T00:00:00.000Z',
          rows: [
            {
              id: 'x',
              name: 'x.png',
              origin_name: 'x.png',
              size: 1,
              sha256: 'a'.repeat(64),
              ext: '.png',
              type: null,
              created_at: null,
              count: 1,
              path: '../../etc/passwd'
            }
          ],
          referenced: { referencedFileIdCount: 0 },
          degraded: degradedFixture(),
          skipped: skippedFixture()
        }),
        'utf8'
      )
      expect(readAndValidateCatalog(catalogPath)).toBeNull()
    })

    it('readAndValidateCatalog rejects a wrong sha256 shape', () => {
      const catalogPath = path.join(tempDir, 'bad-sha.json')
      fs.writeFileSync(
        catalogPath,
        JSON.stringify({
          version: 1,
          sessionId: 's',
          createdAt: '2020-01-01T00:00:00.000Z',
          rows: [
            {
              id: 'x',
              name: 'x.png',
              origin_name: 'x.png',
              size: 1,
              sha256: 'not-a-hash',
              ext: '.png',
              type: null,
              created_at: null,
              count: 1,
              path: 'Files/x.png'
            }
          ],
          referenced: { referencedFileIdCount: 0 },
          degraded: degradedFixture(),
          skipped: skippedFixture()
        }),
        'utf8'
      )
      expect(readAndValidateCatalog(catalogPath)).toBeNull()
    })

    it('readAndValidateCatalog rejects a row whose name is not id + ext (LOCK-CORR)', () => {
      const catalogPath = path.join(tempDir, 'bad-name.json')
      fs.writeFileSync(
        catalogPath,
        JSON.stringify({
          version: 1,
          sessionId: 's',
          createdAt: '2020-01-01T00:00:00.000Z',
          rows: [
            {
              id: 'x',
              name: 'other.png', // ≠ 'x' + '.png'
              origin_name: 'x.png',
              size: 1,
              sha256: 'a'.repeat(64),
              ext: '.png',
              type: null,
              created_at: null,
              count: 1,
              path: 'Files/other.png'
            }
          ],
          referenced: { referencedFileIdCount: 0 },
          degraded: degradedFixture(),
          skipped: skippedFixture()
        }),
        'utf8'
      )
      expect(readAndValidateCatalog(catalogPath)).toBeNull()
    })

    it('readAndValidateCatalog accepts a legitimate empty-extension name (id + "")', () => {
      const catalogPath = path.join(tempDir, 'ok-noext.json')
      fs.writeFileSync(
        catalogPath,
        JSON.stringify({
          version: 1,
          sessionId: 's',
          createdAt: '2020-01-01T00:00:00.000Z',
          rows: [
            {
              id: 'noext',
              name: 'noext',
              origin_name: 'noext',
              size: 1,
              sha256: 'a'.repeat(64),
              ext: '',
              type: null,
              created_at: null,
              count: 1,
              path: 'Files/noext'
            }
          ],
          referenced: { referencedFileIdCount: 0 },
          degraded: degradedFixture(),
          skipped: skippedFixture()
        }),
        'utf8'
      )
      expect(readAndValidateCatalog(catalogPath)).not.toBeNull()
    })

    it('readAndValidateCatalog rejects a malformed aggregate shape (LOCK-CORR)', () => {
      const write = (overrides: Record<string, unknown>) => {
        const catalogPath = path.join(tempDir, 'bad-shape.json')
        fs.writeFileSync(
          catalogPath,
          JSON.stringify({
            version: 1,
            sessionId: 's',
            createdAt: '2020-01-01T00:00:00.000Z',
            rows: [],
            referenced: { referencedFileIdCount: 0 },
            degraded: degradedFixture(),
            skipped: skippedFixture(),
            ...overrides
          }),
          'utf8'
        )
        return catalogPath
      }

      // Unknown degraded category → reject.
      expect(readAndValidateCatalog(write({ degraded: { ...degradedFixture(), bogus: 1 } }))).toBeNull()
      // Missing a required degraded category → reject.
      const partial = degradedFixture()
      delete partial.missingPayload
      expect(readAndValidateCatalog(write({ degraded: partial }))).toBeNull()
      // Negative count → reject.
      expect(readAndValidateCatalog(write({ degraded: { ...degradedFixture(), missingPayload: -1 } }))).toBeNull()
      // Unknown skipped category → reject.
      expect(readAndValidateCatalog(write({ skipped: { ...skippedFixture(), bogus: 1 } }))).toBeNull()
      // referencedFileIdCount missing → reject.
      expect(readAndValidateCatalog(write({ referenced: {} }))).toBeNull()
      // A valid full shape still validates.
      expect(readAndValidateCatalog(write({}))).not.toBeNull()
    })

    it('finalize fails closed when a written payload disappears (CANDIDATE_STATE_UNRECOVERABLE)', async () => {
      const plane = makePlane()
      setInventory(plane, [['Data/Files/file-1.png', 5]])
      setStream({ 'Data/Files/file-1.png': { name: 'Data/Files/file-1.png', size: 5 } }, Buffer.from('hello'))

      const originalStat = fs.statSync
      // Sabotage the seal verification: report size 0 for the payload.
      fsMock.statSync = ((targetPath: string) => {
        const st = originalStat(targetPath)
        if (targetPath.endsWith('file-1.png')) {
          return { ...st, size: 0, isFile: () => true }
        }
        return st
      }) as any
      try {
        await expect(
          plane.finalize({
            sourceFileRows: [sourceFileRow()],
            referenceCounts: []
          })
        ).rejects.toMatchObject({ code: 'CANDIDATE_STATE_UNRECOVERABLE' })
      } finally {
        fsMock.statSync = originalStat
      }
    })
  })

  describe('private detail boundaries (LOCK-FIX-8)', () => {
    it('never exposes source paths in the catalog handoff (LOCK-FIX-8)', async () => {
      const plane = makePlane()
      setInventory(plane, [['Data/Files/file-1.png', 5]])
      setStream({ 'Data/Files/file-1.png': { name: 'Data/Files/file-1.png', size: 5 } }, Buffer.from('hello'))

      await plane.finalize({
        sourceFileRows: [
          sourceFileRow({
            path: '/private/var/folders/source/Data/Files/file-1.png',
            origin_name: 'my-2024-photo.png'
          })
        ],
        referenceCounts: []
      })

      const catalogJson = JSON.stringify(plane.getCatalog())
      // The source absolute path and any other machine-specific location
      // never reach the handoff (LOCK-FIX-6/8).
      expect(catalogJson).not.toContain('/private/var')
      expect(catalogJson).not.toContain('/source/Data/Files')
      // The normalized display name IS an application artifact required for
      // the Dexie handoff, so it is retained (LOCK-FIX-8 carve-out).
      expect(catalogJson).toContain('my-2024-photo.png')
      expect(plane.getCatalog()?.rows[0]?.path).toBe('Files/file-1.png')
    })
  })

  describe('stats shape', () => {
    it('returns the full count-only stats contract', async () => {
      const plane = makePlane()
      setInventory(plane, [])
      setStream({}, Buffer.alloc(0))
      const stats = await plane.finalize({ sourceFileRows: [], referenceCounts: [] })
      expect(stats).toEqual({
        catalogRowCount: 0,
        healthyFileCount: 0,
        extractedBytes: 0,
        referencedFileIdCount: 0,
        degraded: {
          missingPayload: 0,
          missingCatalogRow: 0,
          metadataMismatch: 0,
          payloadReadFailure: 0,
          lostContent: 0,
          invalidTargetName: 0,
          duplicateCatalogRow: 0
        },
        skipped: { payloadWithoutCatalog: 0 }
      })
      expect(plane.getStats()).toEqual(stats)
    })
  })

  describe('privacy-internal degraded file ids (LOCK-UI-2/5)', () => {
    it('throws before a successful finalize (fail closed)', () => {
      const plane = makePlane()
      expect(() => plane.getDegradedFileIds()).toThrow('CANDIDATE_STATE_UNRECOVERABLE')
    })

    it('returns an empty set for a healthy import (LOCK-UI-2: healthy files excluded)', async () => {
      const plane = makePlane()
      setInventory(plane, [['Data/Files/file-1.png', 5]])
      setStream({ 'Data/Files/file-1.png': { name: 'Data/Files/file-1.png', size: 5 } }, Buffer.from('hello'))
      await plane.finalize({ sourceFileRows: [sourceFileRow()], referenceCounts: [['file-1', 1]] })

      expect(plane.getDegradedFileIds()).toEqual([])
      // The aggregate catalog/stats carry NO degraded identity — the degraded
      // classification stays count-only (LOCK-UI-5); healthy catalog rows
      // legitimately carry their source file ids (handoff contract).
      expect(plane.getStats()?.degraded).toEqual({
        missingPayload: 0,
        missingCatalogRow: 0,
        metadataMismatch: 0,
        payloadReadFailure: 0,
        lostContent: 0,
        invalidTargetName: 0,
        duplicateCatalogRow: 0
      })
      expect(JSON.stringify(plane.getCatalog()?.degraded)).not.toContain('degraded-file')
    })

    it('includes missingPayload and missingCatalogRow ids', async () => {
      const plane = makePlane()
      setInventory(plane, [])
      setStream({}, Buffer.alloc(0))
      await plane.finalize({
        sourceFileRows: [sourceFileRow()],
        referenceCounts: [
          ['file-1', 1],
          ['ref-only', 2]
        ]
      })

      const ids = new Set(plane.getDegradedFileIds())
      expect(ids.has('file-1')).toBe(true) // missingPayload
      expect(ids.has('ref-only')).toBe(true) // missingCatalogRow
      expect(plane.getStats()?.degraded.missingPayload).toBe(1)
      expect(plane.getStats()?.degraded.missingCatalogRow).toBe(1)
    })

    it('includes metadataMismatch, payloadReadFailure, lostContent, and invalidTargetName ids', async () => {
      // metadataMismatch
      const planeA = makePlane()
      setInventory(planeA, [['Data/Files/file-1.png', 5]])
      setStream({ 'Data/Files/file-1.png': { name: 'Data/Files/file-1.png', size: 5 } }, Buffer.from('hello'))
      await planeA.finalize({ sourceFileRows: [sourceFileRow({ size: 99 })], referenceCounts: [] })
      expect(new Set(planeA.getDegradedFileIds()).has('file-1')).toBe(true)

      // payloadReadFailure (CRC mismatch)
      const planeB = makePlane()
      setInventory(planeB, [['Data/Files/corrupt.bin', 5]])
      streamZipMock.config.entriesMap = {
        'Data/Files/corrupt.bin': { name: 'Data/Files/corrupt.bin', size: 5, crc: 0xdeadbeef >>> 0 }
      }
      streamZipMock.config.streamImpl = () => Readable.from([Buffer.from('hello')])
      streamZipMock.config.payloadFor = () => Buffer.from('hello')
      await planeB.finalize({
        sourceFileRows: [sourceFileRow({ id: 'corrupt', name: 'corrupt.bin', ext: '.bin', size: 5 })],
        referenceCounts: []
      })
      expect(new Set(planeB.getDegradedFileIds()).has('corrupt')).toBe(true)

      // lostContent (truncated)
      const planeC = makePlane()
      setInventory(planeC, [['Data/Files/trunc.bin', 100]])
      streamZipMock.config.entriesMap = { 'Data/Files/trunc.bin': { name: 'Data/Files/trunc.bin', size: 100 } }
      streamZipMock.config.streamImpl = () => Readable.from([Buffer.alloc(90, 1)])
      streamZipMock.config.payloadFor = () => Buffer.alloc(90, 1)
      await planeC.finalize({
        sourceFileRows: [sourceFileRow({ id: 'trunc', name: 'trunc.bin', ext: '.bin', size: 100 })],
        referenceCounts: []
      })
      expect(new Set(planeC.getDegradedFileIds()).has('trunc')).toBe(true)

      // invalidTargetName
      const planeD = makePlane()
      setInventory(planeD, [])
      setStream({}, Buffer.alloc(0))
      await planeD.finalize({ sourceFileRows: [sourceFileRow({ id: '../evil', ext: '.png' })], referenceCounts: [] })
      expect(new Set(planeD.getDegradedFileIds()).has('../evil')).toBe(true)
    })

    it('excludes duplicateCatalogRow ids (first row wins — the file stays healthy, LOCK-UI-2)', async () => {
      const plane = makePlane()
      setInventory(plane, [['Data/Files/file-1.png', 5]])
      setStream({ 'Data/Files/file-1.png': { name: 'Data/Files/file-1.png', size: 5 } }, Buffer.from('hello'))
      await plane.finalize({
        sourceFileRows: [sourceFileRow(), sourceFileRow({ size: 999 })],
        referenceCounts: [['file-1', 1]]
      })

      expect(plane.getStats()?.degraded.duplicateCatalogRow).toBe(1)
      // The file was materialized healthy (first row won) → never unavailable.
      expect(plane.getDegradedFileIds()).toEqual([])
    })

    it('excludes skipped unreferenced orphan payloads (LOCK-UI-2)', async () => {
      const plane = makePlane()
      setInventory(plane, [['Data/Files/stray.bin', 4]])
      streamZipMock.config.entriesMap = { 'Data/Files/stray.bin': { name: 'Data/Files/stray.bin', size: 4 } }
      streamZipMock.config.streamImpl = () => Readable.from([Buffer.from('stray')])
      streamZipMock.config.payloadFor = () => Buffer.from('stray')
      await plane.finalize({ sourceFileRows: [], referenceCounts: [] })

      expect(plane.getStats()?.skipped.payloadWithoutCatalog).toBe(1)
      expect(plane.getDegradedFileIds()).toEqual([])
    })

    it('snapshots the set without aliasing (LOCK-UI-5 Main-only contract)', async () => {
      const plane = makePlane()
      setInventory(plane, [])
      setStream({}, Buffer.alloc(0))
      await plane.finalize({ sourceFileRows: [sourceFileRow()], referenceCounts: [] })

      const ids = plane.getDegradedFileIds()
      expect(ids).toEqual(['file-1'])
      // Repeated calls return equal snapshots; mutating one never affects the
      // next read (Main-internal set stays private).
      ;(ids as string[]).push('tampered')
      expect(plane.getDegradedFileIds()).toEqual(['file-1'])
    })
  })
})
