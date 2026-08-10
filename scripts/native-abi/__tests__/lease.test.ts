import { describe, expect, it } from 'vitest'

import {
  LEASE_ENV_NAME,
  LEASE_VERSION,
  leaseEnv,
  leaseFromEnv,
  parseLease,
  serializeLease,
  validateLease,
  withLease
} from '../lease'
import { type LockOwner, serializeLockFile } from '../lock'

const CHECKOUT = '/repo/checkout'

function owner(overrides: Partial<LockOwner> = {}): LockOwner {
  return {
    pid: 4242,
    token: 'tok-outer',
    lane: 'electron',
    checkoutRoot: CHECKOUT,
    timestamp: 1,
    ...overrides
  }
}

function leasePayload(overrides: { owner?: LockOwner; version?: number } = {}): string {
  return JSON.stringify({ version: overrides.version ?? LEASE_VERSION, owner: overrides.owner ?? owner() })
}

describe('lease environment inheritance and validation', () => {
  it('injects the lease while preserving the rest of the environment', () => {
    const base = { PATH: '/usr/bin', FOO: 'bar' }
    const injected = withLease(base, { version: 1, owner: owner() })

    expect(injected).toEqual({ ...base, [LEASE_ENV_NAME]: serializeLease({ version: 1, owner: owner() }) })
    // The input environment is never mutated.
    expect(base[LEASE_ENV_NAME]).toBeUndefined()
  })

  it('leaseEnv builds a child environment from a held lock owner', () => {
    const childEnv = leaseEnv({ PATH: '/usr/bin' }, owner({ token: 'tok-lane', lane: 'node' }))
    const lease = leaseFromEnv(childEnv)
    expect(lease).toEqual({
      version: 1,
      owner: { pid: 4242, token: 'tok-lane', lane: 'node', checkoutRoot: CHECKOUT, timestamp: 1 }
    })
    expect(childEnv.PATH).toBe('/usr/bin')
  })

  it('round-trips a lease through the environment', () => {
    const expected = owner({ token: 'tok-roundtrip' })
    const env = withLease({}, { version: 1, owner: expected })
    expect(leaseFromEnv(env)).toEqual({ version: 1, owner: expected })
  })

  it('rejects an absent lease', () => {
    const result = validateLease({}, { checkoutRoot: CHECKOUT })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('absent')
    }
  })

  it('rejects a malformed lease payload', () => {
    for (const raw of [
      'not-json{',
      '42',
      '[]',
      JSON.stringify({ version: 1 }),
      JSON.stringify({ version: 1, owner: { pid: 1 } })
    ]) {
      const result = validateLease({ [LEASE_ENV_NAME]: raw }, { checkoutRoot: CHECKOUT })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('malformed')
      }
    }
    // Invalid lane metadata is malformed, never a valid lease.
    const invalidLane = parseLease(leasePayload({ owner: owner({ lane: 'browser' as LockOwner['lane'] }) }))
    expect(invalidLane.ok).toBe(false)
    if (!invalidLane.ok) {
      expect(invalidLane.reason).toBe('malformed')
    }
  })

  it('rejects an unsupported lease version', () => {
    const result = validateLease({ [LEASE_ENV_NAME]: leasePayload({ version: 99 }) }, { checkoutRoot: CHECKOUT })
    expect(result).toEqual({
      ok: false,
      reason: 'version',
      detail: expect.stringContaining('99')
    })
  })

  it('rejects a lease whose owner carries a relative checkoutRoot (fail closed)', () => {
    const result = parseLease(leasePayload({ owner: owner({ checkoutRoot: 'relative/checkout' }) }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('malformed')
    }
    const env = withLease({}, { version: 1, owner: owner({ checkoutRoot: 'relative/checkout' }) })
    const validated = validateLease(env, { checkoutRoot: CHECKOUT })
    expect(validated.ok).toBe(false)
  })

  it('rejects a checkout-root mismatch', () => {
    const env = withLease({}, { version: 1, owner: owner({ checkoutRoot: CHECKOUT }) })
    const result = validateLease(env, { checkoutRoot: '/other/checkout' })
    expect(result).toEqual({
      ok: false,
      reason: 'checkout-mismatch',
      detail: expect.stringContaining('/other/checkout')
    })
  })

  it('rejects a token mismatch', () => {
    const env = withLease({}, { version: 1, owner: owner({ token: 'tok-outer' }) })
    const result = validateLease(env, { checkoutRoot: CHECKOUT, token: 'tok-other' })
    expect(result).toEqual({
      ok: false,
      reason: 'token-mismatch',
      detail: expect.stringContaining('tok-other')
    })
  })

  it('accepts valid nested inheritance under the same checkout and token', () => {
    const outer = { version: 1 as const, owner: owner({ token: 'tok-nested' }) }
    const outerEnv = withLease({}, outer)

    // The inner lane re-validates the inherited lease against the same
    // checkout/acquisition and proceeds.
    const inner = validateLease(outerEnv, { checkoutRoot: CHECKOUT, token: 'tok-nested' })
    expect(inner).toEqual({ ok: true, lease: outer })

    // A grandchild inherits the lease through a further env copy unchanged.
    const grandchildEnv = { ...outerEnv }
    const grandchild = validateLease(grandchildEnv, { checkoutRoot: CHECKOUT, token: 'tok-nested' })
    expect(grandchild.ok).toBe(true)
  })

  it('replaces an inherited lease when a new acquisition injects its own', () => {
    const outer = withLease({}, { version: 1, owner: owner({ token: 'tok-outer' }) })
    const inner = withLease(outer, { version: 1, owner: owner({ token: 'tok-inner' }) })

    const result = validateLease(inner, { checkoutRoot: CHECKOUT, token: 'tok-inner' })
    expect(result.ok).toBe(true)
    const stale = validateLease(inner, { checkoutRoot: CHECKOUT, token: 'tok-outer' })
    expect(stale.ok).toBe(false)
    if (!stale.ok) {
      expect(stale.reason).toBe('token-mismatch')
    }
  })

  it('serializes a lock file with the same owner shape a lease carries', () => {
    // The lock owner record is the single source of truth for both artifacts.
    const o = owner()
    const parsed = JSON.parse(serializeLockFile({ version: 1, owner: o })) as { owner: LockOwner }
    expect(parsed.owner).toEqual(o)
    expect(leaseFromEnv(withLease({}, { version: 1, owner: parsed.owner }))?.owner).toEqual(o)
  })
})
