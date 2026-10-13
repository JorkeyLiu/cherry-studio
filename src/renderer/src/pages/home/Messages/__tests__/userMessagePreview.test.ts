import { MessageBlockType } from '@renderer/types/newMessage'
import type { SnapshotBlockMap } from '@renderer/utils/messageUtils/snapshotBlocks'
import { describe, expect, it } from 'vitest'

import {
  type AttachmentLabelFormatters,
  buildAttachmentLabel,
  collapsePreviewWhitespace,
  collectAttachmentSummary,
  hasNavigableAttachment,
  isGeneratedAttachmentName,
  safeBasename,
  stripHtmlBlockquotes,
  stripMarkdownQuotes,
  stripRemainingHtml,
  summarizeUserMessage
} from '../userMessagePreview'

const mainText = (id: string, content: string) =>
  ({
    id,
    messageId: 'u1',
    type: MessageBlockType.MAIN_TEXT,
    content,
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z'
  }) as never

const fileBlock = (id: string) =>
  ({
    id,
    messageId: 'u1',
    type: MessageBlockType.FILE,
    file: { name: 'doc.pdf' },
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z'
  }) as never

const mapOf = (blocks: never[]): SnapshotBlockMap =>
  new Map(blocks.map((b: { id: string }) => [b.id, b] as const)) as SnapshotBlockMap

const userMessage = (blocks: string[]) => ({ blocks }) as never

describe('userMessagePreview quote stripping', () => {
  it('strips HTML blockquote content including nested and multiline quotes', () => {
    const input = [
      'My own words here.',
      '<blockquote>',
      'quoted line one',
      '<blockquote>nested quoted line</blockquote>',
      'quoted line two',
      '</blockquote>',
      'Trailing thought.'
    ].join('\n')
    const out = stripHtmlBlockquotes(input)
    expect(out).toContain('My own words here.')
    expect(out).toContain('Trailing thought.')
    expect(out).not.toContain('quoted line one')
    expect(out).not.toContain('nested quoted line')
    expect(out).not.toContain('quoted line two')
  })

  it('drops an unclosed blockquote from its opening tag to the end', () => {
    const out = stripHtmlBlockquotes('Keep this.\n<blockquote>quoted forever')
    expect(out).toContain('Keep this.')
    expect(out).not.toContain('quoted forever')
  })

  it('strips Markdown > quote lines but keeps ordinary text', () => {
    // Blank line before the trailing body: without it CommonMark parses the
    // last line as a lazy continuation of the blockquote (covered explicitly
    // below), so the fixture keeps the paragraph boundary the preview needs.
    const input = [
      'Real question about the API.',
      '> quoted reply from docs',
      '  > indented quote',
      '',
      'More of my words.'
    ].join('\n')
    const out = stripMarkdownQuotes(input)
    expect(out).toContain('Real question about the API.')
    expect(out).toContain('More of my words.')
    expect(out).not.toContain('quoted reply from docs')
    expect(out).not.toContain('indented quote')
  })

  it('treats a no-blank trailing line as CommonMark lazy continuation (stays quoted)', () => {
    const input = [
      'Real question about the API.',
      '> quoted reply from docs',
      '  > indented quote',
      'More of my words.'
    ].join('\n')
    const out = stripMarkdownQuotes(input)
    expect(out).toContain('Real question about the API.')
    // Lazy continuation: the trailing line belongs to the blockquote node and
    // is removed together — callers must keep a blank boundary for body text.
    expect(out).not.toContain('More of my words.')
    expect(out).not.toContain('quoted reply from docs')
  })

  it('strips CommonMark lazy continuation lines as part of the blockquote', () => {
    const input = ['> quoted first line', 'quoted continuation', '', 'actual body'].join('\n')
    const out = stripMarkdownQuotes(input)
    expect(out).toContain('actual body')
    expect(out).not.toContain('quoted first line')
    expect(out).not.toContain('quoted continuation')
    const summary = summarizeUserMessage(userMessage(['b1']), mapOf([mainText('b1', input)]))
    expect(summary).toBe('actual body')
  })

  it('keeps proper paragraph boundaries after a blank line following a quote', () => {
    const input = ['> dropped quote', '', 'body para one', '', 'body para two'].join('\n')
    const summary = summarizeUserMessage(userMessage(['b1']), mapOf([mainText('b1', input)]))
    expect(summary).toContain('body para one')
    expect(summary).toContain('body para two')
    expect(summary).not.toContain('dropped quote')
  })

  it('strips nested Markdown quotes as one blockquote node', () => {
    const input = ['> outer', '>> nested', '> back', '', 'body'].join('\n')
    const out = stripMarkdownQuotes(input)
    expect(out).toContain('body')
    expect(out).not.toContain('outer')
    expect(out).not.toContain('nested')
    expect(out).not.toContain('back')
  })

  it('strips a quote contained in a list but keeps surrounding items', () => {
    const input = ['- keep one', '- > quoted list content', '- keep two'].join('\n')
    const summary = summarizeUserMessage(userMessage(['b1']), mapOf([mainText('b1', input)]))
    expect(summary).toContain('keep one')
    expect(summary).toContain('keep two')
    expect(summary).not.toContain('quoted list content')
  })

  it('strips multiline nested HTML blockquotes across lines', () => {
    const input = [
      'Intro.',
      '<blockquote class="q">',
      '<p>line one</p>',
      '<blockquote>',
      'inner quoted',
      '</blockquote>',
      'line two',
      '</blockquote>',
      'Keep body.'
    ].join('\n')
    const summary = summarizeUserMessage(userMessage(['b1']), mapOf([mainText('b1', input)]))
    expect(summary).toContain('Intro.')
    expect(summary).toContain('Keep body.')
    expect(summary).not.toContain('line one')
    expect(summary).not.toContain('inner quoted')
    expect(summary).not.toContain('line two')
  })

  it('does not strip code examples containing quote markers or literal HTML', () => {
    const raw = [
      'How does this behave?',
      '```python',
      '> not a quote, just a doctest prompt',
      'print("<blockquote>literal</blockquote>")',
      '```',
      'And `> inline code` stays too.'
    ].join('\n')
    const summary = summarizeUserMessage(userMessage(['b1']), mapOf([mainText('b1', raw)]))
    expect(summary).toContain('How does this behave?')
    expect(summary).toContain('not a quote, just a doctest prompt')
    expect(summary).toContain('inline code')
  })

  it('preserves fenced literal blockquote tags verbatim in text-only output', () => {
    const raw = [
      'Before',
      '```python',
      '> not a quote',
      'print("<blockquote>literal</blockquote>")',
      '```',
      'After.'
    ].join('\n')
    const summary = summarizeUserMessage(userMessage(['b1']), mapOf([mainText('b1', raw)]))
    expect(summary).toContain('Before')
    expect(summary).toContain('After.')
    expect(summary).toContain('not a quote')
    expect(summary).toContain('print("<blockquote>literal</blockquote>")')
  })

  it('preserves inline literal blockquote tags', () => {
    const raw = 'See `print("<blockquote>hi</blockquote>")` done.'
    const summary = summarizeUserMessage(userMessage(['b1']), mapOf([mainText('b1', raw)]))
    expect(summary).toContain('<blockquote>hi</blockquote>')
    expect(summary).toContain('done.')
  })

  it('removes remaining raw HTML tags to text-only output', () => {
    expect(stripRemainingHtml('Hello <b>world</b> &amp; friends')).toBe('Hello world & friends')
  })

  it('summarizes body text while stripping both quote forms at once', () => {
    const raw = [
      'Please summarize this:',
      '> markdown quote to drop',
      '<blockquote><p>html quote to drop</p></blockquote>',
      'Keep this sentence.'
    ].join('\n')
    const summary = summarizeUserMessage(userMessage(['b1']), mapOf([mainText('b1', raw)]))
    expect(summary).toContain('Please summarize this:')
    expect(summary).toContain('Keep this sentence.')
    expect(summary).not.toContain('markdown quote to drop')
    expect(summary).not.toContain('html quote to drop')
    expect(summary).not.toContain('<')
  })

  it('returns empty for quote-only content so callers apply a localized fallback', () => {
    const raw = ['> only a quote', '<blockquote>only html quote</blockquote>'].join('\n')
    expect(summarizeUserMessage(userMessage(['b1']), mapOf([mainText('b1', raw)]))).toBe('')
  })

  it('returns empty for lazy and nested quote-only content', () => {
    expect(
      summarizeUserMessage(
        userMessage(['b1']),
        mapOf([mainText('b1', ['> quoted first line', 'quoted continuation'].join('\n'))])
      )
    ).toBe('')
    expect(summarizeUserMessage(userMessage(['b1']), mapOf([mainText('b1', ['> a', '>> b', '> c'].join('\n'))]))).toBe(
      ''
    )
  })

  it('keeps existing non-quote Markdown body', () => {
    const raw = ['# Title', '', '**bold** body with `code` and plain text.'].join('\n')
    const summary = summarizeUserMessage(userMessage(['b1']), mapOf([mainText('b1', raw)]))
    expect(summary).toContain('Title')
    expect(summary).toContain('bold')
    expect(summary).toContain('code')
    expect(summary).toContain('plain text.')
  })

  it('does not mutate the original message content when stripping quotes', () => {
    const raw = ['> quoted first line', 'quoted continuation', '', 'actual body'].join('\n')
    const before = raw
    summarizeUserMessage(userMessage(['b1']), mapOf([mainText('b1', raw)]))
    expect(raw).toBe(before)
  })

  it('returns empty for attachment-only messages and reports the attachment', () => {
    const blocksById = mapOf([fileBlock('f1')])
    expect(summarizeUserMessage(userMessage(['f1']), blocksById)).toBe('')
    expect(hasNavigableAttachment(userMessage(['f1']), blocksById)).toBe(true)
  })

  it('reports no attachment for text-only messages', () => {
    const blocksById = mapOf([mainText('b1', 'hello')])
    expect(hasNavigableAttachment(userMessage(['b1']), blocksById)).toBe(false)
  })

  it('truncates long previews at maxLength without mutating the input', () => {
    const raw = 'word '.repeat(200)
    const before = raw
    const summary = summarizeUserMessage(userMessage(['b1']), mapOf([mainText('b1', raw)]), { maxLength: 50 })
    expect(summary.length).toBeLessThanOrEqual(50)
    expect(raw).toBe(before)
  })

  it('collapses whitespace for a single-line-friendly preview', () => {
    expect(collapsePreviewWhitespace('  hello\n\n  world  ')).toBe('hello world')
  })
})

const fileMeta = (overrides: Record<string, unknown>) =>
  ({
    id: 'file-1',
    name: 'doc.pdf',
    origin_name: 'doc.pdf',
    path: '/tmp/doc.pdf',
    size: 10,
    ext: '.pdf',
    type: 'document',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }) as never

const namedFileBlock = (id: string, messageId: string, originName: string, extra?: Record<string, unknown>) =>
  ({
    id,
    messageId,
    type: MessageBlockType.FILE,
    file: fileMeta({ origin_name: originName, name: originName, ...extra }),
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z'
  }) as never

const imageBlock = (id: string, messageId: string, file?: Record<string, unknown>) =>
  ({
    id,
    messageId,
    type: MessageBlockType.IMAGE,
    ...(file ? { file: fileMeta({ type: 'image', ...file }) } : {}),
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z'
  }) as never

const videoBlock = (id: string, messageId: string) =>
  ({
    id,
    messageId,
    type: MessageBlockType.VIDEO,
    filePath: '/Users/someone/secret/clip.mp4',
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z'
  }) as never

const testFormatters = (overrides?: Partial<AttachmentLabelFormatters>): AttachmentLabelFormatters => ({
  genericFallback: 'Attachment',
  formatSingleNamed: (name) => name,
  formatNamedWithMore: (name, remaining) => `${name} +${remaining} attachments`,
  formatImageCount: (count) => (count === 1 ? '1 image' : `${count} images`),
  formatAttachmentCount: (count) => (count === 1 ? '1 attachment' : `${count} attachments`),
  pastedImageLabel: 'Pasted Image',
  ...overrides
})

describe('userMessagePreview attachment labels', () => {
  it('labels a single named file with its safe basename', () => {
    const blocksById = mapOf([namedFileBlock('f1', 'u1', 'report.pdf')])
    expect(buildAttachmentLabel(userMessage(['f1']), blocksById, testFormatters())).toBe('report.pdf')
  })

  it('labels multiple named files with the first name plus remaining count only', () => {
    const blocksById = mapOf([
      namedFileBlock('f1', 'u1', 'report.pdf'),
      namedFileBlock('f2', 'u1', 'a-very-long-second-filename-that-must-not-appear.csv'),
      namedFileBlock('f3', 'u1', 'third-workbook.xlsx')
    ])
    const label = buildAttachmentLabel(userMessage(['f1', 'f2', 'f3']), blocksById, testFormatters())
    expect(label).toBe('report.pdf +2 attachments')
    expect(label).not.toContain('second-filename')
    expect(label).not.toContain('third-workbook')
  })

  it('labels image-only attachments with localized image counts', () => {
    expect(buildAttachmentLabel(userMessage(['i1']), mapOf([imageBlock('i1', 'u1')]), testFormatters())).toBe('1 image')
    const blocksById = mapOf([imageBlock('i1', 'u1'), imageBlock('i2', 'u1'), imageBlock('i3', 'u1')])
    expect(buildAttachmentLabel(userMessage(['i1', 'i2', 'i3']), blocksById, testFormatters())).toBe('3 images')
  })

  it('labels mixed named plus unnamed attachments with first name plus total remaining', () => {
    const blocksById = mapOf([namedFileBlock('f1', 'u1', 'notes.md'), imageBlock('i1', 'u1'), videoBlock('v1', 'u1')])
    expect(buildAttachmentLabel(userMessage(['f1', 'i1', 'v1']), blocksById, testFormatters())).toBe(
      'notes.md +2 attachments'
    )
  })

  it('labels mixed unnamed attachments with a generic total count', () => {
    const blocksById = mapOf([imageBlock('i1', 'u1'), videoBlock('v1', 'u1')])
    expect(buildAttachmentLabel(userMessage(['i1', 'v1']), blocksById, testFormatters())).toBe('2 attachments')
  })

  it('labels quote-only plus attachment messages with the attachment label', () => {
    const blocksById = mapOf([mainText('b1', '> only a quote'), namedFileBlock('f1', 'u1', 'quoted-context.pdf')])
    expect(summarizeUserMessage(userMessage(['b1']), blocksById)).toBe('')
    expect(buildAttachmentLabel(userMessage(['b1', 'f1']), blocksById, testFormatters())).toBe('quoted-context.pdf')
  })

  it('returns empty for quote-only messages without attachments', () => {
    const blocksById = mapOf([mainText('b1', '> only a quote')])
    expect(buildAttachmentLabel(userMessage(['b1']), blocksById, testFormatters())).toBe('')
  })

  it('never exposes filesystem paths, URL secrets, or internal IDs', () => {
    const blocksById = mapOf([
      namedFileBlock('f1', 'u1', '/Users/someone/secret/report.pdf?token=abc123'),
      imageBlock('i1', 'u1'),
      videoBlock('v1', 'u1')
    ])
    const single = buildAttachmentLabel(userMessage(['f1']), blocksById, testFormatters())
    expect(single).toBe('report.pdf')
    expect(single).not.toContain('/')
    expect(single).not.toContain('token')
    expect(single).not.toContain('Users')
    const mixed = buildAttachmentLabel(userMessage(['f1', 'i1', 'v1']), blocksById, testFormatters())
    expect(mixed).toBe('report.pdf +2 attachments')
    expect(mixed).not.toContain('secret')
    expect(mixed).not.toContain('abc123')
    expect(mixed).not.toContain('clip.mp4')
    // Nameless image/video rows never surface raw block IDs either.
    const nameless = buildAttachmentLabel(userMessage(['i1', 'v1']), blocksById, testFormatters())
    expect(nameless).toBe('2 attachments')
    expect(nameless).not.toContain('i1')
    expect(nameless).not.toContain('v1')
  })

  it('uses the safe basename when the stored name contains path segments', () => {
    expect(safeBasename('C:\\Users\\someone\\docs\\plan.docx')).toBe('plan.docx')
    expect(safeBasename('https://example.com/files/slide.pdf?sig=secret#frag')).toBe('slide.pdf')
    expect(safeBasename('  plain.txt  ')).toBe('plain.txt')
    expect(safeBasename('')).toBe('')
  })

  it('maps clipboard pasted-image internal names to the meaningful app label, never the raw ID', () => {
    const pasted = 'pasted_image_45285c9c-a7cd-4c3d-a9b6-6854c3bbe479.png'
    expect(isGeneratedAttachmentName(pasted)).toBe(true)
    const blocksById = mapOf([imageBlock('i1', 'u1', { origin_name: pasted, name: pasted })])
    const label = buildAttachmentLabel(userMessage(['i1']), blocksById, testFormatters())
    expect(label).toBe('Pasted Image')
    expect(label).not.toContain('45285c9c')
    // Without a pasted-image convention available, fall back to the type count.
    const typeLabel = buildAttachmentLabel(
      userMessage(['i1']),
      blocksById,
      testFormatters({ pastedImageLabel: undefined })
    )
    expect(typeLabel).toBe('1 image')
  })

  it('treats temp/pasted-text generated names as nameless', () => {
    expect(isGeneratedAttachmentName('temp_file_foo_image.png')).toBe(true)
    expect(isGeneratedAttachmentName('pasted_text_abc123.txt')).toBe(true)
    const blocksById = mapOf([namedFileBlock('f1', 'u1', 'pasted_text_abc123.txt', { type: 'text' })])
    expect(buildAttachmentLabel(userMessage(['f1']), blocksById, testFormatters())).toBe('1 attachment')
  })

  it('bounds long attachment labels at maxLength', () => {
    const longName = `${'a'.repeat(500)}.pdf`
    const blocksById = mapOf([namedFileBlock('f1', 'u1', longName)])
    const label = buildAttachmentLabel(userMessage(['f1']), blocksById, testFormatters())
    expect(label.length).toBeLessThanOrEqual(280)
    expect(collectAttachmentSummary(userMessage(['f1']), blocksById).firstNamed).toBe(longName)
  })
})
