import { beforeEach, describe, expect, it, vi } from 'vitest'

import { exportTopicDataToFile, importTopicDataFromFile } from '../topicDataJson'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    exportTopicData: vi.fn(),
    importTopicData: vi.fn(),
    save: vi.fn(),
    open: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  }
}))

vi.mock('@renderer/i18n', () => ({
  default: { t: (key: string) => key }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    exportTopicData: mocks.exportTopicData,
    importTopicData: mocks.importTopicData
  }
}))

const VALID_PAYLOAD = {
  format: 'cherry-chat-topic-data',
  version: 1,
  exportedAt: '2026-10-13T00:00:00.000Z',
  topic: { name: 'T' },
  messages: [],
  blocks: [],
  branches: [],
  segments: [],
  fileReferences: []
}

describe('topicDataJson service (standalone topic JSON file exchange)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as any).api = { file: { save: mocks.save, open: mocks.open } }
    ;(window as any).toast = { success: mocks.toastSuccess, error: mocks.toastError }
  })

  it('exports the Main snapshot to a JSON file and toasts success', async () => {
    mocks.exportTopicData.mockResolvedValue(VALID_PAYLOAD)
    // Native `file:save` resolves the saved path string on success.
    mocks.save.mockResolvedValue('/tmp/My Topic.json')

    const result = await exportTopicDataToFile({ id: 't1', name: 'My Topic' })

    expect(result).toBe(true)
    expect(mocks.exportTopicData).toHaveBeenCalledWith('t1')
    expect(mocks.save).toHaveBeenCalledTimes(1)
    const [fileName, content] = mocks.save.mock.calls[0]
    expect(typeof fileName === 'string' && fileName.endsWith('.json')).toBe(true)
    expect(JSON.parse(content as string)).toEqual(VALID_PAYLOAD)
    expect(mocks.toastSuccess).toHaveBeenCalledWith('chat.topics.export.json.success')
  })

  it('treats a falsy native save resolution as silent (no toast)', async () => {
    mocks.exportTopicData.mockResolvedValue(VALID_PAYLOAD)
    mocks.save.mockResolvedValue(false)

    const result = await exportTopicDataToFile({ id: 't1', name: 'My Topic' })

    expect(result).toBe(false)
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('treats the real native save cancellation rejection as silent (no toast)', async () => {
    mocks.exportTopicData.mockResolvedValue(VALID_PAYLOAD)
    // Representative of FileStorage.save: cancel REJECTS, never resolves false.
    mocks.save.mockRejectedValue(new Error('User canceled the save dialog'))

    const result = await exportTopicDataToFile({ id: 't1', name: 'My Topic' })

    expect(result).toBe(false)
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('treats the string-form native save cancellation as silent (no toast)', async () => {
    mocks.exportTopicData.mockResolvedValue(VALID_PAYLOAD)
    mocks.save.mockRejectedValue('An error occurred saving the file: User canceled the save dialog')

    const result = await exportTopicDataToFile({ id: 't1', name: 'My Topic' })

    expect(result).toBe(false)
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('toasts a localized error when the native save write fails', async () => {
    mocks.exportTopicData.mockResolvedValue(VALID_PAYLOAD)
    mocks.save.mockRejectedValue(new Error('EACCES: permission denied'))

    const result = await exportTopicDataToFile({ id: 't1', name: 'My Topic' })

    expect(result).toBe(false)
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('chat.topics.export.json.error')
  })

  it('toasts a localized error when the export snapshot fails', async () => {
    mocks.exportTopicData.mockRejectedValue(new Error('NOT_FOUND'))

    const result = await exportTopicDataToFile({ id: 'missing', name: 'Missing' })

    expect(result).toBe(false)
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('chat.topics.export.json.error')
  })

  it('imports a valid file as a new topic projection', async () => {
    mocks.open.mockResolvedValue({ content: JSON.stringify(VALID_PAYLOAD) })
    mocks.importTopicData.mockResolvedValue({
      topic: { id: 't-new', assistantId: 'a1', name: 'T' },
      messageCount: 0,
      blockCount: 0,
      branchCount: 0,
      segmentCount: 0,
      fileReferenceCount: 0
    })

    const topic = await importTopicDataFromFile('a1')

    expect(mocks.importTopicData).toHaveBeenCalledWith(VALID_PAYLOAD, 'a1')
    expect(topic).toMatchObject({ id: 't-new', assistantId: 'a1', name: 'T' })
    expect(mocks.toastSuccess).toHaveBeenCalledWith('chat.topics.import.success')
  })

  it('treats native open cancellation as silent (no toast, no import)', async () => {
    mocks.open.mockResolvedValue(null)

    const topic = await importTopicDataFromFile('a1')

    expect(topic).toBeNull()
    expect(mocks.importTopicData).not.toHaveBeenCalled()
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('rejects unparseable files without touching Main', async () => {
    mocks.open.mockResolvedValue({ content: 'not json' })

    const topic = await importTopicDataFromFile('a1')

    expect(topic).toBeNull()
    expect(mocks.importTopicData).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('chat.topics.import.invalid')
  })

  it('rejects files with an unexpected format marker without touching Main', async () => {
    mocks.open.mockResolvedValue({ content: JSON.stringify({ format: 'other', version: 1 }) })

    const topic = await importTopicDataFromFile('a1')

    expect(topic).toBeNull()
    expect(mocks.importTopicData).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('chat.topics.import.invalid')
  })

  it('toasts a localized error when Main rejects the payload', async () => {
    mocks.open.mockResolvedValue({ content: JSON.stringify(VALID_PAYLOAD) })
    mocks.importTopicData.mockRejectedValue(new Error('VALIDATION_ERROR'))

    const topic = await importTopicDataFromFile('a1')

    expect(topic).toBeNull()
    expect(mocks.toastError).toHaveBeenCalledWith('chat.topics.import.error')
  })
})
