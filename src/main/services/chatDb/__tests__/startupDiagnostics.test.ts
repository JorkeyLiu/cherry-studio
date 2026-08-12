/**
 * Startup SQLite metadata tests (LOCK-002/003/005).
 *
 * Focused unit tests for the sanitized startup metadata collector:
 * - Fixed size bucketing (no exact personal-profile file sizes in logs)
 * - DB/WAL/SHM presence flags
 * - Failure-safe reads: throwing PRAGMAs and stats become safe unknowns
 *   (null / absence), never throws
 * - Only fixed read-only PRAGMA names are sampled
 *
 * These tests never open or scan a real database or personal profile; the
 * collector receives a fake pragma handle and an injectable stat provider.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  bucketFileSize,
  collectStartupMetadata,
  type FileStatsProvider,
  STARTUP_PRAGMAS,
  type StartupMetadata
} from '../startupDiagnostics'

const FAKE_DB_PATH = '/fake/profile/chat.db'

function makeFakeSqlite(overrides: Record<string, unknown> = {}) {
  const pragma = (name: string) => {
    if (name in overrides) return overrides[name]
    return name === 'page_size' ? 4096 : name === 'synchronous' ? 1 : 42
  }
  return { pragma: vi.fn(pragma) as unknown as (name: string, opts?: unknown) => unknown }
}

function makeFakeStats(entries: Record<string, number>): FileStatsProvider {
  return (p: string) => (p in entries ? { size: entries[p] } : undefined)
}

describe('bucketFileSize — fixed non-sensitive buckets', () => {
  it('buckets sizes into stable categories', () => {
    expect(bucketFileSize(0)).toBe('0B')
    expect(bucketFileSize(500)).toBe('<1KB')
    expect(bucketFileSize(1024)).toBe('<1KB')
    expect(bucketFileSize(2048)).toBe('1KB-1MB')
    expect(bucketFileSize(5 * 1024 * 1024)).toBe('1-10MB')
    expect(bucketFileSize(50 * 1024 * 1024)).toBe('10-100MB')
    expect(bucketFileSize(500 * 1024 * 1024)).toBe('100MB-1GB')
    expect(bucketFileSize(2 * 1024 * 1024 * 1024)).toBe('>1GB')
  })

  it('never emits raw byte counts', () => {
    const fixedLabels = ['0B', '<1KB', '1KB-1MB', '1-10MB', '10-100MB', '100MB-1GB', '>1GB']
    for (const bytes of [0, 1, 4096, 12345678, 1.5 * 1024 * 1024 * 1024]) {
      const bucket = bucketFileSize(bytes)
      // Always one of the fixed labels — never the raw byte count.
      expect(fixedLabels).toContain(bucket)
    }
    // A large raw byte count never leaks through.
    expect(bucketFileSize(12345678)).not.toContain('12345678')
  })
})

describe('collectStartupMetadata — sanitized, failure-safe metadata', () => {
  it('reports DB/WAL/SHM presence with bucketed sizes', () => {
    const sqlite = makeFakeSqlite()
    const stats = makeFakeStats({
      [FAKE_DB_PATH]: 5 * 1024 * 1024,
      [`${FAKE_DB_PATH}-wal`]: 40 * 1024 * 1024,
      [`${FAKE_DB_PATH}-shm`]: 512
    })

    const metadata: StartupMetadata = collectStartupMetadata(sqlite as any, FAKE_DB_PATH, stats)
    expect(metadata.dbSizeBucket).toBe('1-10MB')
    expect(metadata.walPresent).toBe(true)
    expect(metadata.walSizeBucket).toBe('10-100MB')
    expect(metadata.shmPresent).toBe(true)
    expect(metadata.shmSizeBucket).toBe('<1KB')
  })

  it('reports absence of WAL/SHM files when stats are unavailable', () => {
    const sqlite = makeFakeSqlite()
    const stats = makeFakeStats({ [FAKE_DB_PATH]: 100 })

    const metadata = collectStartupMetadata(sqlite as any, FAKE_DB_PATH, stats)
    expect(metadata.dbSizeBucket).toBe('<1KB')
    expect(metadata.walPresent).toBe(false)
    expect(metadata.walSizeBucket).toBeNull()
    expect(metadata.shmPresent).toBe(false)
    expect(metadata.shmSizeBucket).toBeNull()
  })

  it('reads only the fixed read-only PRAGMA set and returns primitives', () => {
    const sqlite = makeFakeSqlite({ page_count: 1234, busy_timeout: 5000, foreign_keys: 1 })
    const stats = makeFakeStats({ [FAKE_DB_PATH]: 1 })

    const metadata = collectStartupMetadata(sqlite as any, FAKE_DB_PATH, stats)
    expect(Object.keys(metadata.sqlite).sort()).toEqual([...STARTUP_PRAGMAS].sort())
    expect(metadata.sqlite.page_count).toBe(1234)
    expect(metadata.sqlite.page_size).toBe(4096)
    expect(metadata.sqlite.busy_timeout).toBe(5000)
    expect(metadata.sqlite.foreign_keys).toBe(1)
  })

  it('turns a throwing PRAGMA read into a safe null, never a throw', () => {
    const throwingSqlite = {
      pragma: vi.fn(() => {
        throw new Error('corrupt database metadata read')
      })
    }
    const stats = makeFakeStats({ [FAKE_DB_PATH]: 1 })

    const metadata = collectStartupMetadata(throwingSqlite as any, FAKE_DB_PATH, stats)
    for (const value of Object.values(metadata.sqlite)) {
      expect(value).toBeNull()
    }
  })

  it('turns non-primitive PRAGMA results into safe null', () => {
    const sqlite = makeFakeSqlite({ page_count: { rows: [] } })
    const stats = makeFakeStats({ [FAKE_DB_PATH]: 1 })

    const metadata = collectStartupMetadata(sqlite as any, FAKE_DB_PATH, stats)
    expect(metadata.sqlite.page_count).toBeNull()
  })

  it('is failure-safe when the stat provider throws', () => {
    const sqlite = makeFakeSqlite()
    const throwingStats: FileStatsProvider = () => {
      throw new Error('stat failed')
    }

    const metadata = collectStartupMetadata(sqlite as any, FAKE_DB_PATH, throwingStats)
    expect(metadata.dbSizeBucket).toBeNull()
    expect(metadata.walPresent).toBe(false)
    expect(metadata.shmPresent).toBe(false)
    // Pragmas unaffected by the stat failure.
    expect(metadata.sqlite.page_size).toBe(4096)
  })
})
