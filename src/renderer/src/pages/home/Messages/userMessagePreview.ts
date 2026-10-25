import { FILE_TYPE } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'
import { getMediaKind } from '@renderer/utils/mediaAttachment'
import type { SnapshotBlockMap } from '@renderer/utils/messageUtils/snapshotBlocks'
import { documentExts, imageExts } from '@shared/config/constant'
import remarkGfm from 'remark-gfm'
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
 * Outbound link schemes the renderer treats as real external links (mirrors
 * the Markdown `Link`/`Hyperlink` semantics: http/https plus the mailto and
 * obsidian deep-link schemes the app opens externally). Anything else is not
 * an external link: `#anchor` internals keep their visible label, images are
 * never links, and code content stays literal via the code placeholders.
 */
const EXTERNAL_LINK_SCHEMES = new Set(['http', 'https', 'mailto', 'obsidian'])

const classifyLinkUrl = (raw: unknown): 'external' | 'internal' | 'other' => {
  if (typeof raw !== 'string') return 'other'
  const url = raw.trim()
  if (!url) return 'other'
  if (url.startsWith('#')) return 'internal'
  const scheme = url.match(/^([A-Za-z][A-Za-z0-9+.-]*):/)
  if (scheme) {
    return EXTERNAL_LINK_SCHEMES.has(scheme[1].toLowerCase()) ? 'external' : 'other'
  }
  // GFM autolink-literal `www.` host without an explicit scheme.
  if (/^www\./i.test(url)) return 'external'
  return 'other'
}

/** Bracket-free placeholder for one replaced external link (applied before HTML stripping). */
const LINK_TOKEN = '__CHERRY_LINK__'

/**
 * Minimal link-boundary join: consume the whitespace run immediately after a
 * replaced external link only when it contains a linebreak (any CRLF/blank-line
 * run joins, so `URL\\nTest` previews as `[Link]Test`). Ordinary inline spaces
 * are preserved (`look URL test` stays `look [Link] test`). Operates on
 * code-protected LINK_TOKEN text, so code literals never change; whitespace
 * before links is untouched and collapses normally downstream.
 */
const consumeLinkBoundaryLinebreaks = (input: string): string => {
  if (!input.includes(LINK_TOKEN)) return input
  return input.replace(/__CHERRY_LINK__[ \t]*(\r\n|\n|\r)\s*/g, LINK_TOKEN)
}

/**
 * Replace whole HTML `<a>…</a>` elements on code-protected text. External
 * `href` targets become one link token (label + destination both replaced);
 * internal `#anchor` or unsafe/relative targets keep their inner text with
 * tags dropped (URL never leaks). No full HTML parser: one non-greedy span
 * match, existing tag behavior otherwise unchanged. Unclosed anchors are left
 * for the existing HTML strip.
 */
const replaceHtmlAnchors = (input: string): string => {
  if (!input.includes('<')) return input
  return input.replace(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi, (match) => {
    const openTag = match.match(/^<a\b[^>]*>/i)?.[0] ?? ''
    const hrefMatch = openTag.match(/href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i)
    const href = hrefMatch ? (hrefMatch[2] ?? hrefMatch[3] ?? hrefMatch[4] ?? '') : ''
    if (classifyLinkUrl(decodeEntities(href)) === 'external') return LINK_TOKEN
    const inner = match.replace(/^<a\b[^>]*>/i, '').replace(/<\/a\s*>$/i, '')
    return inner.replace(/<[^>]*>/g, ' ')
  })
}

/**
 * Cheap gate so ordinary link-free body text skips the GFM parse entirely:
 * inline/reference link markers, autolink/HTML-anchor markers, or a URI
 * scheme/email hint must be present. Texts with `@` but no link simply parse
 * once, find no link nodes, and return unchanged.
 */
const LINK_CANDIDATE_RE = /https?:\/\/|www\.|mailto:|obsidian:|@|<a[\s>]|\]\s*\(|\]\s*\[/i

const plainLinkLabel = (node: any): string => {
  let out = ''
  visit(node, (child: any) => {
    if (child.type === 'text' || child.type === 'inlineCode') out += (child.value ?? '') as string
    else if (child.type === 'image') out += (child.alt ?? '') as string
  })
  return out
}

/**
 * Replace Markdown links in place by readonly AST source ranges (remark-parse
 * + remark-gfm, so bare http/https/www URLs, `<autolink>`s, inline
 * `[text](URL)` and reference links share the renderer's recognition —
 * including trailing-punctuation handling — with no hand regex over rich
 * Markdown). Every external link becomes one token at its original position
 * (never merged/counted/collected); internal `#anchor` and other-scheme
 * links keep their visible label with the destination dropped. Reference
 * definitions are removed (they never render). Images are never links and
 * are left exactly as-is. Operates on code-protected text so fenced/inline
 * code URLs stay literal. Falls back to input on parse failure.
 */
const replaceMarkdownLinks = (input: string): string => {
  if (!LINK_CANDIDATE_RE.test(input)) return input
  let tree: any
  try {
    tree = unified().use(remarkParse).use(remarkGfm).parse(input)
  } catch {
    return input
  }
  const edits: Array<{ start: number; end: number; text: string }> = []
  // Reference definitions by normalized identifier so `linkReference` nodes
  // (`[text][ref]` / `[text][]` / `[ref]`) classify by their target URL.
  const definitions = new Map<string, string>()
  visit(tree, (node: any) => {
    if (node?.type === 'definition' && typeof node?.identifier === 'string' && typeof node?.url === 'string') {
      definitions.set(node.identifier, node.url)
    }
  })
  visit(tree, (node: any) => {
    if (!node || typeof node !== 'object') return
    const start = node?.position?.start?.offset
    const end = node?.position?.end?.offset
    if (typeof start !== 'number' || typeof end !== 'number' || end <= start) return
    if (node.type === 'definition') {
      edits.push({ start, end, text: '' })
      return
    }
    // `link` covers inline `[text](URL)` and autolinks; `linkReference`
    // covers full/collapsed/shortcut reference forms. Images
    // (`image`/`imageReference`) are never links and stay untouched.
    if (node.type !== 'link' && node.type !== 'linkReference') return
    const url =
      node.type === 'link'
        ? node.url
        : (definitions.get(typeof node.identifier === 'string' ? node.identifier : '') ?? '')
    if (classifyLinkUrl(url) === 'external') {
      edits.push({ start, end, text: LINK_TOKEN })
    } else {
      edits.push({ start, end, text: plainLinkLabel(node) })
    }
  })
  if (edits.length === 0) return input
  // Descending by source offset; overlapping (nested) ranges keep the later
  // (innermost-last) edit and skip the outer one.
  edits.sort((a, b) => b.start - a.start)
  let out = input
  let appliedStart = Number.POSITIVE_INFINITY
  for (const edit of edits) {
    if (edit.end > appliedStart) continue
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
    appliedStart = edit.start
  }
  return out
}

/**
 * Build the text-only preview for one user message from a caller-local
 * snapshot block map. Returns '' when nothing previewable remains (caller
 * applies a localized attachment/quote fallback). Never mutates input.
 *
 * `options.linkLabel` is the localized link word (e.g. `Link`/`链接`/`連結`,
 * supplied by the caller via `t()` — this pure module never touches i18n).
 * When present, every external link (http/https bare URL, `<autolink>`,
 * inline/reference Markdown link incl. mailto/obsidian, HTML `<a>`) is
 * replaced in place by `[<linkLabel>]` before HTML stripping (so a plain
 * `<autolink>` is not mistaken for a tag and dropped); surrounding text and
 * reference/quote/code protections are unchanged, and the existing
 * whitespace collapse + `maxLength` (default 280) still apply. When absent,
 * link syntax is left exactly as before (no replacement, no hardcoded word).
 */
export const summarizeUserMessage = (
  message: Pick<Message, 'blocks'>,
  blocksById: SnapshotBlockMap,
  options?: { maxLength?: number; linkLabel?: string }
): string => {
  const maxLength = options?.maxLength ?? 280
  const linkLabel = options?.linkLabel ?? ''
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
  // Links are replaced while code is still protected (code URLs stay
  // literal) and before remaining-HTML stripping (a plain `<autolink>` must
  // become the label, not be dropped as a tag). Link-boundary linebreaks
  // immediately after a replaced link join (no added space); ordinary inline
  // spaces and pre-link newlines collapse normally downstream.
  const withLinks = linkLabel
    ? consumeLinkBoundaryLinebreaks(replaceMarkdownLinks(replaceHtmlAnchors(noMdQuotes)))
    : noMdQuotes
  // Strip remaining HTML while code is still protected so literal tags
  // inside code examples survive; restore code literally afterwards.
  const textOnlyProtected = stripRemainingHtml(withLinks)
  // Realize link tokens only now (code still protected, so a literal token
  // inside user code can never be rewritten); restored code below stays
  // literal, which stays text-only because callers render it React-escaped.
  const withLinkLabels = linkLabel ? textOnlyProtected.split(LINK_TOKEN).join(`[${linkLabel}]`) : textOnlyProtected
  const restored = restoreCode(withLinkLabels, guarded)
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

type AttachmentFileLike = {
  file?: { type?: unknown; ext?: unknown } | null
}

/**
 * Extension normalizer for the public `file.ext` fallback. Production stores
 * the ext with a dot on upload/select paths but WITHOUT a dot on pasted-image
 * rows (`ext.slice(1)` in FileStorage), so both forms plus case variants
 * normalize to the dotted lowercase form the shared tables use. Never reads
 * paths/URLs/IDs.
 */
const normalizePreviewExt = (raw: unknown): string => {
  if (typeof raw !== 'string') return ''
  const text = raw.trim().toLowerCase()
  if (!text || text === '.' || text === '..') return ''
  return text.startsWith('.') ? text : `.${text}`
}

/**
 * Ordinary plain-text/code extension fallback for typeless rows. The full
 * linguist + custom `textExts` table (69K code-languages) stays in the main
 * process `getFileType`, which types every real upload — so the renderer
 * trusts `file.type === 'text'` as authoritative and only needs this small
 * ordinary subset for null-type/legacy schema inputs without importing the
 * linguist bundle into this pure preview module (bundle-barrel rule). All
 * other tables reuse the shared small arrays (same sources as `getMediaKind`).
 */
const TEXT_EXT_FALLBACK = new Set([
  '.txt',
  '.text',
  '.md',
  '.markdown',
  '.mdown',
  '.json',
  '.jsonl',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.py',
  '.pyi',
  '.java',
  '.c',
  '.h',
  '.hpp',
  '.cpp',
  '.cc',
  '.cs',
  '.go',
  '.rs',
  '.rb',
  '.php',
  '.swift',
  '.kt',
  '.scala',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.htm',
  '.xml',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.log'
])

/**
 * Kind of one FILE/IMAGE attachment from public metadata only. An explicit
 * `file.type` (upload-typed via main `getFileType`, incl. the text-file
 * heuristic) always wins and matches the upstream runtime classification;
 * the extension fallback runs only when the type is absent/`other`/unknown.
 * Unknown binaries (archives, `.unknownext`, bare dots) stay `attachment` —
 * no invented category, matching runtime FILE_TYPE.OTHER.
 */
const readAttachmentKind = (block: AttachmentFileLike): Exclude<AttachmentKind, 'code'> => {
  const file = block.file
  if (file && typeof file === 'object') {
    const rawType = (file as { type?: unknown }).type
    if (typeof rawType === 'string') {
      const type = rawType.trim().toLowerCase()
      if (type === FILE_TYPE.IMAGE) return 'image'
      if (type === FILE_TYPE.VIDEO) return 'video'
      if (type === FILE_TYPE.AUDIO) return 'audio'
      if (type === FILE_TYPE.TEXT) return 'text'
      if (type === FILE_TYPE.DOCUMENT) return 'document'
    }
    const ext = normalizePreviewExt((file as { ext?: unknown }).ext)
    if (ext) {
      // Reuse the shared pure media classifier sources for audio/video so
      // accepted containers outside the old hand list (e.g. `.wmv`, `.avi`,
      // `.mkv`, `.flv`) classify exactly like the player does.
      const media = getMediaKind({
        type: null,
        ext
      })
      if (media === 'audio') return 'audio'
      if (media === 'video') return 'video'
      if ((imageExts as readonly string[]).includes(ext)) return 'image'
      if ((documentExts as readonly string[]).includes(ext)) return 'document'
      if (TEXT_EXT_FALLBACK.has(ext)) return 'text'
    }
  }
  return 'attachment'
}

/** Per-attachment kind for the sequential navigation label. */
export type AttachmentKind = 'image' | 'video' | 'audio' | 'text' | 'document' | 'code' | 'attachment'

/** Back-compat alias for the previous first-kind name. */
export type FirstAttachmentKind = AttachmentKind

/** Presentation brackets around one attachment kind label; punctuation only, never i18n content. */
const wrapLabel = (label: string): string => `[${label}]`

const labelForKind = (kind: AttachmentKind, formatters: AttachmentLabelFormatters): string => {
  switch (kind) {
    case 'image':
      return formatters.typeImage
    case 'video':
      return formatters.typeVideo
    case 'audio':
      return formatters.typeAudio
    case 'text':
      return formatters.typeText
    case 'document':
      return formatters.typeDocument
    case 'code':
      return formatters.typeCode
    default:
      return formatters.genericFallback
  }
}

/**
 * Localized label builders for attachment-only navigation rows. The pure
 * preview module never touches i18n: the component supplies labels bound
 * to `t()`, tests supply synthetic strings. No filenames are ever shown.
 */
export interface AttachmentLabelFormatters {
  /** Generic fallback (existing user_attachment_fallback, for unknown kinds). */
  genericFallback: string
  /** Singular localized kind labels (image/video/audio/text/document/code). */
  typeImage: string
  typeVideo: string
  typeAudio: string
  typeText: string
  typeDocument: string
  typeCode: string
}

/**
 * Sequential label for an attachment-only (or quote-only + attachments)
 * user message. Body text always wins at the call site — this covers only
 * the no-body case. Returns '' when the message has no attachments so the
 * caller can apply the quote-only fallback.
 *
 * Final product rule: every navigable attachment (FILE/IMAGE/VIDEO/CODE)
 * contributes exactly one bracketed kind label in original block order,
 * joined directly with no separator (`[Image][Audio][Image][Document]`),
 * duplicates preserved, no counts/merging/dots/spaces, no filenames ever.
 * Unknown kinds fall back to the generic `[Attachment]`. The sequence is
 * never truncated here — the single-line UI ellipsis (`text-overflow:
 * ellipsis`, `title` carries the full sequence) controls visibility while
 * the text-summary `maxLength: 280` rule stays untouched.
 *
 * Classification reads only `file.type`/`file.ext` metadata (type authority
 * first, shared `imageExts`/`documentExts` + `getMediaKind` ext fallback,
 * ordinary text ext fallback for typeless rows) plus the block type for
 * IMAGE/VIDEO/CODE. Filenames, paths, URLs, IDs, and credentials are never
 * read and never surface.
 */
export const buildAttachmentLabel = (
  message: Pick<Message, 'blocks'>,
  blocksById: SnapshotBlockMap,
  formatters: AttachmentLabelFormatters
): string => {
  const labels: string[] = []
  for (const blockId of message.blocks) {
    const block = blocksById.get(blockId)
    if (!block) continue
    if (block.type === MessageBlockType.FILE) {
      labels.push(wrapLabel(labelForKind(readAttachmentKind(block as AttachmentFileLike), formatters)))
      continue
    }
    if (block.type === MessageBlockType.IMAGE) {
      labels.push(wrapLabel(labelForKind('image', formatters)))
      continue
    }
    if (block.type === MessageBlockType.VIDEO) {
      // Privacy: never read `url`/`filePath` for a display name.
      labels.push(wrapLabel(labelForKind('video', formatters)))
      continue
    }
    if (block.type === MessageBlockType.CODE) {
      labels.push(wrapLabel(labelForKind('code', formatters)))
    }
  }
  return labels.join('')
}
