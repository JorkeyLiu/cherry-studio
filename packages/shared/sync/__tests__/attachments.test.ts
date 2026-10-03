/**
 * Portable sync attachment metadata (`sync/attachments.ts`) — focused unit.
 *
 * NOT RUN in this unit (branch writer owns the checkout runtime lane) — report only.
 * Covers: exact FileAsset schema accept, denied-key rejection (path/count/
 * tokens/purpose/device), hash/length coherence, mime derivation, and the
 * strict block file-reference projector (file/image/video full refs project;
 * tool/citation stay excluded; partial shells project to null, never part-shell;
 * arbitrary overflow keys reject the ref).
 */
import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  ATTACHMENT_DIGEST_RE,
  isFileAsset,
  mimeTypeForExtension,
  projectPortableMediaRefs,
  validateFileAsset
} from '../attachments'

function shaHex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function validAsset(): Record<string, unknown> {
  const bytes = new TextEncoder().encode('portable-asset-bytes')
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    sha256: shaHex(bytes),
    byteLength: bytes.length,
    extension: '.pdf',
    mimeType: 'application/pdf',
    originalName: 'original_doc.pdf',
    createdAt: '2026-01-01T00:00:00.000Z'
  }
}

describe('validateFileAsset exact schema', () => {
  it('accepts the exact 7-key asset', () => {
    expect(validateFileAsset(validAsset())).toBeNull()
    expect(isFileAsset(validAsset())).toBe(true)
  })

  it('rejects local-only keys (path/count/tokens/purpose/device)', () => {
    for (const extra of [
      { path: '/files/doc.pdf' },
      { file_path: '/files/doc.pdf' },
      { count: 1 },
      { tokens: 500 },
      { purpose: 'assistants' },
      { device: 'd1' },
      { deviceSecret: 'x' },
      { token: 'x' }
    ]) {
      expect(validateFileAsset({ ...validAsset(), ...extra })).not.toBeNull()
    }
  })

  it('rejects hash/length incoherence and bad fields', () => {
    const base = validAsset()
    expect(validateFileAsset({ ...base, sha256: (base.sha256 as string).toUpperCase() })).toBe('asset sha256 invalid')
    expect(validateFileAsset({ ...base, sha256: 'abc' })).toBe('asset sha256 invalid')
    expect(validateFileAsset({ ...base, byteLength: -1 })).toBe('asset byteLength invalid')
    expect(validateFileAsset({ ...base, byteLength: 1.5 })).toBe('asset byteLength invalid')
    expect(validateFileAsset({ ...base, byteLength: Number.MAX_SAFE_INTEGER + 1 })).toBe('asset byteLength invalid')
    expect(validateFileAsset({ ...base, extension: 'pdf' })).toBe('asset extension invalid')
    expect(validateFileAsset({ ...base, extension: '.PDF' })).toBe('asset extension invalid')
    expect(validateFileAsset({ ...base, mimeType: 'not-a-mime' })).toBe('asset mimeType invalid')
    expect(validateFileAsset({ ...base, originalName: '/tmp/evil.pdf' })).toBe('asset originalName invalid')
    expect(validateFileAsset({ ...base, createdAt: 'not-a-date' })).toBe('asset createdAt invalid')
    expect(validateFileAsset({ ...base, id: '../evil' })).toBe('asset id invalid')
    expect(validateFileAsset({ ...base })).toBeNull()
  })

  it('rejects wrong key counts (missing or extra keys)', () => {
    const base = validAsset()
    const { mimeType: _drop, ...missing } = base
    void _drop
    expect(validateFileAsset(missing)).not.toBeNull()
    expect(validateFileAsset({ ...base, extra: 1 })).not.toBeNull()
  })

  it('digest regex is strict lowercase hex', () => {
    expect(ATTACHMENT_DIGEST_RE.test('a'.repeat(64))).toBe(true)
    expect(ATTACHMENT_DIGEST_RE.test('A'.repeat(64))).toBe(false)
    expect(ATTACHMENT_DIGEST_RE.test('a'.repeat(63))).toBe(false)
    expect(ATTACHMENT_DIGEST_RE.test(`a`.repeat(64) + '/')).toBe(false)
  })
})

describe('mimeTypeForExtension', () => {
  it('maps known media/document extensions deterministically', () => {
    expect(mimeTypeForExtension('.png')).toBe('image/png')
    expect(mimeTypeForExtension('.JPG')).toBe('image/jpeg')
    expect(mimeTypeForExtension('.mp4')).toBe('video/mp4')
    expect(mimeTypeForExtension('.pdf')).toBe('application/pdf')
  })

  it('falls back to application/octet-stream for unknown extensions', () => {
    expect(mimeTypeForExtension('.zzzunknown')).toBe('application/octet-stream')
  })
})

describe('projectPortableMediaRefs', () => {
  const payload = new TextEncoder().encode('block-file-bytes')
  const digest = shaHex(payload)

  function fileRef(): Record<string, unknown> {
    return {
      fileId: 'file-a',
      overflow: {
        id: 'file-a',
        name: 'doc.pdf',
        origin_name: 'original_doc.pdf',
        size: payload.length,
        ext: '.pdf',
        type: 'document',
        created_at: '2026-01-01T00:00:00.000Z',
        sha256: digest
      }
    }
  }

  it('projects full file/image/video refs to portable asset refs', () => {
    for (const type of ['file', 'image', 'video']) {
      const refs = projectPortableMediaRefs({ id: 'b1', type, fileRefs: [fileRef()] })
      expect(refs).not.toBeNull()
      expect(refs).toHaveLength(1)
      expect(refs?.[0]).toMatchObject({ blockId: 'b1', blockType: type, fileId: 'file-a' })
      expect(validateFileAsset(refs?.[0]?.asset)).toBeNull()
      expect(refs?.[0]?.asset).toMatchObject({
        id: 'file-a',
        sha256: digest,
        byteLength: payload.length,
        extension: '.pdf',
        originalName: 'original_doc.pdf'
      })
    }
  })

  it('keeps tool/citation excluded (empty projection)', () => {
    for (const type of ['tool', 'citation', 'main_text', 'unknown']) {
      expect(projectPortableMediaRefs({ id: 'b1', type, fileRefs: [fileRef()] })).toEqual([])
    }
  })

  it('never emits a partial shell: zero refs projects to null', () => {
    expect(projectPortableMediaRefs({ id: 'b1', type: 'file', fileRefs: [] })).toBeNull()
    expect(projectPortableMediaRefs({ id: 'b1', type: 'image' })).toBeNull()
  })

  it('never emits a partial shell: any invalid ref fails the whole block', () => {
    const bad = fileRef()
    ;(bad.overflow as Record<string, unknown>).sha256 = 'not-a-hash'
    expect(projectPortableMediaRefs({ id: 'b1', type: 'file', fileRefs: [fileRef(), bad] })).toBeNull()
  })

  it('ignores local-only snapshot fields (path/count/tokens/purpose) without projecting them', () => {
    const ref = fileRef()
    Object.assign(ref.overflow as Record<string, unknown>, {
      path: '/files/doc.pdf',
      file_path: '/files/doc.pdf',
      count: 2,
      tokens: 500,
      purpose: 'assistants',
      fileType: 'file',
      type: 'document'
    })
    const refs = projectPortableMediaRefs({ id: 'b1', type: 'file', fileRefs: [ref] })
    expect(refs).not.toBeNull()
    expect(refs).toHaveLength(1)
    expect(validateFileAsset(refs?.[0]?.asset)).toBeNull()
    expect(refs?.[0]?.asset).not.toHaveProperty('path')
    expect(refs?.[0]?.asset).not.toHaveProperty('count')
  })

  it('rejects refs with arbitrary overflow or secret-adjacent keys (toolId/url/device)', () => {
    for (const poison of [
      { toolId: 'tool-1' },
      { url: 'https://example.com' },
      { response: { text: 'x' } },
      { l2AttachmentUnavailable: true },
      { deviceSecret: 'x' },
      { someFutureKey: 'x' }
    ]) {
      const ref = fileRef()
      Object.assign(ref.overflow as Record<string, unknown>, poison)
      expect(projectPortableMediaRefs({ id: 'b1', type: 'file', fileRefs: [ref] })).toBeNull()
    }
    const topPoison = fileRef()
    topPoison.filePath = '/files/doc.pdf'
    // `filePath` is known-local vocabulary (ignored), so this still projects.
    expect(projectPortableMediaRefs({ id: 'b1', type: 'file', fileRefs: [topPoison] })).not.toBeNull()
    const topBad = fileRef()
    topBad.credentials = 'x'
    expect(projectPortableMediaRefs({ id: 'b1', type: 'file', fileRefs: [topBad] })).toBeNull()
  })

  it('rejects refs missing hash material (no faked digest)', () => {
    const ref = fileRef()
    delete (ref.overflow as Record<string, unknown>).sha256
    expect(projectPortableMediaRefs({ id: 'b1', type: 'file', fileRefs: [ref] })).toBeNull()
  })
})
