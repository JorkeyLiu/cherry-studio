/**
 * Narrow media-attachment open contract (in-app audio/video preview).
 *
 * The renderer addresses stored attachments by `id + ext` only and
 * pre-upload drafts by their original path; Main resolves and gates each
 * branch. The guard keeps malformed IPC payloads from reaching the opener.
 */
import { describe, expect, it } from 'vitest'

import { IpcChannel } from '../IpcChannel'
import {
  isMediaAttachmentOpenRequest,
  isSupportedMediaAttachmentExt,
  normalizeMediaAttachmentExt
} from '../mediaAttachment'

describe('File_OpenMediaAttachment channel', () => {
  it('exposes a dedicated narrow channel distinct from the generic openPath', () => {
    expect(IpcChannel.File_OpenMediaAttachment).toBe('file:open-media-attachment')
    expect(IpcChannel.File_OpenMediaAttachment).not.toBe(IpcChannel.File_OpenPath)
  })
})

describe('isMediaAttachmentOpenRequest', () => {
  it('accepts a stored request with a non-empty stored file name', () => {
    expect(isMediaAttachmentOpenRequest({ kind: 'stored', storedFileName: 'uuid.mp3' })).toBe(true)
  })

  it('accepts an external request with a non-empty path', () => {
    expect(isMediaAttachmentOpenRequest({ kind: 'external', filePath: '/tmp/song.mp3' })).toBe(true)
  })

  it('rejects a stored request carrying an arbitrary resolved path', () => {
    expect(isMediaAttachmentOpenRequest({ kind: 'stored', filePath: '/etc/passwd' })).toBe(false)
  })

  it('rejects empty identities', () => {
    expect(isMediaAttachmentOpenRequest({ kind: 'stored', storedFileName: '' })).toBe(false)
    expect(isMediaAttachmentOpenRequest({ kind: 'external', filePath: '' })).toBe(false)
  })

  it('rejects unknown kinds and non-objects', () => {
    expect(isMediaAttachmentOpenRequest({ kind: 'any', filePath: '/tmp/a.mp3' })).toBe(false)
    expect(isMediaAttachmentOpenRequest(null)).toBe(false)
    expect(isMediaAttachmentOpenRequest(undefined)).toBe(false)
    expect(isMediaAttachmentOpenRequest('stored')).toBe(false)
  })
})

describe('external media extension allow-set (F1)', () => {
  it('normalizes case and a missing dot prefix', () => {
    expect(normalizeMediaAttachmentExt('.MP3')).toBe('.mp3')
    expect(normalizeMediaAttachmentExt('mp3')).toBe('.mp3')
    expect(normalizeMediaAttachmentExt('.Mp4')).toBe('.mp4')
    expect(normalizeMediaAttachmentExt('')).toBe('')
    expect(normalizeMediaAttachmentExt(null)).toBe('')
  })

  it('accepts the supported audio/video attachment extensions', () => {
    expect(isSupportedMediaAttachmentExt('.mp3')).toBe(true)
    expect(isSupportedMediaAttachmentExt('.MP3')).toBe(true)
    expect(isSupportedMediaAttachmentExt('mp3')).toBe(true)
    expect(isSupportedMediaAttachmentExt('.mp4')).toBe(true)
    expect(isSupportedMediaAttachmentExt('.mkv')).toBe(true)
    expect(isSupportedMediaAttachmentExt('.flac')).toBe(true)
  })

  it('rejects non-media extensions', () => {
    expect(isSupportedMediaAttachmentExt('.txt')).toBe(false)
    expect(isSupportedMediaAttachmentExt('.pdf')).toBe(false)
    expect(isSupportedMediaAttachmentExt('.png')).toBe(false)
    expect(isSupportedMediaAttachmentExt('')).toBe(false)
  })
})
