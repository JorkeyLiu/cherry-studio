/**
 * B-07 Scroll snapshot bounded cache — renderer-local.
 *
 * Calibration defaults (not product thresholds): max 256 topic snapshots,
 * 90-day TTL. No performance claim or architecture-exit claim.
 *
 * Eviction: TTL first, then deterministic LRU using topicId (scroll key suffix)
 * tie-break. Enforcement at startup and read/write lifecycle points only; no
 * periodic background timers.
 *
 * Index is renderer-local, safely namespaced under `scroll:__index__`. Snapshot
 * keys are `scroll:topic-${topicId}` only (B-07 governs topic snapshots; generic
 * non-topic scroll keys like scroll:SearchResults are untouched and not subject
 * to the 256 budget). Missing/corrupted index rebuilds from `window.keyv.keys()` scan.
 *
 * Soft delete retains snapshots; hard delete removes its snapshot via
 * `removeScrollSnapshotsForTopicIds` called from `topicDeletionInvalidation`.
 * Hard delete durably invalidates the topic scroll key for the session so
 * pending throttled trailing writes cannot recreate it.
 */

export const SCROLL_SNAPSHOT_MAX_COUNT = 256
export const SCROLL_SNAPSHOT_TTL_MS = 90 * 24 * 60 * 60 * 1000 // 7776000000
export const SCROLL_SNAPSHOT_INDEX_KEY = 'scroll:__index__'
export const SCROLL_SNAPSHOT_PREFIX = 'scroll:'
export const SCROLL_SNAPSHOT_TOPIC_PREFIX = 'scroll:topic-'

export interface ScrollSnapshotIndexEntry {
  key: string // full key e.g., "scroll:topic-xxx"
  lastAccess: number // epoch ms
}

// Session-local hard-delete invalidation: pending throttled writes for these
// keys must not recreate snapshots after authoritative hard delete.
const invalidatedTopicScrollKeys = new Set<string>()

// ---------------------------------------------------------------------------
// B-07 local scalar diagnostics — renderer-local, no content/keys retained
// ---------------------------------------------------------------------------

export interface ScrollSnapshotEnforcementDiagnostics {
  /** Raw persisted index-array length before repair/sync/canonicalization */
  indexCountBefore: number
  /** Post-enforcement index count (after TTL/LRU) */
  indexCountAfter: number
  /** Count of expired entries successfully removed (Keyv remove returned !== false and did not throw) */
  expiredRemoved: number
  /** Count of LRU entries successfully evicted (Keyv remove returned !== false and did not throw) */
  lruEvicted: number
  /** Whether index was missing or malformed (required rebuild/repair) */
  didRebuild: boolean
}

export interface ScrollSnapshotDiagnostics {
  /** Current valid index count (filtered) */
  indexCount: number
  /** Calibration max count (256) */
  maxCount: number
  /** Calibration TTL ms */
  ttlMs: number
  /** Last enforcement outcome, null until first enforcement */
  lastEnforcement: ScrollSnapshotEnforcementDiagnostics | null
}

let lastEnforcement: ScrollSnapshotEnforcementDiagnostics | null = null

function getKeyv(): any {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { keyv?: any }).keyv
}

function compareKeys(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function isScrollSnapshotKey(key: string): boolean {
  if (typeof key !== 'string' || key.length === 0) return false
  if (key === SCROLL_SNAPSHOT_INDEX_KEY) return false
  if (key.startsWith(SCROLL_SNAPSHOT_INDEX_KEY)) return false
  if (!key.startsWith(SCROLL_SNAPSHOT_PREFIX)) return false
  if (!key.startsWith(SCROLL_SNAPSHOT_TOPIC_PREFIX)) return false
  if (key.endsWith(':expired_time')) return false
  if (key.includes(':expired_time')) return false
  return true
}

export function isScrollSnapshotInvalidated(key: string): boolean {
  return invalidatedTopicScrollKeys.has(key)
}

function safeKeys(): string[] {
  const keyv = getKeyv()
  if (!keyv || typeof keyv.keys !== 'function') return []
  try {
    const keys = keyv.keys()
    return Array.isArray(keys) ? keys : []
  } catch {
    return []
  }
}

function loadIndexRaw(): unknown {
  const keyv = getKeyv()
  if (!keyv || typeof keyv.get !== 'function') return null
  try {
    return keyv.get(SCROLL_SNAPSHOT_INDEX_KEY)
  } catch {
    return null
  }
}

function isValidIndexEntry(entry: unknown): entry is ScrollSnapshotIndexEntry {
  if (!entry || typeof entry !== 'object') return false
  const e = entry as Record<string, unknown>
  if (typeof e.key !== 'string' || e.key.length === 0) return false
  if (!isScrollSnapshotKey(e.key)) return false
  if (typeof e.lastAccess !== 'number' || !Number.isFinite(e.lastAccess)) return false
  return true
}

function saveIndex(entries: ScrollSnapshotIndexEntry[]): void {
  const keyv = getKeyv()
  if (!keyv || typeof keyv.set !== 'function') return
  try {
    keyv.set(SCROLL_SNAPSHOT_INDEX_KEY, entries)
  } catch {
    // best-effort
  }
}

export function getScrollSnapshotIndex(): ScrollSnapshotIndexEntry[] | null {
  const raw = loadIndexRaw()
  if (Array.isArray(raw)) {
    const filtered = (raw as unknown[]).filter(isValidIndexEntry)
    return filtered
  }
  return null
}

function getScrollSnapshotIndexWithRepairMeta(): {
  index: ScrollSnapshotIndexEntry[] | null
  hadMalformed: boolean
} {
  const raw = loadIndexRaw()
  if (Array.isArray(raw)) {
    const filtered = (raw as unknown[]).filter(isValidIndexEntry)
    return { index: filtered, hadMalformed: filtered.length !== raw.length }
  }
  return { index: null, hadMalformed: false }
}

export function getScrollSnapshotIndexOrEmpty(now = Date.now()): ScrollSnapshotIndexEntry[] {
  const idx = getScrollSnapshotIndex()
  if (idx !== null) return idx
  return rebuildScrollSnapshotIndex(now)
}

export function rebuildScrollSnapshotIndex(now = Date.now()): ScrollSnapshotIndexEntry[] {
  const keys = safeKeys().filter(isScrollSnapshotKey)
  // Deduplicate and sort deterministically by key using locale-independent comparator
  const unique = [...new Set(keys)].sort(compareKeys)
  const entries: ScrollSnapshotIndexEntry[] = unique.map((k) => ({ key: k, lastAccess: now }))
  saveIndex(entries)
  return entries
}

function canonicalizeEntries(entries: ScrollSnapshotIndexEntry[]): {
  canonical: ScrollSnapshotIndexEntry[]
  changed: boolean
} {
  if (entries.length <= 1) return { canonical: entries, changed: false }
  const map = new Map<string, ScrollSnapshotIndexEntry>()
  let changed = false
  for (const e of entries) {
    const existing = map.get(e.key)
    if (!existing) {
      map.set(e.key, e)
    } else {
      changed = true
      if (e.lastAccess > existing.lastAccess) {
        map.set(e.key, e)
      }
    }
  }
  if (map.size !== entries.length) changed = true
  return { canonical: Array.from(map.values()), changed }
}

function syncIndexWithKeys(
  index: ScrollSnapshotIndexEntry[],
  actualKeys: Set<string>,
  now: number
): { synced: ScrollSnapshotIndexEntry[]; changed: boolean } {
  let changed = false
  // Remove stale index entries where snapshot no longer exists
  const filtered = index.filter((e) => actualKeys.has(e.key))
  if (filtered.length !== index.length) changed = true
  const existingSet = new Set(filtered.map((e) => e.key))
  // Add missing actual keys
  for (const k of actualKeys) {
    if (!existingSet.has(k)) {
      filtered.push({ key: k, lastAccess: now })
      changed = true
    }
  }
  return { synced: filtered, changed }
}

/**
 * Enforce TTL first, then LRU capacity with topicId (key) tie-break.
 * Rebuilds missing index, canonicalizes duplicates, syncs with actual keys,
 * purges invalidated and expired, then evicts oldest LRU entries deterministically.
 */
export function enforceScrollSnapshotBounds(now = Date.now()): void {
  const keyv = getKeyv()
  if (!keyv || typeof keyv.remove !== 'function') return

  // Raw pre-enforcement count captured before repair/sync/canonicalization (no durable format change)
  let rawBefore = 0
  try {
    const raw = loadIndexRaw()
    if (Array.isArray(raw)) rawBefore = raw.length
    else rawBefore = 0
  } catch {
    rawBefore = 0
  }

  const meta = getScrollSnapshotIndexWithRepairMeta()
  let index = meta.index
  const hadMalformed = meta.hadMalformed
  const actualKeys = new Set(safeKeys().filter(isScrollSnapshotKey))

  // Purge any invalidated keys that were recreated outside the cache (defense in depth)
  // Remove from actualKeys and storage so they don't re-enter the index via sync.
  for (const inv of [...invalidatedTopicScrollKeys]) {
    if (actualKeys.has(inv)) {
      try {
        keyv.remove(inv)
      } catch {
        // best-effort
      }
      actualKeys.delete(inv)
    }
  }

  let indexWasNull = false
  let syncChanged = false
  let canonicalChanged = false
  let invalidatedPurged = false

  if (index === null) {
    // Missing/corrupted index — rebuild from keys (already filtered for invalidated above)
    index = actualKeys.size === 0 ? [] : rebuildScrollSnapshotIndex(now)
    // rebuild already persisted; continue to TTL/LRU below using rebuilt index
    // Avoid double sync: actualKeys already reflected in rebuilt index
    indexWasNull = true
  } else {
    const sync = syncIndexWithKeys(index, actualKeys, now)
    index = sync.synced
    syncChanged = sync.changed
  }

  // Canonicalize duplicate valid index entries before TTL/LRU; keep max lastAccess
  const canonicalResult = canonicalizeEntries(index)
  if (canonicalResult.changed) {
    index = canonicalResult.canonical
    canonicalChanged = true
  }

  // Remove invalidated keys from index (stale entries that survived sync/canonicalize)
  const beforeInvalidated = index.length
  const filteredInvalidated = index.filter((e) => !invalidatedTopicScrollKeys.has(e.key))
  if (filteredInvalidated.length !== beforeInvalidated) {
    // Ensure storage is clean for those keys as well (in case actualKeys miss)
    for (const e of index) {
      if (invalidatedTopicScrollKeys.has(e.key)) {
        try {
          keyv.remove(e.key)
        } catch {
          // best-effort
        }
      }
    }
    index = filteredInvalidated
    invalidatedPurged = true
  }

  const ttlThreshold = now - SCROLL_SNAPSHOT_TTL_MS
  const expired: ScrollSnapshotIndexEntry[] = []
  const remaining: ScrollSnapshotIndexEntry[] = []
  for (const e of index) {
    if (e.lastAccess < ttlThreshold) {
      expired.push(e)
    } else {
      remaining.push(e)
    }
  }

  // Count only successful Keyv removals (false return or throw = not removed)
  let expiredRemoved = 0
  for (const e of expired) {
    try {
      const res = keyv.remove(e.key)
      if (res !== false) expiredRemoved += 1
    } catch {
      // best-effort: not counted
    }
  }

  let working = remaining
  let evicted = false
  let lruEvicted = 0

  if (working.length > SCROLL_SNAPSHOT_MAX_COUNT) {
    // Deterministic LRU: sort by lastAccess asc, then key asc (locale-independent)
    working = [...working].sort((a, b) => {
      if (a.lastAccess !== b.lastAccess) return a.lastAccess - b.lastAccess
      return compareKeys(a.key, b.key)
    })
    const toEvictCount = working.length - SCROLL_SNAPSHOT_MAX_COUNT
    const toEvict = working.slice(0, toEvictCount)
    const toKeep = working.slice(toEvictCount)
    for (const e of toEvict) {
      try {
        const res = keyv.remove(e.key)
        if (res !== false) lruEvicted += 1
      } catch {
        // best-effort: not counted
      }
    }
    working = toKeep
    evicted = true
  }

  // Record local scalar diagnostics before persistence decision (raw/success semantics)
  {
    const didRebuild = hadMalformed || indexWasNull
    const indexCountAfter = working.length
    lastEnforcement = {
      indexCountBefore: rawBefore,
      indexCountAfter,
      expiredRemoved,
      lruEvicted,
      didRebuild
    }
  }

  // Determine if we need to persist: any structural change
  const needsSave =
    hadMalformed ||
    indexWasNull ||
    syncChanged ||
    canonicalChanged ||
    invalidatedPurged ||
    expired.length > 0 ||
    evicted ||
    working.length !== index.length ||
    (() => {
      // Compare final working vs current index (after canonical/invalidated) for any key set diff
      if (working.length !== index.length) return true
      const originalKeys = new Set(index.map((e) => e.key))
      const workingKeys = new Set(working.map((e) => e.key))
      if (originalKeys.size !== workingKeys.size) return true
      for (const k of originalKeys) if (!workingKeys.has(k)) return true
      for (const k of workingKeys) if (!originalKeys.has(k)) return true
      return false
    })()

  // If rebuilt, we already saved the rebuilt index; but if TTL/LRU/invalidated changed it, re-save final state
  if (needsSave) {
    // If we just rebuilt and working equals rebuilt index and no eviction/expiry, rebuild already saved correctly — avoid redundant write unless changed
    if (
      indexWasNull &&
      !hadMalformed &&
      !expired.length &&
      !evicted &&
      !invalidatedPurged &&
      !canonicalChanged &&
      working.length === index.length
    ) {
      return
    }
    saveIndex(working)
  }
}

/**
 * Called after a snapshot is saved (throttled handleScroll or savePosition).
 * Upserts lastAccess and enforces bounds. Durably blocked for invalidated keys.
 */
export function handleScrollSnapshotSaved(scrollKey: string, now = Date.now()): void {
  if (!isScrollSnapshotKey(scrollKey)) return
  if (isScrollSnapshotInvalidated(scrollKey)) {
    const keyv = getKeyv()
    if (keyv && typeof keyv.remove === 'function') {
      try {
        keyv.remove(scrollKey)
      } catch {
        // best-effort
      }
    }
    return
  }
  const keyv = getKeyv()
  if (!keyv) return

  let index = getScrollSnapshotIndex()
  if (index === null) {
    index = rebuildScrollSnapshotIndex(now)
    // After rebuild, ensure the saved key is present with correct timestamp (rebuild already included it)
    const idx = index.findIndex((e) => e.key === scrollKey)
    if (idx >= 0) {
      index[idx] = { key: scrollKey, lastAccess: now }
      saveIndex(index)
    } else {
      // Edge: if actualKeys didn't yet include the just-saved key because keys() snapshot was before set,
      // the rebuild wouldn't have it — add it explicitly
      index.push({ key: scrollKey, lastAccess: now })
      saveIndex(index)
    }
    enforceScrollSnapshotBounds(now)
    return
  }

  // Canonicalize before upsert to avoid operating on duplicate-tainted index
  const can = canonicalizeEntries(index)
  if (can.changed) {
    index = can.canonical
  }
  const existing = index.findIndex((e) => e.key === scrollKey)
  if (existing >= 0) {
    index[existing] = { key: scrollKey, lastAccess: now }
  } else {
    index.push({ key: scrollKey, lastAccess: now })
  }
  saveIndex(index)
  enforceScrollSnapshotBounds(now)
}

/**
 * Called after a snapshot is read/restored. Updates recency.
 * Caller should ensure snapshot actually existed before invoking.
 */
export function handleScrollSnapshotRead(scrollKey: string, now = Date.now()): void {
  if (!isScrollSnapshotKey(scrollKey)) return
  if (isScrollSnapshotInvalidated(scrollKey)) return
  const keyv = getKeyv()
  if (!keyv) return

  // Verify snapshot still exists before updating index (avoid polluting index for missing keys)
  // Use try/catch; if get throws or returns undefined and no actual key, skip
  let exists = false
  try {
    const val = keyv.get(scrollKey)
    exists = val !== undefined && val !== null
  } catch {
    exists = false
  }
  // Also check safeKeys for extra safety (handles legacy numeric values stored as number)
  if (!exists) {
    const keys = safeKeys()
    exists = keys.includes(scrollKey)
  }
  if (!exists) return

  let index = getScrollSnapshotIndex()
  if (index === null) {
    index = rebuildScrollSnapshotIndex(now)
    const idx = index.findIndex((e) => e.key === scrollKey)
    if (idx >= 0) {
      index[idx] = { key: scrollKey, lastAccess: now }
      saveIndex(index)
    } else {
      index.push({ key: scrollKey, lastAccess: now })
      saveIndex(index)
    }
    enforceScrollSnapshotBounds(now)
    return
  }

  const can = canonicalizeEntries(index)
  if (can.changed) index = can.canonical
  const existing = index.findIndex((e) => e.key === scrollKey)
  if (existing >= 0) {
    index[existing] = { key: scrollKey, lastAccess: now }
  } else {
    index.push({ key: scrollKey, lastAccess: now })
  }
  saveIndex(index)
  enforceScrollSnapshotBounds(now)
}

/**
 * Called after a snapshot is cleared via clearSavedPosition.
 */
export function handleScrollSnapshotCleared(scrollKey: string): void {
  if (!isScrollSnapshotKey(scrollKey)) return
  if (isScrollSnapshotInvalidated(scrollKey)) {
    // Already invalidated; ensure removal but don't pollute index
    const keyv = getKeyv()
    if (keyv && typeof keyv.remove === 'function') {
      try {
        keyv.remove(scrollKey)
      } catch {}
    }
    return
  }
  const keyv = getKeyv()
  if (!keyv) return
  let index = getScrollSnapshotIndex()
  if (index === null) {
    // Rebuild then remove
    index = rebuildScrollSnapshotIndex(Date.now())
  }
  const can = canonicalizeEntries(index)
  if (can.changed) index = can.canonical
  const filtered = index.filter((e) => e.key !== scrollKey)
  if (filtered.length !== index.length || can.changed) {
    saveIndex(filtered)
  }
}

/**
 * Hard-delete cleanup: removes snapshots for given topicIds.
 * Uses `scroll:topic-${topicId}` keys. Safe: only deletes scroll namespace.
 * Durably invalidates the key for the session so pending trailing writes cannot recreate it.
 */
export function removeScrollSnapshotsForTopicIds(topicIds: string[]): void {
  if (!Array.isArray(topicIds) || topicIds.length === 0) return
  const keyv = getKeyv()
  if (!keyv || typeof keyv.remove !== 'function') return

  let index = getScrollSnapshotIndex()
  if (index === null) {
    index = rebuildScrollSnapshotIndex(Date.now())
  }
  const can = canonicalizeEntries(index)
  if (can.changed) index = can.canonical

  let filtered = index
  let changed = false

  for (const rawId of topicIds) {
    if (typeof rawId !== 'string' || rawId.length === 0) continue
    // Support both raw topicId ("abc") and already-prefixed ("topic-abc") for robustness
    const suffix = rawId.startsWith('topic-') ? rawId : `topic-${rawId}`
    const scrollKey = `${SCROLL_SNAPSHOT_PREFIX}${suffix}`
    if (!isScrollSnapshotKey(scrollKey)) continue
    // Durably invalidate so pending throttled trailing cannot recreate
    invalidatedTopicScrollKeys.add(scrollKey)
    // Attempt removal
    try {
      const hadKey = filtered.some((e) => e.key === scrollKey)
      const keys = safeKeys()
      const hadActual = keys.includes(scrollKey)
      if (hadKey || hadActual) {
        keyv.remove(scrollKey)
        changed = true
      } else {
        // Even if no key present, we still want to ensure any future stale index entry is removed
        // Check if filtered contains it (already above), but if not, no storage removal needed
        // Still consider changed if we added to invalidated set? No need to persist index then unless entry existed
      }
    } catch {
      // best-effort
    }
    const before = filtered.length
    filtered = filtered.filter((e) => e.key !== scrollKey)
    if (filtered.length !== before) changed = true
    // Canonicalize already done; but if we added to invalidated, future enforce will also purge
  }

  if (changed || can.changed) {
    saveIndex(filtered)
  }
}

/**
 * Startup entry — enforces TTL then LRU.
 */
export function initScrollSnapshotCache(now = Date.now()): void {
  try {
    enforceScrollSnapshotBounds(now)
  } catch {
    // best-effort
  }
}

/**
 * B-07 local scalar diagnostics getters — renderer-local, no sensitive values
 */

export function getScrollSnapshotDiagnostics(): ScrollSnapshotDiagnostics {
  let indexCount = 0
  try {
    const idx = getScrollSnapshotIndex()
    if (Array.isArray(idx)) indexCount = idx.length
    else indexCount = 0
  } catch {
    indexCount = 0
  }
  return {
    indexCount,
    maxCount: SCROLL_SNAPSHOT_MAX_COUNT,
    ttlMs: SCROLL_SNAPSHOT_TTL_MS,
    lastEnforcement: lastEnforcement ? { ...lastEnforcement } : null
  }
}

export function getScrollSnapshotEnforcementDiagnostics(): ScrollSnapshotEnforcementDiagnostics | null {
  return lastEnforcement ? { ...lastEnforcement } : null
}

export function resetScrollSnapshotDiagnosticsForTests(): void {
  lastEnforcement = null
}

/** Test helpers */

export function resetScrollSnapshotCacheForTests(): void {
  const keyv = getKeyv()
  if (keyv && typeof keyv.remove === 'function') {
    try {
      keyv.remove(SCROLL_SNAPSHOT_INDEX_KEY)
    } catch {}
  }
  invalidatedTopicScrollKeys.clear()
  // Integrate diagnostics reset for test isolation (does not affect Keyv format)
  lastEnforcement = null
}

export function resetInvalidatedScrollSnapshotsForTests(): void {
  invalidatedTopicScrollKeys.clear()
}

export function getScrollSnapshotIndexForTests(): ScrollSnapshotIndexEntry[] | null {
  return getScrollSnapshotIndex()
}

export function __internalIsScrollSnapshotKeyForTests(key: string): boolean {
  return isScrollSnapshotKey(key)
}

export function __internalIsInvalidatedForTests(key: string): boolean {
  return isScrollSnapshotInvalidated(key)
}
