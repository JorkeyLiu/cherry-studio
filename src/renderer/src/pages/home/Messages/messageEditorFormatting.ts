/**
 * View-independent Markdown formatting helpers for message editing.
 *
 * Pure string/selection transforms: the CodeMirror engine glue lives in
 * MessageEditor (selection read + dispatch), while every transform here is
 * unit-testable without an editor mount. Raw content is preserved exactly —
 * helpers only insert/remove the requested markers, never reflow text.
 *
 * Undo/redo history is the CodeMirror native history (basicSetup `history()`):
 * toolbar mutations dispatch a single native transaction per operation, so
 * Ctrl/Cmd-Z and the toolbar buttons share one canonical history. No manual
 * stacks are kept here.
 */

import diff from 'fast-diff'

export interface EditorSelection {
  from: number
  to: number
}

export interface FormatResult {
  content: string
  /** Restored cursor/selection anchor in the new content. */
  anchor: number
  /** Restored cursor/selection head in the new content. */
  head: number
}

const clampSelection = (content: string, selection: EditorSelection): EditorSelection => {
  const len = content.length
  const from = Math.max(0, Math.min(selection.from, len))
  const to = Math.max(0, Math.min(selection.to, len))
  return { from: Math.min(from, to), to: Math.max(from, to) }
}

const lineStartOf = (content: string, index: number): number => {
  const at = content.lastIndexOf('\n', Math.max(0, index - 1))
  return at < 0 ? 0 : at + 1
}

const lineEndOf = (content: string, index: number): number => {
  const at = content.indexOf('\n', index)
  return at < 0 ? content.length : at
}

/** Expand a selection to full covered lines (for line-prefix operations). */
export const expandToFullLines = (content: string, selection: EditorSelection): EditorSelection => {
  const { from, to } = clampSelection(content, selection)
  return { from: lineStartOf(content, from), to: lineEndOf(content, to) }
}

/** Wrap the selection with markers; empty selection inserts markers + cursor between. */
export const applyInlineWrap = (
  content: string,
  selection: EditorSelection,
  before: string,
  after: string,
  placeholder = ''
): FormatResult => {
  const { from, to } = clampSelection(content, selection)
  if (from === to) {
    const insert = `${before}${placeholder}${after}`
    return {
      content: content.slice(0, from) + insert + content.slice(to),
      anchor: from + before.length,
      head: from + before.length + placeholder.length
    }
  }
  return {
    content: content.slice(0, from) + before + content.slice(from, to) + after + content.slice(to),
    anchor: from + before.length,
    head: to + before.length
  }
}

/** Toggle bold (**…**) around the selection. */
export const toggleBold = (content: string, selection: EditorSelection): FormatResult => {
  const { from, to } = clampSelection(content, selection)
  if (from !== to) {
    const selected = content.slice(from, to)
    if (selected.startsWith('**') && selected.endsWith('**') && selected.length >= 4) {
      const inner = selected.slice(2, -2)
      return { content: content.slice(0, from) + inner + content.slice(to), anchor: from, head: from + inner.length }
    }
  }
  return applyInlineWrap(content, selection, '**', '**')
}

const toggleLinePrefix = (
  content: string,
  selection: EditorSelection,
  prefix: string,
  removePattern: RegExp
): FormatResult => {
  const range = expandToFullLines(content, selection)
  const slice = content.slice(range.from, range.to)
  const lines = slice.split('\n')
  const allPrefixed = lines.length > 0 && lines.every((line) => removePattern.test(line))
  const nextLines = allPrefixed
    ? lines.map((line) => line.replace(removePattern, ''))
    : lines.map((line) => (line.length === 0 ? line : `${prefix}${line}`))
  const nextSlice = nextLines.join('\n')
  // Selection restore: keep the same line-span shape, clamped to the result.
  const delta = nextSlice.length - slice.length
  return {
    content: content.slice(0, range.from) + nextSlice + content.slice(range.to),
    anchor: range.from,
    head: Math.max(range.from, range.to + delta)
  }
}

/** Toggle `## ` headings on the covered lines. */
export const toggleHeading = (content: string, selection: EditorSelection): FormatResult =>
  toggleLinePrefix(content, selection, '## ', /^#{1,6}\s+/)

const BULLET_PATTERN = /^(\s*)([-*+]\s+|\d+[.)]\s+)/
const TASK_PATTERN = /^(\s*[-*+]\s+\[[ xX]\]\s+)/

/** Toggle `- ` bullets on the covered lines. */
export const toggleBulletList = (content: string, selection: EditorSelection): FormatResult => {
  const range = expandToFullLines(content, selection)
  const slice = content.slice(range.from, range.to)
  const lines = slice.split('\n')
  const strip = (line: string): string => line.replace(TASK_PATTERN, '$1').replace(BULLET_PATTERN, '$1')
  const allBulleted =
    lines.length > 0 && lines.filter((line) => line.trim().length > 0).every((line) => BULLET_PATTERN.test(line))
  const nextSlice = (
    allBulleted ? lines.map(strip) : lines.map((line) => (line.trim().length === 0 ? line : `- ${strip(line)}`))
  ).join('\n')
  const delta = nextSlice.length - slice.length
  return {
    content: content.slice(0, range.from) + nextSlice + content.slice(range.to),
    anchor: range.from,
    head: Math.max(range.from, range.to + delta)
  }
}

/** Toggle `> ` quotes on the covered lines. */
export const toggleQuote = (content: string, selection: EditorSelection): FormatResult =>
  toggleLinePrefix(content, selection, '> ', /^>\s?/)

/** Toggle code: inline `…` for single-line, fenced block for multi-line selections. */
export const toggleCode = (content: string, selection: EditorSelection): FormatResult => {
  const { from, to } = clampSelection(content, selection)
  const selected = content.slice(from, to)
  const isMultiline = selected.includes('\n')
  if (!isMultiline) {
    if (selected.length >= 2 && selected.startsWith('`') && selected.endsWith('`')) {
      const inner = selected.slice(1, -1)
      return { content: content.slice(0, from) + inner + content.slice(to), anchor: from, head: from + inner.length }
    }
    return applyInlineWrap(content, selection, '`', '`')
  }
  const range = expandToFullLines(content, selection)
  const slice = content.slice(range.from, range.to)
  const fenced = slice.startsWith('```') && slice.trimEnd().endsWith('```')
  if (fenced) {
    const lines = slice.split('\n')
    const inner = lines.slice(1, lines[lines.length - 1].trim() === '```' ? -1 : undefined).join('\n')
    return {
      content: content.slice(0, range.from) + inner + content.slice(range.to),
      anchor: range.from,
      head: range.from + inner.length
    }
  }
  const insert = `\`\`\`\n${slice}\n\`\`\``
  return {
    content: content.slice(0, range.from) + insert + content.slice(range.to),
    anchor: range.from + 4,
    head: range.from + 4 + slice.length
  }
}

/** Wrap the selection as `[text](url)`; empty selection inserts a link template. */
export const insertLink = (content: string, selection: EditorSelection, url = ''): FormatResult => {
  const { from, to } = clampSelection(content, selection)
  if (from === to) {
    const insert = `[text](${url})`
    return {
      content: content.slice(0, from) + insert + content.slice(to),
      anchor: from + 1,
      head: from + 5
    }
  }
  const selected = content.slice(from, to)
  const insert = `[${selected}](${url})`
  return {
    content: content.slice(0, from) + insert + content.slice(to),
    anchor: from + insert.length - 1,
    head: from + insert.length - 1
  }
}

/** Find all non-overlapping match offsets (case-sensitive literal search). */
export const findMatches = (content: string, query: string): number[] => {
  if (!query) return []
  const offsets: number[] = []
  let index = content.indexOf(query)
  while (index >= 0) {
    offsets.push(index)
    index = content.indexOf(query, index + Math.max(1, query.length))
  }
  return offsets
}

/** Replace every literal occurrence; returns the content unchanged when query is empty. */
export const replaceAllOccurrences = (content: string, query: string, replacement: string): string => {
  if (!query) return content
  return content.split(query).join(replacement)
}

/** Replace the match at offsets[index] with the replacement text. */
export const replaceMatchAt = (
  content: string,
  query: string,
  replacement: string,
  index: number
): { content: string; anchor: number } => {
  const offsets = findMatches(content, query)
  if (offsets.length === 0) return { content, anchor: 0 }
  const safeIndex = ((index % offsets.length) + offsets.length) % offsets.length
  const at = offsets[safeIndex]
  return {
    content: content.slice(0, at) + replacement + content.slice(at + query.length),
    anchor: at + replacement.length
  }
}

export interface DocumentChange {
  from: number
  to: number
  insert: string
}

/**
 * Build the minimal CodeMirror change set turning `prev` into `next`.
 *
 * Pure fast-diff projection (same algorithm as the shared CodeEditor stream
 * sync): toolbar/translate/replace operations dispatch these changes as ONE
 * native transaction, so the edit lands in the canonical engine history
 * instead of replacing the whole document. Returns an empty array when the
 * documents are already equal, so callers can dispatch a selection-only
 * transaction and never touch history unnecessarily.
 */
export const buildDocumentChanges = (prev: string, next: string): DocumentChange[] => {
  if (prev === next) return []
  const diffResult = diff(prev, next)
  const changes: DocumentChange[] = []
  let offset = 0
  // operation: 1=insert, -1=delete, 0=equal
  for (const [operation, text] of diffResult) {
    if (operation === 1) {
      changes.push({ from: offset, to: offset, insert: text })
    } else if (operation === -1) {
      changes.push({ from: offset, to: offset + text.length, insert: '' })
      offset += text.length
    } else {
      offset += text.length
    }
  }
  return changes
}
