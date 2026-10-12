import { describe, expect, it } from 'vitest'

import {
  applyInlineWrap,
  buildDocumentChanges,
  expandToFullLines,
  findMatches,
  insertLink,
  replaceAllOccurrences,
  replaceMatchAt,
  toggleBold,
  toggleBulletList,
  toggleCode,
  toggleHeading,
  toggleQuote
} from '../messageEditorFormatting'

describe('messageEditorFormatting — view-independent transforms', () => {
  it('applyInlineWrap wraps a selection and inserts markers on empty selection', () => {
    const wrapped = applyInlineWrap('hello world', { from: 6, to: 11 }, '**', '**')
    expect(wrapped.content).toBe('hello **world**')
    expect(wrapped.anchor).toBe(8)
    expect(wrapped.head).toBe(13)

    const empty = applyInlineWrap('hi', { from: 2, to: 2 }, '**', '**')
    expect(empty.content).toBe('hi****')
    expect(empty.anchor).toBe(4)
    expect(empty.head).toBe(4)
  })

  it('toggleBold wraps and unwraps without touching surrounding text', () => {
    const raw = 'line with two spaces  \nnext **bold** end'
    const wrapped = toggleBold(raw, { from: 0, to: 4 })
    expect(wrapped.content).toBe('**line** with two spaces  \nnext **bold** end')

    const unwrapped = toggleBold('a **bold** b', { from: 2, to: 10 })
    expect(unwrapped.content).toBe('a bold b')
  })

  it('toggleHeading prefixes covered lines and removes on second toggle', () => {
    const content = 'first\nsecond'
    const headed = toggleHeading(content, { from: 0, to: content.length })
    expect(headed.content).toBe('## first\n## second')

    const plain = toggleHeading('## first\n## second', { from: 0, to: 15 })
    expect(plain.content).toBe('first\nsecond')
  })

  it('toggleHeading expands a mid-line selection to full lines', () => {
    const headed = toggleHeading('alpha\nbeta', { from: 1, to: 3 })
    expect(headed.content).toBe('## alpha\nbeta')
  })

  it('expandToFullLines covers whole lines only', () => {
    expect(expandToFullLines('ab\ncd\nef', { from: 1, to: 5 })).toEqual({ from: 0, to: 5 })
  })

  it('toggleBulletList adds and removes bullets, skipping blank lines', () => {
    const listed = toggleBulletList('a\n\nb', { from: 0, to: 4 })
    expect(listed.content).toBe('- a\n\n- b')

    const plain = toggleBulletList('- a\n- b', { from: 0, to: 7 })
    expect(plain.content).toBe('a\nb')
  })

  it('toggleQuote prefixes and strips quote markers', () => {
    expect(toggleQuote('a\nb', { from: 0, to: 3 }).content).toBe('> a\n> b')
    expect(toggleQuote('> a\n> b', { from: 0, to: 7 }).content).toBe('a\nb')
  })

  it('toggleCode uses inline markers for single-line and fences for multi-line', () => {
    const inline = toggleCode('const x = 1', { from: 6, to: 7 })
    expect(inline.content).toBe('const `x` = 1')

    const uninline = toggleCode('const `x` = 1', { from: 6, to: 9 })
    expect(uninline.content).toBe('const x = 1')

    const fenced = toggleCode('a\nb', { from: 0, to: 3 })
    expect(fenced.content).toBe('```\na\nb\n```')

    const unfenced = toggleCode('```\na\nb\n```', { from: 0, to: 11 })
    expect(unfenced.content).toBe('a\nb')
  })

  it('insertLink wraps selection and templates empty selection', () => {
    const wrapped = insertLink('click here', { from: 0, to: 5 }, 'https://example.com')
    expect(wrapped.content).toBe('[click](https://example.com) here')

    const templated = insertLink('', { from: 0, to: 0 })
    expect(templated.content).toBe('[text]()')
    expect(templated.anchor).toBe(1)
    expect(templated.head).toBe(5)
  })

  it('raw syntax survives transforms (no reflow or trimming)', () => {
    const raw = 'Unclosed <div> stays literal, trailing spaces: x  \nnext $a^2$ `code`'
    const result = toggleBold(raw, { from: 0, to: 8 })
    expect(result.content).toBe(`**Unclosed** <div> stays literal, trailing spaces: x  \nnext $a^2$ \`code\``)
  })

  it('findMatches locates literal occurrences and replace helpers substitute', () => {
    expect(findMatches('aa aa aa', 'aa')).toEqual([0, 3, 6])
    expect(findMatches('abc', '')).toEqual([])
    expect(replaceAllOccurrences('aa aa', 'aa', 'b')).toBe('b b')
    expect(replaceAllOccurrences('aa', '', 'b')).toBe('aa')

    const replaced = replaceMatchAt('one two one', 'one', '1', 1)
    expect(replaced.content).toBe('one two 1')
  })

  it('buildDocumentChanges projects the minimal native transaction', () => {
    // Identical documents need no history entry: callers dispatch
    // selection-only and never touch the native history.
    expect(buildDocumentChanges('same', 'same')).toEqual([])

    // A toolbar insert projects to a single minimal change, not a whole-doc
    // replacement: applying the change set must reproduce the target exactly.
    const prev = 'hello world'
    const next = 'hello **world**'
    const changes = buildDocumentChanges(prev, next)
    expect(changes.length).toBeGreaterThan(0)
    const totalReplaced = changes.reduce((sum, change) => sum + (change.to - change.from), 0)
    expect(totalReplaced).toBeLessThan(prev.length)
    let applied = prev
    const appliedChanges = [...changes].sort((a, b) => b.from - a.from)
    for (const change of appliedChanges) {
      applied = applied.slice(0, change.from) + change.insert + applied.slice(change.to)
    }
    expect(applied).toBe(next)
  })
})
