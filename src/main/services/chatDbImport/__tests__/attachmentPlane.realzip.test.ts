/**
 * attachmentPlane REAL-ZIP tests (LOCK-CORR-2/3/4/5) — actual ZIP bytes in
 * data-descriptor (bit 3) form, verified through the REAL node-stream-zip
 * library (not a mock):
 *
 * - LOCK-CORR-2: the plane's own streaming CRC-32 catches real corruption in
 *   bit-3 entries that node-stream-zip skips verifying (the form the real
 *   backup writer — archiver — produces).
 * - LOCK-CORR-3: one ZIP reopen + one central-directory parse per finalize.
 * - LOCK-CORR-4: an entry absent from the reopened central directory is a
 *   payload-level degrade, not a fatal.
 * - LOCK-CORR-1: cancellation immediately before durable catalog publication
 *   leaves no catalog and never publishes candidate state.
 * - LOCK-CORR-5: realistic bytes (archiver output + hand-crafted bit-3
 *   archives with real CEN CRCs), not only mocked impossible errors.
 *
 * node:fs / node:os / node:path are overridden with REAL implementations
 * (main.setup.ts mocks them for the main suite) using the same mutable-fs
 * pattern as attachmentPlane.test.ts / zipIntake.test.ts.
 */

import * as realCrypto from 'node:crypto'
import type * as NodeFs from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mutable fs wrapper: properties can be overridden per-test. `default`
// points to itself so `import fs from 'node:fs'` resolves to the real API.
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

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import StreamZip from 'node-stream-zip'

import type { AttachmentPlane } from '../attachmentPlane'
import { createAttachmentPlane, FILES_CATALOG_FILENAME, readAndValidateCatalog } from '../attachmentPlane'
import type { SourceFileRow } from '../importDataPlane'

// ---------------------------------------------------------------------------
// Real bit-3 ZIP builder (LOCK-CORR-5)
// ---------------------------------------------------------------------------

/**
 * Build a real ZIP archive with data-descriptor (bit 3) entries and REAL
 * central-directory CRCs. `content` is the uncompressed payload; method 8
 * deflates it (matching the real writer). When `cenCrc` is provided it
 * overrides the CEN-declared CRC — the ONLY way to fabricate real
 * corruption that node-stream-zip will skip verifying (bit 3) while the
 * plane's own CRC-32 check still detects.
 */
function buildDataDescriptorZip(
  entries: Array<{
    name: string
    content: Buffer
    method?: 0 | 8
    flags?: number
    cenCrc?: number
  }>
): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0

  for (const spec of entries) {
    const name = Buffer.from(spec.name)
    const flags = spec.flags ?? 0x08 // default: data descriptor (bit 3)
    const method = spec.method ?? 8
    const content = spec.content
    const comp = method === 8 ? zlib.deflateRawSync(content) : content
    const realCrc = zlib.crc32(content) >>> 0
    const crc = spec.cenCrc ?? realCrc
    const hasDataDescriptor = (flags & 0x8) !== 0

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(flags, 6)
    localHeader.writeUInt16LE(method, 8)
    localHeader.writeUInt16LE(0, 10)
    localHeader.writeUInt16LE(0, 12)
    // Bit-3: local sizes/CRC are zero (they live in the data descriptor).
    localHeader.writeUInt32LE(hasDataDescriptor ? 0 : crc, 14)
    localHeader.writeUInt32LE(hasDataDescriptor ? 0 : comp.length, 18)
    localHeader.writeUInt32LE(hasDataDescriptor ? 0 : content.length, 22)
    localHeader.writeUInt16LE(name.length, 26)
    localHeader.writeUInt16LE(0, 28)
    localParts.push(Buffer.concat([localHeader, name, comp]))

    if (hasDataDescriptor) {
      const dd = Buffer.alloc(16)
      dd.writeUInt32LE(0x08074b50, 0)
      dd.writeUInt32LE(crc, 4)
      dd.writeUInt32LE(comp.length, 8)
      dd.writeUInt32LE(content.length, 12)
      localParts.push(dd)
    }

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(flags, 8)
    centralHeader.writeUInt16LE(method, 10)
    centralHeader.writeUInt16LE(0, 12)
    centralHeader.writeUInt16LE(0, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(comp.length, 20)
    centralHeader.writeUInt32LE(content.length, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(localOffset, 42)
    centralParts.push(Buffer.concat([centralHeader, name]))

    localOffset += 30 + name.length + comp.length + (hasDataDescriptor ? 16 : 0)
  }

  const centralDirectory = Buffer.concat(centralParts)
  const endOfCentralDirectory = Buffer.alloc(22)
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0)
  endOfCentralDirectory.writeUInt16LE(entries.length, 8)
  endOfCentralDirectory.writeUInt16LE(entries.length, 10)
  endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12)
  endOfCentralDirectory.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...localParts, centralDirectory, endOfCentralDirectory])
}

// ---------------------------------------------------------------------------
// StreamZip instrumentation (one open / one CEN parse per finalize — F4)
// ---------------------------------------------------------------------------

/** Wrap the real StreamZip.async to count constructor/entries() calls. */
function instrumentStreamZip() {
  const AsyncClass = StreamZip.async
  const counts = { open: 0, entries: 0 }
  const Wrapped = class extends AsyncClass {
    constructor(options: ConstructorParameters<typeof AsyncClass>[0]) {
      super(options)
      counts.open += 1
    }
    async entries() {
      counts.entries += 1
      return super.entries()
    }
  }
  // The plane reads `StreamZip.async` at call time; patching the shared
  // class object instruments it for the duration of the test.
  ;(StreamZip as unknown as { async: unknown }).async = Wrapped
  return { counts, restore: () => ((StreamZip as unknown as { async: unknown }).async = AsyncClass) }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

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

describe('attachmentPlane (real ZIP bytes, data-descriptor form — LOCK-CORR-2/3/4/5)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-plane-realzip-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function makePlane(zipBytes: Buffer) {
    const zipPath = path.join(tempDir, 'source.zip')
    fs.writeFileSync(zipPath, zipBytes)
    const filesDir = path.join(tempDir, 'candidate', 'Files')
    return createAttachmentPlane({
      sessionId: 'session-real',
      zipPath,
      filesInventory: { entries: [], totalUncompressedBytes: 0 },
      candidateFilesDir: filesDir,
      catalogPath: path.join(tempDir, 'candidate', FILES_CATALOG_FILENAME),
      now: () => 1_700_000_000_000
    })
  }

  /** Overwrite the plane's intake inventory (as if zipIntake produced it). */
  function setInventory(plane: AttachmentPlane, entries: Array<[string, number]>) {
    ;(plane as unknown as { filesInventory: unknown }).filesInventory = {
      entries: entries.map(([entryName, size]) => ({ entryName, size })),
      totalUncompressedBytes: entries.reduce((a, [, s]) => a + s, 0)
    }
  }

  it('extracts real data-descriptor payloads healthy and CRC-verifies them (LOCK-CORR-2/5)', async () => {
    const payload = Buffer.from('hello real zip')
    const zipBytes = buildDataDescriptorZip([
      { name: 'Data/Files/file-1.png', content: payload, method: 8, flags: 0x08 }
    ])
    const plane = makePlane(zipBytes)
    setInventory(plane, [['Data/Files/file-1.png', payload.length]])

    const stats = await plane.finalize({
      sourceFileRows: [sourceFileRow({ size: payload.length })],
      referenceCounts: []
    })

    expect(stats.healthyFileCount).toBe(1)
    const written = fs.readFileSync(path.join(tempDir, 'candidate', 'Files', 'file-1.png'))
    expect(written.equals(payload)).toBe(true)
    const expectedSha = realCrypto.createHash('sha256').update(payload).digest('hex')
    expect(plane.getCatalog()?.rows[0]?.sha256).toBe(expectedSha)
    // The durable handoff re-validates through the same validator.
    expect(readAndValidateCatalog(path.join(tempDir, 'candidate', FILES_CATALOG_FILENAME))).not.toBeNull()
  })

  it('degrades REAL data-descriptor corruption that node-stream-zip skips verifying (LOCK-CORR-2/5)', async () => {
    // CEN declares a WRONG CRC for content that decompresses to exactly the
    // claimed size. The entry is bit-3 (data descriptor), so node-stream-zip
    // does NOT run its EntryVerifyStream — only the plane's streaming CRC-32
    // can detect the corruption.
    const good = Buffer.from('good-payload')
    const corrupted = Buffer.from('this content is real but its CEN crc is wrong')
    const zipBytes = buildDataDescriptorZip([
      { name: 'Data/Files/bad.bin', content: corrupted, method: 8, flags: 0x08, cenCrc: 0x1234abcd >>> 0 },
      { name: 'Data/Files/good.bin', content: good, method: 8, flags: 0x08 }
    ])
    const plane = makePlane(zipBytes)
    setInventory(plane, [
      ['Data/Files/bad.bin', corrupted.length],
      ['Data/Files/good.bin', good.length]
    ])

    // Prove the library itself skips CRC verification for this bit-3 entry
    // (the corruption is ONLY detectable by the plane's own check).
    const probe = new StreamZip.async({ file: path.join(tempDir, 'source.zip') })
    try {
      const probeEntries = await probe.entries()
      expect((probeEntries['Data/Files/bad.bin'] as { flags: number }).flags & 0x8).toBe(0x8)
    } finally {
      await probe.close()
    }

    const stats = await plane.finalize({
      sourceFileRows: [
        sourceFileRow({ id: 'bad', name: 'bad.bin', ext: '.bin', size: corrupted.length }),
        sourceFileRow({ id: 'good', name: 'good.bin', ext: '.bin', size: good.length })
      ],
      referenceCounts: []
    })

    expect(stats.degraded.payloadReadFailure).toBe(1)
    expect(stats.healthyFileCount).toBe(1)
    // The corrupted payload left no row and no file; the good one is intact.
    expect(plane.getCatalog()?.rows[0]?.id).toBe('good')
    expect(fs.existsSync(path.join(tempDir, 'candidate', 'Files', 'bad.bin'))).toBe(false)
    expect(fs.readFileSync(path.join(tempDir, 'candidate', 'Files', 'good.bin'), 'utf8')).toBe('good-payload')
  })

  it('extracts an ORDINARY archiver-made backup (real writer, bit-3) with CRC verification (LOCK-CORR-2/5)', async () => {
    const { default: archiver } = await import('archiver')
    const zipPath = path.join(tempDir, 'archiver-source.zip')
    const out = fs.createWriteStream(zipPath)
    const archive = archiver('zip', { zlib: { level: 9 } })
    const closed = new Promise<void>((resolve, reject) => {
      out.on('close', resolve)
      out.on('error', reject)
      archive.on('error', reject)
    })
    archive.pipe(out)
    archive.append(Buffer.from('archiver-payload-123'), { name: 'Data/Files/file-1.png' })
    await archive.finalize()
    await closed

    const plane = createAttachmentPlane({
      sessionId: 'session-archiver',
      zipPath,
      filesInventory: { entries: [], totalUncompressedBytes: 0 },
      candidateFilesDir: path.join(tempDir, 'candidate', 'Files'),
      catalogPath: path.join(tempDir, 'candidate', FILES_CATALOG_FILENAME),
      now: () => 1_700_000_000_000
    })
    setInventory(plane, [['Data/Files/file-1.png', 20]])

    const stats = await plane.finalize({
      sourceFileRows: [sourceFileRow({ size: 20 })],
      referenceCounts: []
    })

    expect(stats.healthyFileCount).toBe(1)
    expect(fs.readFileSync(path.join(tempDir, 'candidate', 'Files', 'file-1.png'), 'utf8')).toBe('archiver-payload-123')
  })

  it('reopens + parses the ZIP exactly once for multiple payloads (LOCK-CORR-3/F4)', async () => {
    const zipBytes = buildDataDescriptorZip([
      { name: 'Data/Files/a.bin', content: Buffer.from('aaa'), method: 8, flags: 0x08 },
      { name: 'Data/Files/b.bin', content: Buffer.from('bbb'), method: 8, flags: 0x08 },
      { name: 'Data/Files/c.bin', content: Buffer.from('ccc'), method: 8, flags: 0x08 }
    ])
    const plane = makePlane(zipBytes)
    setInventory(plane, [
      ['Data/Files/a.bin', 3],
      ['Data/Files/b.bin', 3],
      ['Data/Files/c.bin', 3]
    ])

    const instr = instrumentStreamZip()
    try {
      const stats = await plane.finalize({
        sourceFileRows: [
          sourceFileRow({ id: 'a', name: 'a.bin', ext: '.bin', size: 3 }),
          sourceFileRow({ id: 'b', name: 'b.bin', ext: '.bin', size: 3 }),
          sourceFileRow({ id: 'c', name: 'c.bin', ext: '.bin', size: 3 })
        ],
        referenceCounts: []
      })
      expect(stats.healthyFileCount).toBe(3)
      // ONE reopen + ONE central-directory parse for the whole finalize (F4).
      expect(instr.counts.open).toBe(1)
      expect(instr.counts.entries).toBe(1)
    } finally {
      instr.restore()
    }
  })

  it('degrades an entry absent from the reopened central directory (LOCK-CORR-4)', async () => {
    // The intake inventory claims Data/Files/file-1.png, but the actual
    // archive does not contain it. Payload-level degrade, never fatal.
    const zipBytes = buildDataDescriptorZip([
      { name: 'Data/Files/other.bin', content: Buffer.from('other'), method: 8, flags: 0x08 }
    ])
    const plane = makePlane(zipBytes)
    setInventory(plane, [['Data/Files/file-1.png', 5]])

    const stats = await plane.finalize({
      sourceFileRows: [sourceFileRow()],
      referenceCounts: [['file-1', 1]]
    })

    expect(stats.degraded.payloadReadFailure).toBe(1)
    expect(stats.healthyFileCount).toBe(0)
    expect(plane.getCatalog()?.rows).toHaveLength(0)
    expect(fs.existsSync(path.join(tempDir, 'candidate', 'Files', 'file-1.png'))).toBe(false)
  })

  it('leaves no catalog and no candidate-ready state when cancelled before publication (LOCK-CORR-1/F1)', async () => {
    const payload = Buffer.from('cancel-me')
    const zipBytes = buildDataDescriptorZip([
      { name: 'Data/Files/file-1.png', content: payload, method: 8, flags: 0x08 }
    ])
    const plane = makePlane(zipBytes)
    setInventory(plane, [['Data/Files/file-1.png', payload.length]])
    const payloadPath = path.join(tempDir, 'candidate', 'Files', 'file-1.png')

    const statsPromise = plane.finalize({
      sourceFileRows: [sourceFileRow({ size: payload.length })],
      referenceCounts: [],
      // The payload is fully extracted before publication: shouldAbort flips
      // true exactly at the pre-publication recheck (LOCK-CORR-1).
      shouldAbort: () => fs.existsSync(payloadPath)
    })

    await expect(statsPromise).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(fs.existsSync(path.join(tempDir, 'candidate', FILES_CATALOG_FILENAME))).toBe(false)
    expect(plane.getCatalog()).toBeNull()
    expect(plane.getStats()).toBeNull()
  })
})
