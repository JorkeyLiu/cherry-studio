/**
 * Attachment display-name capture — real production defect regression.
 *
 * Real `FileStorage.uploadFile` splits portable display from disk identity:
 * `origin_name = basename(original)` (e.g. `photo.png`), `name = uuid + ext`
 * (e.g. `<uuid>.png`), `path` device-local. The pre-fix capture read only
 * `file.name` into `file_references.file_name` with `extra = NULL`, so the
 * sync drain preferred the stored basename as `originalName` and receivers
 * rendered `uuid.png`/`uuid.mp4` instead of `photo.png`/`movie.mp4`.
 *
 * This suite simulates the real FileDto (never a directly-seeded asset
 * pretending capture passed) and proves:
 * - disk basename stays in `fileName`/`filePath` for byte reads;
 * - portable display lands in trusted ref `overflow` without schema/wire change;
 * - hostile upstream names fail safe (no path leak, no invented display);
 * - the sync selector prefers ref-extra display, supplements pre-fix
 *   `extra = NULL` history from the owning block `extra.file`, and never
 *   reuses the stored basename as display.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('@main/config', () => ({ DATA_PATH: '/mock/data' }))

import { selectAttachmentDisplayName } from '../../sync/SyncService'
import type { MessageBlockData } from '../domain/types'
import { projectFileReferences } from '../wireAdapters'

function realFileBlock(opts: {
  blockId: string
  type: string
  fileId: string
  storedName: string
  originName: string
  localPath: string
}): MessageBlockData {
  return {
    id: opts.blockId,
    messageId: 'm-1',
    type: opts.type,
    content: null,
    status: 'success',
    createdAt: null,
    updatedAt: null,
    sortOrder: 0,
    overflow: {
      file: {
        id: opts.fileId,
        name: opts.storedName,
        origin_name: opts.originName,
        path: opts.localPath,
        size: 4,
        ext: '.png',
        type: 'image/png',
        created_at: '2026-01-02T00:00:00.000Z',
        count: 1
      }
    }
  }
}

describe('attachment display-name capture (real FileDto)', () => {
  it('photo.png real upload keeps disk basename in columns and display in trusted overflow', () => {
    const fileId = '11111111-2222-4333-8444-555555555555'
    const storedName = `${fileId}.png`
    const block = realFileBlock({
      blockId: 'b-photo',
      type: 'image',
      fileId,
      storedName,
      originName: 'photo.png',
      localPath: `/Users/sender/Data/Files/${storedName}`
    })

    const refs = projectFileReferences(block)
    expect(refs).toHaveLength(1)
    // Disk identity for byte reads (never display-confused).
    expect(refs[0].fileName).toBe(storedName)
    expect(refs[0].filePath).toBe(`/Users/sender/Data/Files/${storedName}`)
    // Portable display in trusted ref metadata (existing extra keys, no schema change).
    expect(refs[0].overflow).toEqual({ originalName: 'photo.png', origin_name: 'photo.png' })

    // Sync selector prefers the ref-extra display over the stored basename.
    const display = selectAttachmentDisplayName(refs[0].overflow, [], refs[0].fileName)
    expect(display).toBe('photo.png')
  })

  it('movie.mp4 real upload keeps display distinct from uuid stored name', () => {
    const fileId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const storedName = `${fileId}.mp4`
    const block: MessageBlockData = {
      id: 'b-movie',
      messageId: 'm-1',
      type: 'video',
      content: null,
      status: 'success',
      createdAt: null,
      updatedAt: null,
      sortOrder: 0,
      overflow: {
        file: {
          id: fileId,
          name: storedName,
          origin_name: 'movie.mp4',
          path: `/Users/sender/Data/Files/${storedName}`,
          size: 30,
          ext: '.mp4',
          type: 'video/mp4',
          created_at: '2026-01-02T00:00:00.000Z',
          count: 1
        }
      }
    }

    const refs = projectFileReferences(block)
    expect(refs).toHaveLength(1)
    expect(refs[0].fileName).toBe(storedName)
    expect(refs[0].overflow).toEqual({ originalName: 'movie.mp4', origin_name: 'movie.mp4' })
    expect(selectAttachmentDisplayName(refs[0].overflow, [], storedName)).toBe('movie.mp4')
  })

  it('pre-fix extra-NULL history is supplemented from the owning block extra.file', () => {
    const fileId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
    const storedName = `${fileId}.png`
    // Old row: file_name is the stored basename, extra is NULL.
    const extra: Record<string, unknown> | null = null
    // Owning block still carries the sender display snapshot.
    const blockCandidates: unknown[] = ['photo.png', undefined]
    const display = selectAttachmentDisplayName(extra, blockCandidates, storedName)
    expect(display).toBe('photo.png')
  })

  it('stored basename is never reused as display when no trusted source exists', () => {
    const fileId = 'cccccccc-dddd-4eee-8fff-111111111111'
    const storedName = `${fileId}.png`
    expect(selectAttachmentDisplayName(null, [], storedName)).toBeUndefined()
    expect(selectAttachmentDisplayName({}, [], storedName)).toBeUndefined()
  })

  it('hostile upstream names fail safe without leaking private paths', () => {
    const fileId = 'dddddddd-eeee-4fff-8000-222222222222'
    const storedName = `${fileId}.png`
    const block: MessageBlockData = {
      id: 'b-hostile',
      messageId: 'm-1',
      type: 'image',
      content: null,
      status: 'success',
      createdAt: null,
      updatedAt: null,
      sortOrder: 0,
      overflow: {
        file: {
          id: fileId,
          name: storedName,
          origin_name: '/etc/passwd',
          path: `/Users/sender/Data/Files/${storedName}`,
          type: 'image/png'
        }
      }
    }
    const refs = projectFileReferences(block)
    expect(refs).toHaveLength(1)
    expect(refs[0].fileName).toBe(storedName)
    expect(refs[0].overflow).toEqual({})
    expect(selectAttachmentDisplayName({ origin_name: '/etc/passwd' }, [], storedName)).toBeUndefined()
    expect(selectAttachmentDisplayName({ originalName: 'a/b.png' }, [], storedName)).toBeUndefined()
    expect(selectAttachmentDisplayName(null, ['/tmp/evil.png'], storedName)).toBeUndefined()
    expect(selectAttachmentDisplayName(null, ['..'], storedName)).toBeUndefined()
  })
})
