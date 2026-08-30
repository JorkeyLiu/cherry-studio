import { describe, expect, it } from 'vitest'

import { containsMath } from '../containsMath'

describe('containsMath - S7.6 conservative trigger', () => {
  it('does not trigger on ordinary Markdown', () => {
    expect(containsMath('Hello world')).toBe(false)
    expect(containsMath('# Heading\n\nThis is **bold** text.')).toBe(false)
    expect(containsMath('Just plain - list\n- item 1\n- item 2')).toBe(false)
    expect(containsMath('')).toBe(false)
    expect(containsMath('No math here, just $ sign alone')).toBe(false)
  })

  it('triggers on inline $...$ single dollar', () => {
    expect(containsMath('Euler $e^{i\\pi} = -1$ is famous')).toBe(true)
    expect(containsMath('Inline $a+b$ and more')).toBe(true)
    expect(containsMath('$x$')).toBe(true)
  })

  it('triggers on display $$...$$', () => {
    expect(containsMath('Display $$x^2$$ math')).toBe(true)
    expect(containsMath('$$\n\\frac{1}{2}\n$$')).toBe(true)
    expect(containsMath('Multiple $$a$$ and $$b$$')).toBe(true)
  })

  it('triggers on bracket forms after preprocessing', () => {
    expect(containsMath('Inline \\(a+b\\) test')).toBe(true)
    expect(containsMath('Display \\[a+b\\] test')).toBe(true)
    expect(containsMath('Mixed \\(x\\) and \\[y\\]')).toBe(true)
  })

  it('does not trigger for math inside fenced code blocks', () => {
    expect(containsMath('```\n$x$\n```')).toBe(false)
    expect(containsMath('```js\n$x$\n```')).toBe(false)
    expect(containsMath('```\n\\(a\\)\n```')).toBe(false)
  })

  it('triggers for fenced math language exactly', () => {
    expect(containsMath('```math\nE=mc^2\n```')).toBe(true)
    expect(containsMath('Some text\n```math\nx^2\n```\nmore')).toBe(true)
    expect(containsMath('```math extra\ncontent\n```')).toBe(true)
    expect(containsMath('```math\na\n``` and $b$')).toBe(true)
  })

  it('does not trigger for non-math fence names or case variants', () => {
    expect(containsMath('```Math\n$x$\n```')).toBe(false)
    expect(containsMath('```MATH\nx\n```')).toBe(false)
    expect(containsMath('```mathematics\nx\n```')).toBe(false)
    expect(containsMath('```matha\nx\n```')).toBe(false)
    expect(containsMath('```\n```math\n```')).toBe(false)
  })

  it('fenced math qualifies before ordinary fence stripping', () => {
    // This ensures the fence itself qualifies even though stripping would blank fences
    expect(containsMath('```math\n$$x$$\n```')).toBe(true)
    expect(containsMath('```math\n\\(a\\)\n```')).toBe(true)
  })

  it('does not trigger for math inside inline code', () => {
    expect(containsMath('`$x$`')).toBe(false)
    expect(containsMath('`$$x$$` code')).toBe(false)
    expect(containsMath('`\\(a\\)`')).toBe(false)
  })

  it('triggers when math is outside code even if code also contains dollars', () => {
    expect(containsMath('Text $a$ and `code $b$`')).toBe(true)
    expect(containsMath('`code` then $$x$$')).toBe(true)
    expect(containsMath('```\ncode\n```\n$y$')).toBe(true)
  })

  it('may over-trigger but must not under-trigger valid math with surrounding text', () => {
    expect(containsMath('Price $5 and $x$ math')).toBe(true)
    expect(containsMath('a $b$ c')).toBe(true)
  })

  it('handles multiline and edge cases', () => {
    expect(containsMath('line1 $a$\nline2')).toBe(true)
    expect(containsMath('$$a\nb$$')).toBe(true)
    expect(containsMath('text without closing $ only')).toBe(false)
    expect(containsMath('$$unclosed display')).toBe(false)
  })

  it('triggers for tilde fenced math language', () => {
    expect(containsMath('~~~math\nE=mc^2\n~~~')).toBe(true)
    expect(containsMath('Some text\n~~~math\nx\n~~~\nmore')).toBe(true)
    expect(containsMath('~~~math extra\ncontent\n~~~')).toBe(true)
    expect(containsMath('~~~math\n$$x$$\n~~~')).toBe(true)
  })

  it('triggers for 4+ backtick and tilde fences', () => {
    expect(containsMath('````math\nx\n````')).toBe(true)
    expect(containsMath('````math extra\ncontent\n````')).toBe(true)
    expect(containsMath('~~~~math\nx\n~~~~')).toBe(true)
    expect(containsMath('~~~~~math\nx\n~~~~~')).toBe(true)
    expect(containsMath('`````math\nx\n`````')).toBe(true)
  })

  it('matching closer: longer opener not closed by shorter', () => {
    // Longer opener must not be closed by shorter fence - content remains inside
    // Math fence with 4 backticks should remain math even if inner shorter fence present
    expect(containsMath('````math\ncontent\n```\nmore\n````')).toBe(true)
    expect(containsMath('~~~~math\ncontent\n~~~\nmore\n~~~~')).toBe(true)
    // Ordinary long fence containing math delimiters: shorter inner fence does not close outer, so delimiters remain inside and should NOT trigger
    expect(containsMath('````\n$x$\n```\n$y$\n````')).toBe(false)
    expect(containsMath('~~~~\n$x$\n~~~\n~~~~')).toBe(false)
    // Matching closer does close and next math outside should trigger
    expect(containsMath('````\ncode\n````\n$y$')).toBe(true)
  })

  it('triggers for unclosed streaming fences', () => {
    expect(containsMath('```math\nE=mc^2')).toBe(true)
    expect(containsMath('~~~math\nx^2')).toBe(true)
    expect(containsMath('````math\nunclosed content')).toBe(true)
    expect(containsMath('Some text\n```math\nstreaming...')).toBe(true)
    // Unclosed ordinary fence containing delimiter should NOT trigger
    expect(containsMath('```\n$x$')).toBe(false)
    expect(containsMath('~~~\n$x$')).toBe(false)
    expect(containsMath('````\n$x$\nmore without close')).toBe(false)
  })

  it('handles indentation up to 3 spaces for fences', () => {
    expect(containsMath('   ```math\nx\n```')).toBe(true)
    expect(containsMath('  ~~~math\nx\n~~~')).toBe(true)
    expect(containsMath('   ````math\nx\n````')).toBe(true)
    expect(containsMath(' ```math\nx\n```')).toBe(true)
    // 4 spaces is indented code, not fenced math - should not trigger as math fence (but $ outside would still trigger)
    expect(containsMath('    ```math\nx\n```')).toBe(false)
    // Indented ordinary fence should still blank content
    expect(containsMath('   ```\n$x$\n   ```')).toBe(false)
    expect(containsMath('  ~~~\n$x$\n  ~~~')).toBe(false)
  })

  it('case variants and non-math language do not trigger as fences', () => {
    expect(containsMath('~~~Math\n$x$\n~~~')).toBe(false)
    expect(containsMath('~~~MATH\nx\n~~~')).toBe(false)
    expect(containsMath('````Math\nx\n````')).toBe(false)
    expect(containsMath('```mathematics\nx\n```')).toBe(false)
    expect(containsMath('~~~mathematics\nx\n~~~')).toBe(false)
    expect(containsMath('```matha\nx\n```')).toBe(false)
    expect(containsMath('~~~matha\nx\n~~~')).toBe(false)
    expect(containsMath('```python\nx\n```')).toBe(false)
  })

  it('ordinary tilde/long/unclosed fences containing delimiters do not trigger', () => {
    expect(containsMath('~~~\n$x$\n~~~')).toBe(false)
    expect(containsMath('~~~\n$$x$$\n~~~')).toBe(false)
    expect(containsMath('~~~\n\\(a\\)\n~~~')).toBe(false)
    expect(containsMath('````\n$x$\n````')).toBe(false)
    expect(containsMath('~~~~\n$$x$$\n~~~~')).toBe(false)
    expect(containsMath('```\n$x$\n')).toBe(false)
    expect(containsMath('~~~\n$x$\n')).toBe(false)
    expect(containsMath('````\n$$x$$\n')).toBe(false)
    expect(containsMath('~~~\n`$x$`\n~~~')).toBe(false)
  })

  it('info-string first token must be exactly lowercase math', () => {
    expect(containsMath('```math\nx\n```')).toBe(true)
    expect(containsMath('```math extra\nx\n```')).toBe(true)
    expect(containsMath('```math   extra  tokens\nx\n```')).toBe(true)
    expect(containsMath('``` math\nx\n```')).toBe(true)
    expect(containsMath('```  math  \nx\n```')).toBe(true)
    expect(containsMath('~~~math extra\nx\n~~~')).toBe(true)
    expect(containsMath('````math extra\nx\n````')).toBe(true)
    expect(containsMath('```matha\nx\n```')).toBe(false)
    expect(containsMath('``` mathematics\nx\n```')).toBe(false)
    expect(containsMath('```Math extra\nx\n```')).toBe(false)
    expect(containsMath('```MATH\nx\n```')).toBe(false)
    // Backtick info containing backtick is invalid fence - should not count as math
    expect(containsMath('```math`extra\nx\n```')).toBe(false)
  })

  it('math fence inside ordinary fence is not considered outside math (stateful)', () => {
    expect(containsMath('```\n```math\n```\n```')).toBe(false)
    expect(containsMath('~~~\n~~~math\n~~~\n~~~')).toBe(false)
    expect(containsMath('````\n```math\nx\n```\n````')).toBe(false)
  })

  it('does not trigger for math inside tilde/long inline and fenced mixed', () => {
    expect(containsMath('``$x$``')).toBe(false)
    expect(containsMath('```code $x$``` should not but $y$ outside')).toBe(true)
    expect(containsMath('~~~code $x$~~~ then text')).toBe(false)
  })
})
