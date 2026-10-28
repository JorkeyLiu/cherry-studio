/**
 * Standalone topic JSON export — referenced-history snapshot posture messaging.
 *
 * Proves `exportTopicDataToFile` keeps the standard success/cancel/error
 * behavior and adds ONLY the informative follow-up driven by the exported
 * payload's `historySnapshot` status (never loaded topic metadata).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  exportTopicData: vi.fn()
}))

vi.mock('@renderer/i18n', () => ({
  default: { t: (key: string) => key }
}))
vi.mock('@renderer/services/db', () => ({
  dbService: { exportTopicData: mocks.exportTopicData }
}))
vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  topicWireToTopic: (topic: unknown) => topic
}))
vi.mock('@renderer/utils/file', () => ({
  removeSpecialCharactersForFileName: (name: string) => name
}))

const toastSuccess = vi.fn()
const toastInfo = vi.fn()
const toastWarning = vi.fn()
const toastError = vi.fn()
const fileSave = vi.fn()

const ORDINARY_PAYLOAD = {
  format: 'cherry-chat-topic-data',
  version: 1,
  exportedAt: '2026-07-19T00:00:00.000Z',
  topic: { name: 'T', createdAt: null, updatedAt: null },
  messages: [],
  blocks: [],
  branches: [],
  segments: [],
  fileReferences: []
}

beforeEach(() => {
  vi.clearAllMocks()
  fileSave.mockResolvedValue('/tmp/topic.json')
  window.api = { file: { save: fileSave } } as never
  window.toast = {
    success: toastSuccess,
    info: toastInfo,
    warning: toastWarning,
    error: toastError
  } as never
})

describe('exportTopicDataToFile history snapshot explanation', () => {
  it('ordinary topic (no historySnapshot): standard success only', async () => {
    mocks.exportTopicData.mockResolvedValue({ ...ORDINARY_PAYLOAD })
    const { exportTopicDataToFile } = await import('../topicDataJson')

    const ok = await exportTopicDataToFile({ id: 't1', name: 'Topic' })

    expect(ok).toBe(true)
    expect(toastSuccess).toHaveBeenCalledWith('chat.topics.export.json.success')
    expect(toastInfo).not.toHaveBeenCalled()
    expect(toastWarning).not.toHaveBeenCalled()
  })

  it('materialized snapshot: success plus the independent-copy explanation', async () => {
    mocks.exportTopicData.mockResolvedValue({
      ...ORDINARY_PAYLOAD,
      historySnapshot: { status: 'materialized' }
    })
    const { exportTopicDataToFile } = await import('../topicDataJson')

    const ok = await exportTopicDataToFile({ id: 't1', name: 'Topic' })

    expect(ok).toBe(true)
    expect(toastSuccess).toHaveBeenCalledWith('chat.topics.export.json.success')
    expect(toastInfo).toHaveBeenCalledWith('chat.topics.export.json.referenceExplanation')
    expect(toastWarning).not.toHaveBeenCalled()
  })

  it('missing snapshot: success plus the explicit missing-history warning', async () => {
    mocks.exportTopicData.mockResolvedValue({
      ...ORDINARY_PAYLOAD,
      historySnapshot: { status: 'missing' }
    })
    const { exportTopicDataToFile } = await import('../topicDataJson')

    const ok = await exportTopicDataToFile({ id: 't1', name: 'Topic' })

    expect(ok).toBe(true)
    expect(toastSuccess).toHaveBeenCalledWith('chat.topics.export.json.success')
    expect(toastWarning).toHaveBeenCalledWith('chat.topics.export.json.referenceMissing')
    expect(toastInfo).not.toHaveBeenCalled()
  })

  it('native cancellation stays silent (no success/snapshot/error toast)', async () => {
    mocks.exportTopicData.mockResolvedValue({
      ...ORDINARY_PAYLOAD,
      historySnapshot: { status: 'materialized' }
    })
    fileSave.mockRejectedValue(new Error('User canceled the save dialog'))
    const { exportTopicDataToFile } = await import('../topicDataJson')

    const ok = await exportTopicDataToFile({ id: 't1', name: 'Topic' })

    expect(ok).toBe(false)
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(toastInfo).not.toHaveBeenCalled()
    expect(toastWarning).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('export failure toasts the standard error only', async () => {
    mocks.exportTopicData.mockRejectedValue(new Error('boom'))
    const { exportTopicDataToFile } = await import('../topicDataJson')

    const ok = await exportTopicDataToFile({ id: 't1', name: 'Topic' })

    expect(ok).toBe(false)
    expect(toastError).toHaveBeenCalledWith('chat.topics.export.json.error')
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(toastWarning).not.toHaveBeenCalled()
  })
})

const { exportPathState } = vi.hoisted(() => ({
  exportPathState: { path: null as string | null, includeThinking: false }
}))

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => ({
      settings: {
        exportPath: exportPathState.path,
        exportIncludeThinking: exportPathState.includeThinking
      }
    })
  }
}))

describe('exportTopicDataToFile uses the shared export directory', () => {
  const payload = () => ({
    ...ORDINARY_PAYLOAD,
    blocks: [{ id: 'b1', type: 'THINKING', content: 'reasoning' }],
    messages: [{ id: 'm1', role: 'assistant' }]
  })
  const fileWrite = vi.fn()

  beforeEach(() => {
    exportPathState.path = null
    exportPathState.includeThinking = false
    fileWrite.mockResolvedValue(undefined)
    window.api = { file: { save: fileSave, write: fileWrite } } as never
    mocks.exportTopicData.mockResolvedValue(payload())
  })

  it('writes the unchanged payload into the configured directory (no dialog)', async () => {
    exportPathState.path = '/tmp/exports'
    const { exportTopicDataToFile } = await import('../topicDataJson')

    const ok = await exportTopicDataToFile({ id: 't1', name: 'Topic' })

    expect(ok).toBe(true)
    expect(fileSave).not.toHaveBeenCalled()
    expect(fileWrite).toHaveBeenCalledTimes(1)
    const [target, written] = fileWrite.mock.calls[0] as [string, string]
    expect(target).toBe('/tmp/exports/Topic.json')
    // Only `exportedAt` is nondeterministic; everything else is the payload verbatim.
    const parsed = JSON.parse(written)
    delete parsed.exportedAt
    const expected: any = payload()
    delete expected.exportedAt
    expect(parsed).toEqual(expected)
  })

  it('keeps the payload identical when the Markdown reasoning default is toggled', async () => {
    exportPathState.path = '/tmp/exports'
    const { exportTopicDataToFile } = await import('../topicDataJson')

    exportPathState.includeThinking = false
    await exportTopicDataToFile({ id: 't1', name: 'Topic' })
    const withoutThinking = JSON.parse(fileWrite.mock.calls[0][1] as string)
    delete withoutThinking.exportedAt

    fileWrite.mockClear()
    exportPathState.includeThinking = true
    await exportTopicDataToFile({ id: 't1', name: 'Topic' })
    const withThinking = JSON.parse(fileWrite.mock.calls[0][1] as string)
    delete withThinking.exportedAt

    expect(withThinking).toEqual(withoutThinking)
    // The reasoning block survives in both cases: the setting is document-level
    // for Markdown exports and never filters the JSON payload.
    expect(withThinking.blocks).toEqual([{ id: 'b1', type: 'THINKING', content: 'reasoning' }])
  })
})
