/**
 * Exact FTS↔normalized multiset row comparator (LOCK-SP-2/3).
 *
 * The search-projection parity check compares two multisets of projection
 * rows `(block_id, normalized_content)`. A row key is the injective,
 * self-delimiting tuple
 *
 *   (length(block_id), block_id, length(normalized_content), normalized_content)
 *
 * Two rows are equal iff every component is byte-equal, which preserves
 * duplicate multiplicity and NUL bytes and can never conflate distinct
 * tuples (e.g. ("ab","c") vs ("a","bc")). This module provides the pure
 * comparison functions only — no database access.
 *
 * Ordering contract: both source streams are produced by SQLite ordered by
 * `block_id, normalized_content` under SQLite's BINARY collation. SQLite's
 * BINARY collation compares the UTF-8 byte representations with memcmp and
 * breaks ties by length (a string that is a byte-prefix sorts first). This
 * is NOT the same as JavaScript string `<` (UTF-16 code-unit order) for
 * supplementary-plane characters, so the JS comparator must replicate the
 * UTF-8 byte order exactly — otherwise the ordered merge would miscompare.
 * {@link compareTextBinary} implements exactly that collation.
 *
 * Main-only module. Not exposed over IPC/preload/renderer.
 */

/** One projection row as produced by the normalized/FTS cursors. */
export interface ProjectionRow {
  readonly rowid: number
  readonly block_id: string
  readonly normalized_content: string
}

/** Row key used for equality: the two content-bearing fields only. */
export interface ProjectionRowKey {
  readonly block_id: string
  readonly normalized_content: string
}

/**
 * SQLite BINARY collation equivalent over two JS strings: compare the UTF-8
 * byte representations (memcmp semantics, shorter-first on a byte prefix).
 * Returns a negative number when `a` sorts before `b`, 0 when byte-equal,
 * and a positive number otherwise. Handles NUL bytes and
 * supplementary-plane characters exactly like SQLite.
 */
export function compareTextBinary(a: string, b: string): number {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  const n = Math.min(ab.length, bb.length)
  for (let i = 0; i < n; i++) {
    if (ab[i] !== bb[i]) return ab[i] < bb[i] ? -1 : 1
  }
  if (ab.length < bb.length) return -1
  if (ab.length > bb.length) return 1
  return 0
}

/**
 * Injective total-order comparator for projection row keys, consistent with
 * SQLite `ORDER BY block_id, normalized_content` (BINARY collation):
 * compare `block_id` first, then `normalized_content`. Returns 0 iff both
 * fields are byte-identical (the multiset key is equal). The `rowid` is a
 * table-local ordering artifact and never participates in equality.
 */
export function compareProjectionRows(a: ProjectionRowKey, b: ProjectionRowKey): number {
  const byBlock = compareTextBinary(a.block_id, b.block_id)
  if (byBlock !== 0) return byBlock
  return compareTextBinary(a.normalized_content, b.normalized_content)
}
