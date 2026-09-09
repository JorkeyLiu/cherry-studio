import { describe, expect, it, vi } from 'vitest'

import { hasExactUserDataDirToken, terminateProcessesByUserDataDir } from './process-cleanup'

describe('exact-token process cleanup', () => {
  it('matches only the complete user-data-dir argv token', () => {
    expect(hasExactUserDataDirToken('--user-data-dir=/private/var/profile', '/private/var/profile')).toBe(true)
    expect(hasExactUserDataDirToken('--user-data-dir=/private/var/profile-copy', '/private/var/profile')).toBe(false)
    expect(hasExactUserDataDirToken('--user-data-dir=/var/profile', '/private/var/profile')).toBe(false)
  })

  it('requires a stable empty verification interval and catches a late spawn', async () => {
    let scanCount = 0
    const scan = vi.fn(() => {
      scanCount += 1
      return scanCount === 3 ? [{ pid: 77, args: '--user-data-dir=/owned/profile' }] : []
    })
    const kill = vi.fn((_pid: number) => ({ ok: true }))
    const killed = new Set<number>()
    const exists = vi.fn((pid: number) => !killed.has(pid))
    kill.mockImplementation((pid: number) => {
      killed.add(pid)
      return { ok: true }
    })
    const sleep = vi.fn(async () => undefined)

    const result = await terminateProcessesByUserDataDir(
      '/owned/profile',
      null,
      { termGraceMs: 0, settleMs: 0, verifyMs: 3 },
      {
        scan,
        kill,
        exists,
        sleep
      }
    )

    expect(kill).toHaveBeenCalledWith(77, 'SIGKILL')
    expect(result.errors).toEqual([])
    expect(scan.mock.calls.length).toBeGreaterThan(3)
  })

  it('succeeds only after the empty interval remains stable', async () => {
    const scan = vi.fn(() => [])
    const result = await terminateProcessesByUserDataDir(
      '/owned/profile',
      null,
      { termGraceMs: 0, settleMs: 0, verifyMs: 3 },
      {
        scan,
        sleep: vi.fn(async () => undefined)
      }
    )

    expect(result.errors).toEqual([])
    expect(scan.mock.calls.length).toBeGreaterThan(2)
  })
})
