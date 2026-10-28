import { loggerService } from '@logger'
import i18n from '@renderer/i18n'
import { getMessageTitle } from '@renderer/services/MessagesService'
import { addNote } from '@renderer/services/NotesService'
import store from '@renderer/store'
import { setExportState } from '@renderer/store/runtime'
import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { saveExportFile, saveExportImage } from '@renderer/utils/exportFile'
import { removeSpecialCharactersForFileName } from '@renderer/utils/file'
import { captureScrollableAsBlob, captureScrollableAsDataURL } from '@renderer/utils/image'
import { markdownToPlainText } from '@renderer/utils/markdown'
import { getCitationContent, getMainTextContent, getThinkingContent } from '@renderer/utils/messageUtils/find'
import {
  getCitationSnapshotContent,
  getMainTextSnapshotContent,
  getThinkingSnapshotContent,
  type SnapshotBlockMap
} from '@renderer/utils/messageUtils/snapshotBlocks'
import { loadWholeTopicSnapshot } from '@renderer/utils/topicSnapshot'
import dayjs from 'dayjs'
import DOMPurify from 'dompurify'

const logger = loggerService.withContext('Utils:export')

// 全局的导出状态获取函数
const getExportState = () => store.getState().runtime.export.isExporting

// 全局的导出状态设置函数，使用 dispatch 保障 Redux 状态更新正确
const setExportingState = (isExporting: boolean) => {
  store.dispatch(setExportState({ isExporting }))
}

/**
 * 安全地处理思维链内容，保留安全的 HTML 标签如 <br>，移除危险内容
 *
 * 支持的标签：
 * - 结构：br, p, div, span, h1-h6, blockquote
 * - 格式：strong, b, em, i, u, s, del, mark, small, sup, sub
 * - 列表：ul, ol, li
 * - 代码：code, pre, kbd, var, samp
 * - 表格：table, thead, tbody, tfoot, tr, td, th
 *
 * @param content 原始思维链内容
 * @returns 安全处理后的内容
 */
const sanitizeReasoningContent = (content: string): string => {
  // 先处理换行符转换为 <br>
  const contentWithBr = content.replace(/\n/g, '<br>')

  // 使用 DOMPurify 清理内容，保留常用的安全标签和属性
  return DOMPurify.sanitize(contentWithBr, {
    ALLOWED_TAGS: [
      // 换行和基础结构
      'br',
      'p',
      'div',
      'span',
      // 文本格式化
      'strong',
      'b',
      'em',
      'i',
      'u',
      's',
      'del',
      'mark',
      'small',
      // 上标下标（数学公式、引用等）
      'sup',
      'sub',
      // 标题
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      // 引用
      'blockquote',
      // 列表
      'ul',
      'ol',
      'li',
      // 代码相关
      'code',
      'pre',
      'kbd',
      'var',
      'samp',
      // 表格（AI输出中可能包含表格）
      'table',
      'thead',
      'tbody',
      'tfoot',
      'tr',
      'td',
      'th',
      // 分隔线
      'hr'
    ],
    ALLOWED_ATTR: [
      // 安全的通用属性
      'class',
      'title',
      'lang',
      'dir',
      // code 标签的语言属性
      'data-language',
      // 表格属性
      'colspan',
      'rowspan',
      // 列表属性
      'start',
      'type'
    ],
    KEEP_CONTENT: true, // 保留被移除标签的文本内容
    RETURN_DOM: false,
    SANITIZE_DOM: true,
    // 允许的协议（预留，虽然目前没有允许链接标签）
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i
  })
}

/**
 * Load a short-lived whole-topic snapshot from Main for one-shot topic exports.
 * Centralizes all topic-scoped export reads so no path relies on or mutates
 * the loaded Redux projection. Caller-local only.
 */
const loadTopicSnapshotForExport = async (topicId: string) => {
  return await loadWholeTopicSnapshot(topicId)
}

const resolveMainTextContent = (message: Message, blocksById?: SnapshotBlockMap): string => {
  if (blocksById) return getMainTextSnapshotContent(message, blocksById)
  return getMainTextContent(message)
}

const resolveThinkingContent = (message: Message, blocksById?: SnapshotBlockMap): string => {
  if (blocksById) return getThinkingSnapshotContent(message, blocksById)
  return getThinkingContent(message)
}

const resolveCitationContent = (message: Message, blocksById?: SnapshotBlockMap): string => {
  if (blocksById) return getCitationSnapshotContent(message, blocksById)
  return getCitationContent(message)
}

/**
 * 从消息内容中提取标题，限制长度并处理换行和标点符号。用于导出功能。
 * @param {string} str 输入字符串
 * @param {number} [length=80] 标题最大长度，默认为 80
 * @returns {string} 提取的标题
 */
export function getTitleFromString(str: string, length: number = 80): string {
  let title = str.trimStart().split('\n')[0]

  if (title.includes('。')) {
    title = title.split('。')[0]
  } else if (title.includes('，')) {
    title = title.split('，')[0]
  } else if (title.includes('.')) {
    title = title.split('.')[0]
  } else if (title.includes(',')) {
    title = title.split(',')[0]
  }

  if (title.length > length) {
    title = title.slice(0, length)
  }

  if (!title) {
    title = str.slice(0, length)
  }

  return title
}

const getRoleText = (role: string): string => {
  if (role === 'user') {
    return '🧑‍💻 User'
  }
  if (role === 'system') {
    return '🤖 System'
  }
  return '🤖 Assistant'
}

/**
 * 处理文本中的引用标记
 * @param content 原始文本内容
 * @param mode 处理模式：'remove' 移除引用，'normalize' 标准化为Markdown格式
 * @returns 处理后的文本
 */
export const processCitations = (content: string, mode: 'remove' | 'normalize' = 'remove'): string => {
  // 使用正则表达式匹配Markdown代码块
  const codeBlockRegex = /(```[a-zA-Z]*\n[\s\S]*?\n```)/g
  const parts = content.split(codeBlockRegex)

  const processedParts = parts.map((part, index) => {
    // 如果是代码块(奇数索引),则原样返回
    if (index % 2 === 1) {
      return part
    }

    let result = part

    if (mode === 'remove') {
      // 移除各种形式的引用标记
      result = result
        .replace(/\[<sup[^>]*data-citation[^>]*>\d+<\/sup>\]\([^)]*\)/g, '')
        .replace(/\[<sup[^>]*>\d+<\/sup>\]\([^)]*\)/g, '')
        .replace(/<sup[^>]*data-citation[^>]*>\d+<\/sup>/g, '')
        .replace(/\[(\d+)\](?!\()/g, '')
    } else if (mode === 'normalize') {
      // 标准化引用格式为Markdown脚注格式
      result = result
        // 将 [<sup data-citation='...'>数字</sup>](链接) 转换为 [^数字]
        .replace(/\[<sup[^>]*data-citation[^>]*>(\d+)<\/sup>\]\([^)]*\)/g, '[^$1]')
        // 将 [<sup>数字</sup>](链接) 转换为 [^数字]
        .replace(/\[<sup[^>]*>(\d+)<\/sup>\]\([^)]*\)/g, '[^$1]')
        // 将独立的 <sup data-citation='...'>数字</sup> 转换为 [^数字]
        .replace(/<sup[^>]*data-citation[^>]*>(\d+)<\/sup>/g, '[^$1]')
        // 将 [数字] 转换为 [^数字]（但要小心不要转换其他方括号内容）
        .replace(/\[(\d+)\](?!\()/g, '[^$1]')
    }

    // 按行处理，保留Markdown结构
    const lines = result.split('\n')
    const processedLines = lines.map((line) => {
      // 如果是引用块或其他特殊格式，不要修改空格
      if (line.match(/^>|^#{1,6}\s|^\s*[-*+]\s|^\s*\d+\.\s|^\s{4,}/)) {
        return line.replace(/[ ]+/g, ' ').replace(/[ ]+$/g, '')
      }
      // 普通文本行，清理多余空格但保留基本格式
      return line.replace(/[ ]+/g, ' ').trim()
    })

    return processedLines.join('\n')
  })

  return processedParts.join('').trim()
}

/**
 * 标准化引用内容为Markdown脚注格式
 * @param citations 引用列表
 * @returns Markdown脚注格式的引用内容
 */
const formatCitationsAsFootnotes = (citations: string): string => {
  if (!citations.trim()) return ''

  // 将引用列表转换为脚注格式
  const lines = citations.split('\n\n')
  const footnotes = lines.map((line) => {
    const match = line.match(/^\[(\d+)\]\s*(.+)/)
    if (match) {
      const [, num, content] = match
      return `[^${num}]: ${content}`
    }
    return line
  })

  return footnotes.join('\n\n')
}

const createBaseMarkdown = (
  message: Message,
  includeReasoning: boolean = false,
  excludeCitations: boolean = false,
  normalizeCitations: boolean = true,
  blocksById?: SnapshotBlockMap
): { titleSection: string; reasoningSection: string; contentSection: string; citation: string } => {
  const roleText = getRoleText(message.role)
  const titleSection = `## ${roleText}`
  let reasoningSection = ''

  if (includeReasoning) {
    let reasoningContent = resolveThinkingContent(message, blocksById)
    if (reasoningContent) {
      if (reasoningContent.startsWith('<think>\n')) {
        reasoningContent = reasoningContent.substring(8)
      } else if (reasoningContent.startsWith('<think>')) {
        reasoningContent = reasoningContent.substring(7)
      }
      // 使用 DOMPurify 安全地处理思维链内容
      reasoningContent = sanitizeReasoningContent(reasoningContent)
      reasoningSection = `<div style="border: 2px solid #dddddd; border-radius: 10px;">
  <details style="padding: 5px;">
    <summary>${i18n.t('common.reasoning_content')}</summary>
    ${reasoningContent}
  </details>
</div>
`
    }
  }

  const content = resolveMainTextContent(message, blocksById)
  let citation = excludeCitations ? '' : resolveCitationContent(message, blocksById)

  let processedContent = content

  // 处理引用标记
  if (excludeCitations) {
    processedContent = processCitations(processedContent, 'remove')
  } else if (normalizeCitations) {
    processedContent = processCitations(processedContent, 'normalize')
    citation = formatCitationsAsFootnotes(citation)
  }

  return { titleSection, reasoningSection, contentSection: processedContent, citation }
}

export const messageToMarkdown = (
  message: Message,
  excludeCitations?: boolean,
  blocksById?: SnapshotBlockMap
): string => {
  const { excludeCitationsInExport, standardizeCitationsInExport } = store.getState().settings
  const shouldExcludeCitations = excludeCitations ?? excludeCitationsInExport
  const { titleSection, contentSection, citation } = createBaseMarkdown(
    message,
    false,
    shouldExcludeCitations,
    standardizeCitationsInExport,
    blocksById
  )
  return [titleSection, '', contentSection, citation].join('\n')
}

export const messageToMarkdownWithReasoning = (
  message: Message,
  excludeCitations?: boolean,
  blocksById?: SnapshotBlockMap
): string => {
  const { excludeCitationsInExport, standardizeCitationsInExport } = store.getState().settings
  const shouldExcludeCitations = excludeCitations ?? excludeCitationsInExport
  const { titleSection, reasoningSection, contentSection, citation } = createBaseMarkdown(
    message,
    true,
    shouldExcludeCitations,
    standardizeCitationsInExport,
    blocksById
  )
  return [titleSection, '', reasoningSection, contentSection, citation].join('\n')
}

export const messagesToMarkdown = (
  messages: Message[],
  exportReasoning?: boolean,
  excludeCitations?: boolean,
  blocksById?: SnapshotBlockMap
): string => {
  return messages
    .map((message) =>
      exportReasoning
        ? messageToMarkdownWithReasoning(message, excludeCitations, blocksById)
        : messageToMarkdown(message, excludeCitations, blocksById)
    )
    .join('\n---\n')
}

const formatMessageAsPlainText = (message: Message, blocksById?: SnapshotBlockMap): string => {
  const roleText = message.role === 'user' ? 'User:' : 'Assistant:'
  const content = resolveMainTextContent(message, blocksById)
  const plainTextContent = markdownToPlainText(content).trim()
  return `${roleText}\n${plainTextContent}`
}

export const messageToPlainText = (message: Message, blocksById?: SnapshotBlockMap): string => {
  const content = resolveMainTextContent(message, blocksById)
  return markdownToPlainText(content).trim()
}

const messagesToPlainText = (messages: Message[], blocksById?: SnapshotBlockMap): string => {
  return messages.map((message) => formatMessageAsPlainText(message, blocksById)).join('\n\n')
}

export const topicToMarkdown = async (
  topic: Topic,
  exportReasoning?: boolean,
  excludeCitations?: boolean
): Promise<string> => {
  const topicName = `# ${topic.name}`

  const snapshot = await loadTopicSnapshotForExport(topic.id)
  const messages = snapshot.messages

  if (messages && messages.length > 0) {
    return topicName + '\n\n' + messagesToMarkdown(messages, exportReasoning, excludeCitations, snapshot.blocksById)
  }

  return topicName
}

export const topicToPlainText = async (topic: Topic): Promise<string> => {
  const topicName = markdownToPlainText(topic.name).trim()

  const snapshot = await loadTopicSnapshotForExport(topic.id)
  const topicMessages = snapshot.messages

  if (topicMessages && topicMessages.length > 0) {
    return topicName + '\n\n' + messagesToPlainText(topicMessages, snapshot.blocksById)
  }

  return topicName
}

export const exportTopicAsMarkdown = async (
  topic: Topic,
  exportReasoning?: boolean,
  excludeCitations?: boolean
): Promise<void> => {
  if (getExportState()) {
    window.toast.warning(i18n.t('message.warn.export.exporting'))
    return
  }

  // Document-level default for topic Markdown exports; an explicit caller
  // argument still wins (topic Markdown copy never goes through this path).
  const { exportPath, exportIncludeThinking } = store.getState().settings
  const withReasoning = exportReasoning ?? exportIncludeThinking

  setExportingState(true)
  try {
    // Direct writes into the configured directory keep the timestamp suffix so
    // repeated exports never overwrite each other.
    const stamp = exportPath ? ` ${dayjs().format('YYYY-MM-DD-HH-mm-ss')}` : ''
    const fileName = removeSpecialCharactersForFileName(topic.name) + stamp + '.md'
    const markdown = await topicToMarkdown(topic, withReasoning, excludeCitations)
    const saved = await saveExportFile(fileName, markdown)
    if (saved) {
      window.toast.success(
        i18n.t(
          exportPath
            ? i18n.t('message.success.markdown.export.preconf')
            : i18n.t('message.success.markdown.export.specified')
        )
      )
    }
  } catch (error: any) {
    window.toast.error(
      i18n.t(
        exportPath ? i18n.t('message.error.markdown.export.preconf') : i18n.t('message.error.markdown.export.specified')
      )
    )
    logger.error('Failed to export topic as markdown:', error)
  } finally {
    setExportingState(false)
  }
}

export const exportMessageAsMarkdown = async (
  message: Message,
  exportReasoning?: boolean,
  excludeCitations?: boolean
): Promise<void> => {
  if (getExportState()) {
    window.toast.warning(i18n.t('message.warn.export.exporting'))
    return
  }

  // Document-level default for message Markdown exports; an explicit caller
  // argument still wins (plain message copy never goes through this path).
  const { exportPath, exportIncludeThinking } = store.getState().settings
  const withReasoning = exportReasoning ?? exportIncludeThinking

  setExportingState(true)
  try {
    const title = await getMessageTitle(message)
    // Direct writes into the configured directory keep the timestamp suffix so
    // repeated exports never overwrite each other.
    const stamp = exportPath ? ` ${dayjs().format('YYYY-MM-DD-HH-mm-ss')}` : ''
    const fileName = removeSpecialCharactersForFileName(title) + stamp + '.md'
    const markdown = withReasoning
      ? messageToMarkdownWithReasoning(message, excludeCitations)
      : messageToMarkdown(message, excludeCitations)
    const saved = await saveExportFile(fileName, markdown)
    if (saved) {
      window.toast.success(
        i18n.t(
          exportPath
            ? i18n.t('message.success.markdown.export.preconf')
            : i18n.t('message.success.markdown.export.specified')
        )
      )
    }
  } catch (error: any) {
    window.toast.error(
      i18n.t(
        exportPath ? i18n.t('message.error.markdown.export.preconf') : i18n.t('message.error.markdown.export.specified')
      )
    )
    logger.error('Failed to export message as markdown:', error)
  } finally {
    setExportingState(false)
  }
}

/**
 * 导出消息到笔记工作区
 * @returns 创建的笔记节点
 * @param title
 * @param content
 * @param folderPath
 */
export const exportMessageToNotes = async (title: string, content: string, folderPath: string): Promise<void> => {
  try {
    const cleanedContent = content.replace(/^## 🤖 Assistant(\n|$)/m, '')
    await addNote(title, cleanedContent, folderPath)

    window.toast.success(i18n.t('message.success.notes.export'))
  } catch (error) {
    logger.error('导出到笔记失败:', error as Error)
    window.toast.error(i18n.t('message.error.notes.export'))
    throw error
  }
}

/**
 * 导出话题到笔记工作区
 * @param topic 要导出的话题
 * @param folderPath
 * @returns 创建的笔记节点
 */
export const exportTopicToNotes = async (topic: Topic, folderPath: string): Promise<void> => {
  try {
    const content = await topicToMarkdown(topic)
    await addNote(topic.name, content, folderPath)

    window.toast.success(i18n.t('message.success.notes.export'))
  } catch (error) {
    logger.error('导出到笔记失败:', error as Error)
    window.toast.error(i18n.t('message.error.notes.export'))
    throw error
  }
}

const exportNoteAsMarkdown = async (noteName: string, content: string): Promise<void> => {
  const markdown = `# ${noteName}\n\n${content}`
  const fileName = removeSpecialCharactersForFileName(noteName) + '.md'
  const saved = await saveExportFile(fileName, markdown)
  if (saved) {
    window.toast.success(i18n.t('message.success.markdown.export.specified'))
  }
}

const getScrollableElement = (): HTMLElement | null => {
  const notesPage = document.querySelector('#notes-page')
  if (!notesPage) return null

  const allDivs = notesPage.querySelectorAll('div')
  for (const div of Array.from(allDivs)) {
    const style = window.getComputedStyle(div)
    if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
      if (div.querySelector('.ProseMirror')) {
        return div as HTMLElement
      }
    }
  }
  return null
}

const getScrollableRef = (): { current: HTMLElement } | null => {
  const element = getScrollableElement()
  if (!element) {
    window.toast.warning(i18n.t('notes.no_content_to_copy'))
    return null
  }
  return { current: element }
}

const exportNoteAsImageToClipboard = async (): Promise<void> => {
  const scrollableRef = getScrollableRef()
  if (!scrollableRef) return

  await captureScrollableAsBlob(scrollableRef, async (blob) => {
    if (blob) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      window.toast.success(i18n.t('common.copied'))
    }
  })
}

const exportNoteAsImageFile = async (noteName: string): Promise<void> => {
  const scrollableRef = getScrollableRef()
  if (!scrollableRef) return

  const dataUrl = await captureScrollableAsDataURL(scrollableRef)
  if (dataUrl) {
    await saveExportImage(removeSpecialCharactersForFileName(noteName), dataUrl)
  }
}

interface NoteExportOptions {
  node: { name: string; externalPath: string }
  platform: 'markdown' | 'copyImage' | 'exportImage'
}

export const exportNote = async ({ node, platform }: NoteExportOptions): Promise<void> => {
  try {
    const content = await window.api.file.readExternal(node.externalPath)

    switch (platform) {
      case 'copyImage':
        return await exportNoteAsImageToClipboard()
      case 'exportImage':
        return await exportNoteAsImageFile(node.name)
      case 'markdown':
        return await exportNoteAsMarkdown(node.name, content)
    }
  } catch (error) {
    logger.error(`Failed to export note to ${platform}:`, error as Error)
    throw error
  }
}
