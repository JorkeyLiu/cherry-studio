/**
 * Conservative, pure math trigger detection for Home Markdown.
 *
 * - Must not under-trigger valid existing `$...$`, `$$...$$`, `\(...\)`, `\[...\]` math.
 * - May over-trigger to preserve current behavior (no currency escaping).
 * - Attempts to avoid treating delimiters inside fenced/inline code as qualifying
 *   by stripping code segments using a scanner that handles tilde/long/unclosed
 *   fences and inline code. Otherwise prefers false-positive loading over missed valid math.
 * - Fenced ` ```math ` blocks are math language forms recognized by the installed
 *   rehype-katex (`language-math` case-sensitive). They are detected before ordinary
 *   fence stripping so they are not suppressed as ordinary code. The installed
 *   parser generates `language-math` for:
 *     * fences of at least 3 backticks OR tildes (` ``` `, `~~~~`, ` ```` `, etc.)
 *     * optional indentation up to 3 spaces (CommonMark)
 *     * first info-string token exactly lowercase `math`
 *     * unclosed fences to EOF (important during streaming)
 *     * a longer opening fence is not closed by a shorter fence
 *     * for backtick fences, info string must not contain a backtick
 */

function parseOpeningFence(line: string): { char: string; length: number; info: string } | null {
  let indent = 0
  while (indent < line.length && line[indent] === ' ') {
    indent += 1
  }
  if (indent > 3) {
    return null
  }
  if (indent >= line.length) {
    return null
  }
  const ch = line[indent]
  if (ch !== '`' && ch !== '~') {
    return null
  }
  let len = 0
  let p = indent
  while (p < line.length && line[p] === ch) {
    len += 1
    p += 1
  }
  if (len < 3) {
    return null
  }
  const info = line.slice(p)
  return { char: ch, length: len, info }
}

function isClosingFence(line: string, openingChar: string, openingLen: number): boolean {
  let indent = 0
  while (indent < line.length && line[indent] === ' ') {
    indent += 1
  }
  if (indent > 3) {
    return false
  }
  if (indent >= line.length) {
    return false
  }
  const ch = line[indent]
  if (ch !== openingChar) {
    return false
  }
  let len = 0
  let p = indent
  while (p < line.length && line[p] === ch) {
    len += 1
    p += 1
  }
  if (len < openingLen) {
    return false
  }
  const rest = line.slice(p)
  return rest.trim() === ''
}

function hasFencedMath(text: string): boolean {
  const lines = text.split('\n')
  let inside: { char: string; len: number } | null = null
  for (const line of lines) {
    if (inside) {
      if (isClosingFence(line, inside.char, inside.len)) {
        inside = null
      }
      continue
    }
    const opening = parseOpeningFence(line)
    if (!opening) {
      continue
    }
    if (opening.char === '`' && opening.info.includes('`')) {
      continue
    }
    const infoTrim = opening.info.trim()
    if (infoTrim === '') {
      inside = { char: opening.char, len: opening.length }
      continue
    }
    const firstToken = infoTrim.split(/\s+/)[0]
    if (firstToken === 'math') {
      return true
    }
    inside = { char: opening.char, len: opening.length }
  }
  return false
}

function stripCodeSegments(text: string): string {
  // Phase 1: blank fenced blocks
  const lines = text.split('\n')
  let offset = 0
  let inside: { char: string; len: number; start: number } | null = null
  const ranges: Array<[number, number]> = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineStart = offset
    const lineEnd = offset + line.length
    const hasNewline = i < lines.length - 1
    const newlineLen = hasNewline ? 1 : 0

    if (inside) {
      if (isClosingFence(line, inside.char, inside.len)) {
        const blockEnd = lineEnd + newlineLen
        ranges.push([inside.start, blockEnd])
        inside = null
      }
    } else {
      const opening = parseOpeningFence(line)
      if (opening && !(opening.char === '`' && opening.info.includes('`'))) {
        inside = { char: opening.char, len: opening.length, start: lineStart }
      }
    }

    offset = lineEnd + newlineLen
  }

  if (inside) {
    ranges.push([inside.start, text.length])
  }

  // Apply fence blanking
  const chars = text.split('')
  for (const [start, end] of ranges) {
    for (let idx = start; idx < end && idx < chars.length; idx++) {
      chars[idx] = ' '
    }
  }
  const withoutFences = chars.join('')

  // Phase 2: blank inline code (backtick runs)
  const len = withoutFences.length
  const outChars = withoutFences.split('')
  let i = 0
  while (i < len) {
    if (outChars[i] !== '`') {
      i += 1
      continue
    }
    let j = i
    while (j < len && outChars[j] === '`') {
      j += 1
    }
    const openLen = j - i
    // Find closing run of same length that is not part of longer run
    let found = -1
    let k = j
    while (k < len) {
      if (outChars[k] !== '`') {
        k += 1
        continue
      }
      let q = k
      while (q < len && outChars[q] === '`') {
        q += 1
      }
      const runLen = q - k
      if (runLen === openLen) {
        found = k
        break
      }
      // If runLen != openLen, skip this run and continue searching
      k = q
    }
    if (found !== -1) {
      for (let t = i; t < found + openLen; t++) {
        outChars[t] = ' '
      }
      i = found + openLen
    } else {
      i = j
    }
  }

  return outChars.join('')
}

export function containsMath(text: string): boolean {
  if (!text || typeof text !== 'string') {
    return false
  }
  if (hasFencedMath(text)) {
    return true
  }
  const withoutCode = stripCodeSegments(text)

  if (/\\\(.*?\\\)/s.test(withoutCode)) {
    return true
  }
  if (/\\\[.*?\\\]/s.test(withoutCode)) {
    return true
  }
  if (/\$\$[\s\S]*?\$\$/s.test(withoutCode)) {
    return true
  }

  const withoutDisplay = withoutCode.replace(/\$\$[\s\S]*?\$\$/g, (m) => ' '.repeat(m.length))

  if (/(?<!\\)\$(?!\$)[\s\S]*?(?<!\\)\$(?!\$)/s.test(withoutDisplay)) {
    return true
  }

  // Fallback conservative check for single-dollar pair without lookbehind support edge:
  // after removing display, look for any $...$ pair not adjacent to another $.
  // The lookbehind above already handles escaped dollars; this secondary check
  // ensures we don't miss valid math if the engine lacks lookbehind (though
  // Node 24 supports it, we keep a simple alternative).
  if (/\$(?!\$)[^$]*?\$(?!\$)/s.test(withoutDisplay)) {
    return true
  }

  return false
}
