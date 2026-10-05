/**
 * Main sync attachment service (`syncAttachmentService.ts`) — focused unit
 * with a stubbed SyncClient and real temp filesystem dirs.
 *
 * NOT RUN in this unit (branch writer owns the checkout runtime lane) — report only.
 * Covers: trusted filesDir confinement (traversal/absolute/symlink/missing
 * rejected; no external user-file branch), discover metadata+sha256, upload
 * stale-metadata refusal, download install atomicity + localized projection,
 * dedup on identical existing final, conflict rollback leaving the existing
 * final untouched, and failure rollback (no partial in filesDir, tmp cleaned).
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

import type { FileAsset } from '@shared/sync/attachments'

import { SyncAttachmentService } from '../syncAttachmentService'

let tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
  tmpDirs = []
})

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

function shaHex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function setup(): { filesDir: string; tempDir: string } {
  const root = tmpDir('sync-attach-svc-')
  return { filesDir: join(root, 'files'), tempDir: join(root, 'tmp') }
}

async function collectBody(body: unknown): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  }
  return Buffer.concat(chunks)
}

describe('SyncAttachmentService confinement', () => {
  it('discovers portable metadata + sha256 for a trusted stored file', async () => {
    const { filesDir, tempDir } = setup()
    const { mkdirSync } = await import('node:fs')
    mkdirSync(filesDir, { recursive: true })
    const bytes = Buffer.from('stored-file-bytes')
    const id = randomBytes(8).toString('hex')
    writeFileSync(join(filesDir, `${id}.pdf`), bytes)
    const svc = new SyncAttachmentService({ filesDir, tempDir, client: {} as never })
    const asset = await svc.discoverAsset(`${id}.pdf`, {
      originalName: 'original_doc.pdf',
      createdAt: '2026-01-01T00:00:00.000Z'
    })
    expect(asset).toMatchObject({
      id,
      sha256: shaHex(bytes),
      byteLength: bytes.length,
      extension: '.pdf',
      mimeType: 'application/pdf',
      originalName: 'original_doc.pdf'
    })
    expect(asset).not.toHaveProperty('path')
  })

  it('rejects traversal, absolute paths, missing files, and symlinks', async () => {
    const { filesDir, tempDir } = setup()
    const { mkdirSync } = await import('node:fs')
    mkdirSync(filesDir, { recursive: true })
    const svc = new SyncAttachmentService({ filesDir, tempDir, client: {} as never })
    await expect(svc.discoverAsset('../evil.pdf')).rejects.toThrow('stored file unavailable')
    await expect(svc.discoverAsset('/etc/passwd')).rejects.toThrow()
    await expect(svc.discoverAsset('missing.pdf')).rejects.toThrow('stored file unavailable')
    // Symlink inside filesDir pointing outside is rejected (lstat gate).
    const outside = join(tmpDir('sync-attach-outside-'), 'secret.bin')
    writeFileSync(outside, Buffer.from('secret'))
    const linkName = `${randomBytes(8).toString('hex')}.bin`
    try {
      symlinkSync(outside, join(filesDir, linkName))
    } catch {
      return
    }
    await expect(svc.discoverAsset(linkName)).rejects.toThrow('stored file unavailable')
  })
})

describe('SyncAttachmentService upload', () => {
  it('streams stored bytes and refuses stale metadata before transport', async () => {
    const { filesDir, tempDir } = setup()
    const { mkdirSync } = await import('node:fs')
    mkdirSync(filesDir, { recursive: true })
    const bytes = Buffer.from('upload-stream-bytes')
    const id = randomBytes(8).toString('hex')
    writeFileSync(join(filesDir, `${id}.txt`), bytes)
    const seen: Array<{ digest: string; byteLength?: number; body: unknown }> = []
    const client = {
      uploadAttachment: vi.fn(async (_e: string, args: { digest: string; byteLength?: number; body: unknown }) => {
        seen.push(args)
        const streamed = await collectBody(args.body)
        expect(streamed.equals(bytes)).toBe(true)
        return { digest: args.digest, byteLength: streamed.length, deduplicated: false }
      }),
      downloadAttachment: vi.fn()
    }
    const svc = new SyncAttachmentService({ filesDir, tempDir, client: client as never })
    const asset = await svc.discoverAsset(`${id}.txt`)
    const receipt = await svc.uploadAsset(asset, 'http://127.0.0.1:3030', 'ABCDEFGH', 'b'.repeat(64))
    expect(receipt).toMatchObject({ digest: asset.sha256, byteLength: bytes.length })
    expect(seen).toHaveLength(1)
    // Stale metadata (size changed after discover) throws without transport.
    const stale: FileAsset = { ...asset, byteLength: asset.byteLength + 1 }
    await expect(svc.uploadAsset(stale, 'http://127.0.0.1:3030', 'ABCDEFGH', 'b'.repeat(64))).rejects.toThrow(
      'stale metadata'
    )
    expect(seen).toHaveLength(1)
  })
})

describe('SyncAttachmentService downloadAndInstall', () => {
  function assetFor(bytes: Buffer, id: string, ext = '.bin'): FileAsset {
    return {
      id,
      sha256: shaHex(bytes),
      byteLength: bytes.length,
      extension: ext,
      mimeType: 'application/octet-stream',
      originalName: `original${ext}`,
      createdAt: '2026-01-01T00:00:00.000Z'
    }
  }

  function downloadStub(bytes: Buffer, mode: 'ok' | 'digest-mismatch' = 'ok') {
    return {
      uploadAttachment: vi.fn(),
      downloadAttachment: vi.fn(
        async (
          _e: string,
          args: { digest: string; expectedByteLength?: number },
          _c: string,
          _s: string,
          _sig?: AbortSignal,
          onChunk?: (chunk: Uint8Array) => void | Promise<void>
        ) => {
          const out = mode === 'ok' ? bytes : Buffer.from('tampered-bytes')
          const half = Math.ceil(out.length / 2)
          if (onChunk) {
            await onChunk(out.subarray(0, half))
            await onChunk(out.subarray(half))
          }
          if (mode !== 'ok') throw new Error('attachment download failed: digest-mismatch')
          if (args.expectedByteLength !== undefined && out.length !== args.expectedByteLength) {
            throw new Error('attachment download failed: length-mismatch')
          }
          return { digest: args.digest, byteLength: out.length }
        }
      )
    }
  }

  it('installs atomically and returns a localized projection distinct from the wire asset', async () => {
    const { filesDir, tempDir } = setup()
    const bytes = Buffer.from('download-install-bytes')
    const id = randomBytes(8).toString('hex')
    const svc = new SyncAttachmentService({ filesDir, tempDir, client: downloadStub(bytes) as never })
    const installed = await svc.downloadAndInstall(
      assetFor(bytes, id),
      'http://127.0.0.1:3030',
      'ABCDEFGH',
      'b'.repeat(64)
    )
    expect(installed.localPath).toBe(join(filesDir, `${id}.bin`))
    expect(installed.deduplicated).toBe(false)
    expect(installed.asset).toMatchObject({ id, sha256: shaHex(bytes) })
    expect(installed.asset).not.toHaveProperty('path')
    // Second download dedups against the identical final.
    const again = await svc.downloadAndInstall(assetFor(bytes, id), 'http://127.0.0.1:3030', 'ABCDEFGH', 'b'.repeat(64))
    expect(again.deduplicated).toBe(true)
    expect(again.localPath).toBe(installed.localPath)
  })

  it('rolls back on digest failure: no partial in filesDir, tmp cleaned', async () => {
    const { filesDir, tempDir } = setup()
    const bytes = Buffer.from('expected-bytes-missing')
    const id = randomBytes(8).toString('hex')
    const svc = new SyncAttachmentService({
      filesDir,
      tempDir,
      client: downloadStub(bytes, 'digest-mismatch') as never
    })
    await expect(
      svc.downloadAndInstall(assetFor(bytes, id), 'http://127.0.0.1:3030', 'ABCDEFGH', 'b'.repeat(64))
    ).rejects.toThrow('digest-mismatch')
    let filesLeft: string[] = []
    try {
      filesLeft = readdirSync(filesDir).filter((f) => !f.startsWith('.'))
    } catch {
      filesLeft = []
    }
    expect(filesLeft.length).toBe(0)
    let tmpLeft: string[] = []
    try {
      tmpLeft = readdirSync(tempDir)
    } catch {
      tmpLeft = []
    }
    expect(tmpLeft.length).toBe(0)
  })

  it('never overwrites a conflicting existing final (rollback, existing kept)', async () => {
    const { filesDir, tempDir } = setup()
    const { mkdirSync } = await import('node:fs')
    mkdirSync(filesDir, { recursive: true })
    const id = randomBytes(8).toString('hex')
    const existingBytes = Buffer.from('pre-existing-different-content')
    writeFileSync(join(filesDir, `${id}.bin`), existingBytes)
    const incoming = Buffer.from('incoming-other-content-xxxxx')
    const svc = new SyncAttachmentService({ filesDir, tempDir, client: downloadStub(incoming) as never })
    await expect(
      svc.downloadAndInstall(assetFor(incoming, id), 'http://127.0.0.1:3030', 'ABCDEFGH', 'b'.repeat(64))
    ).rejects.toThrow('stored content conflict')
    // Existing final untouched.
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(join(filesDir, `${id}.bin`)).equals(existingBytes)).toBe(true)
  })
})
