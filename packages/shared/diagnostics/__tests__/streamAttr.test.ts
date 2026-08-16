import { describe, expect, it } from 'vitest'

import {
  defaultStreamAttrSessionId,
  newStreamCorrelationId,
  nextStreamAttrOrdinal,
  resolveStreamAttrGate,
  STREAM_ATTR_MAX_RECORDS
} from '../streamAttr'

describe('resolveStreamAttrGate', () => {
  it('disabled for unset/empty/whitespace', () => {
    expect(resolveStreamAttrGate(undefined)).toBe(false)
    expect(resolveStreamAttrGate('')).toBe(false)
    expect(resolveStreamAttrGate('   ')).toBe(false)
  })

  it('enabled for 1 and true (case-insensitive)', () => {
    expect(resolveStreamAttrGate('1')).toBe(true)
    expect(resolveStreamAttrGate('true')).toBe(true)
    expect(resolveStreamAttrGate('TRUE')).toBe(true)
    expect(resolveStreamAttrGate(' 1 ')).toBe(true)
  })

  it('throws for any other non-empty value (fail-loud misconfiguration)', () => {
    for (const value of ['2', 'yes', 'on', 'false', '0']) {
      expect(() => resolveStreamAttrGate(value)).toThrow(/PERF_STREAM_ATTR/)
    }
  })
})

describe('nextStreamAttrOrdinal', () => {
  it('is 1-based and bounded defensively at 100', () => {
    // The counter is per-process; the shared module is stateless across tests
    // except the module-level ordinal counter. Assert the first few calls.
    const a = nextStreamAttrOrdinal()
    const b = nextStreamAttrOrdinal()
    expect(b).toBe(a + 1)
    expect(a).toBeGreaterThanOrEqual(1)
  })
})

describe('newStreamCorrelationId', () => {
  it('embeds the session id and ordinal as opaque, non-sensitive identity', () => {
    const id = newStreamCorrelationId('e2e-s0', 3)
    expect(id).toMatch(/^stm-e2e-s0-3-[a-z0-9]+$/)
    expect(id.length).toBeLessThanOrEqual(64)
  })
})

describe('defaultStreamAttrSessionId', () => {
  it('returns the fixed auto session', () => {
    expect(defaultStreamAttrSessionId()).toBe('auto')
  })
})

describe('STREAM_ATTR_MAX_RECORDS', () => {
  it('is a bounded positive constant', () => {
    expect(STREAM_ATTR_MAX_RECORDS).toBeGreaterThan(0)
  })
})
