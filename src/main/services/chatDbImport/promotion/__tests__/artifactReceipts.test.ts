/**
 * Aggregate artifact receipt primitives (LOCK-PROMO-9/12, LOCK-ART-2/5).
 *
 * Covers:
 * - Deterministic + order-independent files receipts over canonical
 *   `{name,size,sha256}` records (count/totalBytes/digest exactness).
 * - Deterministic + order-independent catalog receipts over canonical
 *   `{id,name,size,count}` records; digest EXACTLY matches the shared
 *   renderer `filesCatalogHashInput` format (cross-boundary agreement).
 * - Empty-input receipts (an empty generation is a valid first-class
 *   receipt — LOCK-ART-1).
 * - db receipt streaming over real files (empty + multi-MB).
 * - Privacy: aggregate receipts expose count/totalBytes/digest ONLY — never
 *   filenames, paths, or content (LOCK-ART-2).
 * - emptyArtifactReceipts / isAllNullReceipts.
 *
 * Real node:crypto + real temp files. No mocks except DATA_PATH.
 */

import type * as NodeCrypto from 'node:crypto'
import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

vi.mock('@main/config', () => ({ DATA_PATH: '/mock/data' }))

import { filesCatalogHashInput, type FilesCatalogSnapshotRow } from '@shared/chatImport/types'

import {
  type CatalogReceiptRow,
  computeCatalogReceipt,
  computeDbReceipt,
  computeFilesReceipt,
  emptyArtifactReceipts,
  type FilesReceiptEntry,
  isAllNullReceipts,
  liveDbReceiptMatchesCandidate
} from '../artifactReceipts'

const SHA256_HEX = /^[0-9a-f]{64}$/

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-receipts-'))
}

function sha256HexOf(content: Buffer | string): string {
  const { createHash } = require('node:crypto') as typeof NodeCrypto
  return createHash('sha256').update(content).digest('hex')
}

describe('computeFilesReceipt', () => {
  it('computes count/totalBytes and a digest over sorted name\\0size\\0sha256 records', () => {
    const entries: FilesReceiptEntry[] = [
      { name: 'b.png', size: 3, sha256: sha256HexOf('b01') },
      { name: 'a.png', size: 2, sha256: sha256HexOf('a0') },
      { name: 'c.png', size: 4, sha256: sha256HexOf('c001') }
    ]
    const receipt = computeFilesReceipt(entries)
    expect(receipt.count).toBe(3)
    expect(receipt.totalBytes).toBe(9)
    expect(receipt.sha256).toMatch(SHA256_HEX)
    // Manual digest over the sorted records — exact byte format
    // `name\0size\0sha256\n`.
    const { createHash } = require('node:crypto') as typeof NodeCrypto
    const manual = createHash('sha256')
      .update(`a.png\0${2}\0${sha256HexOf('a0')}\n`)
      .update(`b.png\0${3}\0${sha256HexOf('b01')}\n`)
      .update(`c.png\0${4}\0${sha256HexOf('c001')}\n`)
      .digest('hex')
    expect(receipt.sha256).toBe(manual)
  })

  it('is order-independent (deterministic for any input order)', () => {
    const base: FilesReceiptEntry[] = [
      { name: 'x.png', size: 1, sha256: sha256HexOf('x') },
      { name: 'y.png', size: 2, sha256: sha256HexOf('yy') },
      { name: 'z.png', size: 3, sha256: sha256HexOf('zzz') }
    ]
    const reversed = [...base].reverse()
    const shuffled = [base[1], base[2], base[0]]
    expect(computeFilesReceipt(base)).toEqual(computeFilesReceipt(reversed))
    expect(computeFilesReceipt(base)).toEqual(computeFilesReceipt(shuffled))
  })

  it('does not mutate or share input ordering', () => {
    const entries: FilesReceiptEntry[] = [
      { name: 'b', size: 1, sha256: sha256HexOf('b') },
      { name: 'a', size: 2, sha256: sha256HexOf('a') }
    ]
    computeFilesReceipt(entries)
    expect(entries.map((e) => e.name)).toEqual(['b', 'a'])
  })

  it('returns an all-zero-shaped receipt for an empty generation (LOCK-ART-1)', () => {
    const receipt = computeFilesReceipt([])
    expect(receipt).toEqual({ count: 0, totalBytes: 0, sha256: sha256HexOf('') })
  })

  it('is a pure aggregate: the receipt exposes no filenames or content', () => {
    const secretName = 'private-attachment-uuid.png'
    const receipt = computeFilesReceipt([{ name: secretName, size: 4, sha256: sha256HexOf('abcd') }])
    const serialized = JSON.stringify(receipt)
    expect(serialized).not.toContain(secretName)
    expect(serialized).not.toContain('abcd')
    expect(Object.keys(receipt).sort()).toEqual(['count', 'sha256', 'totalBytes'])
  })
})

describe('computeCatalogReceipt', () => {
  function rows(order: 'natural' | 'reversed' | 'shuffled'): CatalogReceiptRow[] {
    const base: CatalogReceiptRow[] = [
      { id: 'id-b', name: 'b.png', size: 10, count: 2 },
      { id: 'id-a', name: 'a.png', size: 5, count: 1 },
      { id: 'id-c', name: 'c.png', size: 15, count: 3 }
    ]
    if (order === 'reversed') return [...base].reverse()
    if (order === 'shuffled') return [base[1], base[2], base[0]]
    return base
  }

  it('is deterministic and order-independent', () => {
    expect(computeCatalogReceipt(rows('natural'))).toEqual(computeCatalogReceipt(rows('reversed')))
    expect(computeCatalogReceipt(rows('natural'))).toEqual(computeCatalogReceipt(rows('shuffled')))
    const receipt = computeCatalogReceipt(rows('natural'))
    expect(receipt.count).toBe(3)
    expect(receipt.sha256).toMatch(SHA256_HEX)
  })

  it('digests EXACTLY the shared renderer hash input (main/renderer agreement)', () => {
    const snapshotRows: FilesCatalogSnapshotRow[] = rows('natural').map((r) => ({
      id: r.id,
      name: r.name,
      origin_name: '',
      path: '',
      size: r.size,
      ext: '',
      type: null,
      created_at: null,
      count: r.count
    }))
    const { createHash } = require('node:crypto') as typeof NodeCrypto
    const shared = createHash('sha256').update(filesCatalogHashInput(snapshotRows)).digest('hex')
    expect(computeCatalogReceipt(rows('natural')).sha256).toBe(shared)
  })

  it('returns an empty receipt for zero rows', () => {
    expect(computeCatalogReceipt([])).toEqual({ count: 0, sha256: sha256HexOf('') })
  })

  it('is a pure aggregate: no ids/names/content in the receipt', () => {
    const receipt = computeCatalogReceipt([{ id: 'secret-id', name: 'n.png', size: 1, count: 1 }])
    const serialized = JSON.stringify(receipt)
    expect(serialized).not.toContain('secret-id')
    expect(serialized).not.toContain('n.png')
    expect(Object.keys(receipt).sort()).toEqual(['count', 'sha256'])
  })
})

describe('computeDbReceipt', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
  })

  afterEach(() => {
    realFs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('streams an empty file to a correct size + digest', async () => {
    const p = realPath.join(tempDir, 'empty.db')
    realFs.writeFileSync(p, '')
    const receipt = await computeDbReceipt(p)
    expect(receipt.size).toBe(0)
    expect(receipt.sha256).toBe(sha256HexOf(''))
  })

  it('streams a multi-MB file to a correct size + digest (bounded memory)', async () => {
    const p = realPath.join(tempDir, 'big.db')
    // > 3 × the 1 MiB streaming buffer → multiple read iterations.
    const content = Buffer.alloc(3 * 1024 * 1024 + 12345, 0x5a)
    realFs.writeFileSync(p, content)
    const receipt = await computeDbReceipt(p)
    expect(receipt.size).toBe(content.length)
    expect(receipt.sha256).toBe(sha256HexOf(content))
  })

  it('rejects (throws) on a missing file', async () => {
    await expect(computeDbReceipt(realPath.join(tempDir, 'nope.db'))).rejects.toThrow()
  })
})

describe('emptyArtifactReceipts / isAllNullReceipts', () => {
  it('returns an all-null block', () => {
    expect(emptyArtifactReceipts()).toEqual({ db: null, files: null, catalog: null })
  })

  it('isAllNullReceipts is true only when every artifact is null', () => {
    expect(isAllNullReceipts(emptyArtifactReceipts())).toBe(true)
    expect(isAllNullReceipts({ db: { sha256: sha256HexOf(''), size: 0 }, files: null, catalog: null })).toBe(false)
    expect(
      isAllNullReceipts({ db: null, files: { count: 0, totalBytes: 0, sha256: sha256HexOf('') }, catalog: null })
    ).toBe(false)
    expect(isAllNullReceipts({ db: null, files: null, catalog: { count: 0, sha256: sha256HexOf('') } })).toBe(false)
  })
})

describe('liveDbReceiptMatchesCandidate (LOCK-AMB-3 exact identity)', () => {
  const actual = { sha256: 'a'.repeat(64), size: 1234 }
  const candidate = { sha256: 'a'.repeat(64), size: 1234 }

  it('is true ONLY on an exact size + SHA-256 match against a non-null candidate receipt', () => {
    expect(liveDbReceiptMatchesCandidate(actual, candidate)).toBe(true)
  })

  it('is false on a size divergence', () => {
    expect(liveDbReceiptMatchesCandidate(actual, { sha256: candidate.sha256, size: candidate.size + 1 })).toBe(false)
  })

  it('is false on a digest divergence', () => {
    expect(liveDbReceiptMatchesCandidate(actual, { sha256: 'b'.repeat(64), size: candidate.size })).toBe(false)
  })

  it('fails closed on a null candidate receipt (the generation carried no db)', () => {
    expect(liveDbReceiptMatchesCandidate(actual, null)).toBe(false)
  })

  it('is a pure identity: never reads disk, exposes no private content', () => {
    const raw = JSON.stringify(liveDbReceiptMatchesCandidate(actual, candidate))
    expect(raw).not.toContain('chat.db')
    expect(raw).not.toContain('import')
  })
})
