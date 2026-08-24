/**
 * Focused pure tests for M8 L3 archive health helpers (m8L3ArchiveHealth.ts)
 * Env gate, bounded scale, deterministic fixture math, bounded detail,
 * metric/gate IDs, completeness, failure-closed.
 */

import { describe, expect, it } from 'vitest'

import {
  assertBoundedDetail,
  assertM8SampleCounts,
  buildM8Gates,
  buildM8Metrics,
  byteLengthUtf8,
  computeM8TimingStats,
  deterministicFileByte,
  fileLengthsForScenario,
  isValidM8Suffix,
  M8_L3_ARCHIVE_BENCH_ENV,
  M8_L3_ARCHIVE_BENCH_ID,
  M8_L3_ARCHIVE_COMMAND,
  M8_MEASURE_ROUNDS,
  M8_METRIC_KINDS,
  M8_SCENARIOS,
  M8_WARMUP_ROUNDS,
  m8Scale,
  resolveM8L3ArchiveGate
} from './m8L3ArchiveHealth'

describe('resolveM8L3ArchiveGate', () => {
  it('is disabled by default (unset/empty/whitespace)', () => {
    expect(resolveM8L3ArchiveGate(undefined)).toBe(false)
    expect(resolveM8L3ArchiveGate('')).toBe(false)
    expect(resolveM8L3ArchiveGate('   ')).toBe(false)
    expect(resolveM8L3ArchiveGate('\t\n ')).toBe(false)
  })
  it('enables only on 1/true case-insensitively trimmed', () => {
    expect(resolveM8L3ArchiveGate('1')).toBe(true)
    expect(resolveM8L3ArchiveGate('true')).toBe(true)
    expect(resolveM8L3ArchiveGate('TRUE')).toBe(true)
    expect(resolveM8L3ArchiveGate(' True ')).toBe(true)
    expect(resolveM8L3ArchiveGate(' 1 ')).toBe(true)
  })
  it('rejects any other non-empty value', () => {
    for (const bad of ['yes', '0', 'false', 'enabled', 'on', '2']) {
      expect(() => resolveM8L3ArchiveGate(bad)).toThrow(/M8_L3_ARCHIVE_BENCH/)
    }
  })
  it('declares stable env, id, command', () => {
    expect(M8_L3_ARCHIVE_BENCH_ENV).toBe('M8_L3_ARCHIVE_BENCH')
    expect(M8_L3_ARCHIVE_BENCH_ID).toBe('chatdb-m8-l3-archive-health')
    expect(M8_L3_ARCHIVE_COMMAND).toBe('pnpm bench:m8-l3-archive')
    expect(M8_L3_ARCHIVE_COMMAND).not.toMatch(/[\\/]/)
  })
})

describe('bounded scale matrix (M8-S0/S1/S1-wide)', () => {
  it('has exactly 3 scenarios', () => {
    expect(M8_SCENARIOS).toHaveLength(3)
    expect(M8_WARMUP_ROUNDS).toBe(1)
    expect(M8_MEASURE_ROUNDS).toBe(5)
  })
  it('contains deterministic fixed scales', () => {
    expect(M8_SCENARIOS[0]).toMatchObject({
      suffix: 's0',
      topics: 1,
      messages: 100,
      blocks: 100,
      fileEntries: 4,
      fileBytes: 4096
    })
    expect(M8_SCENARIOS[1]).toMatchObject({
      suffix: 's1',
      topics: 10,
      messages: 1000,
      blocks: 1000,
      fileEntries: 32,
      fileBytes: 65536
    })
    expect(M8_SCENARIOS[2]).toMatchObject({
      suffix: 's1wide',
      topics: 25,
      messages: 5000,
      blocks: 5000,
      fileEntries: 128,
      fileBytes: 262144
    })
  })
  it('scale is finite numeric only', () => {
    const scale = m8Scale()
    for (const [k, v] of Object.entries(scale)) {
      expect(typeof v, k).toBe('number')
      expect(Number.isFinite(v), k).toBe(true)
    }
    expect(scale.scenarioCount).toBe(3)
    expect(scale.topics_s0).toBe(1)
    expect(scale.fileBytes_s1wide).toBe(262144)
  })
})

describe('deterministic fixture math', () => {
  it('deterministicFileByte mirrors (index+offset)%251', () => {
    expect(deterministicFileByte(0, 0)).toBe(0)
    expect(deterministicFileByte(1, 250)).toBe(0)
    expect(deterministicFileByte(5, 10)).toBe(15)
    expect(deterministicFileByte(250, 1)).toBe(0)
  })
  it('fileLengthsForScenario distributes remainder', () => {
    expect(fileLengthsForScenario(4096, 4)).toEqual([1024, 1024, 1024, 1024])
    expect(fileLengthsForScenario(10, 3)).toEqual([4, 3, 3])
    expect(fileLengthsForScenario(0, 1)).toEqual([0])
    const lens = fileLengthsForScenario(262144, 128)
    expect(lens).toHaveLength(128)
    expect(lens.reduce((a, b) => a + b, 0)).toBe(262144)
  })
  it('throws on invalid fileEntries/fileBytes', () => {
    expect(() => fileLengthsForScenario(10, 0)).toThrow()
    expect(() => fileLengthsForScenario(-1, 1)).toThrow()
  })
})

describe('bounded detail', () => {
  it('passes for bounded non-empty string', () => {
    expect(() => assertBoundedDetail('ok')).not.toThrow()
    const s = 'a'.repeat(256)
    expect(byteLengthUtf8(s)).toBe(256)
    expect(() => assertBoundedDetail(s)).not.toThrow()
  })
  it('fails for empty or oversized', () => {
    expect(() => assertBoundedDetail('')).toThrow()
    expect(() => assertBoundedDetail('a'.repeat(257))).toThrow(/exceeds/)
    const emoji = '😀' // 4 bytes
    const oversized = emoji.repeat(65) // 260 bytes
    expect(byteLengthUtf8(oversized)).toBeGreaterThan(256)
    expect(() => assertBoundedDetail(oversized)).toThrow()
  })
  it('byteLengthUtf8 handles CJK', () => {
    expect(byteLengthUtf8('中文')).toBe(6)
  })
})

describe('metric/gate IDs', () => {
  it('valid suffixes', () => {
    expect(isValidM8Suffix('s0')).toBe(true)
    expect(isValidM8Suffix('s1')).toBe(true)
    expect(isValidM8Suffix('s1wide')).toBe(true)
    expect(isValidM8Suffix('s2')).toBe(false)
  })
  it('buildM8Metrics creates 15 finite metrics with correct IDs', () => {
    const map: Map<string, any> = new Map()
    for (const s of M8_SCENARIOS) {
      map.set(s.suffix, {
        backupMs: [1, 2, 3, 4, 5],
        restoreMs: [2, 3, 4, 5, 6],
        metadataBytes: [100, 100, 100, 100, 100],
        archiveEntryCount: [10, 10, 10, 10, 10],
        archiveCompressedBytes: [1000, 1000, 1000, 1000, 1000]
      })
    }
    const metrics = buildM8Metrics(map as any)
    expect(metrics).toHaveLength(15)
    const ids = metrics.map((m) => m.id)
    expect(new Set(ids).size).toBe(15)
    for (const suffix of ['s0', 's1', 's1wide']) {
      for (const kind of M8_METRIC_KINDS) {
        expect(ids).toContain(`${kind}_${suffix}`)
      }
    }
    for (const m of metrics) expect(Number.isFinite(m.value)).toBe(true)
  })
  it('buildM8Gates creates 21 correctness gates with bounded details', () => {
    const inputs: any = {}
    for (const s of M8_SCENARIOS) {
      inputs[s.suffix] = {
        metadataV7: { passed: true, detail: 'metadata v7 ok' },
        archiveSafety: { passed: true, detail: 'archive safety ok' },
        chatDbPresence: { passed: true, detail: 'chat_db_presence ok' },
        excludedAbsence: { passed: true, detail: 'excluded ok' },
        snapshotIntegrity: { passed: true, detail: 'snapshot ok' },
        restoreParity: { passed: true, detail: 'restore parity ok' },
        sampleCompleteness: { passed: true, detail: 'sample complete ok' }
      }
    }
    const gates = buildM8Gates(inputs)
    expect(gates).toHaveLength(21)
    for (const g of gates) {
      expect(g.kind).toBe('correctness')
      expect(typeof g.passed).toBe('boolean')
      expect(() => assertBoundedDetail(g.detail!)).not.toThrow()
    }
    expect(gates.map((g) => g.id)).toContain('metadata_v7_s0')
    expect(gates.map((g) => g.id)).toContain('restore_parity_s1wide')
  })
  it('fails closed on oversized detail', () => {
    const inputs: any = {}
    for (const s of M8_SCENARIOS) {
      inputs[s.suffix] = {
        metadataV7: { passed: true, detail: 'a'.repeat(300) },
        archiveSafety: { passed: true, detail: 'ok' },
        chatDbPresence: { passed: true, detail: 'ok' },
        excludedAbsence: { passed: true, detail: 'ok' },
        snapshotIntegrity: { passed: true, detail: 'ok' },
        restoreParity: { passed: true, detail: 'ok' },
        sampleCompleteness: { passed: true, detail: 'ok' }
      }
    }
    expect(() => buildM8Gates(inputs)).toThrow(/exceeds/)
  })
})

describe('completeness', () => {
  it('assertM8SampleCounts passes when each scenario has exactly 5', () => {
    const m = new Map<string, readonly number[]>([
      ['s0', [1, 2, 3, 4, 5]],
      ['s1', [1, 2, 3, 4, 5]],
      ['s1wide', [1, 2, 3, 4, 5]]
    ])
    expect(assertM8SampleCounts(m, 5).ok).toBe(true)
  })
  it('fails when missing or count mismatch', () => {
    const m = new Map<string, readonly number[]>([
      ['s0', [1, 2, 3, 4, 5]],
      ['s1', [1, 2, 3, 4]],
      ['s1wide', [1, 2, 3, 4, 5]]
    ])
    expect(() => assertM8SampleCounts(m, 5)).toThrow(/expected exactly 5/)
    const m2 = new Map<string, readonly number[]>([['s0', [1, 2, 3, 4, 5]]])
    expect(() => assertM8SampleCounts(m2, 5)).toThrow(/no samples/)
  })
})

describe('computeM8TimingStats', () => {
  it('computes p50/p95/mean/min/max', () => {
    const stats = computeM8TimingStats([1, 2, 3, 4, 5])
    expect(stats.p50).toBe(3)
    expect(stats.p95).toBe(5)
    expect(stats.mean).toBe(3)
    expect(stats.min).toBe(1)
    expect(stats.max).toBe(5)
  })
  it('throws on empty or non-finite', () => {
    expect(() => computeM8TimingStats([])).toThrow()
    expect(() => computeM8TimingStats([1, Infinity])).toThrow()
  })
})
