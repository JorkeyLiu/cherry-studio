/**
 * Deterministic canonical JSON serialization + SHA-256 digests (LOCK-4302).
 *
 * One canonicalization contract for every Phase 4.3 verification surface:
 * - Object keys are sorted recursively (UTF-16 code-unit order).
 * - Array order is preserved exactly as given.
 * - `null` serializes as `null`; ABSENT keys never appear in the output.
 *   Callers must construct projected records explicitly (every canonical
 *   column present, null when null) so absent-vs-null stays meaningful.
 * - Non-JSON values (undefined, NaN/Infinity, bigint, symbol, function,
 *   Date/Map/Set/RegExp/class instances, sparse arrays, cycles) are
 *   rejected with {@link CanonicalizationError} — never coerced or skipped.
 * - Digest = lowercase SHA-256 hex of the canonical UTF-8 string.
 *
 * Never feed raw Dexie objects or raw SQL JSON strings into these digests
 * (LOCK-4302). Hash only explicitly constructed projected records.
 *
 * Main-only. No Electron/IPC/renderer dependencies beyond node:crypto.
 */

import { createHash } from 'node:crypto'

/** Thrown when a value cannot be canonicalized (non-JSON content). */
export class CanonicalizationError extends Error {
  /** Dot/bracket path of the offending value (e.g. `root.overflow[2]`). */
  readonly path: string

  constructor(path: string, detail: string) {
    super(`Canonicalization rejected at '${path}': ${detail}`)
    this.name = 'CanonicalizationError'
    this.path = path
  }
}

/**
 * Serialize a JSON-safe value into its unique canonical string form.
 *
 * @throws {CanonicalizationError} on any non-JSON value (LOCK-4302).
 */
export function canonicalStringify(value: unknown): string {
  return serialize(value, 'root', new Set<object>())
}

function serialize(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(path, `non-finite number (${value})`)
      }
      return JSON.stringify(value)
    case 'undefined':
      throw new CanonicalizationError(path, 'undefined is not a JSON value')
    case 'bigint':
      throw new CanonicalizationError(path, 'bigint is not a JSON value')
    case 'symbol':
      throw new CanonicalizationError(path, 'symbol is not a JSON value')
    case 'function':
      throw new CanonicalizationError(path, 'function is not a JSON value')
  }

  // Object territory from here on.
  const obj = value as object
  if (seen.has(obj)) {
    throw new CanonicalizationError(path, 'cyclic value')
  }

  if (Array.isArray(value)) {
    seen.add(obj)
    const parts: string[] = []
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) {
        throw new CanonicalizationError(`${path}[${i}]`, 'sparse arrays are not allowed')
      }
      parts.push(serialize(value[i], `${path}[${i}]`, seen))
    }
    seen.delete(obj)
    return `[${parts.join(',')}]`
  }

  const proto = Object.getPrototypeOf(obj)
  if (proto !== Object.prototype && proto !== null) {
    throw new CanonicalizationError(path, `non-plain object (constructor: ${proto?.constructor?.name ?? 'unknown'})`)
  }

  seen.add(obj)
  // Default sort() compares UTF-16 code units — deterministic across runs.
  const keys = Object.keys(obj).sort()
  const parts: string[] = []
  for (const key of keys) {
    const entryValue = (obj as Record<string, unknown>)[key]
    parts.push(`${JSON.stringify(key)}:${serialize(entryValue, `${path}.${key}`, seen)}`)
  }
  seen.delete(obj)
  return `{${parts.join(',')}}`
}

/** SHA-256 of a canonical string, as lowercase hex (LOCK-4302). */
export function sha256Hex(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/**
 * Canonical digest of a projected record: SHA-256 hex over
 * {@link canonicalStringify}. The single hashing entry point for
 * verification evidence.
 *
 * @throws {CanonicalizationError} on any non-JSON value.
 */
export function canonicalDigest(value: unknown): string {
  return sha256Hex(canonicalStringify(value))
}
