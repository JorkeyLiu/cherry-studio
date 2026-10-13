import type { Message } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'
import type { SnapshotBlockMap } from '@renderer/utils/messageUtils/snapshotBlocks'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'

/**
 * Text-only user-message preview for the chat-viewport conversation
 * navigation list. Pure, no DOM, no logging of content.
 *
 * Strips BOTH quoted forms without touching the original message:
 * - HTML `<blockquote>` quoted content, including nested and multiline
 *   blockquotes (stack-based, tag-balanced, code-protected).
 * - Markdown blockquotes as whole AST nodes via remark-parse
 *   (CommonMark semantics: `>` markers, lazy continuation lines,
 *   nesting, and list-contained quotes are all part of the blockquote
 *   node and removed together).
 *
 * Code fences (``` / ~~~) and inline code spans are protected via
 * placeholders before any stripping and restored afterwards, so examples
 * are never removed merely for containing quote markers or literal HTML.
 * Remaining HTML is stripped while code is still protected; restored code
 * content is kept literally (including `>` and literal `<blockquote>`),
 * which stays text-only because callers render it React-escaped.
 * The result is plain text: whitespace is collapsed. Empty-after-strip
 * results return '' so callers can apply a localized fallback
 * (attachment-only / quote-only).
 */

const FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/

interface Protected {
  text: string
  codeBlocks: string[]
  inlineCodes: string[]
}

const CODE_BLOCK_TOKEN = (i: number): string => `__CHERRY_CODEBLOCK_${i}__`
const INLINE_CODE_TOKEN = (i: number): string => `__CHERRY_INLINECODE_${i}__`

const decodeEntities = (value: string): string =>
  value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')

const protectCode = (input: string): Protected => {
  const codeBlocks: string[] = []
  const inlineCodes: string[] = []
  const lines = input.split('\n')
  const out: string[] = []
  let fence: string | null = null
  let buf: string[] = []
  for (const line of lines) {
    const m = line.match(FENCE_RE)
    if (m) {
      if (fence === null) {
        fence = m[2][0]
        buf = [line]
      } else {
        buf.push(line)
        codeBlocks.push(buf.join('\n'))
        out.push(CODE_BLOCK_TOKEN(codeBlocks.length - 1))
        fence = null
        buf = []
      }
      continue
    }
    if (fence !== null) {
      buf.push(line)
      continue
    }
    out.push(line)
  }
  if (fence !== null) {
    // Unclosed fence: keep content as code, still protected.
    codeBlocks.push(buf.join('\n'))
    out.push(CODE_BLOCK_TOKEN(codeBlocks.length - 1))
  }
  let text = out.join('\n')
  text = text.replace(/`[^`\n]+`/g, (match) => {
    inlineCodes.push(match)
    return INLINE_CODE_TOKEN(inlineCodes.length - 1)
  })
  return { text, codeBlocks, inlineCodes }
}

const restoreCode = (input: string, guarded: Protected): string => {
  let text = input
  text = text.replace(/__CHERRY_INLINECODE_(\d+)__/g, (_, n) => guarded.inlineCodes[Number(n)] ?? '')
  text = text.replace(/__CHERRY_CODEBLOCK_(\d+)__/g, (_, n) => guarded.codeBlocks[Number(n)] ?? '')
  return text
}

/**
 * Remove HTML <blockquote>…</blockquote> regions (nested/multiline aware).
 * Operates on code-protected text so literal `<blockquote>` inside code
 * examples is never treated as a quote.
 */
export const stripHtmlBlockquotes = (input: string): string => {
  const openRe = /<\s*blockquote\b[^>]*>/gi
  const closeRe = /<\s*\/\s*blockquote\s*>/gi
  type Marker = { index: number; kind: 'open' | 'close'; length: number }
  const markers: Marker[] = []
  let m: RegExpExecArray | null
  openRe.lastIndex = 0
  while ((m = openRe.exec(input)) !== null) {
    markers.push({ index: m.index, kind: 'open', length: m[0].length })
  }
  closeRe.lastIndex = 0
  while ((m = closeRe.exec(input)) !== null) {
    markers.push({ index: m.index, kind: 'close', length: m[0].length })
  }
  markers.sort((a, b) => a.index - b.index)
  let depth = 0
  const keep: string[] = []
  let cursor = 0
  for (const marker of markers) {
    if (marker.kind === 'open') {
      if (depth === 0) {
        keep.push(input.slice(cursor, marker.index))
      }
      depth += 1
    } else {
      if (depth > 0) {
        depth -= 1
        if (depth === 0) {
          cursor = marker.index + marker.length
        }
      }
    }
  }
  if (depth > 0) {
    // Unclosed blockquote: drop from its opening tag to the end.
    return keep.join('')
  }
  keep.push(input.slice(cursor))
  return keep.join('')
}

/**
 * Remove Markdown blockquotes as whole AST nodes (CommonMark semantics).
 * Operates on code-protected text so `>` markers inside fenced/inline code
 * placeholders are never treated as quotes. Lazy continuation lines,
 * nested quotes, and list-contained quotes are part of the blockquote node
 * and removed together. Falls back to input on parse failure.
 */
export const stripMarkdownQuotes = (input: string): string => {
  if (!input.includes('>')) return input
  try {
    const tree = unified().use(remarkParse).parse(input)
    const ranges: Array<[number, number]> = []
    visit(tree, 'blockquote', (node: any) => {
      const start = node?.position?.start?.offset
      const end = node?.position?.end?.offset
      if (typeof start === 'number' && typeof end === 'number' && end > start) {
        ranges.push([start, end])
      }
    })
    if (ranges.length === 0) return input
    ranges.sort((a, b) => a[0] - b[0])
    const merged: Array<[number, number]> = []
    for (const range of ranges) {
      const last = merged[merged.length - 1]
      if (!last || range[0] > last[1]) {
        merged.push([range[0], range[1]])
      } else {
        last[1] = Math.max(last[1], range[1])
      }
    }
    let out = ''
    let cursor = 0
    for (const [start, end] of merged) {
      out += input.slice(cursor, start)
      cursor = end
    }
    out += input.slice(cursor)
    return out
  } catch {
    return input
  }
}

export const stripRemainingHtml = (input: string): string => {
  // Remove comments, then tags; keep text content.
  return decodeEntities(input.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, ' '))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
}

/** Collapse whitespace to a single-line-friendly preview base. */
export const collapsePreviewWhitespace = (input: string): string => input.replace(/\s+/g, ' ').trim()

/**
 * Build the text-only preview for one user message from a caller-local
 * snapshot block map. Returns '' when nothing previewable remains (caller
 * applies a localized attachment/quote fallback). Never mutates input.
 */
export const summarizeUserMessage = (
  message: Pick<Message, 'blocks'>,
  blocksById: SnapshotBlockMap,
  options?: { maxLength?: number }
): string => {
  const maxLength = options?.maxLength ?? 280
  const parts: string[] = []
  for (const blockId of message.blocks) {
    const block = blocksById.get(blockId)
    if (!block || block.type !== MessageBlockType.MAIN_TEXT) continue
    const content = (block as { content?: unknown }).content
    if (typeof content === 'string' && content.length > 0) parts.push(content)
  }
  const raw = parts.join('\n\n')
  if (!raw.trim()) return ''
  const guarded = protectCode(raw)
  const noHtmlQuotes = stripHtmlBlockquotes(guarded.text)
  const noMdQuotes = stripMarkdownQuotes(noHtmlQuotes)
  // Strip remaining HTML while code is still protected so literal tags
  // inside code examples survive; restore code literally afterwards.
  const textOnlyProtected = stripRemainingHtml(noMdQuotes)
  const restored = restoreCode(textOnlyProtected, guarded)
  // Code examples survive above; for the *preview* keep their text but drop
  // fence markers so the list stays readable single-line friendly.
  const deFenced = restored.replace(/`{3,}[^\n]*\n?/g, ' ').replace(/~{3,}[^\n]*\n?/g, ' ')
  const collapsed = collapsePreviewWhitespace(deFenced)
  if (!collapsed) return ''
  return collapsed.length > maxLength ? collapsed.slice(0, maxLength).trimEnd() : collapsed
}

/** True when the message carries non-text attachment blocks. */
export const hasNavigableAttachment = (message: Pick<Message, 'blocks'>, blocksById: SnapshotBlockMap): boolean => {
  for (const blockId of message.blocks) {
    const block = blocksById.get(blockId)
    if (!block) continue
    if (
      block.type === MessageBlockType.FILE ||
      block.type === MessageBlockType.IMAGE ||
      block.type === MessageBlockType.VIDEO ||
      block.type === MessageBlockType.CODE
    ) {
      return true
    }
  }
  return false
}

/**
 * Basename of a stored attachment display name. Strips URL query/fragment
 * suffixes and directory segments (both `/` and `\`) so a stored value that
 * contains a path never leaks directories; never touches the filesystem.
 * Returns '' when nothing displayable remains.
 */
export const safeBasename = (raw: string): string => {
  if (!raw) return ''
  let text = raw.trim()
  if (!text) return ''
  const cut = text.search(/[?#]/)
  if (cut >= 0) {
    text = text.slice(0, cut).trim()
  }
  if (!text) return ''
  const segments = text.split(/[/\\]+/).filter((part) => part.length > 0)
  const last = segments[segments.length - 1] ?? ''
  return last.trim()
}

/**
 * Generated clipboard/paste placeholder names carry internal IDs
 * (e.g. `pasted_image_<uuid>.png`, `temp_file…image…`, `pasted_text…`)
 * that are meaningless to users. They must never surface in navigation
 * labels; such attachments fall back to a localized type/count label.
 */
const GENERATED_ATTACHMENT_NAME_RE = /pasted_(text|image)|^temp_file|pasted_image_[0-9a-f-]{6,}/i

export const isGeneratedAttachmentName = (raw: string): boolean => GENERATED_ATTACHMENT_NAME_RE.test(raw)

type AttachmentFileLike = {
  file?: { name?: unknown; origin_name?: unknown; type?: unknown } | null
}

const readRawAttachmentName = (block: AttachmentFileLike): string => {
  const file = block.file
  if (!file || typeof file !== 'object') return ''
  const origin = typeof file.origin_name === 'string' ? file.origin_name : ''
  const name = typeof file.name === 'string' ? file.name : ''
  return origin || name
}

const readAttachmentKind = (block: AttachmentFileLike): 'image' | 'other' => {
  const file = block.file
  if (file && typeof file === 'object' && (file as { type?: unknown }).type === 'image') return 'image'
  return 'other'
}

/** Caller-local attachment census for one user message; metadata only. */
export interface AttachmentSummary {
  total: number
  firstNamed: string | null
  unnamedImageCount: number
  unnamedOtherCount: number
  singleGeneratedImage: boolean
}

/**
 * Census attachment blocks in message order using only the caller-local
 * snapshot block model. Named FILE/IMAGE attachments contribute their first
 * safe display basename; VIDEO/filePath/URL payloads and CODE blocks only
 * contribute to counts (paths, URLs, and IDs never become labels).
 */
export const collectAttachmentSummary = (
  message: Pick<Message, 'blocks'>,
  blocksById: SnapshotBlockMap
): AttachmentSummary => {
  const summary: AttachmentSummary = {
    total: 0,
    firstNamed: null,
    unnamedImageCount: 0,
    unnamedOtherCount: 0,
    singleGeneratedImage: false
  }
  let singleGeneratedImageKind: 'image' | 'other' | null = null
  for (const blockId of message.blocks) {
    const block = blocksById.get(blockId)
    if (!block) continue
    if (block.type === MessageBlockType.FILE || block.type === MessageBlockType.IMAGE) {
      summary.total += 1
      const raw = readRawAttachmentName(block as AttachmentFileLike)
      const kind = block.type === MessageBlockType.IMAGE ? 'image' : readAttachmentKind(block as AttachmentFileLike)
      if (raw && isGeneratedAttachmentName(raw)) {
        if (kind === 'image') summary.unnamedImageCount += 1
        else summary.unnamedOtherCount += 1
        if (summary.total === 1) singleGeneratedImageKind = kind
        continue
      }
      const base = safeBasename(raw)
      if (base) {
        if (summary.firstNamed === null) summary.firstNamed = base
        continue
      }
      if (kind === 'image') summary.unnamedImageCount += 1
      else summary.unnamedOtherCount += 1
      continue
    }
    if (block.type === MessageBlockType.VIDEO || block.type === MessageBlockType.CODE) {
      summary.total += 1
      summary.unnamedOtherCount += 1
    }
  }
  summary.singleGeneratedImage = summary.total === 1 && singleGeneratedImageKind === 'image'
  return summary
}

/**
 * Localized label builders for attachment-only navigation rows. The pure
 * preview module never touches i18n: the component supplies builders bound
 * to `t()` (with plural semantics), tests supply synthetic templates.
 */
export interface AttachmentLabelFormatters {
  /** Generic single-attachment fallback (existing user_attachment_fallback). */
  genericFallback: string
  formatSingleNamed: (name: string) => string
  formatNamedWithMore: (name: string, remaining: number) => string
  formatImageCount: (count: number) => string
  formatAttachmentCount: (count: number) => string
  /**
   * Meaningful app-convention name for a single clipboard-pasted image
   * (same string as message.attachments.pasted_image). When omitted, the
   * localized image-count label is used instead — never an invented name.
   */
  pastedImageLabel?: string
}

/**
 * Meaningful label for an attachment-only (or quote-only + attachments)
 * user message. Body text always wins at the call site — this covers only
 * the no-body case. Returns '' when the message has no attachments so the
 * caller can apply the quote-only fallback.
 */
export const buildAttachmentLabel = (
  message: Pick<Message, 'blocks'>,
  blocksById: SnapshotBlockMap,
  formatters: AttachmentLabelFormatters,
  options?: { maxLength?: number }
): string => {
  const summary = collectAttachmentSummary(message, blocksById)
  if (summary.total === 0) return ''
  const maxLength = options?.maxLength ?? 280
  const truncate = (value: string): string => (value.length > maxLength ? value.slice(0, maxLength).trimEnd() : value)
  if (summary.firstNamed) {
    if (summary.total === 1) return truncate(formatters.formatSingleNamed(summary.firstNamed))
    return truncate(formatters.formatNamedWithMore(summary.firstNamed, summary.total - 1))
  }
  if (summary.singleGeneratedImage && formatters.pastedImageLabel) {
    return truncate(formatters.pastedImageLabel)
  }
  if (summary.unnamedOtherCount === 0 && summary.unnamedImageCount > 0) {
    return truncate(formatters.formatImageCount(summary.total))
  }
  return truncate(formatters.formatAttachmentCount(summary.total))
}
