/**
 * Focused unit tests for the disposable L2 file-origin seed builder's
 * deterministic parts (LOCK-E1..E5 + LOCK-FF1).
 *
 * Proves against real (non-mocked) containers:
 * 1. `buildSeedPersistedState()` produces a deterministic version-215
 *    redux-persist `persist:cherry-studio` payload in the REAL wire
 *    representation (LOCK-FF1): an outer JSON object whose `_persist` and
 *    `assistants` values are themselves JSON STRINGS — exactly what
 *    `createPersistoid` writes with the default serializer — with EXACT
 *    deterministic bytes. The slices parse back to exactly the exported
 *    fixture contract (two assistants in source order, the visible
 *    IDB-matched topic with a DELIBERATELY STALE inner assistantId, and the
 *    deleted-topic metadata record).
 * 2. A consumer mirror of the production projection contract (`_persist` +
 *    `assistants.assistants`, container-owns-grouping, LS-only drop) parses
 *    the raw wire slices and yields the exact documented projection facts.
 * 3. `produceSeedZip()` materializes EXACTLY the `IndexedDB/` +
 *    `Local Storage/leveldb/` roots — verified independently through the ZIP
 *    central directory (no `Data/`, no `.indexeddb.blob`, no other roots) —
 *    and fails closed on a missing/invalid Local Storage backing store.
 *
 * These are pure Node utility tests (vitest project `e2e-utils`); no
 * Electron, no Playwright, no production code is executed.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import StreamZip from 'node-stream-zip'
import { afterEach, describe, expect, it } from 'vitest'

import {
  buildSeedPersistedState,
  parsePersistWireValue,
  produceSeedZip,
  PROJECTION_ASSISTANTS,
  PROJECTION_TOPICS,
  SEED_LOCAL_STORAGE_LEVELDB_DIR,
  SEED_LOCAL_STORAGE_ROOT,
  SEED_ORIGIN_DIR,
  SEED_PERSIST_VERSION,
  SOURCE_IDS,
  STALE_TOPIC_ASSISTANT_ID
} from './disposable-seed-zip'

const tempDirs: string[] = []

function tempDir(): string {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), 'cherry-e2e-seed-zip-test-'))
  tempDirs.push(result)
  return result
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Synthetic profile directory builder (no Electron needed)
// ---------------------------------------------------------------------------

/**
 * Create a synthetic closed/flushed seed profile shape that `produceSeedZip`
 * accepts: an IndexedDB file-origin subtree with at least one .ldb table file
 * and a Local Storage/leveldb subtree with a CURRENT marker. Returns the
 * profile "Dev" directory path.
 */
function syntheticProfileDevDir(root: string): string {
  const profileDevDir = path.join(root, 'profileDev')
  const originDir = path.join(profileDevDir, 'IndexedDB', SEED_ORIGIN_DIR)
  const lsDir = path.join(profileDevDir, 'Local Storage', 'leveldb')
  fs.mkdirSync(originDir, { recursive: true })
  fs.mkdirSync(lsDir, { recursive: true })
  // IndexedDB: CURRENT + manifest + WAL log + one .ldb table file (Layer 4).
  fs.writeFileSync(path.join(originDir, 'CURRENT'), 'MANIFEST-000001\n')
  fs.writeFileSync(path.join(originDir, 'MANIFEST-000001'), 'manifest')
  fs.writeFileSync(path.join(originDir, '000003.log'), 'wal-log')
  fs.writeFileSync(path.join(originDir, '000005.ldb'), 'table-data'.repeat(1024))
  // Local Storage: CURRENT + manifest + WAL log + one .ldb table file.
  fs.writeFileSync(path.join(lsDir, 'CURRENT'), 'MANIFEST-000001\n')
  fs.writeFileSync(path.join(lsDir, 'MANIFEST-000001'), 'manifest')
  fs.writeFileSync(path.join(lsDir, '000003.log'), 'ls-wal-log')
  fs.writeFileSync(path.join(lsDir, '000005.ldb'), 'ls-table-data'.repeat(1024))
  return profileDevDir
}

/** Read the ZIP entry names (independent oracle — node-stream-zip). */
async function zipEntryNames(zipPath: string): Promise<string[]> {
  const zip = new StreamZip.async({ file: zipPath })
  try {
    const entries = await zip.entries()
    return Object.keys(entries)
  } finally {
    await zip.close()
  }
}

// ---------------------------------------------------------------------------
// Payload contract (LOCK-E3/E4)
// ---------------------------------------------------------------------------

describe('buildSeedPersistedState (LOCK-E3/E4 + LOCK-FF1 payload contract)', () => {
  it('is deterministic and emits the REAL redux-persist wire format (string slices)', () => {
    const first = buildSeedPersistedState()
    const second = buildSeedPersistedState()
    expect(first).toBe(second)

    // LOCK-FF1: the raw wire value is an OUTER JSON object whose `_persist`
    // and `assistants` values are JSON STRINGS (createPersistoid default
    // serialization) — never the decoded nested-object shape.
    const parsed = JSON.parse(first) as { _persist: unknown; assistants: unknown }
    expect(typeof parsed._persist).toBe('string')
    expect(typeof parsed.assistants).toBe('string')

    const persist = JSON.parse(parsed._persist as string) as { version: number; rehydrated: boolean }
    expect(persist.version).toBe(SEED_PERSIST_VERSION)
    expect(persist.rehydrated).toBe(true)
    const slice = JSON.parse(parsed.assistants as string) as { assistants: Array<Record<string, unknown>> }
    // Production reads exactly `root.assistants.assistants` (extractAssistantList).
    expect(slice.assistants).toHaveLength(2)
  })

  it('emits EXACT deterministic wire bytes equal to an independent redux-persist mirror (LOCK-FF1)', () => {
    const first = buildSeedPersistedState()
    expect(buildSeedPersistedState()).toBe(first)

    // Independent oracle: mirror createPersistoid's default serialization —
    // every slice (including `_persist`) is JSON.stringify'd, then the whole
    // staged map is JSON.stringify'd. Key order matches the builder exactly.
    const expected = JSON.stringify({
      _persist: JSON.stringify({ version: SEED_PERSIST_VERSION, rehydrated: true }),
      assistants: JSON.stringify({
        defaultAssistant: {},
        assistants: [
          {
            id: PROJECTION_ASSISTANTS.first.id,
            name: PROJECTION_ASSISTANTS.first.name,
            emoji: PROJECTION_ASSISTANTS.first.emoji,
            prompt: '',
            type: 'assistant',
            topics: [{ ...PROJECTION_TOPICS.visible, messages: [] }]
          },
          {
            id: PROJECTION_ASSISTANTS.second.id,
            name: PROJECTION_ASSISTANTS.second.name,
            emoji: PROJECTION_ASSISTANTS.second.emoji,
            prompt: '',
            type: 'assistant',
            topics: [{ ...PROJECTION_TOPICS.deleted, messages: [] }]
          }
        ],
        tagsOrder: [],
        collapsedTags: {},
        presets: [],
        unifiedListOrder: []
      })
    })
    expect(first).toBe(expected)
    // EXACT deterministic wire bytes (LOCK-FF1). The payload carries emoji
    // (multi-byte UTF-8), so UTF-8 byte length differs from char length — both
    // are pinned so any wire-shape drift breaks this test.
    expect(first.length).toBe(941)
    expect(Buffer.byteLength(first, 'utf8')).toBe(945)
  })

  it('round-trips through the exported wire decoder (parsePersistWireValue)', () => {
    const decoded = parsePersistWireValue(buildSeedPersistedState())
    const persist = decoded._persist as { version: number; rehydrated: boolean }
    expect(persist.version).toBe(SEED_PERSIST_VERSION)
    expect(persist.rehydrated).toBe(true)
    const slice = decoded.assistants as { assistants: unknown[] }
    expect(slice.assistants).toHaveLength(2)
  })

  it('carries exactly the exported assistant contract in source order', () => {
    const parsed = JSON.parse(buildSeedPersistedState()) as { assistants: string }
    const slice = JSON.parse(parsed.assistants) as { assistants: Array<Record<string, unknown>> }
    const assistants = slice.assistants
    expect(assistants[0]).toMatchObject({
      id: PROJECTION_ASSISTANTS.first.id,
      name: PROJECTION_ASSISTANTS.first.name,
      emoji: PROJECTION_ASSISTANTS.first.emoji
    })
    expect(assistants[1]).toMatchObject({
      id: PROJECTION_ASSISTANTS.second.id,
      name: PROJECTION_ASSISTANTS.second.name,
      emoji: PROJECTION_ASSISTANTS.second.emoji
    })
    // Source order is positional: first then second (LOCK-E4).
    expect(assistants.map((a) => a.id)).toEqual([PROJECTION_ASSISTANTS.first.id, PROJECTION_ASSISTANTS.second.id])
  })

  it('groups the visible IDB-matched topic under the first assistant with a STALE inner assistantId (LOCK-E4)', () => {
    const parsed = JSON.parse(buildSeedPersistedState()) as { assistants: string }
    const slice = JSON.parse(parsed.assistants) as { assistants: Array<Record<string, unknown>> }
    const firstAssistant = slice.assistants[0]
    const topics = firstAssistant.topics as Array<Record<string, unknown>>
    expect(topics).toHaveLength(1)
    const visible = topics[0]

    // The visible topic id EXACTLY matches the single IndexedDB topic (the
    // projection can only enrich IDB-matched topics — LOCK-PROD-3).
    expect(visible.id).toBe(SOURCE_IDS.topic)
    // The exported contract is the source of truth for the payload.
    expect(visible).toMatchObject({ ...PROJECTION_TOPICS.visible })
    expect(visible.name).toBe(PROJECTION_TOPICS.visible.name)
    expect(visible.createdAt).toBe(PROJECTION_TOPICS.visible.createdAt)
    expect(visible.updatedAt).toBe(PROJECTION_TOPICS.visible.updatedAt)
    expect(visible.deletedAt).toBeNull()
    expect(visible.pinned).toBe(true)
    expect(visible.isNameManuallyEdited).toBe(true)
    // DELIBERATELY STALE: the inner assistantId differs from the container.
    expect(visible.assistantId).toBe(STALE_TOPIC_ASSISTANT_ID)
    expect(visible.assistantId).not.toBe(PROJECTION_ASSISTANTS.first.id)
  })

  it('carries the deleted-topic metadata record under the second assistant (LOCK-E4)', () => {
    const parsed = JSON.parse(buildSeedPersistedState()) as { assistants: string }
    const slice = JSON.parse(parsed.assistants) as { assistants: Array<Record<string, unknown>> }
    const secondAssistant = slice.assistants[1]
    const topics = secondAssistant.topics as Array<Record<string, unknown>>
    expect(topics).toHaveLength(1)
    const deleted = topics[0]

    expect(deleted.id).toBe(PROJECTION_TOPICS.deleted.id)
    expect(deleted.name).toBe(PROJECTION_TOPICS.deleted.name)
    expect(deleted.deletedAt).toBe(PROJECTION_TOPICS.deleted.deletedAt)
    expect(deleted.assistantId).toBe(PROJECTION_ASSISTANTS.second.id)
    expect(deleted.pinned).toBe(false)
    expect(deleted.isNameManuallyEdited).toBe(false)
  })
})

describe('consumer mirror of the production projection contract (LOCK-PROD-2/3)', () => {
  /**
   * Minimal mirror of Main's `extractPersistVersion` + `extractAssistantList`
   * + container-owns-grouping + LS-only drop. The REAL module is covered by
   * `src/main/services/chatDbImport/__tests__/navigationProjection.test.ts`
   * (whose payload shape is being corrected in parallel to the same wire
   * representation); here the mirror parses the raw wire slices and proves
   * the seed payload itself produces the documented projection facts.
   */
  function mirrorProjection(
    persisted: string,
    idbTopicIds: string[]
  ): {
    sourcePersistVersion: number | null
    assistants: Array<{ id: string; order: number }>
    topics: Array<{ id: string; assistantId: string; order: number; deletedAt: string | null }>
    recoveredTopicIds: string[]
    droppedLsTopicCount: number
  } {
    // LOCK-FF1: parse the REAL redux-persist wire representation — the outer
    // value holds every slice as a JSON string, so `_persist` and
    // `assistants` must be JSON-parsed again to reach the slices.
    const root = JSON.parse(persisted) as { _persist?: unknown; assistants?: unknown }
    let persistMeta: { version?: unknown } | null = null
    if (typeof root._persist === 'string') {
      persistMeta = JSON.parse(root._persist) as { version?: unknown }
    }
    const sourcePersistVersion = typeof persistMeta?.version === 'number' ? persistMeta.version : null
    let slice: { assistants?: Array<{ id?: unknown; topics?: unknown }> } | null = null
    if (typeof root.assistants === 'string') {
      slice = JSON.parse(root.assistants) as { assistants?: Array<{ id?: unknown; topics?: unknown }> }
    }
    const rawAssistants = Array.isArray(slice?.assistants) ? slice.assistants : []
    const idbById = new Set(idbTopicIds)

    const assistants: Array<{ id: string; order: number }> = []
    const topics: Array<{ id: string; assistantId: string; order: number; deletedAt: string | null }> = []
    const topicIds = new Set<string>()
    let droppedLsTopicCount = 0

    rawAssistants.forEach((raw, order) => {
      if (!raw || typeof raw.id !== 'string') return
      // Capture the narrowed id: the nested callback below re-opens the
      // narrowing scope, so the container id must be a plain string here.
      const containerId: string = raw.id
      assistants.push({ id: containerId, order })
      const rawTopics = Array.isArray(raw.topics) ? raw.topics : []
      rawTopics.forEach((rawTopic: unknown, topicOrder) => {
        const t = rawTopic as { id?: unknown; deletedAt?: unknown }
        if (!t || typeof t.id !== 'string') return
        if (!idbById.has(t.id)) {
          // LOCK-PROD-3: LS-only topics are dropped (deleted topic included).
          droppedLsTopicCount++
          return
        }
        if (topicIds.has(t.id)) {
          droppedLsTopicCount++
          return
        }
        topicIds.add(t.id)
        topics.push({
          id: t.id,
          // LOCK-PROD-2: the OUTER container owns grouping.
          assistantId: containerId,
          order: topicOrder,
          deletedAt: typeof t.deletedAt === 'string' ? t.deletedAt : null
        })
      })
    })

    const recoveredTopicIds = idbTopicIds.filter((id) => !topicIds.has(id))
    return { sourcePersistVersion, assistants, topics, recoveredTopicIds, droppedLsTopicCount }
  }

  it('yields the two fixture assistants and groups the visible topic by its container', () => {
    // Only t-e2e-1 exists in IndexedDB (the IDB row count is kept stable).
    const projection = mirrorProjection(buildSeedPersistedState(), [SOURCE_IDS.topic])

    expect(projection.sourcePersistVersion).toBe(SEED_PERSIST_VERSION)
    expect(projection.assistants).toEqual([
      { id: PROJECTION_ASSISTANTS.first.id, order: 0 },
      { id: PROJECTION_ASSISTANTS.second.id, order: 1 }
    ])
    // The stale inner assistantId is ignored — the container owns grouping.
    expect(projection.topics).toEqual([
      {
        id: SOURCE_IDS.topic,
        assistantId: PROJECTION_ASSISTANTS.first.id,
        order: 0,
        deletedAt: null
      }
    ])
    // No IDB topic lacks LS metadata → nothing recovered.
    expect(projection.recoveredTopicIds).toEqual([])
  })

  it('drops the LS-only deleted topic as ls-topic-missing-in-idb (LOCK-PROD-3)', () => {
    const projection = mirrorProjection(buildSeedPersistedState(), [SOURCE_IDS.topic])
    expect(projection.droppedLsTopicCount).toBe(1)
    // The deleted topic id must NOT surface in the projection topics.
    expect(projection.topics.some((t) => t.id === PROJECTION_TOPICS.deleted.id)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ZIP production + exact roots (LOCK-E2)
// ---------------------------------------------------------------------------

describe('produceSeedZip (LOCK-E2 exact roots, no Data/)', () => {
  it('zips EXACTLY the IndexedDB and Local Storage/leveldb subtrees', async () => {
    const root = tempDir()
    const profileDevDir = syntheticProfileDevDir(root)
    const zipPath = path.join(root, 'seed.zip')

    const result = produceSeedZip(profileDevDir, zipPath)
    expect(result.originDir).toBe(SEED_ORIGIN_DIR)
    expect(result.ldbFileCount).toBeGreaterThanOrEqual(1)
    expect(result.localStorageLdbFileCount).toBeGreaterThanOrEqual(1)
    expect(fs.statSync(zipPath).size).toBeGreaterThan(0)

    // Independent central-directory verification (LOCK-E2).
    const names = await zipEntryNames(zipPath)
    const roots = Array.from(new Set(names.map((n) => n.split('/')[0]))).sort()
    expect(roots).toEqual(['IndexedDB', SEED_LOCAL_STORAGE_ROOT])
    expect(names.some((n) => n === 'Data' || n.startsWith('Data/'))).toBe(false)
    expect(names.some((n) => n.includes('.indexeddb.blob'))).toBe(false)

    // The IndexedDB origin subtree with its .ldb table file is present.
    const originPrefix = `IndexedDB/${SEED_ORIGIN_DIR}/`
    expect(names.some((n) => n === `${originPrefix}CURRENT`)).toBe(true)
    expect(names.some((n) => n.startsWith(originPrefix) && n.endsWith('.ldb'))).toBe(true)
    // The Local Storage/leveldb subtree with its CURRENT marker is present.
    const lsPrefix = `${SEED_LOCAL_STORAGE_LEVELDB_DIR}/`
    expect(names.some((n) => n === `${lsPrefix}CURRENT`)).toBe(true)
    expect(names.some((n) => n.startsWith(lsPrefix) && n.endsWith('.ldb'))).toBe(true)
  })

  it('fails closed when the Local Storage backing store is absent (LOCK-E3)', () => {
    const root = tempDir()
    const profileDevDir = path.join(root, 'profileDev')
    const originDir = path.join(profileDevDir, 'IndexedDB', SEED_ORIGIN_DIR)
    fs.mkdirSync(originDir, { recursive: true })
    fs.writeFileSync(path.join(originDir, 'CURRENT'), 'MANIFEST-000001\n')
    fs.writeFileSync(path.join(originDir, '000005.ldb'), 'table-data')

    const zipPath = path.join(root, 'seed.zip')
    expect(() => produceSeedZip(profileDevDir, zipPath)).toThrow(/Local Storage leveldb directory/)
    expect(fs.existsSync(zipPath)).toBe(false)
  })

  it('fails closed when the Local Storage LevelDB has no CURRENT marker', () => {
    const root = tempDir()
    const profileDevDir = syntheticProfileDevDir(root)
    // Corrupt the Local Storage LevelDB: remove CURRENT.
    fs.rmSync(path.join(profileDevDir, 'Local Storage', 'leveldb', 'CURRENT'))

    const zipPath = path.join(root, 'seed.zip')
    expect(() => produceSeedZip(profileDevDir, zipPath)).toThrow(/no CURRENT marker/)
    expect(fs.existsSync(zipPath)).toBe(false)
  })

  it('fails closed when the IndexedDB origin has no .ldb table file', () => {
    const root = tempDir()
    const profileDevDir = syntheticProfileDevDir(root)
    // Remove every IndexedDB .ldb (memtable never flushed → Layer 4 reject).
    const originDir = path.join(profileDevDir, 'IndexedDB', SEED_ORIGIN_DIR)
    for (const file of fs.readdirSync(originDir)) {
      if (file.endsWith('.ldb')) fs.rmSync(path.join(originDir, file))
    }

    const zipPath = path.join(root, 'seed.zip')
    expect(() => produceSeedZip(profileDevDir, zipPath)).toThrow(/no \.ldb files/)
    expect(fs.existsSync(zipPath)).toBe(false)
  })
})
