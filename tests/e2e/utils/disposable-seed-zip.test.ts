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
import crypto from 'node:crypto'

import StreamZip from 'node-stream-zip'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ATTACHMENT_BLOCK_IDS,
  ATTACHMENT_FILES,
  ATTACHMENT_MESSAGE_ID,
  ATTACHMENT_MISSING_CLAIMED_BYTES,
  ATTACHMENT_PAYLOADS,
  attachmentExpectedClassification,
  buildAttachmentCatalogRows,
  buildAttachmentPayloadEntries,
  buildAttachmentSeedConfig,
  buildSeedPersistedState,
  parsePersistWireValue,
  preflightZipEntries,
  produceSeedZip,
  type AttachmentCatalogRow,
  PROJECTION_ASSISTANTS,
  PROJECTION_TOPICS,
  SEED_LOCAL_STORAGE_LEVELDB_DIR,
  SEED_LOCAL_STORAGE_ROOT,
  SEED_ORIGIN_DIR,
  SEED_PERSIST_VERSION,
  SOURCE_IDS,
  STALE_TOPIC_ASSISTANT_ID,
  validateRuntimeSeedProfile
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
 * runtime profile directory path.
 */
function syntheticRuntimeProfileDir(root: string): string {
  const runtimeProfileDir = path.join(root, 'runtime-profile')
  const originDir = path.join(runtimeProfileDir, 'IndexedDB', SEED_ORIGIN_DIR)
  const lsDir = path.join(runtimeProfileDir, 'Local Storage', 'leveldb')
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
  return runtimeProfileDir
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

/** Read one ZIP entry's bytes (independent oracle — node-stream-zip). */
async function readZipEntry(zipPath: string, entryName: string): Promise<Buffer> {
  const zip = new StreamZip.async({ file: zipPath })
  try {
    return await zip.entryData(entryName)
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
    const runtimeProfileDir = syntheticRuntimeProfileDir(root)
    const zipPath = path.join(root, 'seed.zip')

    const result = produceSeedZip(runtimeProfileDir, zipPath)
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
    const runtimeProfileDir = path.join(root, 'runtime-profile')
    const originDir = path.join(runtimeProfileDir, 'IndexedDB', SEED_ORIGIN_DIR)
    fs.mkdirSync(originDir, { recursive: true })
    fs.writeFileSync(path.join(originDir, 'CURRENT'), 'MANIFEST-000001\n')
    fs.writeFileSync(path.join(originDir, '000005.ldb'), 'table-data')

    const zipPath = path.join(root, 'seed.zip')
    expect(() => produceSeedZip(runtimeProfileDir, zipPath)).toThrow(/Local Storage leveldb directory/)
    expect(fs.existsSync(zipPath)).toBe(false)
  })

  it('fails closed when the Local Storage LevelDB has no CURRENT marker', () => {
    const root = tempDir()
    const runtimeProfileDir = syntheticRuntimeProfileDir(root)
    // Corrupt the Local Storage LevelDB: remove CURRENT.
    fs.rmSync(path.join(runtimeProfileDir, 'Local Storage', 'leveldb', 'CURRENT'))

    const zipPath = path.join(root, 'seed.zip')
    expect(() => produceSeedZip(runtimeProfileDir, zipPath)).toThrow(/no CURRENT marker/)
    expect(fs.existsSync(zipPath)).toBe(false)
  })

  it('fails closed when the IndexedDB origin has no .ldb table file', () => {
    const root = tempDir()
    const runtimeProfileDir = syntheticRuntimeProfileDir(root)
    // Remove every IndexedDB .ldb (memtable never flushed → Layer 4 reject).
    const originDir = path.join(runtimeProfileDir, 'IndexedDB', SEED_ORIGIN_DIR)
    for (const file of fs.readdirSync(originDir)) {
      if (file.endsWith('.ldb')) fs.rmSync(path.join(originDir, file))
    }

    const zipPath = path.join(root, 'seed.zip')
    expect(() => produceSeedZip(runtimeProfileDir, zipPath)).toThrow(/no \.ldb files/)
    expect(fs.existsSync(zipPath)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Runtime seed profile ownership (IMPLEMENTATION-004)
// ---------------------------------------------------------------------------

describe('validateRuntimeSeedProfile (IMPLEMENTATION-004 fail-closed ownership)', () => {
  /** One canonical owned root per call (realpath'd so /var → /private/var). */
  function canonicalOwnedRoot(): string {
    return fs.realpathSync(tempDir())
  }

  it('accepts the exact runtime path (runtime appDataPath === launch token)', () => {
    const root = canonicalOwnedRoot()
    const token = path.join(root, 'cherry-e2e-seed-token-accept')
    fs.mkdirSync(token, { recursive: true })

    const result = validateRuntimeSeedProfile(token, root, token)

    expect(result.runtimeProfileDir).toBe(fs.realpathSync(token))
    expect(result.canonicalProfileDir).toBe(fs.realpathSync(token))
  })

  it('accepts a runtime path reported through a symlinked parent (macOS /var → /private/var normalization)', () => {
    const base = fs.realpathSync(os.tmpdir())
    const root = canonicalOwnedRoot()
    const token = path.join(root, 'cherry-e2e-seed-token-symlink-parent')
    fs.mkdirSync(token, { recursive: true })

    // Alias that resolves to the canonical temp base, mirroring macOS where
    // /var is a symlink to /private/var. Electron may report the runtime
    // path through the alias form while the owned root is canonical.
    const alias = fs.mkdtempSync(path.join(base, 'cherry-e2e-alias-'))
    fs.rmdirSync(alias)
    fs.symlinkSync(base, alias)
    tempDirs.push(alias)
    const runtimePath = path.join(alias, path.basename(root), path.basename(token))

    const result = validateRuntimeSeedProfile(token, root, runtimePath)

    expect(result.runtimeProfileDir).toBe(fs.realpathSync(token))
  })

  it('rejects a runtime path whose canonical parent is a different owned root', () => {
    const root = canonicalOwnedRoot()
    const otherRoot = canonicalOwnedRoot()
    const token = path.join(root, 'cherry-e2e-seed-token-parent')
    fs.mkdirSync(token, { recursive: true })
    const runtimePath = path.join(otherRoot, path.basename(token))
    fs.mkdirSync(runtimePath, { recursive: true })

    expect(() => validateRuntimeSeedProfile(token, root, runtimePath)).toThrow(/canonical parent/)
  })

  it('rejects a runtime path with the same parent but a different child token basename', () => {
    const root = canonicalOwnedRoot()
    const token = path.join(root, 'cherry-e2e-seed-token-a')
    fs.mkdirSync(token, { recursive: true })
    const runtimePath = path.join(root, 'cherry-e2e-seed-token-b')
    fs.mkdirSync(runtimePath, { recursive: true })

    expect(() => validateRuntimeSeedProfile(token, root, runtimePath)).toThrow(/basename/)
  })

  it('rejects a runtime path that resolves outside the owned root through a symlinked parent', () => {
    const base = fs.realpathSync(os.tmpdir())
    const root = canonicalOwnedRoot()
    const token = path.join(root, 'cherry-e2e-seed-token-symlink-outside')
    fs.mkdirSync(token, { recursive: true })

    // Runtime path carries the token basename but its canonical parent is a
    // directory OUTSIDE the owned root (a config-redirect-shaped mismatch).
    const outside = fs.mkdtempSync(path.join(base, 'cherry-e2e-outside-'))
    tempDirs.push(outside)
    const alias = path.join(root, 'outside-alias')
    fs.symlinkSync(outside, alias)
    tempDirs.push(alias)
    const runtimePath = path.join(alias, path.basename(token))

    expect(() => validateRuntimeSeedProfile(token, root, runtimePath)).toThrow(/canonical parent/)
  })

  it('rejects a launch token that is not a direct child of the canonical owned root', () => {
    const root = canonicalOwnedRoot()
    const otherRoot = canonicalOwnedRoot()
    const token = path.join(otherRoot, 'cherry-e2e-seed-token-elsewhere')
    fs.mkdirSync(token, { recursive: true })

    expect(() => validateRuntimeSeedProfile(token, root, token)).toThrow(/not a direct child/)
  })

  it('rejects a non-absolute or empty runtime path (fail closed)', () => {
    const root = canonicalOwnedRoot()
    const token = path.join(root, 'cherry-e2e-seed-token-shape')
    fs.mkdirSync(token, { recursive: true })

    expect(() => validateRuntimeSeedProfile(token, root, '')).toThrow(/not a non-empty string/)
    expect(() => validateRuntimeSeedProfile(token, root, 'relative/profile')).toThrow(/must be absolute/)
  })

  it('uses the validated runtime profile dir to produce the seed ZIP (path use)', async () => {
    const root = canonicalOwnedRoot()
    const token = path.join(root, 'cherry-e2e-seed-token-produce')
    // Build the real IndexedDB + Local Storage structure INSIDE the token so
    // the validated runtime path is the ZIP source.
    fs.mkdirSync(path.join(token, 'IndexedDB', SEED_ORIGIN_DIR), { recursive: true })
    fs.mkdirSync(path.join(token, 'Local Storage', 'leveldb'), { recursive: true })
    fs.writeFileSync(path.join(token, 'IndexedDB', SEED_ORIGIN_DIR, 'CURRENT'), 'MANIFEST-000001\n')
    fs.writeFileSync(path.join(token, 'IndexedDB', SEED_ORIGIN_DIR, '000005.ldb'), 'table-data'.repeat(1024))
    fs.writeFileSync(path.join(token, 'Local Storage', 'leveldb', 'CURRENT'), 'MANIFEST-000001\n')
    fs.writeFileSync(path.join(token, 'Local Storage', 'leveldb', '000005.ldb'), 'ls-table-data'.repeat(1024))

    const { runtimeProfileDir } = validateRuntimeSeedProfile(token, root, token)
    const zipPath = path.join(root, 'seed-validated.zip')
    const result = produceSeedZip(runtimeProfileDir, zipPath)

    expect(result.ldbFileCount).toBeGreaterThanOrEqual(1)
    expect(result.localStorageLdbFileCount).toBeGreaterThanOrEqual(1)
    expect(fs.statSync(zipPath).size).toBeGreaterThan(0)
    const names = await zipEntryNames(zipPath)
    const originPrefix = `IndexedDB/${SEED_ORIGIN_DIR}/`
    expect(names.some((n) => n.startsWith(originPrefix) && n.endsWith('.ldb'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Attachment variant (LOCK-E2-FIX)
// ---------------------------------------------------------------------------

describe('attachment variant payload assets (LOCK-E2-FIX-2/3)', () => {
  it('embeds a valid deterministic tiny PNG (magic + IEND, pinned bytes)', () => {
    const png = ATTACHMENT_PAYLOADS.png
    // 1×1 transparent PNG: 70 bytes, valid PNG magic + IEND chunk.
    expect(png.length).toBe(70)
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    // IEND chunk signature (12 bytes incl. length + CRC).
    expect(png.subarray(-8)).toEqual(Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]))
    // Deterministic across calls.
    expect(ATTACHMENT_PAYLOADS.png.equals(png)).toBe(true)
  })

  it('embeds deterministic text payloads (pinned multi-byte UTF-8 lengths)', () => {
    const txt = ATTACHMENT_PAYLOADS.txt
    const orphan = ATTACHMENT_PAYLOADS.orphan
    // Em-dash is multi-byte UTF-8: byte length must differ from char length.
    const txtChars = txt.toString('utf8')
    const orphanChars = orphan.toString('utf8')
    expect(txt.length).toBeGreaterThan(txtChars.length)
    expect(orphan.length).toBeGreaterThan(orphanChars.length)
    // Pinned exact byte lengths.
    expect(txt.length).toBe(101)
    expect(orphan.length).toBe(116)
    expect(ATTACHMENT_PAYLOADS.txt.equals(txt)).toBe(true)
    expect(ATTACHMENT_PAYLOADS.orphan.equals(orphan)).toBe(true)
  })
})

describe('attachment scenario contract (LOCK-E2-FIX-2/3/5)', () => {
  it('builds a deterministic seed config with fixed ids/names/sizes/timestamps', () => {
    const a = buildAttachmentSeedConfig()
    const b = buildAttachmentSeedConfig()
    expect(a).toEqual(b)

    const catalog = buildAttachmentCatalogRows()
    expect(catalog.map((f) => f.id)).toEqual([
      'f-e2e-att-png',
      'f-e2e-att-txt',
      'f-e2e-att-missing',
      'f-e2e-att-orphan'
    ])
    for (const row of catalog) {
      // Canonical physical filename (LOCK-FIX-6) and fake normalized path.
      expect(row.name).toBe(`${row.id}${row.ext}`)
      expect(row.path.startsWith('/fake/')).toBe(true)
    }
    // Sizes: payload lengths for healthy/orphan, claimed bytes for missing.
    expect(catalog[0].size).toBe(ATTACHMENT_PAYLOADS.png.length)
    expect(catalog[1].size).toBe(ATTACHMENT_PAYLOADS.txt.length)
    expect(catalog[2].size).toBe(ATTACHMENT_MISSING_CLAIMED_BYTES)
    expect(catalog[3].size).toBe(ATTACHMENT_PAYLOADS.orphan.length)
    // Reference counts: 1 for referenced, 0 for the browser-only orphan.
    expect(catalog.map((f) => f.count)).toEqual([1, 1, 1, 0])
  })

  it('seeds three attachment blocks owned by the deterministic message (LOCK-E2-FIX-5)', () => {
    const cfg = buildAttachmentSeedConfig()

    // The attachment message is embedded in topic t-e2e-1 (imported).
    expect(cfg.message.id).toBe(ATTACHMENT_MESSAGE_ID)
    expect(cfg.message.topicId).toBe(SOURCE_IDS.topic)
    expect(cfg.message.blocks).toEqual([...ATTACHMENT_BLOCK_IDS])

    // Exactly three blocks: png image, txt file, missing image.
    expect(cfg.blocks).toHaveLength(3)
    const blockFileIds = cfg.blocks.map((b: any) => b.file.id)
    expect(blockFileIds).toEqual(['f-e2e-att-png', 'f-e2e-att-txt', 'f-e2e-att-missing'])
    expect(cfg.blocks.map((b: any) => b.type)).toEqual(['image', 'file', 'image'])
    for (const block of cfg.blocks) {
      expect(block.messageId).toBe(ATTACHMENT_MESSAGE_ID)
      const file = (block as any).file
      expect(file.path.startsWith('/fake/')).toBe(true)
      expect(file.name).toBeDefined()
    }
    // The orphan has a catalog row + payload but NO block (browser-only).
    expect(cfg.blocks.some((b: any) => b.file.id === 'f-e2e-att-orphan')).toBe(false)
    expect(cfg.files).toHaveLength(4)
  })

  it('exposes the exact deterministic scenario facts (LOCK-E2-FIX-3)', () => {
    expect(ATTACHMENT_FILES.map((f) => f.id)).toEqual([
      'f-e2e-att-png',
      'f-e2e-att-txt',
      'f-e2e-att-missing',
      'f-e2e-att-orphan'
    ])
    expect(ATTACHMENT_MESSAGE_ID).toBe('m-e2e-att-1')
    expect([...ATTACHMENT_BLOCK_IDS]).toEqual(['b-e2e-att-png', 'b-e2e-att-txt', 'b-e2e-att-missing'])
    // Exactly one file has no payload (the missing referenced one).
    expect(ATTACHMENT_FILES.filter((f) => f.payloadKey === null).map((f) => f.id)).toEqual(['f-e2e-att-missing'])
  })

  it('computes the expected attachment-plane classification (LOCK-E2-FIX-2)', () => {
    expect(attachmentExpectedClassification()).toEqual({
      referencedFileIdCount: 3,
      healthyFileCount: 3,
      degradedMissingPayload: 1,
      degradedFileIds: ['f-e2e-att-missing'],
      skippedPayloadWithoutCatalog: 0
    })
  })
})

describe('embedded file bag metadata (LOCK-E2-FIX FileManager realism)', () => {
  /**
   * Utility assertions: the `file` bag embedded on a seeded message block is
   * a complete production FileMetadata whose name/id/ext/origin_name/path/
   * type/size/count/timestamp each match its catalog row, and whose target
   * URL suffix (`id + ext`) resolves to the canonical physical filename —
   * the exact `filesPath/<id><ext>` FileManager path/URL contract.
   */
  function expectEmbeddedFileBagMatchesCatalog(
    block: { file: Record<string, unknown> },
    row: AttachmentCatalogRow
  ): void {
    const file = block.file
    // Name is the canonical physical filename `<id><ext>`, never origin_name.
    expect(file.name).toBe(row.name)
    expect(file.id).toBe(row.id)
    expect(file.ext).toBe(row.ext)
    expect(file.origin_name).toBe(row.origin_name)
    // Fake source path is retained unchanged on the embedded bag.
    expect(file.path).toBe(row.path)
    expect(String(file.path).startsWith('/fake/')).toBe(true)
    expect(file.type).toBe(row.type)
    expect(file.size).toBe(row.size)
    expect(file.count).toBe(row.count)
    expect(file.created_at).toBe(row.created_at)
    // Target URL suffix: FileManager resolves the physical payload as
    // `filesPath/<id><ext>` (getFilePath/getFileUrl) — the canonical name.
    expect(`${file.id}${file.ext}`).toBe(row.name)
  }

  it('seeds a complete FileMetadata bag matching its catalog row for every block', () => {
    const cfg = buildAttachmentSeedConfig()
    const catalog = buildAttachmentCatalogRows()
    const catalogById = new Map(catalog.map((row) => [row.id, row]))
    const payloadNames = new Set(buildAttachmentPayloadEntries().map((p) => p.name))

    // Exactly the three referenced blocks (the orphan has no block).
    expect(cfg.blocks).toHaveLength(3)
    for (const block of cfg.blocks) {
      const file = (block as { file: Record<string, unknown> }).file
      const row = catalogById.get(file.id as string)
      expect(row, `catalog row for ${file.id}`).toBeDefined()
      expectEmbeddedFileBagMatchesCatalog(block as { file: Record<string, unknown> }, row!)
      // Healthy bags resolve to a real Data/Files payload basename; the
      // missing referenced file has NO payload by design (LOCK-E2-FIX-2).
      const seed = ATTACHMENT_FILES.find((f) => f.id === file.id)
      expect(seed, `seed entry for ${file.id}`).toBeDefined()
      if (seed!.payloadKey !== null) {
        expect(payloadNames).toContain(`${file.id}${file.ext}`)
      }
    }
  })

  it('keeps the missing referenced file bag count/timestamp/size consistent (LOCK-E2-FIX)', () => {
    const cfg = buildAttachmentSeedConfig()
    const catalog = buildAttachmentCatalogRows()
    const missingBlock = cfg.blocks.find((b: any) => b.file.id === 'f-e2e-att-missing')
    const missingRow = catalog.find((row) => row.id === 'f-e2e-att-missing')

    expect(missingBlock).toBeDefined()
    expect(missingRow).toBeDefined()
    expectEmbeddedFileBagMatchesCatalog(missingBlock as { file: Record<string, unknown> }, missingRow!)
    // No payload exists, but the claimed size and reference count stay fixed.
    expect(missingRow!.size).toBe(ATTACHMENT_MISSING_CLAIMED_BYTES)
    expect(missingRow!.count).toBe(1)
    // The missing file has NO Data/Files payload entry.
    expect(buildAttachmentPayloadEntries().map((p) => p.name)).not.toContain('f-e2e-att-missing.png')
  })
})

describe('produceSeedZip + preflight with Data/Files payloads (LOCK-E2-FIX-4)', () => {
  it('writes Data/Files entries AFTER the Chromium subtrees with exact bytes', async () => {
    const root = tempDir()
    const runtimeProfileDir = syntheticRuntimeProfileDir(root)
    const zipPath = path.join(root, 'seed-att.zip')
    const payloads = buildAttachmentPayloadEntries()

    // Exactly the three healthy/orphan payloads — NOT the missing file.
    expect(payloads.map((p) => p.name)).toEqual(['f-e2e-att-png.png', 'f-e2e-att-txt.txt', 'f-e2e-att-orphan.txt'])

    const result = produceSeedZip(runtimeProfileDir, zipPath, { payloadEntries: payloads })
    expect(result.dataFilesEntryCount).toBe(3)

    const names = await zipEntryNames(zipPath)
    const roots = Array.from(new Set(names.map((n) => n.split('/')[0]))).sort()
    expect(roots).toEqual(['Data', 'IndexedDB', SEED_LOCAL_STORAGE_ROOT])

    // Exact Data/Files inventory (sorted, independent oracle).
    const dataFiles = names.filter((n) => n.startsWith('Data/Files/') && !n.endsWith('/')).sort()
    expect(dataFiles).toEqual([
      'Data/Files/f-e2e-att-orphan.txt',
      'Data/Files/f-e2e-att-png.png',
      'Data/Files/f-e2e-att-txt.txt'
    ])
    expect(dataFiles.some((n) => n.includes('missing'))).toBe(false)

    // Byte-identical round-trip through the ZIP (independent oracle).
    for (const payload of payloads) {
      const entry = await readZipEntry(zipPath, `Data/Files/${payload.name}`)
      expect(entry.equals(payload.bytes)).toBe(true)
    }
  })

  it('preflight verifies payload inventory, bytes and SHA-256 (LOCK-E2-FIX-4)', async () => {
    const root = tempDir()
    const runtimeProfileDir = syntheticRuntimeProfileDir(root)
    const zipPath = path.join(root, 'seed-att.zip')
    const payloads = buildAttachmentPayloadEntries()
    produceSeedZip(runtimeProfileDir, zipPath, { payloadEntries: payloads })

    const preflight = await preflightZipEntries(zipPath, SEED_ORIGIN_DIR, {
      allowDataFiles: true,
      expectedPayloads: payloads
    })

    expect(preflight.payloadsAllVerified).toBe(true)
    expect(preflight.dataFilesEntries).toEqual([
      'Data/Files/f-e2e-att-orphan.txt',
      'Data/Files/f-e2e-att-png.png',
      'Data/Files/f-e2e-att-txt.txt'
    ])
    expect(preflight.payloadVerification).toHaveLength(3)
    for (const payload of payloads) {
      const verified = preflight.payloadVerification.find((v) => v.name === payload.name)
      expect(verified).toBeDefined()
      expect(verified!.size).toBe(payload.bytes.length)
      expect(verified!.bytesEqual).toBe(true)
      // Independent SHA-256 oracle.
      expect(verified!.sha256).toBe(crypto.createHash('sha256').update(payload.bytes).digest('hex'))
    }
    // The missing referenced file is NOT inventoried.
    expect(preflight.dataFilesEntries.some((n) => n.includes('missing'))).toBe(false)
  })

  it('rejects the attachment ZIP when allowDataFiles is false (LOCK-E2 preserved)', async () => {
    const root = tempDir()
    const runtimeProfileDir = syntheticRuntimeProfileDir(root)
    const zipPath = path.join(root, 'seed-att.zip')
    const payloads = buildAttachmentPayloadEntries()
    produceSeedZip(runtimeProfileDir, zipPath, { payloadEntries: payloads })

    // LOCK-E2: Data/Files is an unrelated root for the default contract.
    await expect(preflightZipEntries(zipPath, SEED_ORIGIN_DIR)).rejects.toThrow(/outside the allowed roots/)
  })

  it('fails closed on a missing expected payload', async () => {
    const root = tempDir()
    const runtimeProfileDir = syntheticRuntimeProfileDir(root)
    const zipPath = path.join(root, 'seed-att.zip')
    const payloads = buildAttachmentPayloadEntries()
    produceSeedZip(runtimeProfileDir, zipPath, { payloadEntries: payloads })

    // Ask for a payload that was never written (the missing file).
    const wrongExpectation = [{ name: 'f-e2e-att-missing.png', bytes: ATTACHMENT_PAYLOADS.png }]
    await expect(
      preflightZipEntries(zipPath, SEED_ORIGIN_DIR, { allowDataFiles: true, expectedPayloads: wrongExpectation })
    ).rejects.toThrow(/inventory mismatch/)
  })

  it('fails closed on an unexpected Data/Files entry', async () => {
    const root = tempDir()
    const runtimeProfileDir = syntheticRuntimeProfileDir(root)
    const zipPath = path.join(root, 'seed-att.zip')
    const payloads = buildAttachmentPayloadEntries()
    produceSeedZip(runtimeProfileDir, zipPath, { payloadEntries: payloads })

    // Same entry count (3) but one expected name swapped for an entry that is
    // NOT in the ZIP → the actual Data/Files entry with no expectation throws.
    const swappedExpectation = [payloads[0], payloads[1], { name: 'f-e2e-unknown.txt', bytes: Buffer.from('x') }]
    await expect(
      preflightZipEntries(zipPath, SEED_ORIGIN_DIR, { allowDataFiles: true, expectedPayloads: swappedExpectation })
    ).rejects.toThrow(/unexpected Data\/Files entry/)
  })

  it('default produceSeedZip writes no Data/Files entries (default fixture unchanged)', async () => {
    const root = tempDir()
    const runtimeProfileDir = syntheticRuntimeProfileDir(root)
    const zipPath = path.join(root, 'seed-default.zip')
    const result = produceSeedZip(runtimeProfileDir, zipPath)
    expect(result.dataFilesEntryCount).toBe(0)

    const names = await zipEntryNames(zipPath)
    expect(names.some((n) => n === 'Data' || n.startsWith('Data/'))).toBe(false)
  })
})
