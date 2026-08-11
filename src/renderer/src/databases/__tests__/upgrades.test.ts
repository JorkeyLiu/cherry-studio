/**
 * Focused regression tests for the historical Dexie upgrade functions
 * (`./upgrades`) and their side-effect-free helpers (`./migrationHelpers`).
 *
 * These functions run inside the isolated chatImport renderer against a
 * source database that needs a v5/v7/v8 upgrade, so they are exercised here
 * directly with a minimal in-memory fake Dexie Transaction (the same fake
 * table/collection pattern used by `windows/chatImport/entryPoint.test.ts`).
 * No IndexedDB, window bridge, or real Dexie open is required.
 *
 * Assertions prove representative migration OUTPUT parity without pinning
 * random ids or wall-clock timestamps: block/message ids are checked for
 * RFC 4122 v4 UUID shape, `createdAt` values are asserted against the source
 * rows, and statuses/types/content/error/file/citation fields are asserted
 * exactly (LOCK-001 / LOCK-006).
 */
import type { Transaction } from 'dexie'
import { describe, expect, it } from 'vitest'

import { upgradeToV5, upgradeToV7, upgradeToV8 } from '../upgrades'

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const OLD_CREATED_AT = '2024-05-06T07:08:09.000Z'

function expectUuid(value: unknown): void {
  expect(typeof value).toBe('string')
  expect(value).toMatch(UUID_V4_RE)
}

// ---------------------------------------------------------------------------
// Minimal fake Dexie Transaction (in-memory, structured-clone semantics).
// Supports exactly the table surface the upgrade functions use.
// ---------------------------------------------------------------------------

type Row = Record<string, any>

interface FakeTxTable {
  toArray: () => Promise<Row[]>
  get: (key: string) => Promise<Row | undefined>
  put: (row: Row) => Promise<void>
  bulkPut: (rows: Row[]) => Promise<void>
  bulkUpdate: (updates: Array<{ key: string; changes: Partial<Row> }>) => Promise<void>
  toCollection: () => {
    each: (callback: (row: Row) => void | Promise<void>) => Promise<void>
  }
}

interface TxHarness {
  tx: Transaction
  rows: (table: string) => Row[]
  putCounts: Record<string, number>
}

function createFakeTx(seed: Record<string, Row[]>): TxHarness {
  const maps = new Map<string, Map<string, Row>>()
  const putCounts: Record<string, number> = {}

  for (const [tableName, rows] of Object.entries(seed)) {
    const map = new Map<string, Row>()
    for (const row of rows) map.set(row.id, structuredClone(row))
    maps.set(tableName, map)
  }

  const table = (tableName: string): FakeTxTable => {
    let map = maps.get(tableName)
    if (!map) {
      map = new Map<string, Row>()
      maps.set(tableName, map)
    }
    return {
      toArray: async () => [...map.values()].map((row) => structuredClone(row)),
      get: async (key) => (map.has(key) ? structuredClone(map.get(key)) : undefined),
      put: async (row) => {
        putCounts[tableName] = (putCounts[tableName] ?? 0) + 1
        map.set(row.id, structuredClone(row))
      },
      bulkPut: async (rows) => {
        putCounts[tableName] = (putCounts[tableName] ?? 0) + rows.length
        for (const row of rows) map.set(row.id, structuredClone(row))
      },
      bulkUpdate: async (updates) => {
        for (const { key, changes } of updates) {
          map.set(key, structuredClone({ ...map.get(key), ...changes }))
        }
      },
      toCollection: () => ({
        each: async (callback) => {
          for (const row of [...map.values()]) await callback(structuredClone(row))
        }
      })
    }
  }

  return {
    tx: { table } as unknown as Transaction,
    rows: (tableName: string) => [...(maps.get(tableName)?.values() ?? [])].map((row) => structuredClone(row)),
    putCounts
  }
}

// ---------------------------------------------------------------------------
// v5: files created_at Date → ISO string; tavily metadata → webSearch
// ---------------------------------------------------------------------------

describe('upgradeToV5', () => {
  it('converts Date created_at to ISO strings and migrates tavily metadata to webSearch', async () => {
    const harness = createFakeTx({
      files: [
        { id: 'f1', name: 'a', created_at: new Date('2024-03-04T05:06:07.000Z') },
        { id: 'f2', name: 'b', created_at: '2024-03-05T00:00:00.000Z' }
      ],
      topics: [
        {
          id: 't1',
          messages: [
            {
              id: 'm1',
              content: 'x',
              metadata: {
                tavily: {
                  query: 'cherry chat',
                  results: [{ title: 'T1', url: 'https://u1', content: 'C1' }]
                }
              }
            },
            { id: 'm2', content: 'y', metadata: { foo: 1 } }
          ]
        },
        { id: 't2', messages: [{ id: 'm3', content: 'z' }] }
      ]
    })

    await upgradeToV5(harness.tx)

    const files = harness.rows('files')
    const f1 = files.find((f) => f.id === 'f1')
    const f2 = files.find((f) => f.id === 'f2')
    expect(f1).toBeDefined()
    expect(f2).toBeDefined()
    expect(f1!.created_at).toBe('2024-03-04T05:06:07.000Z')
    expect(f2!.created_at).toBe('2024-03-05T00:00:00.000Z')
    // Only the Date row was rewritten.
    expect(harness.putCounts.files).toBe(1)

    const [t1] = harness.rows('topics')
    const [m1, m2] = t1.messages
    expect(m1.metadata.tavily).toBeUndefined()
    expect(m1.metadata.webSearch).toEqual({
      query: 'cherry chat',
      results: [{ title: 'T1', url: 'https://u1', content: 'C1' }]
    })
    // Messages without tavily are untouched; topic without changes is not re-put.
    expect(m2.metadata).toEqual({ foo: 1 })
    expect(harness.putCounts.topics).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// v7: message normalization into typed message_blocks
// ---------------------------------------------------------------------------

const richMessage = {
  id: 'm-rich',
  assistantId: 'asst-1',
  role: 'assistant',
  status: 'success',
  content: 'main answer text',
  reasoning_content: 'chain of thought',
  translatedContent: 'traduzione',
  topicId: 't-1',
  createdAt: OLD_CREATED_AT,
  modelId: 'gpt-4o',
  model: { id: 'gpt-4o', provider: 'openai', name: 'GPT-4o', group: 'gpt' },
  knowledgeBaseIds: ['kb-1'],
  useful: true,
  askId: 'm-ask',
  usage: { total_tokens: 10 },
  metrics: { time_thinking_millsec: 1234, completion_tokens: 5, time_completion_millsec: 2000 },
  type: 'text',
  files: [
    {
      id: 'file-img',
      type: 'image',
      name: 'pic.png',
      origin_name: 'pic.png',
      path: '/p/pic.png',
      size: 10,
      ext: 'png',
      created_at: '2024-01-01T00:00:00.000Z',
      count: 1
    },
    {
      id: 'file-doc',
      type: 'pdf',
      name: 'doc.pdf',
      origin_name: 'doc.pdf',
      path: '/p/doc.pdf',
      size: 20,
      ext: 'pdf',
      created_at: '2024-01-01T00:00:00.000Z',
      count: 1
    }
  ],
  metadata: {
    mcpTools: [{ id: 'tool-1', status: 'done', response: 'tool output' }],
    citations: ['https://src.example.com/article'],
    knowledge: [{ id: 'k1', title: 'K1' }],
    generateImage: { prompt: 'a cat' }
  }
}

const clearMessage = {
  id: 'm-clear',
  assistantId: 'asst-1',
  role: 'user',
  status: 'sending',
  content: '',
  topicId: 't-1',
  createdAt: OLD_CREATED_AT,
  type: 'clear'
}

const errorMessage = {
  id: 'm-error',
  assistantId: 'asst-1',
  role: 'assistant',
  status: 'error',
  content: '',
  topicId: 't-1',
  createdAt: OLD_CREATED_AT,
  type: 'text',
  error: { message: 'boom', name: 'APIError', stack: 'at fn' }
}

describe('upgradeToV7', () => {
  it('converts a rich assistant message into the exact typed block shapes', async () => {
    const harness = createFakeTx({
      topics: [{ id: 't-1', messages: [richMessage, clearMessage, errorMessage] }]
    })

    await upgradeToV7(harness.tx)

    const blocks = harness.rows('message_blocks')
    // rich: thinking + tool + main_text + translation + image(file) + file +
    //       image(generateImage) + citation = 8; clear: 0; error: 1 → 9.
    expect(blocks).toHaveLength(9)
    expect(harness.putCounts.message_blocks).toBe(9)

    for (const block of blocks) {
      expectUuid(block.id)
      expect(block.createdAt).toBe(OLD_CREATED_AT)
    }
    const ids = new Set(blocks.map((b) => b.id))
    expect(ids.size).toBe(9)

    const richBlocks = blocks.filter((b) => b.messageId === 'm-rich')
    expect(richBlocks).toHaveLength(8)

    const byType = (type: string) => richBlocks.find((b) => b.type === type)

    const mainText = byType('main_text')
    expect(mainText).toMatchObject({
      content: 'main answer text',
      status: 'success',
      knowledgeBaseIds: ['kb-1']
    })

    const thinking = byType('thinking')
    expect(thinking).toMatchObject({
      content: 'chain of thought',
      status: 'success',
      thinking_millsec: 1234
    })

    const translation = byType('translation')
    expect(translation).toMatchObject({
      content: 'traduzione',
      targetLanguage: 'unknown',
      status: 'success'
    })

    const imageFromFile = richBlocks.find((b) => b.type === 'image' && b.file)
    expect(imageFromFile).toMatchObject({ status: 'success', file: richMessage.files[0] })

    const fileBlock = byType('file')
    expect(fileBlock).toMatchObject({ status: 'success', file: richMessage.files[1] })

    const imageFromMetadata = richBlocks.find((b) => b.type === 'image' && b.metadata)
    expect(imageFromMetadata).toMatchObject({
      status: 'success',
      metadata: { generateImageResponse: richMessage.metadata.generateImage }
    })

    const tool = byType('tool')
    expect(tool).toMatchObject({
      toolId: 'tool-1',
      content: 'tool output',
      status: 'success',
      metadata: { rawMcpToolResponse: richMessage.metadata.mcpTools[0] }
    })

    const citation = byType('citation')
    expect(citation).toMatchObject({
      status: 'success',
      response: { results: richMessage.metadata.citations, source: 'openrouter' },
      knowledge: richMessage.metadata.knowledge
    })

    const errorBlock = blocks.find((b) => b.messageId === 'm-error')
    expect(errorBlock).toMatchObject({
      type: 'error',
      status: 'error',
      error: { message: 'boom', name: 'APIError', stack: 'at fn' }
    })

    // The converted topic holds the new message references.
    const [topic] = harness.rows('topics')
    const messages = topic.messages
    expect(messages).toHaveLength(3)

    const richRef = messages.find((m: any) => m.id === 'm-rich')
    expect(richRef).toMatchObject({
      role: 'assistant',
      assistantId: 'asst-1',
      topicId: 't-1',
      createdAt: OLD_CREATED_AT,
      status: 'success',
      modelId: 'gpt-4o',
      model: richMessage.model,
      useful: true,
      usage: { total_tokens: 10 },
      metrics: richMessage.metrics
    })
    // Every referenced block id exists, is a UUID, and belongs to this message.
    expect(richRef.blocks).toHaveLength(8)
    expect(richRef.blocks.every((id: string) => ids.has(id))).toBe(true)
    expect(richRef.blocks.every((id: string) => UUID_V4_RE.test(id))).toBe(true)
    expect([...richRef.blocks].sort()).toEqual(richBlocks.map((b: any) => b.id).sort())
  })

  it('maps statuses and preserves type clear on converted messages (LOCK-006)', async () => {
    const harness = createFakeTx({
      topics: [{ id: 't-1', messages: [clearMessage] }]
    })

    await upgradeToV7(harness.tx)

    const [topic] = harness.rows('topics')
    const [converted] = topic.messages
    // sending → pending on the new message reference; empty content → no blocks.
    expect(converted).toMatchObject({
      id: 'm-clear',
      role: 'user',
      status: 'pending',
      type: 'clear',
      blocks: []
    })
    expect(harness.rows('message_blocks')).toHaveLength(0)
  })

  it('maps webSearch metadata to a citation block with source websearch', async () => {
    const webSearch = { query: 'q1', results: [{ title: 'T', url: 'https://u', content: 'C' }] }
    const harness = createFakeTx({
      topics: [
        {
          id: 't-ws',
          messages: [
            {
              id: 'm-ws',
              assistantId: 'asst-1',
              role: 'assistant',
              status: 'success',
              content: 'with sources',
              topicId: 't-ws',
              createdAt: OLD_CREATED_AT,
              type: 'text',
              metadata: { webSearch }
            }
          ]
        }
      ]
    })

    await upgradeToV7(harness.tx)

    const blocks = harness.rows('message_blocks')
    expect(blocks).toHaveLength(2) // main_text + citation
    const citation = blocks.find((b) => b.type === 'citation')
    expect(citation).toMatchObject({
      status: 'success',
      response: { results: webSearch, source: 'websearch' }
    })
  })

  it('handles a topic with no messages array by writing an empty messages reference', async () => {
    const harness = createFakeTx({
      topics: [{ id: 't-empty' }]
    })

    await upgradeToV7(harness.tx)

    const [topic] = harness.rows('topics')
    expect(topic.messages).toEqual([])
    expect(harness.rows('message_blocks')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// v8: language code conversion in settings and translate_history
// ---------------------------------------------------------------------------

describe('upgradeToV8', () => {
  it('converts english/chinese settings and history rows to en-us/zh-cn', async () => {
    const harness = createFakeTx({
      settings: [
        { id: 'translate:source:language', value: 'english' },
        { id: 'translate:target:language', value: 'chinese' },
        { id: 'translate:bidirectional:pair', value: ['english', 'chinese'] }
      ],
      translate_history: [
        {
          id: 'h1',
          sourceText: 'a',
          targetText: 'b',
          sourceLanguage: 'english',
          targetLanguage: 'chinese',
          createdAt: 'x'
        },
        {
          id: 'h2',
          sourceText: 'c',
          targetText: 'd',
          sourceLanguage: 'japanese',
          targetLanguage: 'french',
          createdAt: 'y'
        }
      ]
    })

    await upgradeToV8(harness.tx)

    const settings = Object.fromEntries(harness.rows('settings').map((s) => [s.id, s.value]))
    expect(settings['translate:source:language']).toBe('en-us')
    expect(settings['translate:target:language']).toBe('zh-cn')
    expect(settings['translate:bidirectional:pair']).toEqual(['en-us', 'zh-cn'])

    const histories = harness.rows('translate_history')
    expect(histories.find((h) => h.id === 'h1')).toMatchObject({
      sourceLanguage: 'en-us',
      targetLanguage: 'zh-cn'
    })
    expect(histories.find((h) => h.id === 'h2')).toMatchObject({
      sourceLanguage: 'ja-jp',
      targetLanguage: 'fr-fr'
    })
  })

  it('keeps auto source, defaults unknown languages, and defaults a missing pair', async () => {
    const harness = createFakeTx({
      settings: [
        { id: 'translate:source:language', value: 'auto' },
        { id: 'translate:target:language', value: 'klingon' }
      ]
      // no bidirectional pair setting at all
    })

    await upgradeToV8(harness.tx)

    const settings = Object.fromEntries(harness.rows('settings').map((s) => [s.id, s.value]))
    expect(settings['translate:source:language']).toBe('auto')
    expect(settings['translate:target:language']).toBe('zh-cn')
    expect(settings['translate:bidirectional:pair']).toEqual(['en-us', 'zh-cn'])
  })

  it('converts a custom pair through the language map', async () => {
    const harness = createFakeTx({
      settings: [{ id: 'translate:bidirectional:pair', value: ['german', 'chinese-traditional'] }]
    })

    await upgradeToV8(harness.tx)

    const settings = Object.fromEntries(harness.rows('settings').map((s) => [s.id, s.value]))
    expect(settings['translate:bidirectional:pair']).toEqual(['de-de', 'zh-tw'])
  })
})
