import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { formatProfileSummary, setupDevSyncProfile } from '../setup-profile'

let owned: string[] = []

afterEach(() => {
  for (const dir of owned) rmSync(dir, { recursive: true, force: true })
  owned = []
  delete (globalThis as Record<string, unknown>).window
  delete (globalThis as Record<string, unknown>).document
})

interface FakeCalls {
  evaluates: number
  syncTouched: boolean
  storageWritten: boolean
  storeDispatched: boolean
  reloaded: boolean
  navigated: boolean
}

/**
 * Minimal fake Page satisfying the diagnostic probe contract. evaluate()
 * executes the closure against an instrumented window/document: any
 * localStorage write, store dispatch, or sync configure/connect marks the
 * call ledger so tests prove NO mutation happened (not by grepping source,
 * but by observing the fake surface).
 */
function makeFakePage(expectedAppDataDir: string, calls: FakeCalls, route: string): unknown {
  const fakeWindow: Record<string, unknown> = {
    api: {
      getAppInfo: async () => ({ appDataPath: expectedAppDataDir }),
      sync: {
        getConfig: async () => {
          calls.syncTouched = true
          return {}
        },
        setConfig: async () => {
          calls.syncTouched = true
        },
        connect: async () => {
          calls.syncTouched = true
        },
        getDeviceCode: async () => {
          calls.syncTouched = true
          return null
        },
        getPairState: async () => {
          calls.syncTouched = true
          return { state: 'unpaired' }
        }
      },
      setLanguage: async () => {
        calls.syncTouched = true
      }
    },
    localStorage: {
      setItem: () => {
        calls.storageWritten = true
      },
      getItem: () => null
    },
    store: {
      getState: () => ({ settings: {}, llm: {}, assistants: {} }),
      dispatch: () => {
        calls.storeDispatched = true
      }
    }
  }
  const fakeDocument = {
    querySelector: (selector: string) => (selector === '#root' || selector === 'body' ? {} : null),
    title: 'fake'
  }
  return {
    url: () => route,
    reload: async () => {
      calls.reloaded = true
    },
    goto: async () => {
      calls.navigated = true
    },
    evaluate: async (fn: (...args: never[]) => unknown) => {
      calls.evaluates++
      ;(globalThis as Record<string, unknown>).window = fakeWindow
      ;(globalThis as Record<string, unknown>).document = fakeDocument
      try {
        return await (fn as () => unknown)()
      } finally {
        delete (globalThis as Record<string, unknown>).window
        delete (globalThis as Record<string, unknown>).document
      }
    },
    $: async () => null
  }
}

function freshCalls(): FakeCalls {
  return {
    evaluates: 0,
    syncTouched: false,
    storageWritten: false,
    storeDispatched: false,
    reloaded: false,
    navigated: false
  }
}

describe('setupDevSyncProfile (diagnostic readiness only)', () => {
  it('verifies persisted identity + window runtime with zero mutations', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'dev-sync-prof-'))
    owned.push(profileDir)
    const calls = freshCalls()
    const page = makeFakePage(profileDir, calls, 'chrome-error://chromewebdata/')
    const result = await setupDevSyncProfile(page as never, {
      sessionId: 'sess-20261006-051530-373-9f4ecd',
      expectedUserDataDir: profileDir,
      label: 'A'
    })
    expect(result).toMatchObject({ label: 'A', appDataPath: profileDir })
    expect(calls.syncTouched).toBe(false)
    expect(calls.storageWritten).toBe(false)
    expect(calls.storeDispatched).toBe(false)
    expect(calls.reloaded).toBe(false)
    expect(calls.navigated).toBe(false)
    expect(formatProfileSummary(result)).toContain('persisted pair verified')
  })

  it('is ready on an arbitrary settings route (no home/textarea requirement)', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'dev-sync-prof-'))
    owned.push(profileDir)
    const calls = freshCalls()
    const page = makeFakePage(profileDir, calls, 'http://127.0.0.1:5173/#/settings/data')
    const result = await setupDevSyncProfile(page as never, {
      sessionId: 'sess-20261006-051530-373-9f4ecd',
      expectedUserDataDir: profileDir,
      label: 'B'
    })
    expect(result.appDataPath).toBe(profileDir)
    expect(calls.syncTouched).toBe(false)
  })

  it('fails closed when the runtime identity does not match the adopted dir', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'dev-sync-prof-'))
    owned.push(profileDir)
    const otherDir = mkdtempSync(join(tmpdir(), 'dev-sync-other-'))
    owned.push(otherDir)
    const calls = freshCalls()
    const page = makeFakePage(otherDir, calls, 'http://127.0.0.1:5173/')
    await expect(
      setupDevSyncProfile(page as never, {
        sessionId: 'sess-20261006-051530-373-9f4ecd',
        expectedUserDataDir: profileDir,
        label: 'A'
      })
    ).rejects.toThrow(/VIOLATION|refusing profile claim|Failed to probe/)
  })
})
