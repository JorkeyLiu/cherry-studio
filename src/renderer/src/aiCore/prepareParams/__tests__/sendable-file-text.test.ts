import type { FileMetadata } from '@renderer/types/file'
import { FILE_TYPE } from '@renderer/types/file'
import type { FileMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/services/AssistantService', () => ({
  getProviderByModel: vi.fn(),
  getDefaultAssistant: vi.fn(() => ({
    id: 'default',
    name: 'Default Assistant',
    prompt: '',
    topics: [],
    type: 'assistant'
  })),
  getDefaultTopic: vi.fn(() => ({ id: 'default-topic', assistantId: 'default', name: 'Default Topic', messages: [] }))
}))

vi.mock('../../provider/factory', () => ({
  getAiSdkProviderId: vi.fn()
}))

vi.mock('../modelCapabilities', () => ({
  getFileSizeLimit: vi.fn(),
  supportsImageInput: vi.fn(),
  supportsLargeFileUpload: vi.fn()
}))

vi.mock('i18next', () => {
  const i18nMock = {
    t: (key: string) => key,
    use: () => i18nMock,
    init: () => Promise.resolve(),
    on: () => i18nMock,
    isInitialized: true
  }
  return { default: i18nMock }
})

// LocalTokenEstimator transitively imports the redux store (via messageUtils/find);
// estimateFileTokens itself never touches it, so a minimal stub suffices.
vi.mock('@renderer/store', () => ({
  default: { getState: () => ({}), dispatch: () => {} }
}))

import { estimateFileTokens, resetLocalTokenEstimatorCache } from '@renderer/services/LocalTokenEstimator'

import { convertFileBlockToFilePart, convertFileBlockToTextPart } from '../fileProcessor'
import { getFileSizeLimit } from '../modelCapabilities'
import {
  buildSendableFileText,
  fileCacheKey,
  getSendableFileText,
  isPdfFile,
  isStoredFile,
  isTextSendableFile,
  MAX_SENDABLE_TEXT_CACHE_ENTRIES,
  normalizeFileExtension,
  prepareSendableFileText,
  resetSendableFileTextCache
} from '../sendableFileText'

const readMock = vi.fn()
const readExternalMock = vi.fn()
const base64FileMock = vi.fn()
const pdfInfoMock = vi.fn()
const pdfInfoExternalMock = vi.fn()
const toastErrorMock = vi.fn()
const toastWarningMock = vi.fn()

let fileCounter = 0

/**
 * Stored/history file: `path` ends with `${id}${ext}` → `isStoredFile` true →
 * storage-id read. This is the default (mirrors uploaded/history attachments).
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
  return { ...merged, path: overrides.path ?? `/storage/${merged.id}${merged.ext}` }
}

/**
 * Pre-upload draft file (select/paste/drop → file.get): fresh id absent from
 * storageDir, `path` at the original/temp file → `isStoredFile` false → path read.
 */
const createDraftFile = (overrides: Partial<FileMetadata> = {}): FileMetadata => {
  const merged = createFile(overrides)
  return { ...merged, path: overrides.path ?? `/Users/me/original/${merged.origin_name}` }
}

const createFileBlock = (file: FileMetadata): FileMessageBlock => ({
  id: `file-block-${fileCounter}`,
  messageId: 'message-1',
  type: MessageBlockType.FILE,
  createdAt: new Date(2024, 0, 1).toISOString(),
  status: MessageBlockStatus.SUCCESS,
  file
})

beforeEach(() => {
  readMock.mockReset()
  readExternalMock.mockReset()
  base64FileMock.mockReset()
  pdfInfoMock.mockReset()
  pdfInfoExternalMock.mockReset()
  toastErrorMock.mockReset()
  toastWarningMock.mockReset()
  vi.mocked(getFileSizeLimit).mockReset()
  resetSendableFileTextCache()
  resetLocalTokenEstimatorCache()
  vi.stubGlobal('api', {
    file: {
      read: readMock,
      readExternal: readExternalMock,
      base64File: base64FileMock,
      pdfInfo: pdfInfoMock,
      pdfInfoExternal: pdfInfoExternalMock
    }
  })
  vi.stubGlobal('toast', { error: toastErrorMock, warning: toastWarningMock })
})

describe('isStoredFile', () => {
  it('recognizes stored files whose path ends with id+ext', () => {
    expect(isStoredFile(createFile({ id: 'abc', ext: '.txt' }))).toBe(true)
  })

  it('rejects pre-upload draft files whose path points at the original file', () => {
    expect(isStoredFile(createDraftFile({ id: 'abc', ext: '.txt', origin_name: 'notes.txt' }))).toBe(false)
  })

  it('rejects files without a path', () => {
    expect(isStoredFile(createFile({ id: 'abc', ext: '.txt', path: '' }))).toBe(false)
  })
})

describe('buildSendableFileText', () => {
  it('joins filename and content with a single newline', () => {
    expect(buildSendableFileText('notes.md', '# Title\nbody')).toBe('notes.md\n# Title\nbody')
  })

  it('trims surrounding whitespace from extracted content only', () => {
    expect(buildSendableFileText('main.ts', '\n\nconst a = 1\n\n')).toBe('main.ts\nconst a = 1')
  })

  it('keeps filename row even when content is empty', () => {
    expect(buildSendableFileText('empty.txt', '')).toBe('empty.txt\n')
  })
})

describe('isTextSendableFile', () => {
  it('accepts text and document files', () => {
    expect(isTextSendableFile(createFile({ type: FILE_TYPE.TEXT }))).toBe(true)
    expect(isTextSendableFile(createFile({ type: FILE_TYPE.DOCUMENT }))).toBe(true)
  })

  it('rejects other file types', () => {
    expect(isTextSendableFile(createFile({ type: FILE_TYPE.IMAGE }))).toBe(false)
    expect(isTextSendableFile(createFile({ type: FILE_TYPE.AUDIO }))).toBe(false)
    expect(isTextSendableFile(createFile({ type: FILE_TYPE.OTHER }))).toBe(false)
  })
})

describe('prepareSendableFileText', () => {
  it('reads text files without encoding detection and returns filename + content', async () => {
    readMock.mockResolvedValue('hello world\n')
    const file = createFile({ id: 'abc', ext: '.txt', origin_name: 'readme.txt' })

    const result = await prepareSendableFileText(file)

    expect(readMock).toHaveBeenCalledTimes(1)
    expect(readMock).toHaveBeenCalledWith('abc.txt', false)
    expect(result).toBe('readme.txt\nhello world')
  })

  it('handles code files as text files with the same shape', async () => {
    readMock.mockResolvedValue('export const x = 1\n')
    const file = createFile({ id: 'code', ext: '.ts', origin_name: 'index.ts', type: FILE_TYPE.TEXT })

    const result = await prepareSendableFileText(file)

    expect(readMock).toHaveBeenCalledWith('code.ts', false)
    expect(result).toBe('index.ts\nexport const x = 1')
  })

  it('reads document (Office) files with forced text extraction flag', async () => {
    readMock.mockResolvedValue('  Quarterly report contents  ')
    const file = createFile({ id: 'doc', ext: '.docx', origin_name: 'report.docx', type: FILE_TYPE.DOCUMENT })

    const result = await prepareSendableFileText(file)

    expect(readMock).toHaveBeenCalledTimes(1)
    expect(readMock).toHaveBeenCalledWith('doc.docx', true)
    expect(result).toBe('report.docx\nQuarterly report contents')
  })

  it('returns filename row with empty content when extraction yields nothing', async () => {
    readMock.mockResolvedValue('   \n  ')
    const file = createFile({ id: 'blank', ext: '.txt', origin_name: 'blank.txt' })

    await expect(prepareSendableFileText(file)).resolves.toBe('blank.txt\n')
  })

  it('propagates read failures to the caller', async () => {
    const failure = new Error('ENOENT: file missing')
    readMock.mockRejectedValue(failure)
    const file = createFile({ type: FILE_TYPE.DOCUMENT, ext: '.xlsx', origin_name: 'data.xlsx' })

    await expect(prepareSendableFileText(file)).rejects.toThrow('ENOENT: file missing')
  })

  it('returns null for non text-sendable files without reading', async () => {
    const file = createFile({ type: FILE_TYPE.IMAGE, ext: '.png', origin_name: 'photo.png' })

    await expect(prepareSendableFileText(file)).resolves.toBeNull()
    expect(readMock).not.toHaveBeenCalled()
    expect(readExternalMock).not.toHaveBeenCalled()
  })

  // ── pre-upload draft resolution (audit F1) ──────────────────────────────
  it('reads pre-upload draft text from its real path via readExternal (no storage-id read)', async () => {
    readExternalMock.mockResolvedValue('draft text\n')
    const file = createDraftFile({ id: 'abc', ext: '.txt', origin_name: 'readme.txt', path: '/Users/me/readme.txt' })

    const result = await prepareSendableFileText(file)

    expect(readExternalMock).toHaveBeenCalledWith('/Users/me/readme.txt', false)
    expect(readMock).not.toHaveBeenCalled()
    expect(result).toBe('readme.txt\ndraft text')
  })

  it('reads pre-upload draft document from its real path with detectEncoding=true', async () => {
    readExternalMock.mockResolvedValue('  draft office body  ')
    const file = createDraftFile({
      id: 'doc',
      ext: '.docx',
      origin_name: 'report.docx',
      type: FILE_TYPE.DOCUMENT,
      path: '/Users/me/report.docx'
    })

    const result = await prepareSendableFileText(file)

    expect(readExternalMock).toHaveBeenCalledWith('/Users/me/report.docx', true)
    expect(readMock).not.toHaveBeenCalled()
    expect(result).toBe('report.docx\ndraft office body')
  })
})

describe('convertFileBlockToTextPart', () => {
  it('returns a TextPart with filename + trimmed content for text files', async () => {
    readMock.mockResolvedValue('line one\nline two\n')
    const block = createFileBlock(createFile({ id: 'txt', ext: '.md', origin_name: 'notes.md' }))

    const result = await convertFileBlockToTextPart(block)

    expect(readMock).toHaveBeenCalledWith('txt.md', false)
    expect(result).toEqual({ type: 'text', text: 'notes.md\nline one\nline two' })
  })

  it('returns a TextPart via forced text extraction for document files', async () => {
    readMock.mockResolvedValue('extracted office text')
    const block = createFileBlock(
      createFile({ id: 'office', ext: '.docx', origin_name: 'contract.docx', type: FILE_TYPE.DOCUMENT })
    )

    const result = await convertFileBlockToTextPart(block)

    expect(readMock).toHaveBeenCalledWith('office.docx', true)
    expect(result).toEqual({ type: 'text', text: 'contract.docx\nextracted office text' })
  })

  it('falls back to null on text file read failure without toasting', async () => {
    readMock.mockRejectedValue(new Error('read failed'))
    const block = createFileBlock(createFile({ type: FILE_TYPE.TEXT }))

    await expect(convertFileBlockToTextPart(block)).resolves.toBeNull()
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('falls back to null and toasts on document extraction failure', async () => {
    readMock.mockRejectedValue(new Error('extraction failed'))
    const block = createFileBlock(createFile({ type: FILE_TYPE.DOCUMENT, ext: '.pdf', origin_name: 'scan.pdf' }))

    await expect(convertFileBlockToTextPart(block)).resolves.toBeNull()
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock).toHaveBeenCalledWith('message.error.file.text_extraction_failed')
  })

  it('returns null for unsupported file types without reading', async () => {
    const block = createFileBlock(createFile({ type: FILE_TYPE.VIDEO, ext: '.mp4', origin_name: 'clip.mp4' }))

    await expect(convertFileBlockToTextPart(block)).resolves.toBeNull()
    expect(readMock).not.toHaveBeenCalled()
    expect(readExternalMock).not.toHaveBeenCalled()
  })

  it('converts a pre-upload draft file block through the path API (shared boundary)', async () => {
    readExternalMock.mockResolvedValue('draft block body')
    const block = createFileBlock(
      createDraftFile({ id: 'draft-uuid', ext: '.md', origin_name: 'draft.md', path: '/Users/me/draft.md' })
    )

    const result = await convertFileBlockToTextPart(block)

    expect(readExternalMock).toHaveBeenCalledWith('/Users/me/draft.md', false)
    expect(result).toEqual({ type: 'text', text: 'draft.md\ndraft block body' })
  })
})

// ---------------------------------------------------------------------------
// Shared PDF / extension classification (unified estimate ↔ send path)
// ---------------------------------------------------------------------------

describe('normalizeFileExtension', () => {
  it('lowercases the extension so case never changes classification', () => {
    expect(normalizeFileExtension('.PDF')).toBe('.pdf')
    expect(normalizeFileExtension('.Pdf')).toBe('.pdf')
    expect(normalizeFileExtension('.pdf')).toBe('.pdf')
  })

  it('returns an empty string for a missing extension', () => {
    expect(normalizeFileExtension(undefined)).toBe('')
    expect(normalizeFileExtension('')).toBe('')
  })
})

describe('isPdfFile', () => {
  it('recognizes PDFs regardless of extension case', () => {
    expect(isPdfFile(createFile({ type: FILE_TYPE.DOCUMENT, ext: '.pdf' }))).toBe(true)
    expect(isPdfFile(createFile({ type: FILE_TYPE.DOCUMENT, ext: '.PDF' }))).toBe(true)
    expect(isPdfFile(createFile({ type: FILE_TYPE.DOCUMENT, ext: '.Pdf' }))).toBe(true)
  })

  it('rejects non-PDF documents and non-document types', () => {
    expect(isPdfFile(createFile({ type: FILE_TYPE.DOCUMENT, ext: '.docx' }))).toBe(false)
    expect(isPdfFile(createFile({ type: FILE_TYPE.TEXT, ext: '.pdf' }))).toBe(false)
    expect(isPdfFile(createFile({ type: FILE_TYPE.IMAGE, ext: '.pdf' }))).toBe(false)
  })
})

describe('send-path PDF classification (convertFileBlockToFilePart)', () => {
  const model = { id: 'm', name: 'model' } as any

  it('routes uppercase .PDF into the PDF FilePart branch (matches estimator classification)', async () => {
    vi.mocked(getFileSizeLimit).mockReturnValue(50 * 1024 * 1024)
    base64FileMock.mockResolvedValue({ data: 'data:application/pdf;base64,AAAA', mime: 'application/pdf' })
    const block = createFileBlock(
      createFile({ id: 'up', ext: '.PDF', origin_name: 'DOC.PDF', type: FILE_TYPE.DOCUMENT })
    )

    const result = await convertFileBlockToFilePart(block, model)

    // Uppercase .PDF must be treated as a PDF: base64File is read and a file
    // FilePart is produced, not the Word/Excel text-extraction fallback (null).
    expect(base64FileMock).toHaveBeenCalledWith('up.PDF')
    expect(result).toEqual({
      type: 'file',
      data: 'data:application/pdf;base64,AAAA',
      mediaType: 'application/pdf',
      filename: 'DOC.PDF'
    })
  })

  it('routes non-PDF documents to the text-extraction fallback (null)', async () => {
    vi.mocked(getFileSizeLimit).mockReturnValue(50 * 1024 * 1024)
    const block = createFileBlock(
      createFile({ id: 'w', ext: '.docx', origin_name: 'report.docx', type: FILE_TYPE.DOCUMENT })
    )

    const result = await convertFileBlockToFilePart(block, model)

    expect(base64FileMock).not.toHaveBeenCalled()
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Shared bounded sendable-text cache (estimator ↔ send path dedupe)
// ---------------------------------------------------------------------------

describe('fileCacheKey', () => {
  it('derives the key from id + ext + size + type', () => {
    const file = createFile({ id: 'abc', ext: '.txt', size: 42, type: FILE_TYPE.TEXT })
    expect(fileCacheKey(file)).toBe(`abc.txt:42:${FILE_TYPE.TEXT}`)
  })

  it('changes when size changes (disk edits invalidate the identity)', () => {
    const before = createFile({ id: 'abc', ext: '.txt', size: 42 })
    const after = { ...before, size: 43 }
    expect(fileCacheKey(before)).not.toBe(fileCacheKey(after))
  })
})

describe('getSendableFileText — shared cache', () => {
  it('sequential calls for the same identity perform one underlying read', async () => {
    readMock.mockResolvedValue('cached body')
    const file = createFile({ id: 'seq', ext: '.txt', origin_name: 'seq.txt' })

    const first = await getSendableFileText(file)
    const second = await getSendableFileText(file)

    expect(first).toBe('seq.txt\ncached body')
    expect(second).toBe(first)
    expect(readMock).toHaveBeenCalledTimes(1)
  })

  it('concurrent calls share a single in-flight promise (one read)', async () => {
    let resolveRead!: (value: string) => void
    readMock.mockImplementation(() => new Promise<string>((resolve) => (resolveRead = resolve)))
    const file = createFile({ id: 'conc', ext: '.txt', origin_name: 'conc.txt' })

    const pending = Promise.all([getSendableFileText(file), getSendableFileText(file)])
    resolveRead('shared body')
    const [first, second] = await pending

    expect(first).toBe('conc.txt\nshared body')
    expect(second).toBe(first)
    expect(readMock).toHaveBeenCalledTimes(1)
  })

  it('deletes rejected entries — retry after failure re-reads and succeeds', async () => {
    readMock.mockRejectedValueOnce(new Error('flaky read')).mockResolvedValueOnce('recovered')
    const file = createFile({ id: 'retry', ext: '.txt', origin_name: 'retry.txt' })

    await expect(getSendableFileText(file)).rejects.toThrow('flaky read')
    await expect(getSendableFileText(file)).resolves.toBe('retry.txt\nrecovered')
    expect(readMock).toHaveBeenCalledTimes(2)
  })

  it('resolves null for unsupported types without any read and without caching', async () => {
    const file = createFile({ id: 'vid', ext: '.mp4', origin_name: 'clip.mp4', type: FILE_TYPE.VIDEO })

    await expect(getSendableFileText(file)).resolves.toBeNull()
    await expect(getSendableFileText(file)).resolves.toBeNull()
    expect(readMock).not.toHaveBeenCalled()
    expect(readExternalMock).not.toHaveBeenCalled()
  })

  it('is bounded — oldest entry is evicted and re-read after capacity overflow', async () => {
    readMock.mockResolvedValue('x')
    const first = createFile({ id: 'evict-me', ext: '.txt', origin_name: 'first.txt' })

    await getSendableFileText(first)
    for (let i = 0; i < MAX_SENDABLE_TEXT_CACHE_ENTRIES; i++) {
      await getSendableFileText(createFile({ id: `filler-${i}`, ext: '.txt', origin_name: `filler-${i}.txt` }))
    }
    await getSendableFileText(first)

    const firstReads = readMock.mock.calls.filter(([arg]) => arg === 'evict-me.txt')
    expect(firstReads).toHaveLength(2)
  })
})

describe('estimator ↔ send path read dedupe (shared boundary)', () => {
  it('estimate then send for the same stored text file performs one read', async () => {
    readMock.mockResolvedValue('body once')
    const file = createFile({ id: 'both', ext: '.txt', origin_name: 'both.txt' })

    const tokens = await estimateFileTokens(file)
    const part = await convertFileBlockToTextPart(createFileBlock(file))

    expect(tokens).toBeGreaterThan(0)
    expect(part).toEqual({ type: 'text', text: 'both.txt\nbody once' })
    expect(readMock).toHaveBeenCalledTimes(1)
  })

  it('send then estimate for the same stored Office document performs one extraction', async () => {
    readMock.mockResolvedValue('office body')
    const file = createFile({ id: 'ofc', ext: '.docx', origin_name: 'report.docx', type: FILE_TYPE.DOCUMENT })

    const part = await convertFileBlockToTextPart(createFileBlock(file))
    const tokens = await estimateFileTokens(file)

    expect(part).toEqual({ type: 'text', text: 'report.docx\noffice body' })
    expect(tokens).toBeGreaterThan(0)
    expect(readMock).toHaveBeenCalledTimes(1)
    expect(readMock).toHaveBeenCalledWith('ofc.docx', true)
  })

  it('PDF estimate then text-fallback send share one text extraction', async () => {
    pdfInfoMock.mockResolvedValue(2)
    readMock.mockResolvedValue('pdf body')
    const file = createFile({ id: 'pdfb', ext: '.pdf', origin_name: 'doc.pdf', type: FILE_TYPE.DOCUMENT })

    await estimateFileTokens(file)
    const part = await convertFileBlockToTextPart(createFileBlock(file))

    expect(part).toEqual({ type: 'text', text: 'doc.pdf\npdf body' })
    // Extraction read happened exactly once; page-count IPC is estimator-only.
    expect(readMock).toHaveBeenCalledTimes(1)
    expect(readMock).toHaveBeenCalledWith('pdfb.pdf', true)
  })

  it('concurrent estimate + send share a single in-flight read', async () => {
    let resolveRead!: (value: string) => void
    readMock.mockImplementation(() => new Promise<string>((resolve) => (resolveRead = resolve)))
    const file = createFile({ id: 'race', ext: '.txt', origin_name: 'race.txt' })

    const pending = Promise.all([estimateFileTokens(file), convertFileBlockToTextPart(createFileBlock(file))])
    resolveRead('raced body')
    const [tokens, part] = await pending

    expect(tokens).toBeGreaterThan(0)
    expect(part).toEqual({ type: 'text', text: 'race.txt\nraced body' })
    expect(readMock).toHaveBeenCalledTimes(1)
  })

  it('failure keeps converter toast semantics and allows the send path to retry', async () => {
    readMock.mockRejectedValueOnce(new Error('extraction failed')).mockResolvedValueOnce('second try')
    const file = createFile({ id: 'tst', ext: '.docx', origin_name: 'contract.docx', type: FILE_TYPE.DOCUMENT })
    const block = createFileBlock(file)

    await expect(convertFileBlockToTextPart(block)).resolves.toBeNull()
    expect(toastErrorMock).toHaveBeenCalledTimes(1)

    // Rejected entry was dropped — the retry re-reads instead of replaying the failure.
    await expect(convertFileBlockToTextPart(block)).resolves.toEqual({
      type: 'text',
      text: 'contract.docx\nsecond try'
    })
    expect(readMock).toHaveBeenCalledTimes(2)
  })

  it('estimator failure fallback does not poison the send path', async () => {
    readMock.mockRejectedValueOnce(new Error('flaky')).mockResolvedValueOnce('healthy body')
    const file = createFile({ id: 'poison', ext: '.txt', origin_name: 'p.txt', size: 400 })

    const tokens = await estimateFileTokens(file)
    const part = await convertFileBlockToTextPart(createFileBlock(file))

    expect(tokens).toBe(100) // bounded byte fallback: 400 / 4
    expect(part).toEqual({ type: 'text', text: 'p.txt\nhealthy body' })
    expect(readMock).toHaveBeenCalledTimes(2)
  })

  it('draft→stored identities are distinct: upload assigns a new uuid, so no cross-identity reuse', async () => {
    // FileStorage.uploadFile creates the storageDir copy under a fresh uuid.
    // The pre-upload draft (original path) and the stored message-block copy are
    // therefore different cache identities by design: estimating the draft cannot
    // serve the stored send, and must not (draft files remain user-editable).
    readExternalMock.mockResolvedValue('same content')
    readMock.mockResolvedValue('same content')
    const draft = createDraftFile({ id: 'draft-id', ext: '.txt', origin_name: 's.txt', path: '/Users/me/s.txt' })
    const stored = createFile({ id: 'stored-id', ext: '.txt', origin_name: 's.txt' })

    expect(fileCacheKey(draft)).not.toBe(fileCacheKey(stored))

    await estimateFileTokens(draft)
    const part = await convertFileBlockToTextPart(createFileBlock(stored))

    expect(part).toEqual({ type: 'text', text: 's.txt\nsame content' })
    expect(readExternalMock).toHaveBeenCalledTimes(1) // draft estimate → path API
    expect(readMock).toHaveBeenCalledTimes(1) // stored send → storage-id API
  })
})
