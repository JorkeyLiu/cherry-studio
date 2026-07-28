/**
 * SearchRepository — FTS5-accelerated search over message_blocks_normalized.
 *
 * LOCK-5125: FTS is a candidate accelerator, not semantic authority.
 * Every result must pass the shared exact regex matcher.
 *
 * LOCK-5122: Preserves current search semantics:
 * - Markdown stripping + CRLF normalization
 * - Quoted/whitespace term parsing
 * - Case-insensitive AND
 * - Unicode whole-word mode
 * - CJK substring mode
 * - MAIN_TEXT blocks only
 * - Raw content for snippet generation
 * - createdAt sort and message-ID tie-break
 *
 * LOCK-5128: Search result contract is minimal JSON-safe data.
 */

import type { SearchMessagesRequest, SearchMessagesResponse, SearchResultItem } from '@shared/chatDb'
import type Database from 'better-sqlite3'

import { ChatDbValidationError } from '../errors'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PAGE_SIZE = 100
const DEFAULT_PAGE_SIZE = 20

// ---------------------------------------------------------------------------
// FTS5 term escaping
// ---------------------------------------------------------------------------

/**
 * Escape a term for safe use in FTS5 MATCH queries.
 * Wraps in double quotes to treat as a literal string — required for terms
 * containing FTS5 query metacharacters (\, %, :, *, parens, operators).
 * Doubles any existing double quotes inside the term.
 * Verified: quoted strings work correctly with the trigram tokenizer for
 * substring candidate generation.
 */
function escapeFtsTerm(term: string): string {
  const escaped = term.replace(/"/g, '""')
  return `"${escaped}"`
}

/**
 * Escape a term for use in LIKE queries.
 * Escapes \, %, and _ which are LIKE wildcards.
 * Uses backslash as the LIKE escape character.
 */
function escapeLikeTerm(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/**
 * Build a FTS5-safe MATCH input from parsed search terms.
 * Each term is used as a plain token query (trigram-compatible).
 * Joined with AND for multi-term intersection semantics.
 */
function buildFtsMatchInput(terms: string[]): string {
  return terms.map(escapeFtsTerm).join(' AND ')
}

// ---------------------------------------------------------------------------
// SearchRepository
// ---------------------------------------------------------------------------

export class SearchRepository {
  constructor(private sqlite: Database.Database) {}

  /**
   * Execute a search query against the FTS5 normalized projection.
   *
   * Strategy (LOCK-5125):
   * 1. Parse keywords into terms.
   * 2. For each term:
   *    - If term length >= 3: use FTS5 trigram as candidate generator.
   *    - If term length < 3: use normalized SQL LIKE as candidate generator.
   * 3. Intersect all term candidate sets (AND semantics).
   * 4. Apply exact regex matcher on normalized content for final filtering.
   * 5. Join with messages/topics for metadata.
   * 6. Sort and paginate.
   */
  search(request: SearchMessagesRequest): SearchMessagesResponse {
    const { keywords, matchMode, sortOrder } = request
    const pageSize = Math.min(Math.max(request.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)

    // Parse keywords into terms
    const terms = this.parseKeywords(keywords)
    if (terms.length === 0) {
      return { items: [], hasMore: false, totalCount: 0 }
    }

    // Decode cursor for pagination — malformed cursor throws validation error
    let cursor: { createdAt: string; messageId: string; blockId: string } | null = null
    if (request.cursor) {
      cursor = this.decodeCursor(request.cursor)
      if (cursor === null) {
        // LOCK: malformed cursor is a validation error, never a silent reset
        throw new ChatDbValidationError('Malformed cursor: invalid format')
      }
    }

    // Collect candidate block IDs using FTS and/or LIKE
    const candidateBlockIds = this.collectCandidates(terms)

    if (candidateBlockIds.size === 0) {
      return { items: [], hasMore: false, totalCount: 0 }
    }

    // Apply exact regex filtering on normalized content (LOCK-5125)
    const filteredIds = this.applyExactFilter(candidateBlockIds, terms, matchMode)

    if (filteredIds.size === 0) {
      return { items: [], hasMore: false, totalCount: 0 }
    }

    // Fetch full results with joins, sort, and paginate
    return this.fetchResults(filteredIds, sortOrder, pageSize, cursor)
  }

  // -------------------------------------------------------------------------
  // Term parsing (mirrors splitKeywordsToTerms from keywordSearch.ts)
  // -------------------------------------------------------------------------

  private parseKeywords(keywords: string): string[] {
    const input = (keywords || '').trim()
    if (input.length === 0) return []

    const terms: string[] = []
    const pattern = /"([^"]*)"?|'([^']*)'?|(\S+)/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(input)) !== null) {
      const term = (match[1] ?? match[2] ?? match[3]).trim()
      if (term.length > 0) {
        terms.push(term.toLowerCase())
      }
    }
    return terms
  }

  // -------------------------------------------------------------------------
  // Regex building (mirrors buildKeywordRegexes from keywordSearch.ts)
  // -------------------------------------------------------------------------

  private containsCJK(text: string): boolean {
    return /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(text)
  }

  private escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  private buildWholeWordPattern(escapedTerm: string): string {
    if (this.containsCJK(escapedTerm)) {
      return escapedTerm
    }
    return `(?<![\\p{L}\\p{N}])${escapedTerm}(?![\\p{L}\\p{N}])`
  }

  private buildRegexes(terms: string[], matchMode: 'whole-word' | 'substring'): RegExp[] {
    return terms
      .filter((term) => term.length > 0)
      .map((term) => {
        const escaped = this.escapeRegex(term)
        const pattern = matchMode === 'whole-word' ? this.buildWholeWordPattern(escaped) : escaped
        const flags = matchMode === 'whole-word' ? 'iu' : 'i'
        return new RegExp(pattern, flags)
      })
  }

  // -------------------------------------------------------------------------
  // Candidate collection
  // -------------------------------------------------------------------------

  /**
   * Check if a term can be represented by FTS5 trigram.
   * FTS5 trigram requires at least 3 Unicode code points (not UTF-16 units —
   * astral-plane characters count as one code point each).
   */
  private isFtsRepresentable(term: string): boolean {
    // Iterate by Unicode code points (string iterator), not UTF-16 units.
    const codePointIterator = term[Symbol.iterator]()
    let codePoints = 0
    while (!codePointIterator.next().done) {
      if (++codePoints >= 3) return true
    }
    return false
  }

  private collectCandidates(terms: string[]): Set<string> {
    // Strategy (LOCK-5125):
    // - For each term:
    //   - If term has >= 3 Unicode code points (FTS representable): use FTS only
    //   - If term has < 3 Unicode code points: use LIKE only
    // - Intersect all term candidate sets (AND semantics across terms)
    // - Do NOT union LIKE for representable terms
    const termCandidateSets: Set<string>[] = []

    for (const term of terms) {
      let termSet: Set<string>

      if (this.isFtsRepresentable(term)) {
        // FTS5 trigram candidate generation (representable terms only)
        termSet = this.ftsCandidates([term])
      } else {
        // SQL LIKE candidate generation (short terms only)
        termSet = this.likeCandidates(term)
      }

      termCandidateSets.push(termSet)
    }

    if (termCandidateSets.length === 0) {
      return new Set()
    }

    // Intersect all term candidate sets (AND semantics across terms)
    let intersection = termCandidateSets[0]
    for (let i = 1; i < termCandidateSets.length; i++) {
      intersection = new Set([...intersection].filter((id) => termCandidateSets[i].has(id)))
    }

    return intersection
  }

  private ftsCandidates(terms: string[]): Set<string> {
    if (terms.length === 0) return new Set()

    const matchInput = buildFtsMatchInput(terms)

    // LOCK-5125/5101: FTS errors propagate to wrapResult() → mapErrorToResult().
    // Never catch-to-empty: runtime failures surface as structured ChatDbFailure
    // (typically STORAGE_ERROR) instead of silently returning zero results.
    const rows = this.sqlite
      .prepare(
        `SELECT block_id
         FROM message_blocks_fts
         WHERE normalized_content MATCH ?`
      )
      .all(matchInput) as Array<{ block_id: string }>

    return new Set(rows.map((r) => r.block_id))
  }

  private likeCandidates(term: string): Set<string> {
    const escaped = escapeLikeTerm(term)
    const pattern = `%${escaped}%`

    const rows = this.sqlite
      .prepare(`SELECT block_id FROM message_blocks_normalized WHERE normalized_content LIKE ? ESCAPE '\\'`)
      .all(pattern) as Array<{ block_id: string }>

    return new Set(rows.map((r) => r.block_id))
  }

  // -------------------------------------------------------------------------
  // Exact regex filtering (LOCK-5125)
  // -------------------------------------------------------------------------

  private applyExactFilter(
    candidateIds: Set<string>,
    terms: string[],
    matchMode: 'whole-word' | 'substring'
  ): Set<string> {
    if (candidateIds.size === 0) return new Set()

    const regexes = this.buildRegexes(terms, matchMode)
    if (regexes.length === 0) return candidateIds

    const idsArray = Array.from(candidateIds)
    const filtered = new Set<string>()

    // Fetch normalized content for candidates in batches
    for (let i = 0; i < idsArray.length; i += 100) {
      const batch = idsArray.slice(i, i + 100)
      const placeholders = batch.map(() => '?').join(',')
      const rows = this.sqlite
        .prepare(
          `SELECT block_id, normalized_content FROM message_blocks_normalized WHERE block_id IN (${placeholders})`
        )
        .all(...batch) as Array<{ block_id: string; normalized_content: string }>

      for (const row of rows) {
        const content = row.normalized_content
        const allMatch = regexes.every((regex) => {
          regex.lastIndex = 0
          return regex.test(content)
        })
        if (allMatch) {
          filtered.add(row.block_id)
        }
      }
    }

    return filtered
  }

  // -------------------------------------------------------------------------
  // Result fetching with joins, sort, and pagination
  // -------------------------------------------------------------------------

  private fetchResults(
    blockIds: Set<string>,
    sortOrder: 'newest' | 'oldest',
    pageSize: number,
    cursor: { createdAt: string; messageId: string; blockId: string } | null
  ): SearchMessagesResponse {
    const idsArray = Array.from(blockIds)
    if (idsArray.length === 0) {
      return { items: [], hasMore: false, totalCount: 0 }
    }

    const sortDir = sortOrder === 'newest' ? 'DESC' : 'ASC'

    // Build the base query with joins
    const baseQuery = `
      SELECT
        nb.block_id,
        nb.message_id,
        m.topic_id,
        t.name AS topic_name,
        mb.content AS raw_content,
        m.created_at AS message_created_at
      FROM message_blocks_normalized nb
      INNER JOIN message_blocks mb ON nb.block_id = mb.id
      INNER JOIN messages m ON nb.message_id = m.id
      INNER JOIN topics t ON m.topic_id = t.id
      WHERE nb.block_id IN (${idsArray.map(() => '?').join(',')})
    `

    let rows: Array<{
      block_id: string
      message_id: string
      topic_id: string
      topic_name: string | null
      raw_content: string
      message_created_at: string | null
    }>

    if (cursor) {
      // Three-level cursor: messageCreatedAt → messageId → blockId
      // Ensures complete block-level pagination within same message
      const cursorCondition =
        sortOrder === 'newest'
          ? `(m.created_at < ?) OR (m.created_at = ? AND m.id < ?) OR (m.created_at = ? AND m.id = ? AND nb.block_id < ?)`
          : `(m.created_at > ?) OR (m.created_at = ? AND m.id > ?) OR (m.created_at = ? AND m.id = ? AND nb.block_id > ?)`

      const query = `${baseQuery} AND ${cursorCondition} ORDER BY m.created_at ${sortDir}, m.id ${sortDir}, nb.block_id ${sortDir} LIMIT ?`
      rows = this.sqlite
        .prepare(query)
        .all(
          ...idsArray,
          cursor.createdAt,
          cursor.createdAt,
          cursor.messageId,
          cursor.createdAt,
          cursor.messageId,
          cursor.blockId,
          pageSize + 1
        ) as any[]
    } else {
      const query = `${baseQuery} ORDER BY m.created_at ${sortDir}, m.id ${sortDir}, nb.block_id ${sortDir} LIMIT ?`
      rows = this.sqlite.prepare(query).all(...idsArray, pageSize + 1) as any[]
    }

    const hasMore = rows.length > pageSize
    if (hasMore) {
      rows = rows.slice(0, pageSize)
    }

    const items: SearchResultItem[] = rows.map((row) => ({
      blockId: row.block_id,
      messageId: row.message_id,
      topicId: row.topic_id,
      topicName: row.topic_name,
      rawContent: row.raw_content,
      messageCreatedAt: row.message_created_at
    }))

    // Build next cursor from last item (includes blockId for complete pagination)
    let nextCursor: string | undefined
    if (hasMore && items.length > 0) {
      const last = items[items.length - 1]
      nextCursor = this.encodeCursor(last.messageCreatedAt ?? '', last.messageId, last.blockId)
    }

    return {
      items,
      nextCursor,
      hasMore,
      totalCount: blockIds.size
    }
  }

  // -------------------------------------------------------------------------
  // Cursor encoding/decoding
  // -------------------------------------------------------------------------

  private encodeCursor(createdAt: string, messageId: string, blockId: string): string {
    const data = `${createdAt}\t${messageId}\t${blockId}`
    return Buffer.from(data, 'utf-8').toString('base64url')
  }

  private decodeCursor(cursor: string): { createdAt: string; messageId: string; blockId: string } | null {
    try {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf-8')
      const parts = decoded.split('\t', 3)
      if (parts.length !== 3 || parts[0] === undefined || parts[1] === undefined || parts[2] === undefined) {
        return null
      }
      return { createdAt: parts[0], messageId: parts[1], blockId: parts[2] }
    } catch {
      return null
    }
  }
}
