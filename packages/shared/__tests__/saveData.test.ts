/**
 * Save-data handshake wire contracts (shared, JSON-only).
 *
 * Boundary: Main ↔ renderer `App_SaveData` / `App_SaveDataAck` payloads.
 * Only the main window holds/flushes redux-persist.
 */
import { describe, expect, it } from 'vitest'

import { isSaveDataAck, isSaveDataRequest, SAVE_DATA_REQUEST_ID_MAX_LENGTH } from '../saveData'

describe('isSaveDataRequest', () => {
  it('accepts a well-formed request', () => {
    expect(isSaveDataRequest({ requestId: 'savedata-abc-0' })).toBe(true)
  })

  it('rejects non-objects and arrays', () => {
    expect(isSaveDataRequest(null)).toBe(false)
    expect(isSaveDataRequest(undefined)).toBe(false)
    expect(isSaveDataRequest('savedata-abc-0')).toBe(false)
    expect(isSaveDataRequest([{ requestId: 'x' }])).toBe(false)
  })

  it('rejects missing, empty, or overlong requestIds', () => {
    expect(isSaveDataRequest({})).toBe(false)
    expect(isSaveDataRequest({ requestId: '' })).toBe(false)
    expect(isSaveDataRequest({ requestId: 'x'.repeat(SAVE_DATA_REQUEST_ID_MAX_LENGTH + 1) })).toBe(false)
    expect(isSaveDataRequest({ requestId: 42 })).toBe(false)
  })

  it('rejects extra keys', () => {
    expect(isSaveDataRequest({ requestId: 'x', extra: 1 })).toBe(false)
  })
})

describe('isSaveDataAck', () => {
  it('accepts success and failure acks with and without code', () => {
    expect(isSaveDataAck({ requestId: 'r1', ok: true, code: 'flushed' })).toBe(true)
    expect(isSaveDataAck({ requestId: 'r1', ok: false, code: 'flush-failed' })).toBe(true)
    expect(isSaveDataAck({ requestId: 'r1', ok: true })).toBe(true)
  })

  it('rejects non-objects and missing fields', () => {
    expect(isSaveDataAck(null)).toBe(false)
    expect(isSaveDataAck({ requestId: 'r1' })).toBe(false)
    expect(isSaveDataAck({ ok: true })).toBe(false)
  })

  it('rejects non-boolean ok, unknown codes, and extra keys', () => {
    expect(isSaveDataAck({ requestId: 'r1', ok: 'yes' })).toBe(false)
    expect(isSaveDataAck({ requestId: 'r1', ok: true, code: 'maybe' })).toBe(false)
    expect(isSaveDataAck({ requestId: 'r1', ok: true, extra: 1 })).toBe(false)
  })

  it('rejects bad requestIds', () => {
    expect(isSaveDataAck({ requestId: '', ok: true })).toBe(false)
    expect(isSaveDataAck({ requestId: 'x'.repeat(SAVE_DATA_REQUEST_ID_MAX_LENGTH + 1), ok: true })).toBe(false)
  })
})
