import { describe, expect, it, vi } from 'vitest'

import { hasExactUserDataDirToken, isZombieStat, terminateProcessesByUserDataDir } from './process-cleanup'

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

  it('distinguishes zombie Z stat from living S/R helpers', () => {
    expect(isZombieStat('Z')).toBe(true)
    expect(isZombieStat('Z+')).toBe(true)
    expect(isZombieStat('ZE')).toBe(true)
    expect(isZombieStat('S')).toBe(false)
    expect(isZombieStat('S+')).toBe(false)
    expect(isZombieStat('R')).toBe(false)
    expect(isZombieStat('R+')).toBe(false)
    expect(isZombieStat('')).toBe(false)
    expect(isZombieStat('  Z  ')).toBe(true)
  })

  it('treats zombie as not existing but S as existing via mocked stat', async () => {
    // Simulate processExists via isZombieStat logic: Z -> false, S -> true
    const exists = (stat: string | null): boolean => {
      if (stat === null) return false
      if (isZombieStat(stat)) return false
      return true
    }
    expect(exists('Z')).toBe(false)
    expect(exists('Z+')).toBe(false)
    expect(exists('S')).toBe(true)
    expect(exists('R')).toBe(true)
    expect(exists(null)).toBe(false)
  })
})
