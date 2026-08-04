/**
 * Focused pure unit tests for the disposable dev-origin seed builder's
 * deterministic Local Storage payload (LOCK-D2 + LOCK-FF1).
 *
 * Proves that `buildDevOriginPersistPayload()` emits the REAL redux-persist
 * wire representation of `persist:cherry-studio`: an outer JSON object whose
 * `_persist` and `assistants` values are themselves JSON STRINGS — exactly
 * the staged-state output of redux-persist `createPersistoid` with the
 * default serializer (JSON.stringify), never the decoded synthetic
 * nested-object shape.
 *
 * Pure Node utility test (vitest project `e2e-utils`); no Electron, no
 * Playwright, no production code is executed.
 */
import { describe, expect, it } from 'vitest'

import {
  buildDevOriginPersistPayload,
  parsePersistWireValue,
  DEV_ASSISTANT_EMOJI,
  DEV_ASSISTANT_ID,
  DEV_ASSISTANT_NAME,
  DEV_NAV_METADATA,
  DEV_TOPIC_CREATED_AT,
  DEV_TOPIC_ID,
  DEV_TOPIC_NAME,
  DEV_TOPIC_UPDATED_AT,
  SEED_PERSIST_VERSION
} from './disposable-dev-origin-seed-zip'

describe('buildDevOriginPersistPayload (LOCK-D2/FF1 raw wire representation)', () => {
  it('is deterministic and emits the REAL redux-persist wire format (string slices)', () => {
    const first = buildDevOriginPersistPayload()
    const second = buildDevOriginPersistPayload()
    expect(first).toBe(second)

    // LOCK-FF1: the raw wire value is an OUTER JSON object whose `_persist`
    // and `assistants` values are JSON STRINGS (createPersistoid default
    // serialization) — never the decoded nested-object shape.
    const parsed = JSON.parse(first) as { _persist: unknown; assistants: unknown }
    expect(typeof parsed._persist).toBe('string')
    expect(typeof parsed.assistants).toBe('string')
  })

  it('carries the version-215 _persist slice and one assistant/topic in wire form', () => {
    const parsed = JSON.parse(buildDevOriginPersistPayload()) as {
      _persist: string
      assistants: string
    }

    const persist = JSON.parse(parsed._persist) as { version: number; rehydrated: boolean }
    expect(persist).toEqual({ version: SEED_PERSIST_VERSION, rehydrated: true })
    expect(persist.version).toBe(DEV_NAV_METADATA.persistVersion)

    const slice = JSON.parse(parsed.assistants) as { assistants: Array<Record<string, unknown>> }
    expect(slice.assistants).toHaveLength(1)
    const assistant = slice.assistants[0]
    expect(assistant).toMatchObject({
      id: DEV_ASSISTANT_ID,
      name: DEV_ASSISTANT_NAME,
      emoji: DEV_ASSISTANT_EMOJI
    })
    // LOCK-D1: the single topic sits at position 0 (order 0) and its id
    // EXACTLY matches the seeded IndexedDB topic.
    const topics = assistant.topics as Array<Record<string, unknown>>
    expect(topics).toHaveLength(1)
    expect(topics[0]).toMatchObject({
      id: DEV_TOPIC_ID,
      name: DEV_TOPIC_NAME,
      createdAt: DEV_TOPIC_CREATED_AT,
      updatedAt: DEV_TOPIC_UPDATED_AT,
      deletedAt: null,
      pinned: false,
      isNameManuallyEdited: true
    })
  })

  it('emits EXACT deterministic wire bytes equal to an independent redux-persist mirror (LOCK-FF1)', () => {
    const payload = buildDevOriginPersistPayload()

    // Independent oracle: mirror createPersistoid's default serialization —
    // every slice (including `_persist`) is JSON.stringify'd, then the whole
    // staged map is JSON.stringify'd. Key order matches the builder exactly.
    const expected = JSON.stringify({
      _persist: JSON.stringify({ version: SEED_PERSIST_VERSION, rehydrated: true }),
      assistants: JSON.stringify({
        defaultAssistant: {},
        assistants: [
          {
            id: DEV_ASSISTANT_ID,
            name: DEV_ASSISTANT_NAME,
            emoji: DEV_ASSISTANT_EMOJI,
            topics: [
              {
                id: DEV_TOPIC_ID,
                assistantId: DEV_ASSISTANT_ID,
                name: DEV_TOPIC_NAME,
                createdAt: DEV_TOPIC_CREATED_AT,
                updatedAt: DEV_TOPIC_UPDATED_AT,
                deletedAt: null,
                pinned: false,
                isNameManuallyEdited: true
              }
            ]
          }
        ],
        tagsOrder: [],
        collapsedTags: {},
        presets: [],
        unifiedListOrder: []
      })
    })
    expect(payload).toBe(expected)
    // EXACT deterministic wire bytes (LOCK-FF1). The payload carries emoji
    // (multi-byte UTF-8), so UTF-8 byte length differs from char length — both
    // are pinned so any wire-shape drift breaks this test.
    expect(payload.length).toBe(525)
    expect(Buffer.byteLength(payload, 'utf8')).toBe(527)
  })

  it('round-trips through the exported wire decoder (parsePersistWireValue)', () => {
    const decoded = parsePersistWireValue(buildDevOriginPersistPayload())
    const persist = decoded._persist as { version: number; rehydrated: boolean }
    expect(persist.version).toBe(SEED_PERSIST_VERSION)
    expect(persist.rehydrated).toBe(true)
    const slice = decoded.assistants as { assistants: unknown[] }
    expect(slice.assistants).toHaveLength(1)
  })
})
