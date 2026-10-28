import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import removeMarkdown from 'remove-markdown'
import { unified } from 'unified'
import type { Point, Position } from 'unist'
import { visit } from 'unist-util-visit'

/**
 * 更彻底的查找方法，递归搜索所有子元素
 * @param {any} children 子元素
 * @returns {string} 找到的 citation 或 ''
 */
export const findCitationInChildren = (children: any): string => {
  if (!children) return ''

  // 直接搜索子元素
  for (const child of Array.isArray(children) ? children : [children]) {
    if (typeof child === 'object' && child?.props?.['data-citation']) {
      return child.props['data-citation']
    }

    // 递归查找更深层次
    if (typeof child === 'object' && child?.props?.children) {
      const found = findCitationInChildren(child.props.children)
      if (found) return found
    }
  }

  return ''
}

// 检查是否包含潜在的 LaTeX 模式
const containsLatexRegex = /\\\(.*?\\\)|\\\[.*?\\\]/s

/**
 * 转换 LaTeX 公式括号 `\[\]` 和 `\(\)` 为 Markdown 格式 `$$...$$` 和 `$...$`
 *
 * remark-math 本身不支持 LaTeX 原生语法，作为替代的一些插件效果也不理想。
 *
 * 目前的实现：
 * - 保护代码块和链接，避免被 remark-math 处理
 * - 支持嵌套括号的平衡匹配
 * - 转义括号 `\\(\\)` 或 `\\[\\]` 不会被处理
 *
 * @see https://github.com/remarkjs/remark-math/issues/39
 * @param text 输入的 Markdown 文本
 * @returns 处理后的字符串
 */
export const processLatexBrackets = (text: string) => {
  // 没有 LaTeX 模式直接返回
  if (!containsLatexRegex.test(text)) {
    return text
  }

  // 保护代码块和链接
  const protectedItems: string[] = []
  let processedContent = text

  processedContent = processedContent
    // 保护代码块（包括多行代码块和行内代码）
    .replace(/(```[\s\S]*?```|`[^`]*`)/g, (match) => {
      const index = protectedItems.length
      protectedItems.push(match)
      return `__CHERRY_STUDIO_PROTECTED_${index}__`
    })
    // 保护链接 [text](url)
    .replace(/\[([^[\]]*(?:\[[^\]]*\][^[\]]*)*)\]\([^)]*?\)/g, (match) => {
      const index = protectedItems.length
      protectedItems.push(match)
      return `__CHERRY_STUDIO_PROTECTED_${index}__`
    })

  // LaTeX 括号转换函数：块级多行输出独立成行的 $$，单行语义不变
  const processMath = (content: string, openDelim: string, closeDelim: string, wrapper: string): string => {
    let result = ''
    let remaining = content

    while (remaining.length > 0) {
      const match = findLatexMatch(remaining, openDelim, closeDelim)
      if (!match) {
        result += remaining
        break
      }

      result += match.pre
      if (wrapper === '$$' && match.body.includes('\n')) {
        const body = match.body
        const prefix = /^[ \t]*\n/.test(body) ? '' : '\n'
        const suffix = /\n[ \t]*$/.test(body) ? '' : '\n'
        result += `${wrapper}${prefix}${body}${suffix}${wrapper}`
      } else {
        result += `${wrapper}${match.body}${wrapper}`
      }
      remaining = match.post
    }

    return result
  }

  // 先处理块级公式，再处理内联公式
  let result = processMath(processedContent, '\\[', '\\]', '$$')
  result = processMath(result, '\\(', '\\)', '$')

  // 还原被保护的内容
  result = result.replace(/__CHERRY_STUDIO_PROTECTED_(\d+)__/g, (match, indexStr) => {
    const index = parseInt(indexStr, 10)
    // 添加边界检查，防止数组越界
    if (index >= 0 && index < protectedItems.length) {
      return protectedItems[index]
    }
    // 如果索引无效，保持原始匹配
    return match
  })

  return result
}

/**
 * 查找 LaTeX 数学公式的匹配括号对
 *
 * 使用平衡括号算法处理嵌套结构，正确识别转义字符
 *
 * @param text 要搜索的文本
 * @param openDelim 开始分隔符 (如 '\[' 或 '\(')
 * @param closeDelim 结束分隔符 (如 '\]' 或 '\)')
 * @returns 匹配结果对象或 null
 */
const findLatexMatch = (text: string, openDelim: string, closeDelim: string) => {
  // 统计连续反斜杠：奇数个表示转义，偶数个表示未转义
  const escaped = (i: number) => {
    let count = 0
    while (--i >= 0 && text[i] === '\\') count++
    return count & 1
  }

  // 查找第一个有效的开始标记
  for (let i = 0, n = text.length; i <= n - openDelim.length; i++) {
    // 没有找到开始分隔符或被转义，跳过
    if (!text.startsWith(openDelim, i) || escaped(i)) continue

    // 处理嵌套结构
    for (let j = i + openDelim.length, depth = 1; j <= n - closeDelim.length && depth; j++) {
      // 计算当前位置对深度的影响：+1(开始), -1(结束), 0(无关)
      const delta =
        text.startsWith(openDelim, j) && !escaped(j) ? 1 : text.startsWith(closeDelim, j) && !escaped(j) ? -1 : 0

      if (delta) {
        depth += delta

        // 找到了匹配的结束位置
        if (!depth)
          return {
            start: i,
            end: j + closeDelim.length,
            pre: text.slice(0, i),
            body: text.slice(i + openDelim.length, j),
            post: text.slice(j + closeDelim.length)
          }

        // 跳过已处理的分隔符字符，避免重复检查
        j += (delta > 0 ? openDelim : closeDelim).length - 1
      }
    }
  }

  return null
}

/**
 * 将多行 `$$` 块公式吸附在公式内容上的开启/闭合 `$$` 拆到独立一行。
 *
 * 背景：remark-math 的块级公式要求开启与闭合 `$$` 各自独立成行
 * （或至少与公式体分行）。当上游文本把 `$$` 直接吸附在公式体之后
 * （如 `$$\begin{aligned}` 开启吸附、`\end{aligned}$$` 闭合吸附），
 * remark-math 会把 `\begin` 误判为 math 元数据、把闭合 `$$` 及后续正文
 * 都误判为未闭合 math 节点的一部分，rehype-katex 再把整段包进红色
 * `span.katex-error`，表现为公式源码与后续 `**加粗**` 正文一起变红。
 *
 * 本函数只做呈现层换行归一化，不改写数学内容、不做补全猜测：
 * - 只处理“真实配对”的分隔符：按顺序配对非转义、非代码内的 `$$`，
 *   落单（流式未完成/真正未闭合）的 opener 保持原样，绝不主动闭合；
 * - 只处理多行块：open 与 close 不在同一行；
 * - opener 须为独立成行（行内仅有 `$$`，≤3 空格、无制表符）或明确的
 *   LaTeX 环境吸附开启（`$$` 后仅允许空格/制表符再接通用
 *   `\begin{env}`，不限定具体环境名；任意其他后缀视为可能的
 *   remark-math 元数据一律不动）。前缀带正文的行内 `$$`
 *   与四空格/制表符缩进代码一律不动；
 * - closer 须为独立成行（已界定，无需拆分）或吸附且行尾仅有空白、
 *   且所在行唯一的 `$$`；同行尾随正文（如 `bar$$ baz`）不猜测；
 * - 单行 `$$x$$`、已独立成行的 `$$`、行内单个 `$`、美元金额、
 *   转义 `\$`、围栏/行内代码（含 ```math）一律不动；
 * - 不校验公式合法性：显式闭合但内容非法（如未知命令）的公式
 *   仍会报 KaTeX 错误，只是错误被收敛在公式范围内，后续正文不受影响。
 *
 * @param text 输入的 Markdown 文本
 * @returns 换行归一化后的字符串（无命中时原样返回）
 */
export function normalizeAttachedBlockMathClose(text: string): string {
  if (!text || !text.includes('$$')) {
    return text
  }

  const lines = text.split('\n')

  // ---- 围栏代码块行标记（含 ```math）：这些行整体跳过 ----
  const fencedLine = new Array<boolean>(lines.length).fill(false)
  let fence: { char: string; len: number } | null = null
  const parseFence = (line: string): { char: string; len: number } | null => {
    let indent = 0
    while (indent < line.length && line[indent] === ' ') indent += 1
    if (indent > 3 || indent >= line.length) return null
    const ch = line[indent]
    if (ch !== '`' && ch !== '~') return null
    let len = 0
    let p = indent
    while (p < line.length && line[p] === ch) {
      len += 1
      p += 1
    }
    if (len < 3) return null
    if (ch === '`' && line.slice(p).includes('`')) return null
    return { char: ch, len }
  }
  const isClosingFence = (line: string, char: string, len: number): boolean => {
    let indent = 0
    while (indent < line.length && line[indent] === ' ') indent += 1
    if (indent > 3 || indent >= line.length) return false
    if (line[indent] !== char) return false
    let n = 0
    let p = indent
    while (p < line.length && line[p] === char) {
      n += 1
      p += 1
    }
    return n >= len && line.slice(p).trim() === ''
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (fence) {
      fencedLine[i] = true
      if (isClosingFence(line, fence.char, fence.len)) fence = null
      continue
    }
    const opening = parseFence(line)
    if (opening) {
      fencedLine[i] = true
      fence = opening
    }
  }

  // ---- 行内代码区间（等长反引号配对，与 containsMath 同策略） ----
  const inlineCodeRanges = (line: string): Array<[number, number]> => {
    const ranges: Array<[number, number]> = []
    const len = line.length
    let i = 0
    while (i < len) {
      if (line[i] !== '`') {
        i += 1
        continue
      }
      let j = i
      while (j < len && line[j] === '`') j += 1
      const openLen = j - i
      let found = -1
      let k = j
      while (k < len) {
        if (line[k] !== '`') {
          k += 1
          continue
        }
        let q = k
        while (q < len && line[q] === '`') q += 1
        if (q - k === openLen) {
          found = k
          break
        }
        k = q
      }
      if (found !== -1) {
        ranges.push([i, found + openLen])
        i = found + openLen
      } else {
        i = j
      }
    }
    return ranges
  }
  const inRanges = (ranges: Array<[number, number]>, index: number, width = 2): boolean =>
    ranges.some(([s, e]) => index >= s && index + width <= e)

  const backslashCountBefore = (line: string, index: number): number => {
    let count = 0
    let p = index - 1
    while (p >= 0 && line[p] === '\\') {
      count += 1
      p -= 1
    }
    return count
  }

  interface Delim {
    line: number
    col: number
  }
  const delims: Delim[] = []
  for (let li = 0; li < lines.length; li++) {
    if (fencedLine[li]) continue
    const line = lines[li]
    const ranges = inlineCodeRanges(line)
    let c = 0
    while (c < line.length - 1) {
      if (line[c] === '$' && line[c + 1] === '$' && !inRanges(ranges, c)) {
        if (backslashCountBefore(line, c) % 2 === 0) {
          delims.push({ line: li, col: c })
          c += 2
          continue
        }
      }
      c += 1
    }
  }

  const countDelimsOnLine = (line: string): number => {
    const ranges = inlineCodeRanges(line)
    let occurrences = 0
    let c = 0
    while (c < line.length - 1) {
      if (line[c] === '$' && line[c + 1] === '$' && !inRanges(ranges, c)) {
        if (backslashCountBefore(line, c) % 2 === 0) {
          occurrences += 1
          c += 2
          continue
        }
      }
      c += 1
    }
    return occurrences
  }
  // 通用 LaTeX 环境开启：$$ 后仅允许空格/制表符再接 \begin{env}（不限环境名）。
  const LATEX_ENV_OPEN_RE = /^[ \t]*\\begin\{[A-Za-z][A-Za-z0-9]*\*?\}/

  // 顺序配对：奇数落单的 opener（流式未完成）保持原样
  const closeSplits = new Map<number, number[]>()
  const openSplits = new Map<number, number>()
  for (let d = 0; d + 1 < delims.length; d += 2) {
    const open = delims[d]
    const close = delims[d + 1]
    if (open.line === close.line) continue
    const openLine = lines[open.line]
    const closeLine = lines[close.line]
    // opener 前缀仅允许空白（≤3 空格、无制表符）。前缀带正文
    // （如 mock 回显 `[Mock ...] "$$`）属于行内公式语义，
    // 四空格/制表符缩进属于缩进代码块，一律不动。
    const openPrefix = openLine.slice(0, open.col)
    if (openPrefix.trim() !== '') continue
    if (openPrefix.includes('\t') || openPrefix.length >= 4) continue
    const openSuffix = openLine.slice(open.col + 2)
    let openKind: 'standalone' | 'attachedEnv' | null = null
    if (openSuffix.trim() === '') {
      openKind = 'standalone'
    } else if (LATEX_ENV_OPEN_RE.test(openSuffix)) {
      // 明确数学吸附开启：通用 \begin{ANY} 机制，不特判 aligned。
      // 任意其他后缀视为可能的 remark-math 元数据，不重解释。
      if (countDelimsOnLine(openLine) !== 1) continue
      openKind = 'attachedEnv'
    } else {
      continue
    }
    // closer 所在整行是缩进代码块时不动（四空格/制表符开头）。
    if (closeLine.startsWith('    ') || closeLine.startsWith('\t')) continue
    const closePrefix = closeLine.slice(0, close.col)
    const closeSuffix = closeLine.slice(close.col + 2)
    let closeKind: 'standalone' | 'attached' | null = null
    if (closePrefix.trim() === '' && closeSuffix.trim() === '') {
      closeKind = 'standalone'
    } else if (closePrefix.trim() !== '' && closeSuffix.trim() === '') {
      // closer 必须是所在行唯一的 $$：行内另有 $$ 时不猜测分隔语义
      if (countDelimsOnLine(closeLine) !== 1) continue
      closeKind = 'attached'
    } else {
      // close 同行尾随正文（如 bar$$ baz）不猜测；前缀空白但后缀非空
      // 的独立 $$ 行亦视为已界定之外的未知形态，保持原样。
      continue
    }
    if (openKind === 'standalone' && closeKind === 'standalone') continue
    if (openKind === 'standalone' && closeKind === 'attached') {
      let cols = closeSplits.get(close.line)
      if (!cols) {
        cols = []
        closeSplits.set(close.line, cols)
      }
      cols.push(close.col)
    } else if (openKind === 'attachedEnv' && closeKind === 'standalone') {
      if (!openSplits.has(open.line)) openSplits.set(open.line, open.col)
    } else if (openKind === 'attachedEnv' && closeKind === 'attached') {
      if (!openSplits.has(open.line)) openSplits.set(open.line, open.col)
      let cols = closeSplits.get(close.line)
      if (!cols) {
        cols = []
        closeSplits.set(close.line, cols)
      }
      cols.push(close.col)
    }
  }

  if (closeSplits.size === 0 && openSplits.size === 0) return text

  const next = lines.slice()
  for (const [li, col] of openSplits) {
    const line = next[li]
    const prefix = line.slice(0, col)
    const suffix = line.slice(col + 2)
    const body = suffix.replace(/^[ \t]*/, '')
    next[li] = `${prefix}$$\n${body}`
  }
  for (const [li, cols] of closeSplits) {
    // 同一行多个命中时只拆行尾最后一个，避免猜测中间分隔
    const col = Math.max(...cols)
    const line = next[li]
    next[li] = `${line.slice(0, col)}\n${line.slice(col)}`
  }
  return next.join('\n')
}

/**
 * 移除 Markdown 文本中每行末尾的两个空格。
 * @param {string} markdown 输入的 Markdown 文本
 * @returns {string} 处理后的文本
 */
export function removeTrailingDoubleSpaces(markdown: string): string {
  // 使用正则表达式匹配末尾的两个空格，并替换为空字符串
  return markdown.replace(/ {2}$/gm, '')
}

/**
 * 根据代码块节点的起始位置生成 ID
 * @param start 代码块节点的起始位置
 * @returns 代码块在 Markdown 字符串中的 ID
 */
export function getCodeBlockId(start?: Point): string | null {
  return start ? `${start.line}:${start.column}:${start.offset}` : null
}

/**
 * 更新Markdown字符串中的代码块内容。
 *
 * 由于使用了remark-stringify，所以会有一些默认格式化操作，例如：
 * - 代码块前后会补充换行符。
 * - 有些空格会被trimmed。
 * - 文档末尾会补充一个换行符。
 *
 * @param raw 原始Markdown字符串
 * @param id 代码块ID，按位置生成
 * @param newContent 修改后的代码内容
 * @returns 替换后的Markdown字符串
 */
export function updateCodeBlock(raw: string, id: string, newContent: string): string {
  const tree = unified().use(remarkParse).parse(raw)
  visit(tree, 'code', (node) => {
    const startIndex = getCodeBlockId(node.position?.start)
    if (startIndex && id && startIndex === id) {
      node.value = newContent
    }
  })

  return unified().use(remarkStringify).stringify(tree)
}

/**
 * 检查代码块是否包含 open fence。
 * 限制：
 * - 语言名不能包含空格，因为 remark-math 无法处理，会导致 end.offset 过长。
 *
 * 这个算法基于 remark/micromark 解析代码块的原理，所有参数实际上都可以从 node 中获取。
 * 一个代码块的 node.position 包含 fences，而 children 不包含 fences，通过它们之间的
 * 差值就可以判断有没有 closed fence。
 *
 * @param codeLength 代码长度（不包含语言信息）
 * @param metaLength 元数据长度（```之后的语言信息）
 * @param position 位置（unist 节点位置）
 * @returns 是否为 open fence 代码块
 */
export function isOpenFenceBlock(codeLength?: number, metaLength?: number, position?: Position): boolean {
  const contentLength = (codeLength ?? 0) + (metaLength ?? 0)
  const start = position?.start?.offset ?? 0
  const end = position?.end?.offset ?? 0
  // 余量至少是 fence (3) + newlines (2)
  return end - start <= contentLength + 5
}

/**
 * 检查代码是否具有HTML特征
 * @param code 输入的代码字符串
 * @returns 是HTML代码 true，否则 false
 */
export function isHtmlCode(code: string | null): boolean {
  if (!code || !code.trim()) {
    return false
  }

  const trimmedCode = code.trim().toLowerCase()

  // 1. 检查是否包含完整的HTML文档结构
  if (
    trimmedCode.includes('<!doctype html>') ||
    trimmedCode.includes('<html') ||
    trimmedCode.includes('</html>') ||
    trimmedCode.includes('<head') ||
    trimmedCode.includes('</head>') ||
    trimmedCode.includes('<body') ||
    trimmedCode.includes('</body>')
  ) {
    return true
  }

  // 2. 检查是否包含常见的HTML/SVG标签
  const commonTags = [
    '<div',
    '<span',
    '<p',
    '<a',
    '<img',
    '<svg',
    '<table',
    '<ul',
    '<ol',
    '<section',
    '<header',
    '<footer',
    '<nav',
    '<article',
    '<button',
    '<form',
    '<input'
  ]
  if (commonTags.some((tag) => trimmedCode.includes(tag))) {
    return true
  }

  // 3. 检查是否存在至少一个闭合的HTML标签
  // 这个正则表达式查找 <tag>...</tag> 或 <tag .../> 结构
  const pairedTagPattern = /<([a-z0-9]+)([^>]*?)>(.*?)<\/\1>|<([a-z0-9]+)([^>]*?)\/>/
  if (pairedTagPattern.test(trimmedCode)) {
    return true
  }

  return false
}

/**
 * 将 Markdown 字符串转换为纯文本。
 * @param markdown Markdown 字符串。
 * @returns 纯文本字符串。
 */
export const markdownToPlainText = (markdown: string): string => {
  if (!markdown) {
    return ''
  }
  // 直接用 remove-markdown 库，使用默认的 removeMarkdown 参数
  return removeMarkdown(markdown)
}

/**
 * 清理 Markdown 中的 base64 图片链接
 *
 * 将 Markdown 中的 base64 格式图片链接替换为普通链接格式。
 *
 * @param {string} markdown - 包含图片链接的 Markdown 文本
 * @returns {string} 处理后的 Markdown 文本，所有 base64 图片链接都被替换为普通链接
 * @example
 * - 输入: `![image](data:image/png;base64,iVBORw0...)`
 * - 输出: `![image](image_url)`
 */
export const purifyMarkdownImages = (markdown: string): string => {
  return markdown.replace(
    /(!\[[^\]]*\]\()\s*data:image\/[\w+.-]+;base64\s*,[\w+/=]+(?:\s*[\w+/=]+)*\s*\)/gi,
    '$1image_url)'
  )
}
