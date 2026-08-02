/**
 * JSON wire boundary — cloneForWire.
 *
 * Deep-clone a value for safe IPC transport. Recursively clones plain
 * arrays/objects, enforcing JSON wire safety constraints:
 *   - Omitted: undefined object properties (stripped recursively).
 *   - Preserved: null, boolean, string, finite number, insertion order.
 *   - Rejected: non-finite numbers, bigint, symbol, function, Date,
 *     Map, Set, TypedArray, class instances, sparse arrays, undefined
 *     array elements, cycles.
 *   - Bounded nesting: max depth 20 levels.
 *
 * Shared non-cyclic references (e.g. one assistant.model object stored on
 * many messages) are treated like JSON.stringify: each occurrence is
 * cloned independently, producing duplicated equal-but-independent data
 * over the wire. Only true ancestor cycles are rejected.
 *
 * Does NOT use JSON.stringify/parse. Does NOT mutate inputs.
 *
 * Shared by SqliteMessageDataSource (renderer→Main IPC) and the chatImport
 * entry point (Dexie→Main IPC) per LOCK-N5. Dependency-neutral: no imports
 * from services, databases, or preload.
 */

const MAX_DEPTH = 20

/**
 * Deep-clone a value for safe IPC transport.
 * Enforces JSON wire safety constraints.
 *
 * @param value  The value to clone.
 * @param depth  Current recursion depth.
 * @param seen   WeakSet for cycle detection.
 * @returns      A deep-cloned, JSON-safe copy.
 * @throws       {TypeError} If the value contains unsupported types.
 */
export function cloneForWire<T>(value: T, depth = 0, seen = new WeakSet()): T {
  if (depth > MAX_DEPTH) {
    throw new TypeError(`cloneForWire: nesting depth exceeds maximum (${MAX_DEPTH})`)
  }

  if (value === undefined) {
    return undefined as T
  }

  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`cloneForWire: non-finite number: ${value}`)
    }
    return value
  }

  if (typeof value === 'bigint') {
    throw new TypeError('cloneForWire: bigint is not a valid JSON value')
  }

  if (typeof value === 'symbol') {
    throw new TypeError('cloneForWire: symbol is not a valid JSON value')
  }

  if (typeof value === 'function') {
    throw new TypeError('cloneForWire: function is not a valid JSON value')
  }

  if (value instanceof Date) {
    throw new TypeError('cloneForWire: Date is not a valid JSON value')
  }

  if (value instanceof Map || value instanceof WeakMap) {
    throw new TypeError('cloneForWire: Map is not a valid JSON value')
  }

  if (value instanceof Set || value instanceof WeakSet) {
    throw new TypeError('cloneForWire: Set is not a valid JSON value')
  }

  if (value instanceof RegExp || value instanceof Error) {
    throw new TypeError(`cloneForWire: ${value.constructor.name} is not a valid JSON value`)
  }

  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new TypeError('cloneForWire: TypedArray/Buffer is not a valid JSON value')
  }

  if (Array.isArray(value)) {
    // Cycle detection: `seen` tracks only ACTIVE ancestors, so a shared object
    // referenced by two siblings is cloned twice (JSON.stringify-compatible)
    // instead of being misread as a cycle. The value is removed in `finally`
    // so a throwing child can never leave a stale entry behind.
    if (seen.has(value as object)) {
      throw new TypeError('cloneForWire: cyclic reference detected')
    }
    seen.add(value as object)

    try {
      const result: unknown[] = new Array(value.length)
      for (let i = 0; i < value.length; i++) {
        if (!(i in value)) {
          throw new TypeError(`cloneForWire: sparse arrays are not allowed (hole at index ${i})`)
        }
        if (value[i] === undefined) {
          throw new TypeError(`cloneForWire: undefined in arrays is not a valid JSON value (index ${i})`)
        }
        result[i] = cloneForWire(value[i], depth + 1, seen)
      }
      return result as T
    } finally {
      seen.delete(value as object)
    }
  }

  if (typeof value === 'object') {
    // Plain object check
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`cloneForWire: non-plain object (constructor: ${proto?.constructor?.name ?? 'unknown'})`)
    }

    // Cycle detection: active-ancestor only (see array branch). A shared
    // object reached again from a sibling is cloned again, not rejected.
    if (seen.has(value as object)) {
      throw new TypeError('cloneForWire: cyclic reference detected')
    }
    seen.add(value as object)

    try {
      const result: Record<string, unknown> = {}
      for (const key of Object.keys(value as Record<string, unknown>)) {
        const v = (value as Record<string, unknown>)[key]
        if (v === undefined) {
          // Omit undefined values — they are not valid in JSON wire
          continue
        }
        result[key] = cloneForWire(v, depth + 1, seen)
      }
      return result as T
    } finally {
      seen.delete(value as object)
    }
  }

  throw new TypeError(`cloneForWire: unsupported type: ${typeof value}`)
}
