/**
 * Phase 4.0-B Fixture Generators
 *
 * Creates deterministic synthetic IndexedDB profiles using Chromium/Dexie APIs.
 * Each generator:
 *  1. Opens a dedicated Dexie instance at a specific schema version
 *  2. Populates deterministic data exercising production upgrade paths
 *  3. Closes the instance (flushes to IndexedDB/LevelDB)
 *  4. Returns metadata for the manifest
 *
 * Importable only from the spike renderer entry point.
 * Does NOT import renderer-specific types; uses raw objects matching
 * the Dexie store declarations from databases/index.ts.
 */
import type { FixtureDonePayload, FixtureId } from '@shared/phase4FixtureManifest'
import Dexie from 'dexie'

/* ── Deterministic constants ── */

const T_V4 = '2024-01-15T10:00:00.000Z'
const T_V11A = '2024-06-01T10:00:00.000Z'
const T_V11B = '2024-06-02T10:00:00.000Z'
const T_V12 = '2024-07-01T10:00:00.000Z'

/* ── Helpers ── */

/**
 * Obtain the actual native IndexedDB version for the given database name
 * using the Web API `indexedDB.databases()`.
 *
 * This is the ONLY reliable way to get the native IDB version in a browser
 * context. `db.verno` returns the Dexie *logical* version (e.g. 4), not the
 * native IDB version (e.g. 40). Dexie 4.x uses native = logical * 10.
 */
async function getActualNativeVersion(dbName: string): Promise<number> {
  const dbs = await indexedDB.databases()
  const found = dbs.find((d) => d.name === dbName)
  if (!found || found.version === undefined) {
    throw new Error(
      `Database "${dbName}" not found or has no version via indexedDB.databases(). ` +
        `Available: [${dbs.map((d) => d.name).join(', ')}]`
    )
  }
  return found.version
}

async function getVersionAndCounts(db: Dexie): Promise<{
  logicalDexieVersion: number
  observedNativeVersion: number
  tables: string[]
  recordCounts: Record<string, number>
}> {
  // Logical version from Dexie (e.g. 4, 11, 12)
  const logicalDexieVersion: number = db.verno

  // Actual native IDB version from the browser API (e.g. 40, 110, 120)
  const observedNativeVersion = await getActualNativeVersion(db.name)

  const tables = db.tables.map((t) => t.name)
  const recordCounts: Record<string, number> = {}
  for (const table of db.tables) {
    recordCounts[table.name] = await table.count()
  }
  return { logicalDexieVersion, observedNativeVersion, tables, recordCounts }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* ══════════════════════════════════════════════════════════════════════════
 * v4 Fixture: Dexie version 4, native IDB version 40
 *
 * Data shape exercises:
 *  - v5 upgrade: Date-valued files.created_at, legacy Tavily metadata
 *  - v7 upgrade: legacy message format (content, reasoning_content,
 *    files, metadata.webSearchInfo) → message_blocks normalization
 *  - v8 upgrade: old-style translate language names (english/chinese)
 *
 * Limitations (explicit):
 *  - v7 MCP tool blocks not exercised (synthetic data has no mcpTools)
 *  - v7 image-from-metadata not exercised (no generateImage)
 *  - v7 groundingMetadata/annotations/citations not exercised
 *  - v5 file type enum migration not exercised (synthetic data uses valid types)
 * ══════════════════════════════════════════════════════════════════════════ */

async function generateV4(): Promise<FixtureDonePayload> {
  const db = new Dexie('CherryStudio', { chromeTransactionDurability: 'strict' })

  // Exact v4 store declarations from databases/index.ts
  db.version(4).stores({
    files: 'id, name, origin_name, path, size, ext, type, created_at, count',
    topics: '&id, messages',
    settings: '&id, value',
    knowledge_notes: '&id, baseId, type, content, created_at, updated_at',
    translate_history: '&id, sourceText, targetText, sourceLanguage, targetLanguage, createdAt'
  })

  await db.open()

  /* ── files: Date-valued created_at (triggers v5 upgrade) ── */
  await db.table('files').put({
    id: 'file-v4-001',
    name: 'legacy-date-test.txt',
    origin_name: 'legacy-date-test.txt',
    path: '/tmp/legacy-date-test.txt',
    size: 1024,
    ext: '.txt',
    type: 'text',
    created_at: new Date('2024-01-15T10:30:00Z'), // Date object, NOT string
    count: 1
  })

  await db.table('files').put({
    id: 'file-v4-002',
    name: 'iso-date-file.txt',
    origin_name: 'iso-date-file.txt',
    path: '/tmp/iso-date-file.txt',
    size: 512,
    ext: '.txt',
    type: 'text',
    created_at: '2024-01-16T12:00:00Z', // Already ISO string — v5 should skip
    count: 0
  })

  /* ── topics: legacy messages exercising v5 (Tavily) + v7 normalization ── */

  // Topic 1: Tavily metadata → v5 converts to webSearch
  await db.table('topics').put({
    id: 'topic-v4-tavily',
    messages: [
      {
        id: 'msg-v4-user-001',
        assistantId: 'asst-001',
        role: 'user',
        content: 'Search for something',
        topicId: 'topic-v4-tavily',
        createdAt: T_V4,
        status: 'success',
        type: 'text'
      },
      {
        id: 'msg-v4-tavily-001',
        assistantId: 'asst-001',
        role: 'assistant',
        content: 'Here are the search results',
        topicId: 'topic-v4-tavily',
        createdAt: T_V4,
        status: 'success',
        type: 'text',
        metadata: {
          tavily: {
            query: 'deterministic test search',
            results: [
              { title: 'Test Result 1', url: 'https://example.com/1', content: 'Content for result 1' },
              { title: 'Test Result 2', url: 'https://example.com/2', content: 'Content for result 2' }
            ]
          }
        }
      }
    ]
  })

  // Topic 2: Legacy messages exercising v7 normalization paths
  await db.table('topics').put({
    id: 'topic-v4-legacy',
    messages: [
      // User message with content (v7 → MainTextBlock)
      {
        id: 'msg-v4-legacy-user',
        assistantId: 'asst-001',
        role: 'user',
        content: 'Analyze this data',
        topicId: 'topic-v4-legacy',
        createdAt: T_V4,
        status: 'success',
        type: 'text'
      },
      // Assistant with content + reasoning_content (v7 → MainTextBlock + ThinkingBlock)
      {
        id: 'msg-v4-legacy-thinking',
        assistantId: 'asst-001',
        role: 'assistant',
        content: 'Here is my analysis.',
        reasoning_content: 'Let me think through this step by step...',
        topicId: 'topic-v4-legacy',
        createdAt: T_V4,
        status: 'success',
        type: 'text',
        modelId: 'gpt-4',
        usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
        metrics: { completion_tokens: 200, time_completion_millsec: 5000, time_thinking_millsec: 1200 }
      },
      // Assistant with webSearchInfo (v7 → CitationBlock)
      {
        id: 'msg-v4-legacy-websearch',
        assistantId: 'asst-001',
        role: 'assistant',
        content: 'Based on web results:',
        topicId: 'topic-v4-legacy',
        createdAt: T_V4,
        status: 'success',
        type: 'text',
        metadata: {
          webSearchInfo: [{ title: 'Search Result', url: 'https://example.com/search', snippet: 'A useful snippet' }]
        }
      },
      // Assistant with translatedContent (v7 → TranslationBlock)
      {
        id: 'msg-v4-legacy-translated',
        assistantId: 'asst-001',
        role: 'assistant',
        content: 'Original content here.',
        translatedContent: '翻译内容在这里。',
        topicId: 'topic-v4-legacy',
        createdAt: T_V4,
        status: 'success',
        type: 'text'
      },
      // User with file attachment (v7 → FileBlock)
      {
        id: 'msg-v4-legacy-file',
        assistantId: 'asst-001',
        role: 'user',
        content: 'Please review this file',
        topicId: 'topic-v4-legacy',
        createdAt: T_V4,
        status: 'success',
        type: 'text',
        files: [
          {
            id: 'file-v4-inline-001',
            name: 'data.csv',
            origin_name: 'data.csv',
            path: '/tmp/data.csv',
            size: 2048,
            ext: '.csv',
            type: 'text',
            created_at: '2024-01-15T09:00:00Z',
            count: 0
          }
        ]
      },
      // Error message (v7 → ErrorBlock when content is empty)
      {
        id: 'msg-v4-legacy-error',
        assistantId: 'asst-001',
        role: 'assistant',
        content: '',
        topicId: 'topic-v4-legacy',
        createdAt: T_V4,
        status: 'error',
        type: 'text',
        error: { message: 'Rate limit exceeded', name: 'RateLimitError', stack: null }
      }
    ]
  })

  // Topic 3: empty messages array (v7 handles gracefully)
  await db.table('topics').put({
    id: 'topic-v4-empty',
    messages: []
  })

  /* ── settings: old-style translate language names (triggers v8 upgrade) ── */
  await db.table('settings').put({ id: 'translate:source:language', value: 'english' })
  await db.table('settings').put({ id: 'translate:target:language', value: 'chinese' })
  await db.table('settings').put({ id: 'translate:bidirectional:pair', value: ['english', 'chinese'] })

  /* ── translate_history: old-style language names (triggers v8 upgrade) ── */
  await db.table('translate_history').put({
    id: 'th-v4-001',
    sourceText: 'Hello world',
    targetText: '你好世界',
    sourceLanguage: 'english',
    targetLanguage: 'chinese',
    createdAt: T_V4
  })
  await db.table('translate_history').put({
    id: 'th-v4-002',
    sourceText: 'Good morning',
    targetText: 'おはようございます',
    sourceLanguage: 'english',
    targetLanguage: 'japanese',
    createdAt: T_V4
  })

  /* ── knowledge_notes ── */
  await db.table('knowledge_notes').put({
    id: 'kn-v4-001',
    baseId: 'kb-001',
    type: 'note',
    content: 'Deterministic knowledge note for v4 fixture',
    created_at: T_V4,
    updated_at: T_V4
  })

  /* ── Capture metadata, close ── */
  const meta = await getVersionAndCounts(db)
  db.close()
  await delay(200) // Allow Chromium to flush LevelDB

  return {
    fixtureId: 'v4',
    logicalDexieVersion: meta.logicalDexieVersion,
    observedNativeVersion: meta.observedNativeVersion,
    markers: {},
    localStorage: {},
    tables: meta.tables,
    recordCounts: meta.recordCounts,
    limitations: [
      'Synthetic data only; does not import production DB code.',
      'v5 coverage: Date-valued files.created_at, legacy Tavily metadata conversion.',
      'v7 coverage: content→MainTextBlock, reasoning_content→ThinkingBlock, ' +
        'webSearchInfo→CitationBlock, translatedContent→TranslationBlock, ' +
        'files→FileBlock, empty-content error→ErrorBlock.',
      'v8 coverage: old-style translate language names (english, chinese, japanese).',
      'NOT covered: v7 MCP tool blocks (no mcpTools in synthetic data).',
      'NOT covered: v7 image-from-metadata (no generateImage).',
      'NOT covered: v7 groundingMetadata/annotations/citations sources.',
      'NOT covered: v5 file.type enum migration (synthetic data uses valid types).',
      'NOT covered: v7 knowledge references (no metadata.knowledge).'
    ]
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * v11-A Fixture: Dexie version 11, marker A
 *
 * Current schema with deterministic marker data.
 * All tables populated. LocalStorage marker set.
 * ══════════════════════════════════════════════════════════════════════════ */

async function generateV11a(): Promise<FixtureDonePayload> {
  return generateV11WithMarker('v11a', 'A', T_V11A)
}

/* ══════════════════════════════════════════════════════════════════════════
 * v11-B Fixture: Dexie version 11, marker B
 *
 * Identical schema to v11-A, different marker values.
 * ══════════════════════════════════════════════════════════════════════════ */

async function generateV11b(): Promise<FixtureDonePayload> {
  return generateV11WithMarker('v11b', 'B', T_V11B)
}

/* ── Shared v11 generator ── */

async function generateV11WithMarker(
  fixtureId: 'v11a' | 'v11b',
  marker: string,
  ts: string
): Promise<FixtureDonePayload> {
  const lower = marker.toLowerCase()
  const db = new Dexie('CherryStudio', { chromeTransactionDurability: 'strict' })

  // Exact v11 store declarations from databases/index.ts
  db.version(11).stores({
    files: 'id, name, origin_name, path, size, ext, type, created_at, count',
    topics: '&id',
    settings: '&id, value',
    knowledge_notes: '&id, baseId, type, content, created_at, updated_at',
    translate_history: '&id, sourceText, targetText, sourceLanguage, targetLanguage, createdAt',
    translate_languages: '&id, langCode',
    quick_phrases: 'id',
    message_blocks: 'id, messageId, file.id',
    topic_segments: 'id, topicId'
  })

  await db.open()

  /* ── settings: marker ── */
  await db.table('settings').put({ id: `phase4:marker`, value: marker })
  await db.table('settings').put({ id: `phase4:fixtureId`, value: fixtureId })

  /* ── files ── */
  await db.table('files').put({
    id: `file-${lower}-001`,
    name: `marker-${lower}-file.txt`,
    origin_name: `marker-${lower}-file.txt`,
    path: `/tmp/marker-${lower}-file.txt`,
    size: 512,
    ext: '.txt',
    type: 'text',
    created_at: ts,
    count: 1
  })

  /* ── topics (v11: no messages index, messages stored inline) ── */
  await db.table('topics').put({
    id: `topic-${lower}-001`,
    messages: [
      {
        id: `msg-${lower}-001`,
        role: 'assistant',
        assistantId: 'asst-001',
        topicId: `topic-${lower}-001`,
        createdAt: ts,
        status: 'success',
        blocks: [`block-${lower}-001`]
      }
    ]
  })

  /* ── message_blocks ── */
  await db.table('message_blocks').put({
    id: `block-${lower}-001`,
    messageId: `msg-${lower}-001`,
    type: 'main_text',
    content: `Fixture ${marker} marker content: deterministic test data for Phase 4.0-B`,
    createdAt: ts,
    status: 'success'
  })

  /* ── topic_segments ── */
  await db.table('topic_segments').put({
    id: `seg-${lower}-001`,
    topicId: `topic-${lower}-001`,
    name: `Segment ${marker}-1`,
    messageIds: [`msg-${lower}-001`],
    color: marker === 'A' ? '#ff0000' : '#0000ff',
    createdAt: ts,
    updatedAt: ts
  })

  /* ── translate_languages ── */
  await db.table('translate_languages').put({
    id: `tl-${lower}-001`,
    langCode: 'en-us',
    value: 'English',
    emoji: '🇺🇸'
  })

  /* ── quick_phrases (createdAt/updatedAt are epoch ms numbers) ── */
  await db.table('quick_phrases').put({
    id: `qp-${lower}-001`,
    title: `Phrase ${marker}`,
    content: `Hello from fixture ${marker}`,
    createdAt: new Date(ts).getTime(),
    updatedAt: new Date(ts).getTime(),
    order: 0
  })

  /* ── knowledge_notes ── */
  await db.table('knowledge_notes').put({
    id: `kn-${lower}-001`,
    baseId: `kb-${lower}`,
    type: 'note',
    content: `Knowledge note for fixture ${marker}`,
    created_at: ts,
    updated_at: ts
  })

  /* ── translate_history ── */
  await db.table('translate_history').put({
    id: `th-${lower}-001`,
    sourceText: 'Hello',
    targetText: marker === 'A' ? '你好' : 'こんにちは',
    sourceLanguage: 'en-us',
    targetLanguage: marker === 'A' ? 'zh-cn' : 'ja-jp',
    createdAt: ts
  })

  /* ── Capture metadata ── */
  const meta = await getVersionAndCounts(db)

  /* ── LocalStorage marker (set before close) ── */
  const lsEntries: Record<string, string> = {}
  try {
    localStorage.setItem('phase4:marker', marker)
    localStorage.setItem('phase4:fixtureId', fixtureId)
    lsEntries['phase4:marker'] = marker
    lsEntries['phase4:fixtureId'] = fixtureId
  } catch {
    // localStorage may not be available in some contexts; not fatal
  }

  db.close()
  await delay(200)

  return {
    fixtureId,
    logicalDexieVersion: meta.logicalDexieVersion,
    observedNativeVersion: meta.observedNativeVersion,
    markers: { 'phase4:marker': marker, 'phase4:fixtureId': fixtureId },
    localStorage: lsEntries,
    tables: meta.tables,
    recordCounts: meta.recordCounts,
    limitations: [
      'Current-schema fixture; no upgrade paths exercised.',
      'Represents a clean Cherry Studio export at Dexie version 11.',
      `Marker: ${marker} (fixtureId: ${fixtureId}).`
    ]
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * v12 Fixture: Dexie version 12 (future), with extra table
 *
 * Extends v11 schema with a `future_markers` table.
 * When the verifier (v11 declaration) tries to open this, Dexie will
 * throw a VersionError because native version 12 > declared 11.
 * This tests pre-open rejection.
 * ══════════════════════════════════════════════════════════════════════════ */

async function generateV12(): Promise<FixtureDonePayload> {
  const db = new Dexie('CherryStudio', { chromeTransactionDurability: 'strict' })

  // v12 stores = v11 + future_markers table
  db.version(12).stores({
    files: 'id, name, origin_name, path, size, ext, type, created_at, count',
    topics: '&id',
    settings: '&id, value',
    knowledge_notes: '&id, baseId, type, content, created_at, updated_at',
    translate_history: '&id, sourceText, targetText, sourceLanguage, targetLanguage, createdAt',
    translate_languages: '&id, langCode',
    quick_phrases: 'id',
    message_blocks: 'id, messageId, file.id',
    topic_segments: 'id, topicId',
    future_markers: 'id, marker, createdAt'
  })

  await db.open()

  /* ── Populate v11 tables (same structure as v11 fixtures) ── */
  await db.table('settings').put({ id: 'phase4:marker', value: 'FUTURE_V12' })
  await db.table('settings').put({ id: 'phase4:fixtureId', value: 'v12' })

  await db.table('files').put({
    id: 'file-v12-001',
    name: 'future-file.txt',
    origin_name: 'future-file.txt',
    path: '/tmp/future-file.txt',
    size: 256,
    ext: '.txt',
    type: 'text',
    created_at: T_V12,
    count: 1
  })

  await db.table('topics').put({
    id: 'topic-v12-001',
    messages: [
      {
        id: 'msg-v12-001',
        role: 'assistant',
        assistantId: 'asst-001',
        topicId: 'topic-v12-001',
        createdAt: T_V12,
        status: 'success',
        blocks: ['block-v12-001']
      }
    ]
  })

  await db.table('message_blocks').put({
    id: 'block-v12-001',
    messageId: 'msg-v12-001',
    type: 'main_text',
    content: 'Future v12 marker content',
    createdAt: T_V12,
    status: 'success'
  })

  await db.table('topic_segments').put({
    id: 'seg-v12-001',
    topicId: 'topic-v12-001',
    name: 'Future Segment',
    messageIds: ['msg-v12-001'],
    color: '#00ff00',
    createdAt: T_V12,
    updatedAt: T_V12
  })

  await db.table('translate_languages').put({
    id: 'tl-v12-001',
    langCode: 'en-us',
    value: 'English',
    emoji: '🇺🇸'
  })

  await db.table('quick_phrases').put({
    id: 'qp-v12-001',
    title: 'Future Phrase',
    content: 'Hello from the future (v12)',
    createdAt: new Date(T_V12).getTime(),
    updatedAt: new Date(T_V12).getTime(),
    order: 0
  })

  await db.table('knowledge_notes').put({
    id: 'kn-v12-001',
    baseId: 'kb-v12',
    type: 'note',
    content: 'Future knowledge note (v12)',
    created_at: T_V12,
    updated_at: T_V12
  })

  await db.table('translate_history').put({
    id: 'th-v12-001',
    sourceText: 'Future',
    targetText: '未来',
    sourceLanguage: 'en-us',
    targetLanguage: 'zh-cn',
    createdAt: T_V12
  })

  /* ── future_markers: the v12-specific table ── */
  await db.table('future_markers').put({
    id: 'fm-v12-001',
    marker: 'FUTURE_V12_MARKER',
    createdAt: T_V12
  })

  const meta = await getVersionAndCounts(db)
  db.close()
  await delay(200)

  return {
    fixtureId: 'v12',
    logicalDexieVersion: meta.logicalDexieVersion,
    observedNativeVersion: meta.observedNativeVersion,
    markers: { 'phase4:marker': 'FUTURE_V12', 'phase4:fixtureId': 'v12' },
    localStorage: {},
    tables: meta.tables,
    recordCounts: meta.recordCounts,
    limitations: [
      'Future-version fixture. The verifier should reject this during pre-open checks.',
      'Native version 12 exceeds the production Dexie declaration (v11).',
      'Contains a future_markers table not present in the production schema.',
      'Pre-open rejection is the expected behavior — not a bug.'
    ]
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * Dispatcher
 * ══════════════════════════════════════════════════════════════════════════ */

export async function generateFixture(fixtureId: FixtureId): Promise<FixtureDonePayload> {
  switch (fixtureId) {
    case 'v4':
      return generateV4()
    case 'v11a':
      return generateV11a()
    case 'v11b':
      return generateV11b()
    case 'v12':
      return generateV12()
    default:
      throw new Error(`Unknown fixtureId: ${fixtureId}`)
  }
}
