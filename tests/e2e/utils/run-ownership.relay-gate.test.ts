/**
 * Fail-closed relay/root ownership gate (fixture cold-load regression).
 *
 * The Electron fixture teardown must block owned-root removal while a
 * file-backed relay handle is unresolved WITHOUT importing the relay-process
 * implementation (raw-TS dynamic cold-load breaks unrelated in-memory sync
 * specs under the fixture module system). The gate lives in run-ownership
 * (ABI-neutral, already fixture-loaded); the relay implementation registers
 * there and unregisters only after close() resolves.
 *
 * NOTE: this file never statically imports sync-relay-process — mirroring
 * the in-memory sync teardown path. The single shared-registry interop check
 * uses a scoped dynamic import only.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  assertNoLiveOwnedRelayChild,
  assertNoUnresolvedOwnedRelayCleanup,
  createOwnedTmpRoot,
  hasLiveOwnedRelayChild,
  hasUnresolvedOwnedRelayCleanup,
  registerOwnedRelayHandle,
  removeOwnedTmpRoot,
  unregisterOwnedRelayHandle,
  type OwnedRelayProbe
} from './run-ownership'

function fakeProbe(running: boolean, pid: number | null = 4242): OwnedRelayProbe {
  return {
    isRunning: () => running,
    pid: () => pid
  }
}

describe('owned relay gate blocks root removal while unresolved', () => {
  it('live handle blocks both gates; unregister releases them', () => {
    const handle = fakeProbe(true, 4242)
    registerOwnedRelayHandle(handle)
    try {
      expect(hasUnresolvedOwnedRelayCleanup()).toBe(true)
      expect(hasLiveOwnedRelayChild()).toBe(true)
      expect(() => assertNoUnresolvedOwnedRelayCleanup('fixture owned root removal')).toThrow(/blocked while/)
      expect(() => assertNoLiveOwnedRelayChild('fixture owned root removal')).toThrow(/blocked while/)
    } finally {
      unregisterOwnedRelayHandle(handle)
    }
    expect(hasUnresolvedOwnedRelayCleanup()).toBe(false)
    expect(hasLiveOwnedRelayChild()).toBe(false)
    expect(() => assertNoUnresolvedOwnedRelayCleanup('fixture owned root removal')).not.toThrow()
    expect(() => assertNoLiveOwnedRelayChild('fixture owned root removal')).not.toThrow()
  })

  it('reaped-but-uncleaned handle blocks unresolved gate but not the live gate', () => {
    const handle = fakeProbe(false, 4243)
    registerOwnedRelayHandle(handle)
    try {
      expect(hasUnresolvedOwnedRelayCleanup()).toBe(true)
      expect(hasLiveOwnedRelayChild()).toBe(false)
      expect(() => assertNoUnresolvedOwnedRelayCleanup('fixture owned root removal')).toThrow(/blocked while/)
      expect(() => assertNoLiveOwnedRelayChild('fixture owned root removal')).not.toThrow()
    } finally {
      unregisterOwnedRelayHandle(handle)
    }
    expect(hasUnresolvedOwnedRelayCleanup()).toBe(false)
  })

  it('throwing isRunning probe fails closed as live', () => {
    const handle: OwnedRelayProbe = {
      isRunning: () => {
        throw new Error('probe boom')
      },
      pid: () => 4244
    }
    registerOwnedRelayHandle(handle)
    try {
      expect(hasLiveOwnedRelayChild()).toBe(true)
      expect(() => assertNoLiveOwnedRelayChild('fixture owned root removal')).toThrow(/blocked while/)
      expect(() => assertNoUnresolvedOwnedRelayCleanup('fixture owned root removal')).toThrow(/blocked while/)
    } finally {
      unregisterOwnedRelayHandle(handle)
    }
  })

  it('duplicate registration does not double-track; one unregister resolves', () => {
    const handle = fakeProbe(true, 4245)
    registerOwnedRelayHandle(handle)
    registerOwnedRelayHandle(handle)
    try {
      expect(hasUnresolvedOwnedRelayCleanup()).toBe(true)
    } finally {
      unregisterOwnedRelayHandle(handle)
    }
    expect(hasUnresolvedOwnedRelayCleanup()).toBe(false)
  })

  it('fixture-ordered teardown preserves a gated root and removes it after resolution', async () => {
    const root = createOwnedTmpRoot()
    const handle = fakeProbe(true, 4246)
    registerOwnedRelayHandle(handle)
    try {
      expect(() => assertNoUnresolvedOwnedRelayCleanup('fixture owned root removal')).toThrow(/blocked while/)
      expect(fs.existsSync(root)).toBe(true)
    } finally {
      unregisterOwnedRelayHandle(handle)
    }
    assertNoUnresolvedOwnedRelayCleanup('fixture owned root removal')
    assertNoLiveOwnedRelayChild('fixture owned root removal')
    await removeOwnedTmpRoot(root, [])
    expect(fs.existsSync(root)).toBe(false)
  })
})

describe('fixture teardown boundary stays free of relay-process loading', () => {
  it('electron fixture never imports the relay-process implementation', () => {
    // Narrow static check only: the Playwright fixture cold module system
    // cannot be simulated under Vitest, so the no-import boundary is asserted
    // directly on the fixture source. Behavioral gating above covers runtime.
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'electron.fixture.ts')
    const source = fs.readFileSync(fixturePath, 'utf8')
    expect(source).not.toContain('sync-relay-process')
    expect(source).toContain('assertNoUnresolvedOwnedRelayCleanup')
    expect(source).toContain('assertNoLiveOwnedRelayChild')
  })

  it('relay implementation shares the same run-ownership registry', async () => {
    // Scoped dynamic import only — this file has no static relay-process
    // import, mirroring the in-memory teardown path.
    const relay = await import('./sync-relay-process')
    const handle = fakeProbe(true, 4247)
    registerOwnedRelayHandle(handle)
    try {
      expect(relay.hasUnresolvedRelayCleanup()).toBe(true)
      expect(relay.hasLiveRelayChild()).toBe(true)
      expect(() => relay.assertNoUnresolvedRelayCleanup('interop check')).toThrow()
      expect(() => relay.assertNoLiveRelayChild('interop check')).toThrow()
    } finally {
      unregisterOwnedRelayHandle(handle)
    }
    expect(relay.hasUnresolvedRelayCleanup()).toBe(false)
    expect(relay.hasLiveRelayChild()).toBe(false)
  })
})
