/**
 * L2 navigation projection builder tests (LOCK-PROD-2/3/4/5/6, LOCK-FP1/FP2).
 *
 * Pure module — no filesystem, IPC, or Electron. Covers:
 * - assistant id uniqueness / reserved id rejection (LOCK-PROD-5)
 * - LS metadata enrichment joined against IndexedDB topic facts (LOCK-PROD-3)
 * - LS-only topics ignored; deletedAt resolved to the IDB value (LOCK-PROD-3)
 * - container-owns-grouping when redundant inner assistantId differs (LOCK-PROD-2)
 * - IDB-only topics surface as recovered with {id, deletedAt} (LOCK-PROD-4/FP2)
 * - real nested-string redux-persist wire + decoded-object compatibility
 *   with strict malformed-nested-string fail-safe (LOCK-FP1)
 * - encode/decode round-trip (LOCK-PROD-6)
 */
import { RECOVERED_SHELL_ASSISTANT_ID } from '@shared/chatImport/types'
import { describe, expect, it } from 'vitest'

import {
  buildNavigationProjection,
  decodeProjectionState,
  encodeProjectionState,
  extractAssistantList,
  extractPersistVersion,
  NAVIGATION_PROJECTION_STATE_KEY
} from '../navigationProjection'

const IDB_TOPICS = [
  { id: 't-1', deletedAt: null },
  { id: 't-2', deletedAt: null },
  { id: 't-3', deletedAt: '2026-07-01T00:00:00.000Z' },
  { id: 't-recovered-1', deletedAt: null },
  { id: 't-recovered-2', deletedAt: '2026-07-02T00:00:00.000Z' }
]

/**
 * REAL redux-persist wire format (LOCK-FP1): the outer JSON's persisted
 * slice values (`_persist`, `assistants`) are themselves JSON strings —
 * `createPersistoid` serializes each slice per key before stringifying the
 * outer root.
 */
function makePersisted(assistants: unknown[]): string {
  return JSON.stringify({
    _persist: JSON.stringify({ version: 215, rehydrated: true }),
    assistants: JSON.stringify({
      defaultAssistant: {},
      assistants,
      tagsOrder: [],
      collapsedTags: {},
      presets: [],
      unifiedListOrder: []
    })
  })
}

/**
 * Already-decoded object slice shape (LOCK-FP1 compatibility): the values
 * are plain objects instead of JSON strings. Retained/strict — mirrors the
 * payload the E2E seed fixture writes.
 */
function makePersistedDecoded(assistants: unknown[]): string {
  return JSON.stringify({
    _persist: { version: 215, rehydrated: true },
    assistants: {
      defaultAssistant: {},
      assistants,
      tagsOrder: [],
      collapsedTags: {},
      presets: [],
      unifiedListOrder: []
    }
  })
}

describe('buildNavigationProjection', () => {
  it('returns an empty-but-valid projection for null persisted state (IDB-only recovered topics)', () => {
    const outcome = buildNavigationProjection(null, IDB_TOPICS)
    expect(outcome.status).toBe('ok')
    if (outcome.status !== 'ok') return
    expect(outcome.projection.assistants).toEqual([])
    expect(outcome.projection.topics).toEqual([])
    expect(outcome.projection.recoveredTopicIds).toEqual([
      { id: 't-1', deletedAt: null },
      { id: 't-2', deletedAt: null },
      { id: 't-3', deletedAt: '2026-07-01T00:00:00.000Z' },
      { id: 't-recovered-1', deletedAt: null },
      { id: 't-recovered-2', deletedAt: '2026-07-02T00:00:00.000Z' }
    ])
    expect(outcome.projection.sourcePersistVersion).toBeNull()
    expect(outcome.projection.version).toBe(1)
  })

  it('parses the REAL nested-string redux-persist wire (LOCK-FP1)', () => {
    // Exact real-wire shape: outer JSON whose persisted slice values
    // (`_persist`, `assistants`) are JSON strings. Other persisted slices
    // (settings, llm, …) may coexist and are ignored.
    const wire = JSON.stringify({
      _persist: JSON.stringify({ version: 215, rehydrated: true }),
      assistants: JSON.stringify({
        defaultAssistant: {},
        assistants: [
          { id: 'a-2', name: 'Second', emoji: '🙂', topics: [] },
          { id: 'a-1', name: 'First', emoji: '😀', topics: [] }
        ],
        tagsOrder: [],
        collapsedTags: {},
        presets: [],
        unifiedListOrder: []
      }),
      settings: JSON.stringify({ themeMode: 'dark' })
    })
    const outcome = buildNavigationProjection(wire, IDB_TOPICS)
    expect(outcome.status).toBe('ok')
    if (outcome.status !== 'ok') return
    expect(outcome.projection.sourcePersistVersion).toBe(215)
    expect(outcome.projection.assistants).toEqual([
      { id: 'a-2', name: 'Second', emoji: '🙂', order: 0 },
      { id: 'a-1', name: 'First', emoji: '😀', order: 1 }
    ])
  })

  it('retains strict compatibility with the decoded object slice shape (LOCK-FP1)', () => {
    const persisted = makePersistedDecoded([
      { id: 'a-2', name: 'Second', emoji: '🙂', topics: [] },
      { id: 'a-1', name: 'First', emoji: '😀', topics: [] }
    ])
    const outcome = buildNavigationProjection(persisted, IDB_TOPICS)
    expect(outcome.status).toBe('ok')
    if (outcome.status !== 'ok') return
    expect(outcome.projection.sourcePersistVersion).toBe(215)
    expect(outcome.projection.assistants.map((a) => a.id)).toEqual(['a-2', 'a-1'])
  })

  it('fails safe when a nested slice string is malformed (LOCK-FP1)', () => {
    // `_persist` malformed → version unknown (null); `assistants` malformed
    // → no assistant metadata. IndexedDB stays authoritative: every IDB
    // topic surfaces as recovered with its authoritative deletedAt.
    const wire = JSON.stringify({
      _persist: '{not-json',
      assistants: '{also-not-json'
    })
    const outcome = buildNavigationProjection(wire, IDB_TOPICS)
    expect(outcome.status).toBe('ok')
    if (outcome.status !== 'ok') return
    expect(outcome.projection.sourcePersistVersion).toBeNull()
    expect(outcome.projection.assistants).toEqual([])
    expect(outcome.projection.topics).toEqual([])
    expect(outcome.projection.recoveredTopicIds).toEqual([
      { id: 't-1', deletedAt: null },
      { id: 't-2', deletedAt: null },
      { id: 't-3', deletedAt: '2026-07-01T00:00:00.000Z' },
      { id: 't-recovered-1', deletedAt: null },
      { id: 't-recovered-2', deletedAt: '2026-07-02T00:00:00.000Z' }
    ])
  })

  it('fails safe when a nested slice string parses to a non-object (LOCK-FP1)', () => {
    const wire = JSON.stringify({
      _persist: '42',
      assistants: '"just-a-string"'
    })
    const outcome = buildNavigationProjection(wire, IDB_TOPICS)
    expect(outcome.status).toBe('ok')
    if (outcome.status !== 'ok') return
    expect(outcome.projection.sourcePersistVersion).toBeNull()
    expect(outcome.projection.assistants).toEqual([])
  })

  it('parses source persist version and builds assistant shells with source order', () => {
    const persisted = makePersisted([
      { id: 'a-2', name: 'Second', emoji: '🙂', topics: [] },
      { id: 'a-1', name: 'First', emoji: '😀', topics: [] }
    ])
    const outcome = buildNavigationProjection(persisted, IDB_TOPICS)
    expect(outcome.status).toBe('ok')
    if (outcome.status !== 'ok') return
    expect(outcome.projection.sourcePersistVersion).toBe(215)
    expect(outcome.projection.assistants).toEqual([
      { id: 'a-2', name: 'Second', emoji: '🙂', order: 0 },
      { id: 'a-1', name: 'First', emoji: '😀', order: 1 }
    ])
  })

  it('enriches only IDB-matched topics and drops LS-only topics (LOCK-PROD-3)', () => {
    let dropped = 0
    const persisted = makePersisted([
      {
        id: 'a-1',
        name: 'A',
        topics: [
          {
            id: 't-1',
            assistantId: 'a-1',
            name: 'Topic One',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
            deletedAt: null,
            pinned: true,
            isNameManuallyEdited: true
          },
          {
            id: 't-ls-only',
            assistantId: 'a-1',
            name: 'Ghost',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: null,
            deletedAt: null,
            pinned: false,
            isNameManuallyEdited: false
          }
        ]
      }
    ])
    const outcome = buildNavigationProjection(persisted, IDB_TOPICS, (cat, count) => {
      if (cat === 'ls-topic-missing-in-idb') dropped = count
    })
    expect(outcome.status).toBe('ok')
    if (outcome.status !== 'ok') return
    expect(dropped).toBe(1)
    expect(outcome.projection.topics).toEqual([
      {
        id: 't-1',
        assistantId: 'a-1',
        name: 'Topic One',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        deletedAt: null,
        pinned: true,
        isNameManuallyEdited: true,
        order: 0
      }
    ])
    expect(outcome.projection.recoveredTopicIds).toEqual([
      { id: 't-2', deletedAt: null },
      { id: 't-3', deletedAt: '2026-07-01T00:00:00.000Z' },
      { id: 't-recovered-1', deletedAt: null },
      { id: 't-recovered-2', deletedAt: '2026-07-02T00:00:00.000Z' }
    ])
  })

  it('preserves IDB-authoritative deletedAt for recovered topics — active AND deleted (LOCK-FP2)', () => {
    // No Local Storage metadata at all: every IDB topic is recovered, and
    // each recovered entry carries its authoritative {id, deletedAt} — the
    // renderer can distinguish active from deleted without inferring state.
    const outcome = buildNavigationProjection(null, IDB_TOPICS)
    expect(outcome.status).toBe('ok')
    if (outcome.status !== 'ok') return
    expect(outcome.projection.recoveredTopicIds).toEqual([
      { id: 't-1', deletedAt: null },
      { id: 't-2', deletedAt: null },
      { id: 't-3', deletedAt: '2026-07-01T00:00:00.000Z' },
      { id: 't-recovered-1', deletedAt: null },
      { id: 't-recovered-2', deletedAt: '2026-07-02T00:00:00.000Z' }
    ])
    // A recovered entry NEVER fabricates metadata: the payload is exactly
    // {id, deletedAt} — no name/createdAt/assistant ownership is inferred.
    for (const entry of outcome.projection.recoveredTopicIds) {
      expect(Object.keys(entry).sort()).toEqual(['deletedAt', 'id'])
    }
  })

  it('resolves deletedAt to the IndexedDB value on mismatch (LOCK-PROD-3)', () => {
    const persisted = makePersisted([
      {
        id: 'a-1',
        name: 'A',
        topics: [
          // LS says not deleted; IDB says deleted → IDB wins.
          {
            id: 't-3',
            assistantId: 'a-1',
            name: 'Trashed',
            createdAt: null,
            updatedAt: null,
            deletedAt: null,
            pinned: false,
            isNameManuallyEdited: false
          }
        ]
      }
    ])
    const outcome = buildNavigationProjection(persisted, IDB_TOPICS)
    expect(outcome.status).toBe('ok')
    if (outcome.status !== 'ok') return
    expect(outcome.projection.topics[0].deletedAt).toBe('2026-07-01T00:00:00.000Z')
  })

  it('container owns grouping when the redundant inner assistantId differs (LOCK-PROD-2)', () => {
    const persisted = makePersisted([
      {
        id: 'a-outer',
        name: 'Outer',
        topics: [
          {
            id: 't-1',
            assistantId: 'a-inner-different',
            name: 'Mismatched',
            createdAt: null,
            updatedAt: null,
            deletedAt: null,
            pinned: false,
            isNameManuallyEdited: false
          }
        ]
      }
    ])
    const outcome = buildNavigationProjection(persisted, IDB_TOPICS)
    expect(outcome.status).toBe('ok')
    if (outcome.status !== 'ok') return
    // The outer container assistant id is authoritative for grouping.
    expect(outcome.projection.topics[0].assistantId).toBe('a-outer')
  })

  it('rejects duplicate assistant ids (LOCK-PROD-5)', () => {
    const persisted = makePersisted([
      { id: 'a-1', name: 'One', topics: [] },
      { id: 'a-1', name: 'Two', topics: [] }
    ])
    const outcome = buildNavigationProjection(persisted, IDB_TOPICS)
    expect(outcome.status).toBe('rejected')
    if (outcome.status === 'ok') return
    expect(outcome.code).toBe('DUPLICATE_ASSISTANT_ID')
  })

  it('rejects the reserved recovered shell assistant id (LOCK-PROD-5)', () => {
    const persisted = makePersisted([{ id: RECOVERED_SHELL_ASSISTANT_ID, name: 'Collides', topics: [] }])
    const outcome = buildNavigationProjection(persisted, IDB_TOPICS)
    expect(outcome.status).toBe('rejected')
    if (outcome.status === 'ok') return
    expect(outcome.code).toBe('RESERVED_ASSISTANT_ID')
  })

  it('treats malformed persisted JSON as absent (IDB stays authoritative)', () => {
    const outcome = buildNavigationProjection('{not-json', IDB_TOPICS)
    expect(outcome.status).toBe('ok')
    if (outcome.status !== 'ok') return
    expect(outcome.projection.assistants).toEqual([])
    expect(outcome.projection.recoveredTopicIds.length).toBe(IDB_TOPICS.length)
  })

  it('reports malformed assistant records via the diagnostic hook (count-only)', () => {
    let malformed = 0
    const persisted = makePersisted([42, { id: 'a-1', name: 'Good', topics: [] }])
    const outcome = buildNavigationProjection(persisted, IDB_TOPICS, (cat, count) => {
      if (cat === 'assistant-malformed') malformed = count
    })
    expect(outcome.status).toBe('ok')
    expect(malformed).toBe(1)
  })

  it('reports the final malformed count once when every assistant record is malformed', () => {
    let malformed = 0
    const persisted = makePersisted([42, 'junk', { topics: [] }])
    const outcome = buildNavigationProjection(persisted, IDB_TOPICS, (cat, count) => {
      if (cat === 'assistant-malformed') malformed = count
    })
    expect(outcome.status).toBe('ok')
    expect(malformed).toBe(3)
  })

  it('falls back to the source id for an empty assistant name (deterministic, no fabricated string)', () => {
    const persisted = makePersisted([{ id: 'a-1', name: '', topics: [] }])
    const outcome = buildNavigationProjection(persisted, IDB_TOPICS)
    expect(outcome.status).toBe('ok')
    if (outcome.status !== 'ok') return
    expect(outcome.projection.assistants[0].name).toBe('a-1')
  })

  it('leaves an empty topic name empty for the renderer to localize (LOCK-PROD-4/12)', () => {
    const persisted = makePersisted([
      {
        id: 'a-1',
        name: 'A',
        topics: [
          {
            id: 't-1',
            assistantId: 'a-1',
            name: '',
            createdAt: null,
            updatedAt: null,
            deletedAt: null,
            pinned: false,
            isNameManuallyEdited: false
          }
        ]
      }
    ])
    const outcome = buildNavigationProjection(persisted, IDB_TOPICS)
    expect(outcome.status).toBe('ok')
    if (outcome.status !== 'ok') return
    expect(outcome.projection.topics[0].name).toBe('')
  })

  it('does not mutate the input payloads (raw persisted string or idb topic facts)', () => {
    const persisted = makePersisted([
      {
        id: 'a-1',
        name: 'A',
        topics: [
          {
            id: 't-1',
            assistantId: 'a-1',
            name: 'T',
            createdAt: null,
            updatedAt: null,
            deletedAt: null,
            pinned: false,
            isNameManuallyEdited: false
          }
        ]
      }
    ])
    const idbTopics = [
      { id: 't-1', deletedAt: null },
      { id: 't-2', deletedAt: '2026-07-01T00:00:00.000Z' }
    ]
    const persistedSnapshot = persisted
    const idbSnapshot = JSON.stringify(idbTopics)
    const outcome = buildNavigationProjection(persisted, idbTopics)
    expect(outcome.status).toBe('ok')
    if (outcome.status !== 'ok') return
    // LOCK-FP3 source immutability: the wire is byte-identical and the idb
    // facts array/objects are unmodified after the build.
    expect(persisted).toBe(persistedSnapshot)
    expect(JSON.stringify(idbTopics)).toBe(idbSnapshot)
    expect(outcome.projection.topics[0].deletedAt).toBeNull()
  })
})

describe('extractPersistVersion / extractAssistantList (LOCK-FP1)', () => {
  it('parses _persist.version from a nested-string slice and an object slice', () => {
    expect(extractPersistVersion(JSON.parse(JSON.stringify({ _persist: JSON.stringify({ version: 215 }) })))).toBe(215)
    expect(extractPersistVersion(JSON.parse(JSON.stringify({ _persist: { version: 215 } })))).toBe(215)
  })

  it('returns null for a malformed _persist nested string (fail-safe)', () => {
    expect(extractPersistVersion(JSON.parse(JSON.stringify({ _persist: '{bad' })))).toBeNull()
    expect(extractPersistVersion(JSON.parse(JSON.stringify({ _persist: '"junk"' })))).toBeNull()
    expect(extractPersistVersion(JSON.parse(JSON.stringify({ _persist: 7 })))).toBeNull()
    expect(extractPersistVersion(JSON.parse(JSON.stringify({})))).toBeNull()
  })

  it('extracts the assistant list from a nested-string slice and an object slice', () => {
    const assistants = [{ id: 'a-1' }, { id: 'a-2' }]
    const fromString = extractAssistantList(JSON.parse(JSON.stringify({ assistants: JSON.stringify({ assistants }) })))
    const fromObject = extractAssistantList(JSON.parse(JSON.stringify({ assistants: { assistants } })))
    expect(fromString).toEqual(assistants)
    expect(fromObject).toEqual(assistants)
  })

  it('fails safe to [] for a malformed assistants nested string or non-array slice', () => {
    expect(extractAssistantList(JSON.parse(JSON.stringify({ assistants: '{bad' })))).toEqual([])
    expect(extractAssistantList(JSON.parse(JSON.stringify({ assistants: JSON.stringify({ noList: true }) })))).toEqual(
      []
    )
    expect(extractAssistantList(JSON.parse(JSON.stringify({ assistants: 42 })))).toEqual([])
    expect(extractAssistantList(JSON.parse(JSON.stringify({})))).toEqual([])
  })
})

describe('projection encode/decode (LOCK-PROD-6)', () => {
  it('round-trips a validated projection through the migration_state value', () => {
    const persisted = makePersisted([
      {
        id: 'a-1',
        name: 'A',
        topics: [
          {
            id: 't-1',
            name: 'T',
            createdAt: null,
            updatedAt: null,
            deletedAt: null,
            pinned: false,
            isNameManuallyEdited: false
          }
        ]
      }
    ])
    const outcome = buildNavigationProjection(persisted, IDB_TOPICS)
    expect(outcome.status).toBe('ok')
    if (outcome.status !== 'ok') return
    const encoded = encodeProjectionState(outcome.projection)
    expect(typeof encoded).toBe('string')
    const decoded = decodeProjectionState(encoded)
    expect(decoded).not.toBeNull()
    expect(decoded).toEqual(outcome.projection)
  })

  it('decodes null/empty/malformed values as absent (idempotent no-op)', () => {
    expect(decodeProjectionState(null)).toBeNull()
    expect(decodeProjectionState('')).toBeNull()
    expect(decodeProjectionState('{bad')).toBeNull()
    expect(decodeProjectionState('{"version":2,"assistants":[]}')).toBeNull()
    expect(decodeProjectionState('{"version":1,"assistants":[{},1],"topics":[],"recoveredTopicIds":[]}')).toBeNull()
  })

  it('strictly validates assistant fields in a stored projection', () => {
    const base = { version: 1, sourcePersistVersion: null, assistants: [], topics: [], recoveredTopicIds: [] }
    // Bad emoji type.
    const badEmoji = { ...base, assistants: [{ id: 'a-1', name: 'A', emoji: 42, order: 0 }] }
    expect(decodeProjectionState(JSON.stringify(badEmoji))).toBeNull()
    // Missing name.
    const noName = { ...base, assistants: [{ id: 'a-1', emoji: null, order: 0 }] }
    expect(decodeProjectionState(JSON.stringify(noName))).toBeNull()
    // Non-numeric order.
    const badOrder = { ...base, assistants: [{ id: 'a-1', name: 'A', emoji: null, order: 'first' }] }
    expect(decodeProjectionState(JSON.stringify(badOrder))).toBeNull()
    // Emoji null and name '' (empty source name) are valid.
    const valid = { ...base, assistants: [{ id: 'a-1', name: '', emoji: null, order: 0 }] }
    expect(decodeProjectionState(JSON.stringify(valid))).not.toBeNull()
  })

  it('strictly validates topic fields in a stored projection', () => {
    const validTopic = {
      id: 't-1',
      assistantId: 'a-1',
      name: 'T',
      createdAt: null,
      updatedAt: null,
      deletedAt: null,
      pinned: false,
      isNameManuallyEdited: false,
      order: 0
    }
    const base = { version: 1, sourcePersistVersion: null, assistants: [], topics: [validTopic], recoveredTopicIds: [] }
    const encode = (topic: unknown) => JSON.stringify({ ...base, topics: [topic] })
    // Non-string name.
    expect(decodeProjectionState(encode({ ...validTopic, name: 7 }))).toBeNull()
    // Non-null numeric createdAt.
    expect(decodeProjectionState(encode({ ...validTopic, createdAt: 123 }))).toBeNull()
    // deletedAt not string/null.
    expect(decodeProjectionState(encode({ ...validTopic, deletedAt: false }))).toBeNull()
    // pinned not boolean.
    expect(decodeProjectionState(encode({ ...validTopic, pinned: 1 }))).toBeNull()
    // Missing assistantId.
    expect(decodeProjectionState(encode({ ...validTopic, assistantId: undefined }))).toBeNull()
    // Empty topic name is valid (renderer localizes it).
    expect(decodeProjectionState(encode({ ...validTopic, name: '' }))).not.toBeNull()
  })

  it('strictly validates recoveredTopicIds and sourcePersistVersion', () => {
    const base = { version: 1, sourcePersistVersion: null, assistants: [], topics: [], recoveredTopicIds: [] }
    // Bare id strings (pre-fix wire shape) reject — every entry must be {id, deletedAt}.
    expect(decodeProjectionState(JSON.stringify({ ...base, recoveredTopicIds: ['t-r', 5] }))).toBeNull()
    expect(decodeProjectionState(JSON.stringify({ ...base, recoveredTopicIds: ['t-r'] }))).toBeNull()
    expect(decodeProjectionState(JSON.stringify({ ...base, recoveredTopicIds: [{ id: 't-r' }] }))).toBeNull()
    // Malformed deletedAt types reject.
    expect(
      decodeProjectionState(JSON.stringify({ ...base, recoveredTopicIds: [{ id: 't-r', deletedAt: 5 }] }))
    ).toBeNull()
    expect(
      decodeProjectionState(JSON.stringify({ ...base, recoveredTopicIds: [{ id: '', deletedAt: null }] }))
    ).toBeNull()
    // Valid {id, deletedAt} entries — active and deleted — decode.
    expect(
      decodeProjectionState(
        JSON.stringify({
          ...base,
          recoveredTopicIds: [
            { id: 't-active', deletedAt: null },
            { id: 't-deleted', deletedAt: '2026-07-01T00:00:00.000Z' }
          ]
        })
      )
    ).not.toBeNull()
    // Non-numeric sourcePersistVersion rejects; numeric decodes.
    expect(decodeProjectionState(JSON.stringify({ ...base, sourcePersistVersion: '215' }))).toBeNull()
    expect(decodeProjectionState(JSON.stringify({ ...base, sourcePersistVersion: 215 }))).not.toBeNull()
  })

  it('exposes the stable versioned state key', () => {
    expect(NAVIGATION_PROJECTION_STATE_KEY).toBe('import_navigation_projection_v1')
  })
})
