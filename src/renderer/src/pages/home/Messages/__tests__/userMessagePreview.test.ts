import { MessageBlockType } from '@renderer/types/newMessage'
import type { SnapshotBlockMap } from '@renderer/utils/messageUtils/snapshotBlocks'
import { describe, expect, it } from 'vitest'

import {
  type AttachmentLabelFormatters,
  buildAttachmentLabel,
  collapsePreviewWhitespace,
  hasNavigableAttachment,
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
    size: 10,
    ext: '.pdf',
    type: 'document',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }) as never

const typedFileBlock = (id: string, messageId: string, type: string | null, ext: string) =>
  ({
    id,
    messageId,
    type: MessageBlockType.FILE,
    file: fileMeta({ type, ext }),
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

const codeBlock = (id: string, messageId: string) =>
  ({
    id,
    messageId,
    type: MessageBlockType.CODE,
    content: 'print(1)',
    language: 'python',
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z'
  }) as never

const testFormatters = (): AttachmentLabelFormatters => ({
  genericFallback: 'Attachment',
  typeImage: 'Image',
  typeVideo: 'Video',
  typeAudio: 'Audio',
  typeText: 'Text',
  typeDocument: 'Document',
  typeCode: 'Code'
})

describe('userMessagePreview attachment labels', () => {
  it('lists IMAGE, audio FILE, IMAGE, document FILE in exact order with no merging', () => {
    const blocksById = mapOf([
      imageBlock('i1', 'u1'),
      typedFileBlock('f1', 'u1', 'audio', '.mp3'),
      imageBlock('i2', 'u1'),
      typedFileBlock('f2', 'u1', 'document', '.pdf')
    ])
    expect(buildAttachmentLabel(userMessage(['i1', 'f1', 'i2', 'f2']), blocksById, testFormatters())).toBe(
      '[Image][Audio][Image][Document]'
    )
  })

  it('preserves duplicate images without merging or counting', () => {
    const blocksById = mapOf([imageBlock('i1', 'u1'), imageBlock('i2', 'u1')])
    expect(buildAttachmentLabel(userMessage(['i1', 'i2']), blocksById, testFormatters())).toBe('[Image][Image]')
  })

  it('never shows filenames: a named report.pdf typed as document reads [Document]', () => {
    const blocksById = mapOf([
      {
        id: 'f1',
        messageId: 'u1',
        type: MessageBlockType.FILE,
        file: { id: 'x', ext: '.pdf', type: 'document' },
        status: 'success',
        createdAt: '2026-01-01T00:00:00.000Z'
      } as never
    ])
    const label = buildAttachmentLabel(userMessage(['f1']), blocksById, testFormatters())
    expect(label).toBe('[Document]')
    expect(label).not.toContain('report')
  })

  it('maps a named song.mp3 to [Audio] and example.py typed text to [Text] without names', () => {
    const song = mapOf([
      {
        id: 'f1',
        messageId: 'u1',
        type: MessageBlockType.FILE,
        file: { id: 'x', ext: '.mp3', type: 'audio' },
        status: 'success',
        createdAt: '2026-01-01T00:00:00.000Z'
      } as never
    ])
    const songLabel = buildAttachmentLabel(userMessage(['f1']), song, testFormatters())
    expect(songLabel).toBe('[Audio]')
    expect(songLabel).not.toContain('song')
    const py = mapOf([
      {
        id: 'f1',
        messageId: 'u1',
        type: MessageBlockType.FILE,
        file: { id: 'x', ext: '.py', type: 'text' },
        status: 'success',
        createdAt: '2026-01-01T00:00:00.000Z'
      } as never
    ])
    const pyLabel = buildAttachmentLabel(userMessage(['f1']), py, testFormatters())
    // A .py suffix never maps to Code: type=text wins, explicit CODE blocks alone read Code.
    expect(pyLabel).toBe('[Text]')
    expect(pyLabel).not.toContain('example')
  })

  it('keeps heterogeneous repeated order exactly, duplicates preserved', () => {
    const blocksById = mapOf([
      videoBlock('v1', 'u1'),
      codeBlock('c1', 'u1'),
      typedFileBlock('f1', 'u1', 'audio', '.mp3'),
      typedFileBlock('f2', 'u1', 'text', '.md'),
      typedFileBlock('f3', 'u1', 'document', '.pdf'),
      imageBlock('i1', 'u1'),
      typedFileBlock('f4', 'u1', 'audio', '.mp3')
    ])
    expect(
      buildAttachmentLabel(userMessage(['v1', 'c1', 'f1', 'f2', 'f3', 'i1', 'f4']), blocksById, testFormatters())
    ).toBe('[Video][Code][Audio][Text][Document][Image][Audio]')
  })

  it('labels single video and code blocks by kind without reading private paths', () => {
    const videoOnly = mapOf([videoBlock('v1', 'u1')])
    const videoLabel = buildAttachmentLabel(userMessage(['v1']), videoOnly, testFormatters())
    expect(videoLabel).toBe('[Video]')
    expect(videoLabel).not.toBe('1 video')
    expect(videoLabel).not.toContain('clip.mp4')
    expect(buildAttachmentLabel(userMessage(['c1']), mapOf([codeBlock('c1', 'u1')]), testFormatters())).toBe('[Code]')
  })

  it('labels quote-only plus attachment messages with the sequential attachment labels', () => {
    const blocksById = mapOf([
      mainText('b1', '> only a quote'),
      imageBlock('i1', 'u1'),
      typedFileBlock('f1', 'u1', 'audio', '.mp3')
    ])
    expect(summarizeUserMessage(userMessage(['b1']), blocksById)).toBe('')
    expect(buildAttachmentLabel(userMessage(['b1', 'i1', 'f1']), blocksById, testFormatters())).toBe('[Image][Audio]')
  })

  it('returns empty for quote-only messages without attachments', () => {
    const blocksById = mapOf([mainText('b1', '> only a quote')])
    expect(buildAttachmentLabel(userMessage(['b1']), blocksById, testFormatters())).toBe('')
  })

  it('never exposes filesystem paths, URL secrets, filenames, or internal IDs', () => {
    const blocksById = mapOf([
      typedFileBlock('f1', 'u1', 'document', '.pdf'),
      imageBlock('i1', 'u1'),
      videoBlock('v1', 'u1')
    ])
    const label = buildAttachmentLabel(userMessage(['f1', 'i1', 'v1']), blocksById, testFormatters())
    expect(label).toBe('[Document][Image][Video]')
    expect(label).not.toContain('/')
    expect(label).not.toContain('token')
    expect(label).not.toContain('Users')
    expect(label).not.toContain('secret')
    expect(label).not.toContain('abc123')
    expect(label).not.toContain('clip.mp4')
    expect(label).not.toContain('f1')
    expect(label).not.toContain('i1')
    expect(label).not.toContain('v1')
    expect(label).not.toContain('report')
  })

  it('reads pasted-text rows by their upstream type metadata, never the raw name', () => {
    // Upstream metadata type=text is authoritative: no filename is ever shown.
    const blocksById = mapOf([typedFileBlock('f1', 'u1', 'text', '.txt')])
    const label = buildAttachmentLabel(userMessage(['f1']), blocksById, testFormatters())
    expect(label).toBe('[Text]')
    expect(label).not.toContain('pasted')
  })

  it('falls back honestly to [Attachment] when type and ext cannot classify', () => {
    const unknownExt = mapOf([typedFileBlock('f1', 'u1', null, '.unknownext')])
    expect(buildAttachmentLabel(userMessage(['f1']), unknownExt, testFormatters())).toBe('[Attachment]')
    const noMeta = mapOf([
      {
        id: 'f2',
        messageId: 'u1',
        type: MessageBlockType.FILE,
        file: { id: 'x' },
        status: 'success',
        createdAt: '2026-01-01T00:00:00.000Z'
      } as never
    ])
    expect(buildAttachmentLabel(userMessage(['f2']), noMeta, testFormatters())).toBe('[Attachment]')
  })

  it('emits the full typed sequence without truncation; the UI ellipsis controls visibility', () => {
    const ids: string[] = []
    const blocks: never[] = []
    const kinds: Array<'image' | 'audio' | 'text' | 'document' | 'video'> = ['image', 'audio', 'text', 'document']
    for (let i = 0; i < 40; i++) {
      const kind = kinds[i % kinds.length]
      const id = `f${i}`
      ids.push(id)
      const ext = kind === 'image' ? '.png' : kind === 'audio' ? '.mp3' : kind === 'text' ? '.md' : '.pdf'
      blocks.push(typedFileBlock(id, 'u1', kind, ext))
    }
    const blocksById = mapOf(blocks)
    const label = buildAttachmentLabel(userMessage(ids), blocksById, testFormatters())
    const expected = Array.from({ length: 40 }, (_, i) => `[${['Image', 'Audio', 'Text', 'Document'][i % 4]}]`).join('')
    expect(label).toBe(expected)
    // Deliberately longer than the old 280 cap: no slicing here.
    expect(label.length).toBeGreaterThan(280)
  })

  it('maps every FILE type to its own kind label', () => {
    const cases: Array<[string, string]> = [
      ['image', '[Image]'],
      ['video', '[Video]'],
      ['audio', '[Audio]'],
      ['text', '[Text]'],
      ['document', '[Document]'],
      ['other', '[Attachment]']
    ]
    for (const [type, expected] of cases) {
      const blocksById = mapOf([
        {
          id: 'f1',
          messageId: 'u1',
          type: MessageBlockType.FILE,
          file: { id: 'x', ext: '.bin', type },
          status: 'success',
          createdAt: '2026-01-01T00:00:00.000Z'
        } as never
      ])
      expect(buildAttachmentLabel(userMessage(['f1']), blocksById, testFormatters())).toBe(expected)
    }
  })

  it('classifies null-type audio via ext case-insensitively and with/without dot', () => {
    const upper = mapOf([
      {
        id: 'f1',
        messageId: 'u1',
        type: MessageBlockType.FILE,
        file: { id: 'x', ext: '.MP3', type: null },
        status: 'success',
        createdAt: '2026-01-01T00:00:00.000Z'
      } as never
    ])
    expect(buildAttachmentLabel(userMessage(['f1']), upper, testFormatters())).toBe('[Audio]')
    const noDot = mapOf([
      {
        id: 'f1',
        messageId: 'u1',
        type: MessageBlockType.FILE,
        file: { id: 'x', ext: 'mp3', type: null },
        status: 'success',
        createdAt: '2026-01-01T00:00:00.000Z'
      } as never
    ])
    expect(buildAttachmentLabel(userMessage(['f1']), noDot, testFormatters())).toBe('[Audio]')
  })

  it('separates text from document via type authority and ordinary ext fallback', () => {
    const textTyped = mapOf([typedFileBlock('f1', 'u1', 'text', '.txt')])
    expect(buildAttachmentLabel(userMessage(['f1']), textTyped, testFormatters())).toBe('[Text]')
    const docTyped = mapOf([typedFileBlock('f1', 'u1', 'document', '.pdf')])
    expect(buildAttachmentLabel(userMessage(['f1']), docTyped, testFormatters())).toBe('[Document]')
    const nullMd = mapOf([typedFileBlock('f1', 'u1', null, '.md')])
    expect(buildAttachmentLabel(userMessage(['f1']), nullMd, testFormatters())).toBe('[Text]')
    const nullPy = mapOf([typedFileBlock('f1', 'u1', null, '.py')])
    expect(buildAttachmentLabel(userMessage(['f1']), nullPy, testFormatters())).toBe('[Text]')
  })

  it('classifies shared accepted video (.wmv) missing from the old hand list', () => {
    const blocksById = mapOf([typedFileBlock('f1', 'u1', null, '.wmv')])
    expect(buildAttachmentLabel(userMessage(['f1']), blocksById, testFormatters())).toBe('[Video]')
  })

  it('keeps audio and document order across messages without names', () => {
    const blocksById = mapOf([
      typedFileBlock('f1', 'u1', 'audio', '.mp3'),
      typedFileBlock('f2', 'u1', 'document', '.pdf')
    ])
    const label = buildAttachmentLabel(userMessage(['f1', 'f2']), blocksById, testFormatters())
    expect(label).toBe('[Audio][Document]')
    expect(label).not.toContain('later-report')
  })

  it('falls back unknown rows to attachment, never document', () => {
    const blocksById = mapOf([typedFileBlock('f1', 'u1', 'other', '.bin')])
    expect(buildAttachmentLabel(userMessage(['f1']), blocksById, testFormatters())).toBe('[Attachment]')
    const noExtUnknown = mapOf([typedFileBlock('f1', 'u1', 'other', '')])
    expect(buildAttachmentLabel(userMessage(['f1']), noExtUnknown, testFormatters())).toBe('[Attachment]')
  })

  it('shows images as image even when the stored ext has no dot', () => {
    const blocksById = mapOf([imageBlock('i1', 'u1', { ext: 'png', type: 'image' })])
    expect(buildAttachmentLabel(userMessage(['i1']), blocksById, testFormatters())).toBe('[Image]')
  })

  it('prefers body text over attachment clutter', () => {
    const blocksById = mapOf([
      mainText('b1', 'Please review the attached report.'),
      typedFileBlock('f1', 'u1', 'document', '.pdf')
    ])
    expect(summarizeUserMessage(userMessage(['b1']), blocksById)).toContain('Please review the attached report.')
    expect(hasNavigableAttachment(userMessage(['b1', 'f1']), blocksById)).toBe(true)
  })
})

describe('userMessagePreview external link labels', () => {
  const linkOpts = { linkLabel: 'Link' }
  const summarizeLink = (content: string, opts: { linkLabel?: string; maxLength?: number } = linkOpts): string =>
    summarizeUserMessage(userMessage(['b1']), mapOf([mainText('b1', content)]), opts)

  it('replaces a bare URL in place, keeping surrounding words and spaces', () => {
    expect(summarizeLink('look https://example.com test')).toBe('look [Link] test')
  })

  it('replaces a bare URL before a newline; the boundary linebreak joins without adding content', () => {
    // Link-boundary rule: whitespace immediately after a replaced link joins
    // only when it contains a newline (`URL\nTest` → `[Link]Test`); ordinary
    // inline spaces stay (`look URL test` → `look [Link] test`).
    expect(summarizeLink('https://example.com\nTest')).toBe('[Link]Test')
  })

  it('replaces a Markdown inline link before a newline with the same boundary join', () => {
    expect(summarizeLink('[Example](https://example.com)\nTest')).toBe('[Link]Test')
  })

  it('replaces a Markdown inline link label and destination together', () => {
    const summary = summarizeLink('[Example](https://example.com) test')
    expect(summary).toBe('[Link] test')
    expect(summary).not.toContain('Example')
    expect(summary).not.toContain('example.com')
  })

  it('replaces reference links and drops their definitions', () => {
    const summary = summarizeLink(['See [Example][ref] today.', '', '[ref]: https://example.com'].join('\n'))
    expect(summary).toContain('[Link]')
    expect(summary).not.toContain('Example')
    expect(summary).not.toContain('example.com')
    expect(summary).not.toContain('[ref]')
  })

  it('replaces angle autolinks without leaking the URL', () => {
    expect(summarizeLink('<https://example.com> test')).toBe('[Link] test')
  })

  it('keeps trailing punctuation outside the replaced link', () => {
    expect(summarizeLink('See https://example.com.')).toBe('See [Link].')
  })

  it('replaces each of multiple links at its own position without merging', () => {
    expect(summarizeLink('a https://a.com b https://b.com c')).toBe('a [Link] b [Link] c')
  })

  it('replaces mailto and obsidian Markdown links as legal external links', () => {
    expect(summarizeLink('[Contact](mailto:foo@example.com)')).toBe('[Link]')
    expect(summarizeLink('[Note](obsidian://open?vault=main)')).toBe('[Link]')
  })

  it('keeps the visible label of internal anchor links', () => {
    const summary = summarizeLink('[label](#section) end')
    expect(summary).toContain('label')
    expect(summary).toContain('end')
    expect(summary).not.toContain('[Link]')
  })

  it('never treats Markdown images as links', () => {
    const summary = summarizeLink('See ![alt](https://example.com/img.png) here')
    expect(summary).not.toContain('[Link]')
    expect(summary).toContain('alt')
  })

  it('removes quote-only links with the quote so callers see the fallback', () => {
    expect(summarizeLink('> https://example.com')).toBe('')
  })

  it('keeps fenced code URLs literal', () => {
    const summary = summarizeLink(['Before', '```', 'https://example.com', '```', 'After'].join('\n'))
    expect(summary).toContain('https://example.com')
    expect(summary).not.toContain('[Link]')
  })

  it('keeps inline code URLs literal', () => {
    const summary = summarizeLink('See `https://example.com` done.')
    expect(summary).toContain('https://example.com')
    expect(summary).not.toContain('[Link]')
  })

  it('replaces HTML anchors with safe external hrefs in place', () => {
    expect(summarizeLink('look <a href="https://example.com">click here</a> test')).toBe('look [Link] test')
  })

  it('keeps the inner text of internal HTML anchors', () => {
    const summary = summarizeLink('see <a href="#sec">label</a> end')
    expect(summary).toContain('label')
    expect(summary).toContain('end')
    expect(summary).not.toContain('[Link]')
  })

  it('leaves link syntax untouched when no localized label is supplied', () => {
    const summary = summarizeUserMessage(userMessage(['b1']), mapOf([mainText('b1', 'look https://example.com test')]))
    expect(summary).toContain('https://example.com')
    expect(summary).not.toContain('[Link]')
  })

  it('keeps multi-block body order with link replacement', () => {
    const blocksById = mapOf([mainText('b1', 'Hello https://example.com'), mainText('b2', 'World')])
    // Link-boundary join applies uniformly: the block-join delimiter after a
    // trailing link contains newlines, so it joins like any boundary linebreak.
    expect(summarizeUserMessage(userMessage(['b1', 'b2']), blocksById, linkOpts)).toBe('Hello [Link]World')
  })
})
