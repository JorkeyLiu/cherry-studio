/**
 * `normalizeSaved` idempotency for anchor-only flow-v1 records.
 *
 * A stored record tagged with the flow coordinate space but carrying only
 * the stable anchor (no `scrollTop`/`rawScrollTop` keys — e.g. after a
 * serialization round-trip drops undefined numerics) must normalize to the
 * stable anchor, not null. Normalizing an already-normalized record must
 * be stable (read-normalize-read keeps the anchor).
 */
import { FLOW_COORDINATE_SPACE } from '@renderer/pages/home/Messages/flowScrollGeometry'
import { describe, expect, it } from 'vitest'

import { normalizeSaved } from '../useScrollPosition'

describe('normalizeSaved anchor-only idempotency', () => {
  it('keeps the stable anchor of an anchor-only flow-v1 record (no scrollTop keys)', () => {
    const stored = {
      messageId: 'm2',
      anchorId: 'm2',
      intraRowOffset: -5,
      isAtBottom: false,
      coordinateSpace: FLOW_COORDINATE_SPACE
    }
    expect('scrollTop' in stored).toBe(false)
    const out = normalizeSaved(stored)
    expect(out).not.toBeNull()
    expect(out).toMatchObject({
      messageId: 'm2',
      intraRowOffset: -5,
      isAtBottom: false,
      coordinateSpace: FLOW_COORDINATE_SPACE
    })
  })

  it('read-normalize-read is stable for the normalized anchor', () => {
    const stored = {
      messageId: 'm2',
      anchorId: 'm2',
      intraRowOffset: -5,
      isAtBottom: false,
      coordinateSpace: FLOW_COORDINATE_SPACE
    }
    const once = normalizeSaved(stored)
    expect(once).not.toBeNull()
    // Re-store the normalized shape (plain JSON round-trip) and read again.
    const restorted = JSON.parse(JSON.stringify(once))
    const twice = normalizeSaved(restorted)
    expect(twice).toEqual(once)
    expect(twice).toMatchObject({ messageId: 'm2', intraRowOffset: -5 })
  })

  it('still drops pre-flow numerics (old numbers are not restored)', () => {
    const out = normalizeSaved(-250)
    expect(out).not.toBeNull()
    expect(out).toMatchObject({ messageId: null, anchorId: null, intraRowOffset: null, isAtBottom: false })
    expect(out?.scrollTop).toBeUndefined()
  })

  it('retains a tagged legal position with numerics', () => {
    const stored = {
      scrollTop: -200,
      rawScrollTop: -200,
      messageId: 'm3',
      anchorId: 'm3',
      intraRowOffset: -7,
      isAtBottom: false,
      coordinateSpace: FLOW_COORDINATE_SPACE
    }
    expect(normalizeSaved(stored)).toMatchObject({
      scrollTop: -200,
      rawScrollTop: -200,
      messageId: 'm3',
      intraRowOffset: -7
    })
  })
})
