/**
 * LocalTokenEstimator 测试 — 统一本地附件/消息估算器。
 *
 * 覆盖：
 * - 文本/代码/Office 复用 prepareSendableFileText（估算文本 = 实际发送文本）
 * - PDF 分层：文本优先（+ 页数开销）→ 页数回退 → 有界字节回退
 * - 图片：分辨率驱动公式；压缩字节数不参与主公式；远程 URL 固定回退且不下载
 * - 缓存：命中去重、并发共享、失败条目删除后可重试、容量有界
 * - TokenService 集成：草稿/历史共用估算器、无 magic -7、历史识别图片块、
 *   无附件消息回归
 */
import { combineReducers, configureStore } from '@reduxjs/toolkit'
import { messageBlocksSlice } from '@renderer/store/messageBlock'
import type { Assistant, FileMetadata } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import type { ImageMessageBlock, Message } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType, UserMessageStatus } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Deterministic tokenizer: 1 char ≈ 1 token
vi.mock('tokenx', () => ({
  estimateTokenCount: (text: string) => text.length
}))

const reducer = combineReducers({
  messageBlocks: messageBlocksSlice.reducer
})

const createMockStore = () =>
  configureStore({
    reducer,
    middleware: (getDefaultMiddleware) => getDefaultMiddleware({ serializableCheck: false })
  })

let mockStore: ReturnType<typeof createMockStore>

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => mockStore.getState(),
    dispatch: (action: unknown) => mockStore.dispatch(action as never)
  }
}))

// window.api.file stubs — storage-id APIs (history / uploaded files)
const readMock = vi.fn()
const base64ImageMock = vi.fn()
const pdfInfoMock = vi.fn()
const imageSizeMock = vi.fn()
// window.api.file stubs — path-based APIs (pre-upload draft files)
const readExternalMock = vi.fn()
const base64ImageExternalMock = vi.fn()
const pdfInfoExternalMock = vi.fn()
const imageSizeExternalMock = vi.fn()

// Controllable Image constructor (only data-URL block probing decodes in-renderer)
let imageProbeResult: { width: number; height: number } | null = null
let imageConstructorCalls = 0

class MockImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  naturalWidth = 0
  naturalHeight = 0
  width = 0
  height = 0

  constructor() {
    imageConstructorCalls += 1
  }

  set src(_value: string) {
    queueMicrotask(() => {
      if (imageProbeResult) {
        this.naturalWidth = imageProbeResult.width
        this.naturalHeight = imageProbeResult.height
        this.onload?.()
      } else {
        this.onerror?.()
      }
    })
  }
}

import { resetSendableFileTextCache } from '@renderer/aiCore/prepareParams/sendableFileText'

import {
  estimateDraftTokens,
  estimateFileTokens,
  estimateImageBlockTokens,
  estimateMessageTokens,
  FALLBACK_MAX_TOKENS,
  IMAGE_FALLBACK_TOKENS,
  resetLocalTokenEstimatorCache
} from '../LocalTokenEstimator'
import { estimateHistoryTokens, estimateUserPromptUsage } from '../TokenService'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let fileCounter = 0

/**
 * Stored/history file: `path` ends with `${id}${ext}` (lives under storageDir),
 * so `isStoredFile` is true and storage-id APIs are used. This is the default —
 * it mirrors uploaded/history attachments.
 */
const createFile = (overrides: Partial<FileMetadata> = {}): FileMetadata => {
  const merged = {
    id: `file-${++fileCounter}`,
    name: 'document.txt',
    origin_name: 'document.txt',
    size: 1024,
    ext: '.txt',
    type: FILE_TYPE.TEXT,
    created_at: new Date(2024, 0, 1).toISOString(),
    count: 1,
    ...overrides
  } as FileMetadata
  // Derive the stored path from id+ext unless the caller overrides it.
  return { ...merged, path: overrides.path ?? `/storage/${merged.id}${merged.ext}` }
}

/**
 * Pre-upload draft file (select/paste/drop → file.get): fresh `id` that does NOT
 * exist under storageDir, `path` pointing at the original/temp file. `isStoredFile`
 * is false, so path-based APIs (readExternal/base64ImageExternal/pdfInfoExternal)
 * must be used. This is the realistic shape audit F1 proved.
 */
const createDraftFile = (overrides: Partial<FileMetadata> = {}): FileMetadata => {
  const merged = createFile(overrides)
  return { ...merged, path: overrides.path ?? `/Users/me/original/${merged.origin_name}` }
}

const makeImageBlock = (overrides: Partial<ImageMessageBlock> = {}): ImageMessageBlock =>
  ({
    id: `image-block-${++fileCounter}`,
    messageId: 'message-1',
    type: MessageBlockType.IMAGE,
    createdAt: new Date(2024, 0, 1).toISOString(),
    status: MessageBlockStatus.SUCCESS,
    ...overrides
  }) as ImageMessageBlock

/** Builds a message and injects its blocks into the mock store */
const makeMessage = (id: string, blocks: Array<Record<string, unknown>>): Message => {
  for (const block of blocks) {
    mockStore.dispatch(messageBlocksSlice.actions.upsertOneBlock({ ...block, messageId: id } as any))
  }
  return {
    id,
    role: 'user',
    assistantId: 'assistant-1',
    topicId: 'topic-1',
    createdAt: '2026-07-24T00:00:00.000Z',
    status: UserMessageStatus.SUCCESS,
    blocks: blocks.map((b) => b.id as string)
  } as Message
}

const makeAssistant = (prompt = ''): Assistant => ({ id: 'a1', prompt, settings: {} }) as unknown as Assistant

beforeEach(() => {
  mockStore = createMockStore()
  readMock.mockReset()
  base64ImageMock.mockReset()
  pdfInfoMock.mockReset()
  imageSizeMock.mockReset()
  readExternalMock.mockReset()
  base64ImageExternalMock.mockReset()
  pdfInfoExternalMock.mockReset()
  imageSizeExternalMock.mockReset()
  imageProbeResult = null
  imageConstructorCalls = 0
  resetLocalTokenEstimatorCache()
  resetSendableFileTextCache()
  vi.stubGlobal('api', {
    file: {
      read: readMock,
      base64Image: base64ImageMock,
      pdfInfo: pdfInfoMock,
      imageSize: imageSizeMock,
      readExternal: readExternalMock,
      base64ImageExternal: base64ImageExternalMock,
      pdfInfoExternal: pdfInfoExternalMock,
      imageSizeExternal: imageSizeExternalMock
    }
  })
  vi.stubGlobal('Image', MockImage)
})

// ---------------------------------------------------------------------------
// Text / code / Office files (LOCK-006)
// ---------------------------------------------------------------------------

describe('estimateFileTokens — text-sendable files', () => {
  it('estimates text file from actual sendable text (filename + newline + content)', async () => {
    readMock.mockResolvedValue('hello world')
    const file = createFile({ id: 'txt1', ext: '.txt', origin_name: 'readme.txt' })

    const tokens = await estimateFileTokens(file)

    expect(readMock).toHaveBeenCalledWith('txt1.txt', false)
    // 'readme.txt\nhello world' → 22 chars → 22 tokens (mocked 1:1)
    expect(tokens).toBe('readme.txt\nhello world'.length)
  })

  it('estimates code file through the same sendable-text path', async () => {
    readMock.mockResolvedValue('export const x = 1')
    const file = createFile({ id: 'code1', ext: '.ts', origin_name: 'index.ts', type: FILE_TYPE.TEXT })

    const tokens = await estimateFileTokens(file)

    expect(readMock).toHaveBeenCalledWith('code1.ts', false)
    expect(tokens).toBe('index.ts\nexport const x = 1'.length)
  })

  it('estimates Office document via forced text extraction', async () => {
    readMock.mockResolvedValue('quarterly report body')
    const file = createFile({ id: 'doc1', ext: '.docx', origin_name: 'report.docx', type: FILE_TYPE.DOCUMENT })

    const tokens = await estimateFileTokens(file)

    expect(readMock).toHaveBeenCalledWith('doc1.docx', true)
    expect(tokens).toBe('report.docx\nquarterly report body'.length)
  })

  it('falls back to bounded byte estimate when read fails', async () => {
    readMock.mockRejectedValue(new Error('ENOENT'))
    const file = createFile({ id: 'gone', ext: '.txt', origin_name: 'gone.txt', size: 400 })

    const tokens = await estimateFileTokens(file)

    // 400 bytes / 4 = 100 tokens
    expect(tokens).toBe(100)
  })

  it('returns 0 for unsupported attachment types without any read', async () => {
    const file = createFile({ id: 'clip', ext: '.mp4', origin_name: 'clip.mp4', type: FILE_TYPE.VIDEO })

    await expect(estimateFileTokens(file)).resolves.toBe(0)
    expect(readMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// PDF layered estimation (LOCK-008)
// ---------------------------------------------------------------------------

describe('estimateFileTokens — PDF layering', () => {
  const pdfFile = (overrides: Partial<FileMetadata> = {}) =>
    createFile({ ext: '.pdf', origin_name: 'doc.pdf', type: FILE_TYPE.DOCUMENT, ...overrides })

  it('prefers extracted text plus per-page overhead when both available', async () => {
    pdfInfoMock.mockResolvedValue(3)
    readMock.mockResolvedValue('pdf text')
    const file = pdfFile({ id: 'pdf1' })

    const tokens = await estimateFileTokens(file)

    expect(readMock).toHaveBeenCalledWith('pdf1.pdf', true)
    // 'doc.pdf\npdf text' (16) + 3 pages × 8 overhead = 40
    expect(tokens).toBe('doc.pdf\npdf text'.length + 3 * 8)
  })

  it('uses extracted text alone when page count is unavailable', async () => {
    pdfInfoMock.mockRejectedValue(new Error('pdf parse error'))
    readMock.mockResolvedValue('pdf text')
    const file = pdfFile({ id: 'pdf2' })

    const tokens = await estimateFileTokens(file)

    expect(tokens).toBe('doc.pdf\npdf text'.length)
  })

  it('falls back to page-count estimate when text extraction fails', async () => {
    pdfInfoMock.mockResolvedValue(5)
    readMock.mockRejectedValue(new Error('extraction failed'))
    const file = pdfFile({ id: 'pdf3' })

    const tokens = await estimateFileTokens(file)

    // 5 pages × 250 = 1250
    expect(tokens).toBe(1250)
  })

  it('falls back to bounded byte estimate when text and page count both fail', async () => {
    pdfInfoMock.mockRejectedValue(new Error('pdf parse error'))
    readMock.mockRejectedValue(new Error('extraction failed'))
    const file = pdfFile({ id: 'pdf4', size: 8000 })

    const tokens = await estimateFileTokens(file)

    // 8000 / 4 = 2000
    expect(tokens).toBe(2000)
  })

  it('bounds the byte fallback for huge PDFs', async () => {
    pdfInfoMock.mockRejectedValue(new Error('pdf parse error'))
    readMock.mockRejectedValue(new Error('extraction failed'))
    const file = pdfFile({ id: 'pdf5', size: 1024 * 1024 * 1024 })

    const tokens = await estimateFileTokens(file)

    expect(tokens).toBe(FALLBACK_MAX_TOKENS)
  })

  it('classifies uppercase .PDF through the PDF layering path (case-insensitive)', async () => {
    pdfInfoMock.mockResolvedValue(3)
    readMock.mockResolvedValue('pdf text')
    const file = pdfFile({ id: 'pdf-upper', ext: '.PDF', origin_name: 'DOC.PDF' })

    const tokens = await estimateFileTokens(file)

    // Reaches PDF layering (pdfInfo + text) — not the plain text-like path.
    expect(pdfInfoMock).toHaveBeenCalledWith('pdf-upper.PDF')
    // 'DOC.PDF\npdf text' + 3 pages × 8 overhead
    expect(tokens).toBe('DOC.PDF\npdf text'.length + 3 * 8)
  })
})

// ---------------------------------------------------------------------------
// Images (LOCK-007)
// ---------------------------------------------------------------------------

describe('estimateFileTokens — images', () => {
  const imageFile = (overrides: Partial<FileMetadata> = {}) =>
    createFile({ ext: '.png', origin_name: 'photo.png', type: FILE_TYPE.IMAGE, ...overrides })

  it('estimates local image from resolution via dimensions-only IPC (512×512 → 1 tile)', async () => {
    imageSizeMock.mockResolvedValue({ width: 512, height: 512 })
    const file = imageFile({ id: 'img1' })

    const tokens = await estimateFileTokens(file)

    expect(imageSizeMock).toHaveBeenCalledWith('img1.png')
    // 85 base + 1 tile × 170 = 255
    expect(tokens).toBe(255)
  })

  it('never transports base64 image data on the estimate path (dimensions IPC only)', async () => {
    imageSizeMock.mockResolvedValue({ width: 512, height: 512 })

    await estimateFileTokens(imageFile({ id: 'no-b64' }))

    expect(imageSizeMock).toHaveBeenCalledWith('no-b64.png')
    // The base64 image transport must not be touched during estimation.
    expect(base64ImageMock).not.toHaveBeenCalled()
    expect(base64ImageExternalMock).not.toHaveBeenCalled()
    // No in-renderer decode of a fetched data URL either.
    expect(imageConstructorCalls).toBe(0)
  })

  it('tile count follows scaled dimensions (800×400 → 2 tiles)', async () => {
    imageSizeMock.mockResolvedValue({ width: 800, height: 400 })
    const file = imageFile({ id: 'img2' })

    const tokens = await estimateFileTokens(file)

    // 85 + 2 × 170 = 425
    expect(tokens).toBe(425)
  })

  it('compressed byte size does not drive the estimate — same resolution, same tokens', async () => {
    imageSizeMock.mockResolvedValue({ width: 512, height: 512 })

    const small = await estimateFileTokens(imageFile({ id: 'small', size: 10_000 }))
    const large = await estimateFileTokens(imageFile({ id: 'large', size: 10_000_000 }))

    expect(small).toBe(large)
    expect(large).toBe(255)
    // old formula would have produced size/100 = 100000 — must not
    expect(large).not.toBe(100_000)
  })

  it('uses fixed fallback when dimensions are unavailable (zero/invalid size)', async () => {
    imageSizeMock.mockResolvedValue({ width: 0, height: 0 })
    const file = imageFile({ id: 'img3', size: 123_456 })

    const tokens = await estimateFileTokens(file)

    expect(tokens).toBe(IMAGE_FALLBACK_TOKENS)
    expect(tokens).not.toBe(Math.floor(123_456 / 100))
  })

  it('uses fixed fallback when the dimensions IPC fails', async () => {
    imageSizeMock.mockRejectedValue(new Error('read failed'))
    const file = imageFile({ id: 'img4' })

    await expect(estimateFileTokens(file)).resolves.toBe(IMAGE_FALLBACK_TOKENS)
    expect(base64ImageMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Pre-upload draft resolution (audit F1): id+ext not in storageDir, path points
// at the original/temp file. Estimation MUST use path-based APIs, not fall back
// solely because the storage id is absent.
// ---------------------------------------------------------------------------

describe('estimateFileTokens — pre-upload draft resolution (audit F1)', () => {
  it('estimates draft text file from its real path via readExternal (no storage-id read)', async () => {
    readExternalMock.mockResolvedValue('draft body')
    const file = createDraftFile({
      id: 'draft-txt',
      ext: '.txt',
      origin_name: 'notes.txt',
      path: '/Users/me/notes.txt'
    })

    const tokens = await estimateFileTokens(file)

    expect(readExternalMock).toHaveBeenCalledWith('/Users/me/notes.txt', false)
    expect(readMock).not.toHaveBeenCalled()
    expect(tokens).toBe('notes.txt\ndraft body'.length)
  })

  it('estimates draft Office document from its real path via readExternal (detectEncoding=true)', async () => {
    readExternalMock.mockResolvedValue('draft report body')
    const file = createDraftFile({
      id: 'draft-doc',
      ext: '.docx',
      origin_name: 'report.docx',
      type: FILE_TYPE.DOCUMENT,
      path: '/Users/me/report.docx'
    })

    const tokens = await estimateFileTokens(file)

    expect(readExternalMock).toHaveBeenCalledWith('/Users/me/report.docx', true)
    expect(readMock).not.toHaveBeenCalled()
    expect(tokens).toBe('report.docx\ndraft report body'.length)
  })

  it('reaches draft PDF text + page-count layers through path-based APIs', async () => {
    pdfInfoExternalMock.mockResolvedValue(4)
    readExternalMock.mockResolvedValue('pdf draft text')
    const file = createDraftFile({
      id: 'draft-pdf',
      ext: '.pdf',
      origin_name: 'draft.pdf',
      type: FILE_TYPE.DOCUMENT,
      path: '/Users/me/draft.pdf'
    })

    const tokens = await estimateFileTokens(file)

    expect(pdfInfoExternalMock).toHaveBeenCalledWith('/Users/me/draft.pdf')
    expect(readExternalMock).toHaveBeenCalledWith('/Users/me/draft.pdf', true)
    expect(pdfInfoMock).not.toHaveBeenCalled()
    // 'draft.pdf\npdf draft text' + 4 pages × 8 overhead
    expect(tokens).toBe('draft.pdf\npdf draft text'.length + 4 * 8)
  })

  it('reaches draft image dimensions through imageSizeExternal (path-based, no base64)', async () => {
    imageSizeExternalMock.mockResolvedValue({ width: 512, height: 512 })
    const file = createDraftFile({
      id: 'draft-img',
      ext: '.png',
      origin_name: 'shot.png',
      type: FILE_TYPE.IMAGE,
      path: '/Users/me/shot.png'
    })

    const tokens = await estimateFileTokens(file)

    expect(imageSizeExternalMock).toHaveBeenCalledWith('/Users/me/shot.png')
    expect(imageSizeMock).not.toHaveBeenCalled()
    expect(base64ImageExternalMock).not.toHaveBeenCalled()
    expect(base64ImageMock).not.toHaveBeenCalled()
    // dimension-driven, not a fallback: 85 + 1 tile × 170
    expect(tokens).toBe(255)
    expect(tokens).not.toBe(IMAGE_FALLBACK_TOKENS)
  })

  it('falls back to bounded bytes only on a true path read failure', async () => {
    readExternalMock.mockRejectedValue(new Error('ENOENT: original file moved'))
    const file = createDraftFile({
      id: 'gone',
      ext: '.txt',
      origin_name: 'gone.txt',
      size: 800,
      path: '/Users/me/gone.txt'
    })

    const tokens = await estimateFileTokens(file)

    // 800 bytes / 4 = 200 tokens — only after a genuine failure, not because id is absent
    expect(tokens).toBe(200)
  })
})

describe('estimateImageBlockTokens', () => {
  it('routes block.file through the file estimator (dimensions IPC)', async () => {
    imageSizeMock.mockResolvedValue({ width: 512, height: 512 })
    const block = makeImageBlock({ file: createFile({ id: 'bf1', ext: '.png', type: FILE_TYPE.IMAGE }) })

    await expect(estimateImageBlockTokens(block)).resolves.toBe(255)
    expect(imageSizeMock).toHaveBeenCalledWith('bf1.png')
    expect(base64ImageMock).not.toHaveBeenCalled()
  })

  it('probes data URLs directly without file IPC', async () => {
    imageProbeResult = { width: 512, height: 512 }
    const block = makeImageBlock({ url: 'data:image/png;base64,AAAA' })

    await expect(estimateImageBlockTokens(block)).resolves.toBe(255)
    expect(base64ImageMock).not.toHaveBeenCalled()
    expect(imageSizeMock).not.toHaveBeenCalled()
  })

  it('caches data-URL estimates — repeated identical URLs probe the image only once', async () => {
    imageProbeResult = { width: 512, height: 512 }
    const url = 'data:image/png;base64,REPEATED_PAYLOAD'

    const first = await estimateImageBlockTokens(makeImageBlock({ url }))
    const probesAfterFirst = imageConstructorCalls
    const second = await estimateImageBlockTokens(makeImageBlock({ url }))

    expect(first).toBe(255)
    expect(second).toBe(255)
    // Second estimate served from cache — no additional Image() probe.
    expect(probesAfterFirst).toBe(1)
    expect(imageConstructorCalls).toBe(1)
  })

  it('distinct data URLs are cached under distinct keys (no cross-contamination)', async () => {
    imageProbeResult = { width: 512, height: 512 }
    await estimateImageBlockTokens(makeImageBlock({ url: 'data:image/png;base64,AAAA' }))
    await estimateImageBlockTokens(makeImageBlock({ url: 'data:image/png;base64,BBBBBB' }))

    // Two different payloads → two distinct probes.
    expect(imageConstructorCalls).toBe(2)
  })

  it('never downloads remote URLs — fixed fallback, no Image load, no IPC', async () => {
    const block = makeImageBlock({ url: 'https://example.com/generated.png' })

    await expect(estimateImageBlockTokens(block)).resolves.toBe(IMAGE_FALLBACK_TOKENS)
    expect(imageConstructorCalls).toBe(0)
    expect(base64ImageMock).not.toHaveBeenCalled()
    expect(imageSizeMock).not.toHaveBeenCalled()
  })

  it('returns 0 for blocks without file or url', async () => {
    await expect(estimateImageBlockTokens(makeImageBlock())).resolves.toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Degraded imported image blocks (LOCK-UI-2): a marked block is skipped
// BEFORE any file:imageSize IPC — deterministic fallback, zero IPC attempts.
// ---------------------------------------------------------------------------

describe('estimateImageBlockTokens — degraded imported images (LOCK-UI-2)', () => {
  it('returns the fixed fallback for a marked file-backed block without any imageSize IPC', async () => {
    imageSizeMock.mockResolvedValue({ width: 512, height: 512 })
    const block = makeImageBlock({
      l2AttachmentUnavailable: true,
      file: createFile({ id: 'degraded', ext: '.png', origin_name: 'missing.png', type: FILE_TYPE.IMAGE })
    })

    await expect(estimateImageBlockTokens(block)).resolves.toBe(IMAGE_FALLBACK_TOKENS)
    expect(imageSizeMock).not.toHaveBeenCalled()
    expect(imageSizeExternalMock).not.toHaveBeenCalled()
    expect(base64ImageMock).not.toHaveBeenCalled()
    expect(base64ImageExternalMock).not.toHaveBeenCalled()
  })

  it('returns the fixed fallback for a marked url-only block without probing or IPC', async () => {
    imageProbeResult = { width: 512, height: 512 }
    const block = makeImageBlock({
      l2AttachmentUnavailable: true,
      url: 'https://example.com/missing.png'
    })

    await expect(estimateImageBlockTokens(block)).resolves.toBe(IMAGE_FALLBACK_TOKENS)
    expect(imageConstructorCalls).toBe(0)
    expect(imageSizeMock).not.toHaveBeenCalled()
    expect(base64ImageMock).not.toHaveBeenCalled()
  })

  it('keeps the healthy file-backed path when the marker is explicitly false', async () => {
    imageSizeMock.mockResolvedValue({ width: 512, height: 512 })
    const block = makeImageBlock({
      l2AttachmentUnavailable: false,
      file: createFile({ id: 'healthy', ext: '.png', origin_name: 'ok.png', type: FILE_TYPE.IMAGE })
    })

    await expect(estimateImageBlockTokens(block)).resolves.toBe(255)
    expect(imageSizeMock).toHaveBeenCalledWith('healthy.png')
  })

  it('excludes marked blocks from the message-level estimate without any imageSize IPC', async () => {
    imageSizeMock.mockResolvedValue({ width: 512, height: 512 })
    imageProbeResult = { width: 512, height: 512 }
    const message = makeMessage('m-degraded', [
      {
        id: 'b-degraded',
        type: MessageBlockType.IMAGE,
        l2AttachmentUnavailable: true,
        file: createFile({ id: 'd1', ext: '.png', origin_name: 'missing.png', type: FILE_TYPE.IMAGE })
      },
      { id: 'b-healthy', type: MessageBlockType.IMAGE, url: 'data:image/png;base64,AAAA' }
    ])

    const estimate = await estimateMessageTokens(message)

    // Degraded block contributes the deterministic fallback; the healthy
    // data-URL block estimates 255 via an in-renderer probe — and no file
    // IPC ever fired for the marked block.
    expect(estimate.imageTokens).toBe(IMAGE_FALLBACK_TOKENS + 255)
    expect(imageSizeMock).not.toHaveBeenCalled()
    expect(imageSizeExternalMock).not.toHaveBeenCalled()
    expect(base64ImageMock).not.toHaveBeenCalled()
    expect(base64ImageExternalMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Cache behavior (LOCK-009)
// ---------------------------------------------------------------------------

describe('estimation cache', () => {
  it('caches by file identity — second sequential estimate does not re-read', async () => {
    readMock.mockResolvedValue('cached body')
    const file = createFile({ id: 'cache1', ext: '.txt', origin_name: 'a.txt' })

    const first = await estimateFileTokens(file)
    const second = await estimateFileTokens(file)

    expect(first).toBe(second)
    expect(readMock).toHaveBeenCalledTimes(1)
  })

  it('deduplicates concurrent estimates into a single read', async () => {
    let resolveRead!: (value: string) => void
    readMock.mockImplementation(() => new Promise<string>((resolve) => (resolveRead = resolve)))
    const file = createFile({ id: 'cache2', ext: '.txt', origin_name: 'b.txt' })

    const pending = Promise.all([estimateFileTokens(file), estimateFileTokens(file)])
    resolveRead('shared body')
    const [first, second] = await pending

    expect(first).toBe(second)
    expect(first).toBe('b.txt\nshared body'.length)
    expect(readMock).toHaveBeenCalledTimes(1)
  })

  it('drops rejected entries — failure yields fallback, retry recomputes', async () => {
    readMock.mockRejectedValueOnce(new Error('flaky read')).mockResolvedValueOnce('recovered')
    const file = createFile({ id: 'cache3', ext: '.txt', origin_name: 'c.txt', size: 400 })

    const failed = await estimateFileTokens(file)
    const recovered = await estimateFileTokens(file)

    expect(failed).toBe(100) // bounded byte fallback: 400 / 4
    expect(recovered).toBe('c.txt\nrecovered'.length)
    expect(readMock).toHaveBeenCalledTimes(2)
  })

  it('is bounded — oldest entry is evicted and recomputed after capacity overflow', async () => {
    readMock.mockResolvedValue('x')
    const first = createFile({ id: 'evict-target', ext: '.txt', origin_name: 'first.txt' })

    await estimateFileTokens(first)
    for (let i = 0; i < 128; i++) {
      await estimateFileTokens(createFile({ id: `filler-${i}`, ext: '.txt', origin_name: `filler-${i}.txt` }))
    }
    await estimateFileTokens(first)

    const firstReads = readMock.mock.calls.filter(([arg]) => arg === 'evict-target.txt')
    expect(firstReads).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Draft / message estimators (LOCK-005)
// ---------------------------------------------------------------------------

describe('estimateDraftTokens', () => {
  it('combines text with mixed attachments into a breakdown', async () => {
    readMock.mockResolvedValue('body')
    imageSizeMock.mockResolvedValue({ width: 512, height: 512 })

    const estimate = await estimateDraftTokens({
      content: 'hello',
      files: [
        createFile({ id: 'd1', ext: '.txt', origin_name: 'a.txt' }),
        createFile({ id: 'd2', ext: '.png', origin_name: 'p.png', type: FILE_TYPE.IMAGE })
      ]
    })

    expect(estimate.textTokens).toBe(5)
    expect(estimate.fileTokens).toBe('a.txt\nbody'.length)
    expect(estimate.imageTokens).toBe(255)
    expect(estimate.totalTokens).toBe(5 + 'a.txt\nbody'.length + 255)
  })

  it('returns text-only estimate when no attachments (regression)', async () => {
    const estimate = await estimateDraftTokens({ content: 'plain draft' })

    expect(estimate).toEqual({ textTokens: 11, imageTokens: 0, fileTokens: 0, totalTokens: 11 })
    expect(readMock).not.toHaveBeenCalled()
    expect(base64ImageMock).not.toHaveBeenCalled()
    expect(imageSizeMock).not.toHaveBeenCalled()
  })
})

describe('estimateMessageTokens', () => {
  it('recognizes both FileMessageBlock and ImageMessageBlock', async () => {
    readMock.mockResolvedValue('abc')
    imageProbeResult = { width: 512, height: 512 }

    const message = makeMessage('m1', [
      { id: 'b-text', type: MessageBlockType.MAIN_TEXT, content: 'hello' },
      {
        id: 'b-file',
        type: MessageBlockType.FILE,
        file: createFile({ id: 'mf1', ext: '.txt', origin_name: 'a.txt' })
      },
      { id: 'b-image', type: MessageBlockType.IMAGE, url: 'data:image/png;base64,AAAA' }
    ])

    const estimate = await estimateMessageTokens(message)

    // combined text: 'hello' + ' ' (empty reasoning join) = 6
    expect(estimate.textTokens).toBe(6)
    expect(estimate.fileTokens).toBe('a.txt\nabc'.length)
    expect(estimate.imageTokens).toBe(255)
    expect(estimate.totalTokens).toBe(6 + 'a.txt\nabc'.length + 255)
  })

  it('text-only message estimate is unchanged by the attachment path (regression)', async () => {
    const message = makeMessage('m2', [{ id: 'b-only', type: MessageBlockType.MAIN_TEXT, content: 'just text' }])

    const estimate = await estimateMessageTokens(message)

    expect(estimate.totalTokens).toBe('just text'.length + 1)
    expect(estimate.imageTokens).toBe(0)
    expect(estimate.fileTokens).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// TokenService integration — shared estimator, usage shape, history
// ---------------------------------------------------------------------------

describe('TokenService integration', () => {
  it('estimateUserPromptUsage has no magic -7 and stays non-negative for image-only drafts', async () => {
    imageSizeMock.mockResolvedValue({ width: 512, height: 512 })

    const usage = await estimateUserPromptUsage({
      files: [createFile({ id: 'u1', ext: '.png', origin_name: 'p.png', type: FILE_TYPE.IMAGE })]
    })

    expect(usage.prompt_tokens).toBe(0)
    expect(usage.completion_tokens).toBe(0)
    expect(usage.total_tokens).toBe(255) // exactly the image estimate — not 255 - 7
    expect(usage.total_tokens).toBeGreaterThanOrEqual(0)
  })

  it('estimateHistoryTokens includes ImageMessageBlock tokens and ignores usage fields', async () => {
    imageProbeResult = { width: 512, height: 512 }

    const withImage = makeMessage('h1', [
      { id: 'h1-text', type: MessageBlockType.MAIN_TEXT, content: 'look' },
      { id: 'h1-image', type: MessageBlockType.IMAGE, url: 'data:image/png;base64,AAAA' }
    ])
    ;(withImage as any).usage = { total_tokens: 99_999, prompt_tokens: 99_999, completion_tokens: 99_999 }

    const tokens = await estimateHistoryTokens(makeAssistant(''), [withImage])

    // text 'look' + ' ' = 5, image 255 — usage 99999 ignored (LOCK-002)
    expect(tokens).toBe(5 + 255)
  })

  it('shared estimator: pre-upload draft (path) and stored history (id) of the same content agree', async () => {
    // Realistic identities: the draft is pre-upload (fresh id, original path) while
    // the uploaded history copy has a different id and a storageDir path. They are
    // NOT the same id — the previous premise (identical ids) was wrong (audit).
    readExternalMock.mockResolvedValue('same body')
    readMock.mockResolvedValue('same body')

    const draftFile = createDraftFile({
      id: 'draft-id',
      ext: '.txt',
      origin_name: 's.txt',
      path: '/Users/me/s.txt'
    })
    const storedFile = createFile({ id: 'stored-id', ext: '.txt', origin_name: 's.txt' }) // path → /storage/stored-id.txt

    const draft = await estimateDraftTokens({ content: '', files: [draftFile] })

    const message = makeMessage('h2', [{ id: 'h2-file', type: MessageBlockType.FILE, file: storedFile }])
    const historyTokens = await estimateHistoryTokens(makeAssistant(''), [message])

    // Same sendable text → same file-token count. History adds the empty
    // combined-text separator (' ' → 1 token) on top of the file tokens.
    expect(historyTokens - 1).toBe(draft.fileTokens)
    // Draft resolved through the path API; history through the storage-id API.
    expect(readExternalMock).toHaveBeenCalledWith('/Users/me/s.txt', false)
    expect(readMock).toHaveBeenCalledWith('stored-id.txt', false)
  })

  it('cache dedupe for identical identity: estimating the same stored file twice reads once', async () => {
    readMock.mockResolvedValue('cached identity')
    const file = createFile({ id: 'identity', ext: '.txt', origin_name: 'i.txt' })

    const first = await estimateDraftTokens({ content: '', files: [file] })
    const second = await estimateDraftTokens({ content: '', files: [file] })

    expect(first.fileTokens).toBe(second.fileTokens)
    // Identical file identity → served from the shared cache: a single read.
    expect(readMock).toHaveBeenCalledTimes(1)
  })
})
