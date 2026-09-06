import { describe, expect, it } from 'vitest'

import { isNonLoopbackHttpEndpoint, validateSyncEndpointUrl } from '../endpoint'

describe('shared sync endpoint policy', () => {
  it('rejects embedded URL credentials', () => {
    expect(validateSyncEndpointUrl('http://user:pass@example.com')).not.toBeNull()
    expect(validateSyncEndpointUrl('http://user@example.com')).not.toBeNull()
    expect(validateSyncEndpointUrl('https://user:pass@192.168.1.10:3030')).not.toBeNull()
    expect(validateSyncEndpointUrl('http://user:pass@127.0.0.1:3030')).not.toBeNull()
  })

  it('rejects wildcard/unspecified hosts and equivalent forms', () => {
    const wildcards = [
      'http://0.0.0.0:3030',
      'http://[::]:3030',
      'http://[::]/',
      'https://0.0.0.0:3030',
      'https://[::]:3030',
      'http://*:3030',
      'http://0:0:0:0:0:0:0:0:3030',
      'http://[0:0:0:0:0:0:0:0]:3030',
      'http://[0::]:3030',
      'http://[::0]:3030',
      'http://[0::0]:3030',
      'http://[::ffff:0.0.0.0]:3030',
      'http://[0:0:0:0:0:ffff:0.0.0.0]:3030',
      'http://[::0.0.0.0]:3030',
      'http://[::ffff:0:0]:3030',
      'http://[::%eth0]:3030'
    ]
    for (const raw of wildcards) {
      expect(validateSyncEndpointUrl(raw), raw).not.toBeNull()
    }
  })

  it('rejects malformed URL prefixes', () => {
    expect(validateSyncEndpointUrl('http:example.com')).not.toBeNull()
    expect(validateSyncEndpointUrl('http:///example.com')).not.toBeNull()
    expect(validateSyncEndpointUrl('ftp://example.com')).not.toBeNull()
    expect(validateSyncEndpointUrl('not-a-url')).not.toBeNull()
    expect(validateSyncEndpointUrl('http://')).not.toBeNull()
  })

  it('accepts valid HTTP/HTTPS loopback and LAN endpoints', () => {
    const valid = [
      'http://127.0.0.1:3030',
      'http://localhost:3000',
      'http://[::1]:3030',
      'http://192.168.1.10:3000',
      'http://example.com',
      'http://10.0.0.5:3030/sync',
      'http://[fe80::1]:3030',
      'https://example.com',
      'https://192.168.1.10/sync',
      'https://127.0.0.1:3030',
      'HTTP://192.168.1.10:3000'
    ]
    for (const raw of valid) {
      expect(validateSyncEndpointUrl(raw), raw).toBeNull()
    }
  })

  it('warns only for valid non-loopback plaintext HTTP', () => {
    expect(isNonLoopbackHttpEndpoint('http://192.168.1.10:3000')).toBe(true)
    expect(isNonLoopbackHttpEndpoint('http://example.com')).toBe(true)
    expect(isNonLoopbackHttpEndpoint('http://localhost:3000')).toBe(false)
    expect(isNonLoopbackHttpEndpoint('http://127.0.0.1:3030')).toBe(false)
    expect(isNonLoopbackHttpEndpoint('http://[::1]:3030')).toBe(false)
    expect(isNonLoopbackHttpEndpoint('https://192.168.1.10:3000')).toBe(false)
    // Rejected endpoints never warn.
    expect(isNonLoopbackHttpEndpoint('http://0.0.0.0:3030')).toBe(false)
    expect(isNonLoopbackHttpEndpoint('http://[::]:3030')).toBe(false)
    expect(isNonLoopbackHttpEndpoint('http://user:pass@example.com')).toBe(false)
    expect(isNonLoopbackHttpEndpoint('http:example.com')).toBe(false)
    expect(isNonLoopbackHttpEndpoint('http:///example.com')).toBe(false)
    expect(isNonLoopbackHttpEndpoint('not-a-url')).toBe(false)
    expect(isNonLoopbackHttpEndpoint('')).toBe(false)
  })

  it('never warns for overlong endpoints (same 2048-char limit as validation)', () => {
    const overlong = `http://192.168.1.10:3000/${'y'.repeat(2048)}`
    expect(overlong.trim().length).toBeGreaterThan(2048)
    expect(validateSyncEndpointUrl(overlong)).toBe('endpoint too long')
    expect(isNonLoopbackHttpEndpoint(overlong)).toBe(false)
  })
})
