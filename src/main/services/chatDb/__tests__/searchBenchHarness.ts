/**
 * Shared search parity harness — corpus generation, query fixtures, and the
 * normalized LIKE full-scan baseline used both by:
 * - search.test.ts (normal suite: small deterministic corpus parity)
 * - search.bench.ts (benchmark suite: 10k corpus parity + timing, LOCK-5129)
 *
 * This file is intentionally NOT a *.test.ts / *.bench.ts file so it is never
 * collected directly by Vitest.
 */

import type Database from 'better-sqlite3'

import type { SearchRepository } from '../repository/SearchRepository'

// ---------------------------------------------------------------------------
// Corpus content
// ---------------------------------------------------------------------------

export const ASCII_CORPUS = [
  'The quick brown fox jumps over the lazy dog',
  'Machine learning is transforming how we solve complex problems',
  'JavaScript developers love using TypeScript for type safety',
  'The weather today is sunny with a chance of rain later',
  'Electric vehicles are becoming more affordable each year',
  'Quantum computing promises to revolutionize cryptography',
  'The stock market showed strong gains this quarter',
  'Climate change poses significant challenges for agriculture',
  'Artificial intelligence can help diagnose medical conditions',
  'The library contains thousands of books on various subjects'
]

export const CJK_CORPUS = [
  '人工智能正在改变我们的生活方式',
  '机器学习是当前最热门的技术领域之一',
  '量子计算将彻底改变密码学',
  '气候变化对全球农业构成重大挑战',
  '电动汽车正变得越来越普及',
  '今天天气晴朗下午可能有雨',
  '股票市场本季度表现强劲',
  '图书馆里有成千上万本各种学科的书籍',
  'JavaScript开发者喜欢使用TypeScript',
  '深度学习在图像识别方面取得了突破'
]

export const MARKDOWN_CORPUS = [
  '## Introduction to Machine Learning\n\nMachine learning is a subset of **artificial intelligence**...',
  '```javascript\nfunction fibonacci(n) {\n  if (n <= 1) return n;\n  return fibonacci(n-1) + fibonacci(n-2);\n}\n```',
  '![Diagram](https://example.com/diagram.png) showing the architecture',
  '### Key Points\n- Point one\n- Point two\n- Point three',
  '*Italic text* and **bold text** and `inline code`',
  '[Link to documentation](https://docs.example.com) for more info',
  '# Chapter 1: Getting Started\n\nWelcome to this tutorial...',
  '```python\ndef train_model(data):\n    model = Model()\n    model.fit(data)\n    return model\n```',
  'The **quick** brown *fox* jumps over the `lazy` dog',
  '## API Reference\n\n### Methods\n\n`GET /api/users` - List all users'
]

export const MIXED_CORPUS = [
  'Hello world 你好世界 안녕하세요 こんにちは',
  'The function calculateSum(a, b) returns a + b',
  'Error: Cannot read property "map" of undefined',
  'SELECT * FROM users WHERE age > 18 ORDER BY name',
  'npm install react react-dom typescript @types/react',
  'const config = { port: 3000, host: "localhost" }',
  'git commit -m "feat: add new search functionality"',
  'docker run -d -p 8080:80 nginx:latest',
  'curl -X POST https://api.example.com/data -H "Content-Type: application/json"',
  'The quick brown fox jumps over 123 lazy dogs'
]

export const ALL_CORPUS = [...ASCII_CORPUS, ...CJK_CORPUS, ...MARKDOWN_CORPUS, ...MIXED_CORPUS]

/**
 * Deterministic corpus generation: `count` MAIN_TEXT blocks cycling through
 * ASCII/CJK/markdown/mixed content with monotonically increasing timestamps.
 */
export function generateCorpus(sqlite: Database.Database, count: number): void {
  sqlite.exec(
    `INSERT INTO topics (id, name, created_at) VALUES ('bench-topic', 'Benchmark', '2026-01-01T00:00:00.000Z')`
  )

  const insertMsg = sqlite.prepare(
    `INSERT INTO messages (id, topic_id, role, content, created_at, sort_order) VALUES (?, 'bench-topic', 'user', ?, ?, ?)`
  )
  const insertBlock = sqlite.prepare(
    `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES (?, ?, 'main_text', ?, ?)`
  )

  const insertMany = sqlite.transaction(() => {
    for (let i = 0; i < count; i++) {
      const msgId = `msg-${i}`
      const content = ALL_CORPUS[i % ALL_CORPUS.length]
      const dateStr = `2026-01-01T${String(Math.floor(i / 3600) % 24).padStart(2, '0')}:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`
      insertMsg.run(msgId, `Message ${i}`, dateStr, i)
      insertBlock.run(`blk-${i}`, msgId, content, 0)
    }
  })

  insertMany()
}

// ---------------------------------------------------------------------------
// Query fixtures
// ---------------------------------------------------------------------------

export interface QueryFixture {
  name: string
  keywords: string
  matchMode: 'whole-word' | 'substring'
}

export const QUERY_FIXTURES: QueryFixture[] = [
  { name: 'simple-ascii', keywords: 'machine learning', matchMode: 'substring' },
  { name: 'single-word', keywords: 'javascript', matchMode: 'whole-word' },
  { name: 'cjk-substring', keywords: '人工', matchMode: 'substring' },
  { name: 'cjk-full', keywords: '人工智能', matchMode: 'substring' },
  { name: 'mixed-terms', keywords: 'hello world', matchMode: 'substring' },
  { name: 'technical', keywords: 'function', matchMode: 'whole-word' },
  { name: 'quoted-phrase', keywords: '"quick brown fox"', matchMode: 'substring' },
  { name: 'multi-term-and', keywords: 'type error', matchMode: 'substring' },
  { name: 'short-term', keywords: 'ai', matchMode: 'substring' },
  { name: 'rare-term', keywords: 'quantum', matchMode: 'substring' }
]

// ---------------------------------------------------------------------------
// Normalized LIKE full-scan baseline
// ---------------------------------------------------------------------------

function containsCJK(text: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(text)
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildWholeWordPattern(escapedTerm: string): string {
  if (containsCJK(escapedTerm)) {
    return escapedTerm
  }
  return `(?<![\\p{L}\\p{N}])${escapedTerm}(?![\\p{L}\\p{N}])`
}

export interface BaselineResult {
  block_id: string
  message_created_at: string
  message_id: string
}

/**
 * Semantic baseline: full scan of message_blocks_normalized with the same
 * term parsing and exact regex filter as SearchRepository, ordered in the
 * production order (messageCreatedAt DESC, messageId DESC, blockId DESC).
 */
export function likeSearch(
  sqlite: Database.Database,
  keywords: string,
  matchMode: 'whole-word' | 'substring'
): BaselineResult[] {
  const input = (keywords || '').trim()
  if (input.length === 0) return []

  // Parse terms (mirrors SearchRepository.parseKeywords)
  const terms: string[] = []
  const pattern = /"([^"]*)"?|'([^']*)'?|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(input)) !== null) {
    const term = (match[1] ?? match[2] ?? match[3]).trim()
    if (term.length > 0) terms.push(term.toLowerCase())
  }
  if (terms.length === 0) return []

  // Build regex for exact filtering (mirrors SearchRepository.buildRegexes)
  const regexes = terms
    .filter((term) => term.length > 0)
    .map((term) => {
      const escaped = escapeRegex(term)
      const regexPattern = matchMode === 'whole-word' ? buildWholeWordPattern(escaped) : escaped
      const flags = matchMode === 'whole-word' ? 'iu' : 'i'
      return new RegExp(regexPattern, flags)
    })

  // Scan ALL blocks via normalized content, join with messages for sort columns.
  const allBlocks = sqlite
    .prepare(
      `SELECT nb.block_id, nb.normalized_content, m.created_at AS message_created_at, m.id AS message_id
       FROM message_blocks_normalized nb
       INNER JOIN messages m ON nb.message_id = m.id
       WHERE nb.normalized_content IS NOT NULL`
    )
    .all() as Array<BaselineResult & { normalized_content: string }>

  const matched: BaselineResult[] = []
  for (const block of allBlocks) {
    const allMatch = regexes.every((regex) => {
      regex.lastIndex = 0
      return regex.test(block.normalized_content)
    })
    if (allMatch) {
      matched.push(block)
    }
  }

  // Production order: (messageCreatedAt DESC, messageId DESC, blockId DESC)
  // Matches SearchRepository.fetchResults ORDER BY m.created_at DESC, m.id DESC, nb.block_id DESC
  matched.sort((a, b) => {
    const dateCmp = b.message_created_at.localeCompare(a.message_created_at)
    if (dateCmp !== 0) return dateCmp
    const msgCmp = b.message_id.localeCompare(a.message_id)
    if (msgCmp !== 0) return msgCmp
    return b.block_id.localeCompare(a.block_id)
  })

  return matched
}

/**
 * Drain ALL pages of the hybrid path via cursor pagination.
 * pageSize is clamped to 100 in SearchRepository, so complete result
 * comparison requires walking every page.
 */
export function hybridSearchAll(
  searchRepo: SearchRepository,
  keywords: string,
  matchMode: 'whole-word' | 'substring',
  pageSize = 100
): string[] {
  const blockIds: string[] = []
  let cursor: string | undefined
  let guard = 0
  for (;;) {
    const page = searchRepo.search({
      keywords,
      matchMode,
      sortOrder: 'newest',
      pageSize,
      cursor
    })
    blockIds.push(...page.items.map((i) => i.blockId))
    if (!page.hasMore || !page.nextCursor) break
    cursor = page.nextCursor
    if (++guard > 500) throw new Error('Pagination did not terminate — possible cursor loop')
  }
  return blockIds
}
