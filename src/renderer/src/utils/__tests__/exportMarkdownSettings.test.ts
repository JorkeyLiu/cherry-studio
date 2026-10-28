/**
 * Document-level Markdown export defaults (`settings.exportIncludeThinking`)
 * and the single shared write path for message Markdown exports.
 *
 * - The setting decides whether the assistant reasoning `<details>` section is
 *   part of a message Markdown export; an explicit caller argument still wins.
 * - The configured default directory changes only WHERE the file is written
 *   (direct write vs. native dialog), never the exported document.
 */
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { storeState } = vi.hoisted(() => ({
  storeState: {
    current: {
      settings: { exportPath: null as string | null, exportIncludeThinking: false },
      runtime: { export: { isExporting: false } }
    }
  }
}))

const toastSuccess = vi.fn()
const toastError = vi.fn()
const toastWarning = vi.fn()
const fileSave = vi.fn()
const fileWrite = vi.fn()

vi.mock('@renderer/i18n', () => ({
  default: { t: (key: string) => key }
}))

vi.mock('@renderer/store', () => ({
  default: { getState: () => storeState.current, dispatch: vi.fn() }
}))

vi.mock('@renderer/store/runtime', () => ({
  setExportState: vi.fn()
}))

vi.mock('@renderer/services/MessagesService', () => ({
  getMessageTitle: vi.fn(async () => 'Title')
}))

vi.mock('@renderer/services/NotesService', () => ({
  addNote: vi.fn()
}))

vi.mock('@renderer/hooks/useTopic', () => ({
  TopicManager: { getTopic: vi.fn() }
}))

const mainTextBlock = {
  id: 'b-main',
  messageId: 'm1',
  type: MessageBlockType.MAIN_TEXT,
  status: MessageBlockStatus.SUCCESS,
  content: 'Answer'
} as unknown as MessageBlock

const thinkingBlock = {
  id: 'b-think',
  messageId: 'm1',
  type: MessageBlockType.THINKING,
  status: MessageBlockStatus.SUCCESS,
  content: 'Reasoning text'
} as unknown as MessageBlock

vi.mock('@renderer/utils/messageUtils/find', () => ({
  getMainTextContent: () => 'Answer',
  getThinkingContent: () => 'Reasoning text',
  getCitationContent: () => '',
  findMainTextBlocks: () => [mainTextBlock],
  findThinkingBlocks: () => [thinkingBlock]
}))

vi.mock('@renderer/utils/messageUtils/snapshotBlocks', () => ({
  createSnapshotBlockMap: (blocks: MessageBlock[]) => new Map(blocks.map((block) => [block.id, block])),
  getMainTextSnapshotContent: () => 'Answer',
  getThinkingSnapshotContent: () => 'Reasoning text',
  getCitationSnapshotContent: () => ''
}))

vi.mock('@renderer/utils/topicSnapshot', () => ({
  loadWholeTopicSnapshot: vi.fn()
}))

const message = {
  id: 'm1',
  topicId: 'topic-1',
  assistantId: 'asst-1',
  role: 'assistant',
  blocks: ['b-main', 'b-think'],
  status: 'success'
} as unknown as Message

beforeEach(() => {
  vi.clearAllMocks()
  storeState.current = {
    settings: { exportPath: null, exportIncludeThinking: false },
    runtime: { export: { isExporting: false } }
  }
  fileSave.mockResolvedValue('/tmp/Title.md')
  fileWrite.mockResolvedValue(undefined)
  Object.defineProperty(window, 'api', {
    value: { file: { save: fileSave, write: fileWrite } },
    configurable: true
  })
  Object.defineProperty(window, 'toast', {
    value: { success: toastSuccess, error: toastError, warning: toastWarning },
    configurable: true
  })
})

describe('message Markdown export reasoning default', () => {
  it('omits the reasoning details section when the setting is off', async () => {
    const { exportMessageAsMarkdown } = await import('../export')

    await exportMessageAsMarkdown(message)

    const content = fileSave.mock.calls[0][1] as string
    expect(content).not.toContain('Reasoning text')
    expect(content).not.toContain('<details')
    expect(content).toContain('Answer')
  })

  it('includes the reasoning details section when the setting is on', async () => {
    storeState.current.settings.exportIncludeThinking = true
    const { exportMessageAsMarkdown } = await import('../export')

    await exportMessageAsMarkdown(message)

    const content = fileSave.mock.calls[0][1] as string
    expect(content).toContain('<details')
    expect(content).toContain('Reasoning text')
  })

  it('lets an explicit caller argument override the document default', async () => {
    storeState.current.settings.exportIncludeThinking = true
    const { exportMessageAsMarkdown } = await import('../export')

    await exportMessageAsMarkdown(message, false)

    const content = fileSave.mock.calls[0][1] as string
    expect(content).not.toContain('<details')
    expect(content).not.toContain('Reasoning text')
  })

  it('shows the plain message copy the reasoning section regardless of the setting', async () => {
    // `messageToMarkdownWithReasoning` is the copy-side formatter: it never reads
    // the export default, so ordinary copy behavior is unchanged.
    const { messageToMarkdownWithReasoning } = await import('../export')
    storeState.current.settings.exportIncludeThinking = false

    const content = messageToMarkdownWithReasoning(message)

    expect(content).toContain('<details')
    expect(content).toContain('Reasoning text')
  })
})

describe('message Markdown export write path', () => {
  it('writes directly into the configured directory (timestamped, no dialog)', async () => {
    storeState.current.settings.exportPath = '/tmp/exports'
    const { exportMessageAsMarkdown } = await import('../export')

    await exportMessageAsMarkdown(message)

    expect(fileSave).not.toHaveBeenCalled()
    expect(fileWrite).toHaveBeenCalledTimes(1)
    const [target] = fileWrite.mock.calls[0] as [string]
    expect(target).toMatch(/^\/tmp\/exports\/Title \d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.md$/)
    expect(toastSuccess).toHaveBeenCalledWith('message.success.markdown.export.preconf')
  })

  it('uses the native dialog without a timestamp when no directory is configured', async () => {
    const { exportMessageAsMarkdown } = await import('../export')

    await exportMessageAsMarkdown(message)

    expect(fileWrite).not.toHaveBeenCalled()
    expect(fileSave).toHaveBeenCalledWith('Title.md', expect.any(String))
    expect(toastSuccess).toHaveBeenCalledWith('message.success.markdown.export.specified')
  })

  it('stays silent when the dialog is canceled', async () => {
    fileSave.mockResolvedValue(undefined)
    const { exportMessageAsMarkdown } = await import('../export')

    await exportMessageAsMarkdown(message)

    expect(toastSuccess).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('reports a real write failure through the error toast', async () => {
    storeState.current.settings.exportPath = '/tmp/exports'
    fileWrite.mockRejectedValue(new Error('EACCES'))
    const { exportMessageAsMarkdown } = await import('../export')

    await exportMessageAsMarkdown(message)

    expect(toastError).toHaveBeenCalledWith('message.error.markdown.export.preconf')
    expect(toastSuccess).not.toHaveBeenCalled()
  })
})
