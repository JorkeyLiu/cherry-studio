import { FILE_TYPE } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import { buildMediaOpenRequest, getMediaKind, isInAppPlayable, toMediaFileUrl } from '../mediaAttachment'

const file = (overrides: { type?: string | null; ext?: string; id?: string; path?: string }) => ({
  id: 'file-1',
  ext: '.mp3',
  path: '/draft/song.mp3',
  type: 'audio' as string | null,
  ...overrides
})

describe('getMediaKind', () => {
  it('prefers the typed file.type', () => {
    expect(getMediaKind(file({ type: FILE_TYPE.AUDIO, ext: '.bin' }))).toBe('audio')
    expect(getMediaKind(file({ type: FILE_TYPE.VIDEO, ext: '.bin' }))).toBe('video')
  })

  it('falls back to the extension when the type is missing', () => {
    expect(getMediaKind(file({ type: null, ext: '.mp3' }))).toBe('audio')
    expect(getMediaKind(file({ type: null, ext: '.mp4' }))).toBe('video')
    expect(getMediaKind(file({ type: null, ext: '.txt' }))).toBe('other')
  })

  it('matches extensions case-insensitively', () => {
    expect(getMediaKind(file({ type: null, ext: '.MP3' }))).toBe('audio')
  })
})

describe('isInAppPlayable', () => {
  it('accepts browser-decodable audio and video', () => {
    expect(isInAppPlayable(file({ type: 'audio', ext: '.mp3' }))).toBe(true)
    expect(isInAppPlayable(file({ type: 'video', ext: '.mp4' }))).toBe(true)
    expect(isInAppPlayable(file({ type: 'video', ext: '.webm' }))).toBe(true)
  })

  it('falls back for container formats the browser cannot decode', () => {
    expect(isInAppPlayable(file({ type: 'video', ext: '.mkv' }))).toBe(false)
    expect(isInAppPlayable(file({ type: 'video', ext: '.avi' }))).toBe(false)
    expect(isInAppPlayable(file({ type: 'audio', ext: '.wma' }))).toBe(false)
  })

  it('never treats non-media as playable', () => {
    expect(isInAppPlayable(file({ type: 'text', ext: '.txt' }))).toBe(false)
    expect(isInAppPlayable(file({ type: null, ext: '.txt' }))).toBe(false)
  })
})

describe('toMediaFileUrl', () => {
  it('returns null for a missing source so no file:// URL is built', () => {
    expect(toMediaFileUrl(null)).toBeNull()
    expect(toMediaFileUrl(undefined)).toBeNull()
    expect(toMediaFileUrl('')).toBeNull()
  })

  it('builds a file URL for a plain path', () => {
    expect(toMediaFileUrl('/mock/files/abc.mp3')).toBe('file:///mock/files/abc.mp3')
  })

  it('encodes macOS spaces, # and ? without naive concatenation', () => {
    expect(toMediaFileUrl('/Users/jorkey/My Music/song #1?.mp3')).toBe(
      'file:///Users/jorkey/My%20Music/song%20%231%3F.mp3'
    )
  })

  it('normalizes backslashes and encodes unicode names', () => {
    expect(toMediaFileUrl('C:\\Music\\歌曲.mp3')).toBe('file://C:/Music/%E6%AD%8C%E6%9B%B2.mp3')
  })
})

describe('buildMediaOpenRequest', () => {
  it('addresses stored attachments by id + ext without a resolved path', () => {
    expect(buildMediaOpenRequest(file({ id: 'uuid-1', ext: '.mp3', path: '/evil' }), 'stored')).toEqual({
      kind: 'stored',
      storedFileName: 'uuid-1.mp3'
    })
  })

  it('returns null for stored scope without an id or ext', () => {
    expect(buildMediaOpenRequest(file({ id: '', ext: '.mp3' }), 'stored')).toBeNull()
    expect(buildMediaOpenRequest(file({ id: 'uuid-1', ext: '' }), 'stored')).toBeNull()
  })

  it('addresses drafts by their original path', () => {
    expect(buildMediaOpenRequest(file({ path: '/draft/song.mp3' }), 'external')).toEqual({
      kind: 'external',
      filePath: '/draft/song.mp3'
    })
  })

  it('returns null for external scope without a path so IPC is never reached', () => {
    expect(buildMediaOpenRequest(file({ path: '' }), 'external')).toBeNull()
  })
})
