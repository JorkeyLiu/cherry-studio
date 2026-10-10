/**
 * Media read hydration — synced v5 attachments must read as local file DTOs.
 *
 * Receiver state: message_blocks.extra NULL (no overflow.file), file_references
 * present (baseline portable or incremental null file_path/type), sync_file_asset
 * present, bytes already installed. Ordinary chat reads (fetchMessages, window,
 * whole-topic) must assemble a local FileMetadata from trusted refs+asset.
 *
 * Fail-safe: missing refs/asset or illegal ids must NOT forge an attachment.
 * Existing local/import overflow.file must be preserved, sender absolute paths
 * must never leak onto the wire.
 */

import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

vi.mock('@main/config', () => ({ DATA_PATH: '/mock/data' }))

const { mockCleanTopic } = vi.hoisted(() => ({ mockCleanTopic: vi.fn() }))
vi.mock('../../SpanCacheService', () => ({
  spanCacheService: { cleanTopic: mockCleanTopic }
}))

import { isSuccess } from '@shared/chatDb'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { hydratePortableMediaFileOverflowInTx } from '../mediaReadAssembly'
import { runMigrations } from '../migration'
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-media-read-'))
}
function rmrf(dir: string): void {
  realFs.rmSync(dir, { recursive: true, force: true })
}

const SHA = '0123456789abcdef'.repeat(4)
const NOW_ISO = '2026-01-02T00:00:00.000Z'

function seedTopicMessage(sqlite: Database.Database, topicId: string, messageId: string): void {
  sqlite
    .prepare(
      `INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?,?)`
    )
    .run(topicId, 'a1', 'T', '2026-01-01T00:00:00.000Z', NOW_ISO, null, null)
  sqlite
    .prepare(
      `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      messageId,
      topicId,
      'user',
      'turn',
      'success',
      null,
      null,
      null,
      null,
      '2026-01-01T00:00:00.000Z',
      NOW_ISO,
      0,
      null
    )
}

function seedBlock(
  sqlite: Database.Database,
  blockId: string,
  messageId: string,
  type: string,
  extra: string | null
): void {
  sqlite
    .prepare(
      `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(blockId, messageId, type, `${type} content`, 'success', '2026-01-01T00:00:00.000Z', NOW_ISO, 0, extra)
}

function seedRef(
  sqlite: Database.Database,
  opts: {
    id: string
    blockId: string
    fileId: string
    fileName: string | null
    filePath: string | null
    fileType: string | null
  }
): void {
  sqlite
    .prepare(
      `INSERT INTO file_references (id, block_id, file_id, file_name, file_path, file_type, count, extra) VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(opts.id, opts.blockId, opts.fileId, opts.fileName, opts.filePath, opts.fileType, 1, null)
}

function seedAsset(
  sqlite: Database.Database,
  opts: { id: string; extension: string; originalName: string; byteLength?: number }
): void {
  sqlite
    .prepare(
      `INSERT INTO sync_file_asset (id, sha256, byte_length, extension, mime_type, original_name, created_at, version, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(
      opts.id,
      SHA,
      opts.byteLength ?? 4,
      opts.extension,
      opts.extension === '.png'
        ? 'image/png'
        : opts.extension === '.mp3'
          ? 'audio/mpeg'
          : opts.extension === '.mp4'
            ? 'video/mp4'
            : 'application/pdf',
      opts.originalName,
      NOW_ISO,
      1,
      Date.now()
    )
}

function wireFileFor(blocks: Array<Record<string, unknown>>, blockId: string): Record<string, unknown> | null {
  const b = blocks.find((x) => x.id === blockId)
  if (!b) return null
  const f = b.file as Record<string, unknown> | null | undefined
  if (!f || typeof f !== 'object') return null
  return f
}

describe('mediaReadHydration (synced v5 receiver reads)', () => {
  let tmpDir: string
  let sqlite: Database.Database
  let db: BetterSQLite3Database<typeof schema>
  let agg: ChatDbAggregateService

  beforeEach(() => {
    tmpDir = makeTempDir()
    sqlite = new Database(realPath.join(tmpDir, 'test.db'))
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    db = drizzle(sqlite, { schema })
    runMigrations(db, sqlite)
    agg = new ChatDbAggregateService(db)
    mockCleanTopic.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    try {
      sqlite.close()
    } catch {}
    rmrf(tmpDir)
  })

  it('baseline-style image refs (portable path/type) read as local file DTO without sender leak', () => {
    const fileId = 'img-base-1'
    seedTopicMessage(sqlite, 't-base', 'm-base')
    seedBlock(sqlite, 'b-base', 'm-base', 'image', null)
    seedRef(sqlite, {
      id: `fr-b-base-${fileId}`,
      blockId: 'b-base',
      fileId,
      fileName: 'sample.png',
      filePath: `/Users/sender/Data/Files/${fileId}.png`,
      fileType: 'image/png'
    })
    seedAsset(sqlite, { id: fileId, extension: '.png', originalName: 'sample.png' })

    const res = agg.fetchMessages('t-base')
    expect(res.ok).toBe(true)
    if (!isSuccess(res)) throw new Error('expected success')
    const file = wireFileFor(res.value.blocks as Array<Record<string, unknown>>, 'b-base')
    expect(file).not.toBeNull()
    expect(file!.id).toBe(fileId)
    expect(file!.ext).toBe('.png')
    expect(file!.origin_name).toBe('sample.png')
    expect(file!.size).toBe(4)
    expect(file!.type).toBe('image')
    expect(typeof file!.path).toBe('string')
    expect(file!.path as string).toContain(`${fileId}.png`)
    expect(file!.path as string).not.toContain('/Users/sender/')
  })

  it('incremental-style image refs (null path/type, fileName=aid) read as local file DTO', () => {
    const fileId = 'img-incr-1'
    seedTopicMessage(sqlite, 't-incr', 'm-incr')
    seedBlock(sqlite, 'b-incr', 'm-incr', 'image', null)
    seedRef(sqlite, {
      id: `fr-b-incr-${fileId}`,
      blockId: 'b-incr',
      fileId,
      fileName: fileId,
      filePath: null,
      fileType: null
    })
    seedAsset(sqlite, { id: fileId, extension: '.png', originalName: 'photo.png' })

    const res = agg.fetchMessages('t-incr')
    expect(res.ok).toBe(true)
    if (!isSuccess(res)) throw new Error('expected success')
    const file = wireFileFor(res.value.blocks as Array<Record<string, unknown>>, 'b-incr')
    expect(file).not.toBeNull()
    expect(file!.id).toBe(fileId)
    expect(file!.origin_name).toBe('photo.png')
    expect(file!.ext).toBe('.png')
    expect(file!.type).toBe('image')
  })

  it('file block (.pdf) reads as local file DTO', () => {
    const fileId = 'doc-1'
    seedTopicMessage(sqlite, 't-doc', 'm-doc')
    seedBlock(sqlite, 'b-doc', 'm-doc', 'file', null)
    seedRef(sqlite, {
      id: `fr-b-doc-${fileId}`,
      blockId: 'b-doc',
      fileId,
      fileName: fileId,
      filePath: null,
      fileType: null
    })
    seedAsset(sqlite, { id: fileId, extension: '.pdf', originalName: 'report.pdf', byteLength: 9 })

    const res = agg.fetchMessages('t-doc')
    expect(res.ok).toBe(true)
    if (!isSuccess(res)) throw new Error('expected success')
    const file = wireFileFor(res.value.blocks as Array<Record<string, unknown>>, 'b-doc')
    expect(file).not.toBeNull()
    expect(file!.id).toBe(fileId)
    expect(file!.ext).toBe('.pdf')
    expect(file!.origin_name).toBe('report.pdf')
    expect(file!.size).toBe(9)
  })

  it('window read hydrates the same synced image DTO (unified mechanism)', () => {
    const fileId = 'img-win-1'
    seedTopicMessage(sqlite, 't-win', 'm-win')
    seedBlock(sqlite, 'b-win', 'm-win', 'image', null)
    seedRef(sqlite, {
      id: `fr-b-win-${fileId}`,
      blockId: 'b-win',
      fileId,
      fileName: fileId,
      filePath: null,
      fileType: null
    })
    seedAsset(sqlite, { id: fileId, extension: '.png', originalName: 'win.png' })

    const res = agg.fetchMessagesWindow({ topicId: 't-win', kind: 'latest', limit: 10 })
    expect(res.ok).toBe(true)
    if (!isSuccess(res)) throw new Error('expected success')
    const file = wireFileFor(res.value.blocks as Array<Record<string, unknown>>, 'b-win')
    expect(file).not.toBeNull()
    expect(file!.id).toBe(fileId)
  })

  it('whole-topic snapshot hydrates the same synced image DTO', () => {
    const fileId = 'img-whole-1'
    seedTopicMessage(sqlite, 't-whole', 'm-whole')
    seedBlock(sqlite, 'b-whole', 'm-whole', 'image', null)
    seedRef(sqlite, {
      id: `fr-b-whole-${fileId}`,
      blockId: 'b-whole',
      fileId,
      fileName: fileId,
      filePath: null,
      fileType: null
    })
    seedAsset(sqlite, { id: fileId, extension: '.png', originalName: 'whole.png' })

    const res = agg.fetchWholeTopicSnapshot({ topicId: 't-whole' })
    expect(res.ok).toBe(true)
    if (!isSuccess(res)) throw new Error('expected success')
    const file = wireFileFor(res.value.blocks as Array<Record<string, unknown>>, 'b-whole')
    expect(file).not.toBeNull()
    expect(file!.id).toBe(fileId)
  })

  it('audio FILE block (.mp3) hydrates with audio type (not image-only fix)', () => {
    const fileId = 'aud-1'
    seedTopicMessage(sqlite, 't-aud', 'm-aud')
    seedBlock(sqlite, 'b-aud', 'm-aud', 'file', null)
    seedRef(sqlite, {
      id: `fr-b-aud-${fileId}`,
      blockId: 'b-aud',
      fileId,
      fileName: fileId,
      filePath: null,
      fileType: null
    })
    seedAsset(sqlite, { id: fileId, extension: '.mp3', originalName: 'song.mp3', byteLength: 12 })

    const res = agg.fetchMessages('t-aud')
    expect(res.ok).toBe(true)
    if (!isSuccess(res)) throw new Error('expected success')
    const file = wireFileFor(res.value.blocks as Array<Record<string, unknown>>, 'b-aud')
    expect(file).not.toBeNull()
    expect(file!.id).toBe(fileId)
    expect(file!.ext).toBe('.mp3')
    expect(file!.origin_name).toBe('song.mp3')
    expect(file!.name).toBe(`${fileId}.mp3`)
    expect(file!.type).toBe('audio')
    expect(file!.size).toBe(12)
  })

  it('FILE block carrying video (.mp4) hydrates with video type', () => {
    const fileId = 'vid-file-1'
    seedTopicMessage(sqlite, 't-vf', 'm-vf')
    seedBlock(sqlite, 'b-vf', 'm-vf', 'file', null)
    seedRef(sqlite, {
      id: `fr-b-vf-${fileId}`,
      blockId: 'b-vf',
      fileId,
      fileName: fileId,
      filePath: null,
      fileType: null
    })
    seedAsset(sqlite, { id: fileId, extension: '.mp4', originalName: 'clip.mp4', byteLength: 20 })

    const res = agg.fetchMessages('t-vf')
    expect(res.ok).toBe(true)
    if (!isSuccess(res)) throw new Error('expected success')
    const file = wireFileFor(res.value.blocks as Array<Record<string, unknown>>, 'b-vf')
    expect(file).not.toBeNull()
    expect(file!.id).toBe(fileId)
    expect(file!.ext).toBe('.mp4')
    expect(file!.type).toBe('video')
  })

  it('independent VIDEO block hydrates file DTO plus local filePath (existing video read shape)', () => {
    const fileId = 'vid-block-1'
    seedTopicMessage(sqlite, 't-vb', 'm-vb')
    seedBlock(sqlite, 'b-vb', 'm-vb', 'video', null)
    seedRef(sqlite, {
      id: `fr-b-vb-${fileId}`,
      blockId: 'b-vb',
      fileId,
      fileName: fileId,
      filePath: null,
      fileType: null
    })
    seedAsset(sqlite, { id: fileId, extension: '.mp4', originalName: 'movie.mp4', byteLength: 30 })

    const res = agg.fetchMessages('t-vb')
    expect(res.ok).toBe(true)
    if (!isSuccess(res)) throw new Error('expected success')
    const blocks = res.value.blocks as Array<Record<string, unknown>>
    const file = wireFileFor(blocks, 'b-vb')
    expect(file).not.toBeNull()
    expect(file!.id).toBe(fileId)
    expect(file!.ext).toBe('.mp4')
    const raw = blocks.find((x) => x.id === 'b-vb')
    expect(typeof raw!.filePath).toBe('string')
    expect(raw!.filePath as string).toContain(`${fileId}.mp4`)
  })

  it('missing asset stays fail-safe (no forged attachment)', () => {
    seedTopicMessage(sqlite, 't-noasset', 'm-noasset')
    seedBlock(sqlite, 'b-noasset', 'm-noasset', 'image', null)
    seedRef(sqlite, {
      id: 'fr-b-noasset-f-missing',
      blockId: 'b-noasset',
      fileId: 'f-missing',
      fileName: 'f-missing',
      filePath: null,
      fileType: null
    })

    const res = agg.fetchMessages('t-noasset')
    expect(res.ok).toBe(true)
    if (!isSuccess(res)) throw new Error('expected success')
    expect(wireFileFor(res.value.blocks as Array<Record<string, unknown>>, 'b-noasset')).toBeNull()
  })

  it('missing refs stay fail-safe (no forged attachment)', () => {
    seedTopicMessage(sqlite, 't-noref', 'm-noref')
    seedBlock(sqlite, 'b-noref', 'm-noref', 'image', null)
    seedAsset(sqlite, { id: 'orphan-asset', extension: '.png', originalName: 'orphan.png' })

    const res = agg.fetchMessages('t-noref')
    expect(res.ok).toBe(true)
    if (!isSuccess(res)) throw new Error('expected success')
    expect(wireFileFor(res.value.blocks as Array<Record<string, unknown>>, 'b-noref')).toBeNull()
  })

  it('existing local overflow.file is preserved (no overwrite)', () => {
    const keepFile = {
      id: 'local-keep',
      name: 'local-keep.png',
      origin_name: 'kept.png',
      path: '/Users/me/Data/Files/local-keep.png',
      size: 7,
      ext: '.png',
      type: 'image',
      created_at: NOW_ISO,
      count: 1
    }
    seedTopicMessage(sqlite, 't-keep', 'm-keep')
    seedBlock(sqlite, 'b-keep', 'm-keep', 'image', JSON.stringify({ file: keepFile }))
    seedRef(sqlite, {
      id: 'fr-b-keep-other',
      blockId: 'b-keep',
      fileId: 'other-asset',
      fileName: 'other-asset',
      filePath: null,
      fileType: null
    })
    seedAsset(sqlite, { id: 'other-asset', extension: '.png', originalName: 'other.png' })

    const res = agg.fetchMessages('t-keep')
    expect(res.ok).toBe(true)
    if (!isSuccess(res)) throw new Error('expected success')
    const file = wireFileFor(res.value.blocks as Array<Record<string, unknown>>, 'b-keep')
    expect(file).not.toBeNull()
    expect(file!.id).toBe('local-keep')
    expect(file!.path).toBe('/Users/me/Data/Files/local-keep.png')
  })

  it('F1 deterministic fail-closed: multi-ref first-missing stays null (no fall-through)', () => {
    // Sorted safe ids: 'a-first-missing' < 'b-second-valid'. First has no asset.
    // Conservative fail-closed: the block stays null even though the second ref
    // has a valid asset (never auto-selects the next valid asset).
    seedTopicMessage(sqlite, 't-multi', 'm-multi')
    seedBlock(sqlite, 'b-multi', 'm-multi', 'image', null)
    seedRef(sqlite, {
      id: 'fr-b-multi-a',
      blockId: 'b-multi',
      fileId: 'a-first-missing',
      fileName: 'a-first-missing',
      filePath: null,
      fileType: null
    })
    seedRef(sqlite, {
      id: 'fr-b-multi-b',
      blockId: 'b-multi',
      fileId: 'b-second-valid',
      fileName: 'b-second-valid',
      filePath: null,
      fileType: null
    })
    seedAsset(sqlite, { id: 'b-second-valid', extension: '.png', originalName: 'second.png' })

    const res = agg.fetchMessages('t-multi')
    expect(res.ok).toBe(true)
    if (!isSuccess(res)) throw new Error('expected success')
    expect(wireFileFor(res.value.blocks as Array<Record<string, unknown>>, 'b-multi')).toBeNull()
  })

  it('F2 infra: DB select failure fails the read explicitly (no ok + null silent success)', () => {
    seedTopicMessage(sqlite, 't-infra', 'm-infra')
    seedBlock(sqlite, 'b-infra', 'm-infra', 'image', null)
    seedRef(sqlite, {
      id: 'fr-b-infra-f1',
      blockId: 'b-infra',
      fileId: 'f-infra-1',
      fileName: 'f-infra-1',
      filePath: null,
      fileType: null
    })
    seedAsset(sqlite, { id: 'f-infra-1', extension: '.png', originalName: 'infra.png' })
    // Simulate a real infra failure: drop the refs table so the hydration
    // select throws. The read must return a failure envelope (wrapResult path),
    // never ok:true with file null. Wire carries no path (generic message).
    sqlite.exec('DROP TABLE file_references')
    const res = agg.fetchMessages('t-infra')
    expect(res.ok).toBe(false)
    if (isSuccess(res)) throw new Error('expected failure')
    expect(typeof res.error.code).toBe('string')
    expect('value' in res).toBe(false)
  })

  it('F2 infra: throwing tx propagates from the helper (no swallow)', () => {
    const throwingTx = {
      select: () => {
        throw new Error('boom-infra')
      }
    }
    const blocks = [
      { id: 'b-x', type: 'image', overflow: null } as unknown as Parameters<
        typeof hydratePortableMediaFileOverflowInTx
      >[1][number]
    ]
    expect(() => hydratePortableMediaFileOverflowInTx(throwingTx, blocks)).toThrow()
  })

  it('F3 fetchContextClosure hydrates the same synced DTO without sender leak', () => {
    const fileId = 'img-closure-1'
    seedTopicMessage(sqlite, 't-closure', 'm-closure')
    seedBlock(sqlite, 'b-closure', 'm-closure', 'image', null)
    seedRef(sqlite, {
      id: `fr-b-closure-${fileId}`,
      blockId: 'b-closure',
      fileId,
      fileName: 'sample.png',
      filePath: `/Users/sender/Data/Files/${fileId}.png`,
      fileType: 'image/png'
    })
    seedAsset(sqlite, { id: fileId, extension: '.png', originalName: 'closure.png' })

    const res = agg.fetchContextClosure({ topicId: 't-closure', anchorGroupKey: 'm-closure' })
    expect(res.ok).toBe(true)
    if (!isSuccess(res)) throw new Error('expected success')
    const file = wireFileFor(res.value.blocks as Array<Record<string, unknown>>, 'b-closure')
    expect(file).not.toBeNull()
    expect(file!.id).toBe(fileId)
    expect(file!.ext).toBe('.png')
    expect(file!.path as string).toContain(`${fileId}.png`)
    expect(file!.path as string).not.toContain('/Users/sender/')
  })

  it('F3 resolveContextClosure (closure detail) hydrates the same synced DTO without sender leak', () => {
    const fileId = 'img-resolve-1'
    seedTopicMessage(sqlite, 't-resolve', 'm-resolve')
    seedBlock(sqlite, 'b-resolve', 'm-resolve', 'image', null)
    seedRef(sqlite, {
      id: `fr-b-resolve-${fileId}`,
      blockId: 'b-resolve',
      fileId,
      fileName: 'sample.png',
      filePath: `/Users/sender/Data/Files/${fileId}.png`,
      fileType: 'image/png'
    })
    seedAsset(sqlite, { id: fileId, extension: '.png', originalName: 'resolve.png' })

    const res = agg.resolveContextClosure({ topicId: 't-resolve', intent: 'establish', contextCount: null })
    expect(res.ok).toBe(true)
    if (!isSuccess(res)) throw new Error('expected success')
    const v = res.value as unknown as { blocks: Array<Record<string, unknown>> }
    const file = wireFileFor(v.blocks, 'b-resolve')
    expect(file).not.toBeNull()
    expect(file!.id).toBe(fileId)
    expect(file!.path as string).toContain(`${fileId}.png`)
    expect(file!.path as string).not.toContain('/Users/sender/')
  })

  it('F3 clipboard main route hydrates the same synced DTO without sender leak', () => {
    const fileId = 'img-clip-1'
    seedTopicMessage(sqlite, 't-clip', 'm-clip')
    seedBlock(sqlite, 'b-clip', 'm-clip', 'image', null)
    seedRef(sqlite, {
      id: `fr-b-clip-${fileId}`,
      blockId: 'b-clip',
      fileId,
      fileName: 'sample.png',
      filePath: `/Users/sender/Data/Files/${fileId}.png`,
      fileType: 'image/png'
    })
    seedAsset(sqlite, { id: fileId, extension: '.png', originalName: 'clip.png' })

    const res = agg.fetchClipboardGroups({ topicId: 't-clip', groupIds: ['m-clip'] })
    expect(res.ok).toBe(true)
    if (!isSuccess(res)) throw new Error('expected success')
    const file = wireFileFor(res.value.blocks as Array<Record<string, unknown>>, 'b-clip')
    expect(file).not.toBeNull()
    expect(file!.id).toBe(fileId)
    expect(file!.path as string).toContain(`${fileId}.png`)
    expect(file!.path as string).not.toContain('/Users/sender/')
  })

  it('F3 createBranch projection + branch clipboard hydrate without sender leak', () => {
    const fileId = 'img-branch-1'
    seedTopicMessage(sqlite, 't-br', 'm-br')
    seedBlock(sqlite, 'b-br', 'm-br', 'image', null)
    seedRef(sqlite, {
      id: `fr-b-br-${fileId}`,
      blockId: 'b-br',
      fileId,
      fileName: 'sample.png',
      filePath: `/Users/sender/Data/Files/${fileId}.png`,
      fileType: 'image/png'
    })
    seedAsset(sqlite, { id: fileId, extension: '.png', originalName: 'branch.png' })

    const created = agg.createBranch('t-br', null, 'm-br', 'br1')
    expect(created.ok).toBe(true)
    if (!isSuccess(created)) throw new Error('expected success')
    const branchId = (created.value.branch as unknown as Record<string, unknown>).id as string
    expect(typeof branchId).toBe('string')
    const createdFile = wireFileFor(created.value.blocks as Array<Record<string, unknown>>, 'b-br')
    expect(createdFile).not.toBeNull()
    expect(createdFile!.id).toBe(fileId)
    expect(createdFile!.path as string).toContain(`${fileId}.png`)
    expect(createdFile!.path as string).not.toContain('/Users/sender/')

    const clip = agg.fetchClipboardGroups({ topicId: 't-br', branchId, groupIds: ['m-br'] })
    expect(clip.ok).toBe(true)
    if (!isSuccess(clip)) throw new Error('expected success')
    const clipFile = wireFileFor(clip.value.blocks as Array<Record<string, unknown>>, 'b-br')
    expect(clipFile).not.toBeNull()
    expect(clipFile!.id).toBe(fileId)
    expect(clipFile!.path as string).toContain(`${fileId}.png`)
    expect(clipFile!.path as string).not.toContain('/Users/sender/')
  })

  it('unsafe stored ids stay fail-safe (overlong/control/NUL, no protocol bypass)', () => {
    // Overlong (>256) and control/NUL ids must never hydrate, matching the
    // portable protocol validator (1..256) without opening a bypass: invalid
    // stays null, never forged.
    const overlong = `o-${'a'.repeat(260)}`
    seedTopicMessage(sqlite, 't-unsafe', 'm-unsafe')
    seedBlock(sqlite, 'b-unsafe-over', 'm-unsafe', 'image', null)
    seedBlock(sqlite, 'b-unsafe-ctl', 'm-unsafe', 'image', null)
    seedBlock(sqlite, 'b-unsafe-nul', 'm-unsafe', 'image', null)
    seedRef(sqlite, {
      id: 'fr-unsafe-over',
      blockId: 'b-unsafe-over',
      fileId: overlong,
      fileName: overlong,
      filePath: null,
      fileType: null
    })
    seedRef(sqlite, {
      id: 'fr-unsafe-ctl',
      blockId: 'b-unsafe-ctl',
      fileId: 'bad\nctl-id',
      fileName: 'bad-ctl',
      filePath: null,
      fileType: null
    })
    seedRef(sqlite, {
      id: 'fr-unsafe-nul',
      blockId: 'b-unsafe-nul',
      fileId: 'bad\0nul-id',
      fileName: 'bad-nul',
      filePath: null,
      fileType: null
    })
    // Note: sync_file_asset has a DB CHECK length(id) <= 256, so an overlong
    // asset row cannot exist authoritatively — no seed needed (the overlong ref
    // alone must stay null). Control/NUL assets are DB-storable and must still
    // fail closed at the helper validator.
    seedAsset(sqlite, { id: 'bad\nctl-id', extension: '.png', originalName: 'ctl.png' })
    seedAsset(sqlite, { id: 'bad\0nul-id', extension: '.png', originalName: 'nul.png' })

    const res = agg.fetchMessages('t-unsafe')
    expect(res.ok).toBe(true)
    if (!isSuccess(res)) throw new Error('expected success')
    const blocks = res.value.blocks as Array<Record<string, unknown>>
    expect(wireFileFor(blocks, 'b-unsafe-over')).toBeNull()
    expect(wireFileFor(blocks, 'b-unsafe-ctl')).toBeNull()
    expect(wireFileFor(blocks, 'b-unsafe-nul')).toBeNull()
  })
})
