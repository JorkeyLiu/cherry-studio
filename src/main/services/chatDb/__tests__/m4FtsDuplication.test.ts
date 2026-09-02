/**
 * Focused pure tests for M4 FTS duplication helper (m4FtsDuplication.ts):
 * env-gate, bounded scale, UTF-8 aggregation, metric/gate construction,
 * sample/completeness, finite-value and privacy invariants.
 *
 * Pure logic — imports no native module, so mainLanes.ts classifies it
 * into the core lane (`pnpm test:main:core`).
 */

import { describe, expect, it } from 'vitest'

import {
  aggregateCharCount,
  aggregateUtf8Bytes,
  assertCheckpointComplete,
  assertM4PrivacyInvariants,
  assertM4SampleCompleteness,
  buildM4BusyCheckpointFailureMessage,
  buildM4CheckpointFailureMessage,
  buildM4FtsDuplicationGates,
  buildM4FtsDuplicationMetrics,
  buildM4FtsSmokeFailureDetail,
  buildM4PhysicalMetrics,
  buildM4StatFailureMessage,
  DEFAULT_M4_FTS_DUP_SCALE,
  M4_CHECKPOINT_FAILURE_CATEGORY,
  M4_FTS_DUP_BENCH_ENV,
  M4_FTS_DUP_COMMAND,
  M4_FTS_DUP_PROFILES,
  M4_FTS_DUP_SCALE_ENV,
  M4_FTS_SMOKE_FAILURE_CATEGORY,
  M4_STAT_FAILURE_CATEGORY,
  m4FtsDupScaleMetadata,
  parseCheckpointBusy,
  resolveM4FtsDupGate,
  resolveM4FtsDupScale,
  utf8ByteLength
} from './m4FtsDuplication'

describe('resolveM4FtsDupGate (default inert / on-demand enable)', () => {
  it('is disabled by default (unset/empty/whitespace)', () => {
    expect(resolveM4FtsDupGate(undefined)).toBe(false)
    expect(resolveM4FtsDupGate('')).toBe(false)
    expect(resolveM4FtsDupGate('   ')).toBe(false)
    expect(resolveM4FtsDupGate('\t\n ')).toBe(false)
  })
  it('enables only on 1/true values case-insensitively', () => {
    expect(resolveM4FtsDupGate('1')).toBe(true)
    expect(resolveM4FtsDupGate('true')).toBe(true)
    expect(resolveM4FtsDupGate('TRUE')).toBe(true)
    expect(resolveM4FtsDupGate(' True ')).toBe(true)
    expect(resolveM4FtsDupGate(' 1 ')).toBe(true)
  })
  it('rejects any other non-empty value loudly', () => {
    for (const bad of ['yes', '0', 'false', 'on', 'enabled', '2']) {
      expect(() => resolveM4FtsDupGate(bad)).toThrow(/M4_FTS_DUP_BENCH/)
    }
  })
  it('declares stable env and command without path', () => {
    expect(M4_FTS_DUP_BENCH_ENV).toBe('M4_FTS_DUP_BENCH')
    expect(M4_FTS_DUP_COMMAND).toBe('pnpm bench:m4-fts-dup')
    expect(M4_FTS_DUP_COMMAND).not.toMatch(/[\\/]/)
  })
})

describe('bounded scale profile (1k/10k/50k, default 10k)', () => {
  it('declares exactly three profiles', () => {
    expect(Object.keys(M4_FTS_DUP_PROFILES).sort()).toEqual(['10k', '1k', '50k'])
    expect(M4_FTS_DUP_SCALE_ENV).toBe('M4_FTS_DUP_SCALE')
    expect(DEFAULT_M4_FTS_DUP_SCALE).toBe('10k')
  })
  it('keeps 10k as default bounded profile', () => {
    const p = M4_FTS_DUP_PROFILES['10k']
    expect(p.blocks).toBe(10_000)
    expect(p.id).toBe('chatdb-m4-fts-duplication-10k')
    expect(p.profileCode).toBe(1)
  })
  it('defines distinct 1k and 50k profiles', () => {
    expect(M4_FTS_DUP_PROFILES['1k'].blocks).toBe(1_000)
    expect(M4_FTS_DUP_PROFILES['50k'].blocks).toBe(50_000)
    expect(M4_FTS_DUP_PROFILES['1k'].profileCode).toBe(0)
    expect(M4_FTS_DUP_PROFILES['50k'].profileCode).toBe(2)
  })
  it('resolves default when unset/empty', () => {
    expect(resolveM4FtsDupScale(undefined)).toBe('10k')
    expect(resolveM4FtsDupScale('')).toBe('10k')
    expect(resolveM4FtsDupScale('   ')).toBe('10k')
  })
  it('resolves each declared profile deterministically', () => {
    for (const k of Object.keys(M4_FTS_DUP_PROFILES) as Array<keyof typeof M4_FTS_DUP_PROFILES>) {
      expect(resolveM4FtsDupScale(k)).toBe(k)
    }
  })
  it('rejects unknown scale loudly', () => {
    for (const bad of ['120k', '50000', '10K', '2k', 'n1']) {
      expect(() => resolveM4FtsDupScale(bad)).toThrow(/M4_FTS_DUP_SCALE/)
    }
  })
  it('scale metadata is finite numeric', () => {
    const meta = m4FtsDupScaleMetadata(M4_FTS_DUP_PROFILES['10k'])
    expect(meta.blocks).toBe(10_000)
    expect(meta.profileCode).toBe(1)
    for (const v of Object.values(meta)) expect(Number.isFinite(v)).toBe(true)
  })
})

describe('UTF-8 byte aggregation (numeric-only, no content leakage)', () => {
  it('utf8ByteLength counts bytes correctly for ASCII/CJK/emoji', () => {
    expect(utf8ByteLength('hello')).toBe(5)
    expect(utf8ByteLength('')).toBe(0)
    // CJK 3 bytes each in UTF-8
    expect(utf8ByteLength('人工')).toBe(6)
    expect(utf8ByteLength('a人工b')).toBe(1 + 6 + 1)
    // emoji 4 bytes
    expect(utf8ByteLength('😀')).toBe(4)
  })
  it('aggregateCharCount sums lengths', () => {
    expect(aggregateCharCount(['hello', '人工'])).toBe(5 + 2)
    expect(aggregateCharCount([])).toBe(0)
  })
  it('aggregateUtf8Bytes sums bytes', () => {
    expect(aggregateUtf8Bytes(['hello', '人工'])).toBe(5 + 6)
    expect(aggregateUtf8Bytes([])).toBe(0)
    expect(aggregateUtf8Bytes(['😀', 'a'])).toBe(4 + 1)
  })
  it('handles mixed deterministic corpus strings', () => {
    const corpus = ['hello', '人工智能', 'foo 😀 bar', '']
    const bytes = aggregateUtf8Bytes(corpus)
    const chars = aggregateCharCount(corpus)
    expect(Number.isFinite(bytes)).toBe(true)
    expect(Number.isFinite(chars)).toBe(true)
    expect(bytes).toBeGreaterThan(chars) // CJK/emoji inflate bytes
  })
})

describe('buildM4FtsDuplicationMetrics (finite, privacy, no content)', () => {
  it('builds required 5 metrics plus optional FTS scalars', () => {
    const metrics = buildM4FtsDuplicationMetrics({
      canonicalRows: 10_000,
      normalizedRows: 10_000,
      ftsRows: 10_000,
      normalizedChars: 123456,
      normalizedBytesUtf8: 200000
    })
    expect(metrics.map((m) => m.id)).toEqual([
      'canonical.rows',
      'normalized.rows',
      'fts.rows',
      'normalized.chars',
      'normalized.bytesUtf8'
    ])
    for (const m of metrics) expect(Number.isFinite(m.value)).toBe(true)
  })
  it('adds FTS char/byte and duplication totals when FTS sides supplied', () => {
    const metrics = buildM4FtsDuplicationMetrics({
      canonicalRows: 1000,
      normalizedRows: 1000,
      ftsRows: 1000,
      normalizedChars: 5000,
      normalizedBytesUtf8: 6000,
      ftsChars: 5000,
      ftsBytesUtf8: 6000
    })
    const ids = metrics.map((m) => m.id)
    expect(ids).toContain('fts.chars')
    expect(ids).toContain('fts.bytesUtf8')
    expect(ids).toContain('duplication.logicalChars')
    expect(ids).toContain('duplication.logicalBytesUtf8')
    const dupChars = metrics.find((m) => m.id === 'duplication.logicalChars')!
    expect(dupChars.value).toBe(10000)
    const dupBytes = metrics.find((m) => m.id === 'duplication.logicalBytesUtf8')!
    expect(dupBytes.value).toBe(12000)
  })
  it('throws on non-finite row counts', () => {
    expect(() =>
      buildM4FtsDuplicationMetrics({
        canonicalRows: Number.NaN,
        normalizedRows: 1,
        ftsRows: 1,
        normalizedChars: 1,
        normalizedBytesUtf8: 1
      })
    ).toThrow(/canonical\.rows/)
  })
  it('carries byte units only on byte metrics', () => {
    const metrics = buildM4FtsDuplicationMetrics({
      canonicalRows: 10,
      normalizedRows: 10,
      ftsRows: 10,
      normalizedChars: 100,
      normalizedBytesUtf8: 120,
      ftsBytesUtf8: 120
    })
    for (const m of metrics) {
      if (m.id.endsWith('bytesUtf8') || m.id === 'duplication.logicalBytesUtf8') expect(m.unit).toBe('bytes')
      else if (m.id.includes('.rows') || m.id.includes('.chars') || m.id === 'duplication.logicalChars')
        expect(m.unit).toBeUndefined()
    }
  })
  it('ids are stable ASCII without path segments', () => {
    const metrics = buildM4FtsDuplicationMetrics({
      canonicalRows: 5,
      normalizedRows: 5,
      ftsRows: 5,
      normalizedChars: 10,
      normalizedBytesUtf8: 10
    })
    for (const m of metrics) {
      expect(m.id).toMatch(/^[A-Za-z0-9._]+$/)
      expect(m.id).not.toMatch(/[\\/]/)
    }
  })
})

describe('buildM4FtsDuplicationGates (parity/classification)', () => {
  it('passes parity when all row counts equal', () => {
    const gates = buildM4FtsDuplicationGates({
      canonicalRows: 1000,
      normalizedRows: 1000,
      ftsRows: 1000,
      ftsSmokePassed: true,
      ftsSmokeDetail: 'FTS smoke passed: MATCH token executed without throw',
      corpusBlocks: 1000,
      finitePassed: true,
      finiteDetail: 'all metrics finite'
    })
    expect(gates.find((g) => g.id === 'parity.rowCounts')!.passed).toBe(true)
    expect(gates.find((g) => g.id === 'corpus.completeness')!.passed).toBe(true)
    expect(gates.find((g) => g.id === 'fts.smoke')!.passed).toBe(true)
    expect(gates.find((g) => g.id === 'metrics.finite')!.passed).toBe(true)
  })
  it('fails parity when mismatch', () => {
    const gates = buildM4FtsDuplicationGates({
      canonicalRows: 1000,
      normalizedRows: 999,
      ftsRows: 1000,
      ftsSmokePassed: true,
      ftsSmokeDetail: 'smoke ok',
      corpusBlocks: 1000,
      finitePassed: true,
      finiteDetail: 'finite'
    })
    expect(gates.find((g) => g.id === 'parity.rowCounts')!.passed).toBe(false)
  })
  it('fails corpus when expected blocks mismatch', () => {
    const gates = buildM4FtsDuplicationGates({
      canonicalRows: 1000,
      normalizedRows: 1000,
      ftsRows: 1000,
      ftsSmokePassed: true,
      ftsSmokeDetail: 'smoke ok',
      corpusBlocks: 5000,
      finitePassed: true,
      finiteDetail: 'finite'
    })
    expect(gates.find((g) => g.id === 'corpus.completeness')!.passed).toBe(false)
  })
  it('propagates FTS smoke failure', () => {
    const gates = buildM4FtsDuplicationGates({
      canonicalRows: 100,
      normalizedRows: 100,
      ftsRows: 100,
      ftsSmokePassed: false,
      ftsSmokeDetail: 'FTS smoke failed: missing virtual table',
      corpusBlocks: 100,
      finitePassed: true,
      finiteDetail: 'finite'
    })
    expect(gates.find((g) => g.id === 'fts.smoke')!.passed).toBe(false)
  })
  it('gate details are bounded non-empty without path leakage', () => {
    const gates = buildM4FtsDuplicationGates({
      canonicalRows: 10,
      normalizedRows: 10,
      ftsRows: 10,
      ftsSmokePassed: true,
      ftsSmokeDetail: 'smoke passed',
      corpusBlocks: 10,
      finitePassed: true,
      finiteDetail: 'finite ok'
    })
    for (const g of gates) {
      expect(g.detail).toBeDefined()
      expect(g.detail!.length).toBeGreaterThan(0)
      expect(Buffer.byteLength(g.detail!, 'utf8')).toBeLessThanOrEqual(256)
      expect(g.detail).not.toContain('/tmp')
    }
  })
})

describe('assertM4SampleCompleteness & privacy invariants', () => {
  it('passes when normalized/FTS match expected blocks', () => {
    const res = assertM4SampleCompleteness(
      { canonicalRows: 1000, normalizedRows: 1000, ftsRows: 1000, normalizedChars: 5000, normalizedBytesUtf8: 6000 },
      1000
    )
    expect(res.ok).toBe(true)
  })
  it('throws when normalizedRows mismatch expected', () => {
    expect(() =>
      assertM4SampleCompleteness(
        { canonicalRows: 10, normalizedRows: 9, ftsRows: 10, normalizedChars: 1, normalizedBytesUtf8: 1 },
        10
      )
    ).toThrow(/normalizedRows/)
  })
  it('throws when ftsRows mismatch expected', () => {
    expect(() =>
      assertM4SampleCompleteness(
        { canonicalRows: 10, normalizedRows: 10, ftsRows: 9, normalizedChars: 1, normalizedBytesUtf8: 1 },
        10
      )
    ).toThrow(/ftsRows/)
  })
  it('assertM4PrivacyInvariants passes for valid metrics', () => {
    const metrics = buildM4FtsDuplicationMetrics({
      canonicalRows: 10,
      normalizedRows: 10,
      ftsRows: 10,
      normalizedChars: 100,
      normalizedBytesUtf8: 120
    })
    expect(() => assertM4PrivacyInvariants(metrics)).not.toThrow()
  })
  it('assertM4PrivacyInvariants rejects path-bearing id', () => {
    expect(() => assertM4PrivacyInvariants([{ id: 'bad/path', name: 'bad', value: 1 } as never])).toThrow(
      /path segment/
    )
  })
  it('rejects non-finite metric value via privacy check', () => {
    expect(() => assertM4PrivacyInvariants([{ id: 'a.b', name: 'a', value: Number.NaN } as never])).toThrow(
      /non-finite/
    )
  })
})

describe('M4 physical-page proxy — four raw metrics only (no derived)', () => {
  it('emits exactly four approved raw physical metrics', () => {
    const metrics = buildM4PhysicalMetrics({ pageCount: 12, pageSize: 4096, freelistCount: 1, dbFileBytes: 49152 })
    expect(metrics.map((m) => m.id)).toEqual([
      'physical.page_count',
      'physical.page_size',
      'physical.freelist_count',
      'physical.dbFileBytes'
    ])
    expect(metrics).toHaveLength(4)
    for (const m of metrics) expect(Number.isFinite(m.value)).toBe(true)
  })
  it('does not emit derived pageBytes/freelistBytes', () => {
    const metrics = buildM4PhysicalMetrics({ pageCount: 10, pageSize: 4096, freelistCount: 0, dbFileBytes: 40960 })
    const ids = metrics.map((m) => m.id)
    expect(ids).not.toContain('physical.pageBytes')
    expect(ids).not.toContain('physical.freelistBytes')
    expect(ids).not.toContain('physical.page_bytes')
    expect(ids).not.toContain('physical.freelist_bytes')
  })
  it('units only on byte metrics', () => {
    const metrics = buildM4PhysicalMetrics({ pageCount: 5, pageSize: 4096, freelistCount: 0, dbFileBytes: 20480 })
    expect(metrics.find((m) => m.id === 'physical.page_count')!.unit).toBeUndefined()
    expect(metrics.find((m) => m.id === 'physical.freelist_count')!.unit).toBeUndefined()
    expect(metrics.find((m) => m.id === 'physical.page_size')!.unit).toBe('bytes')
    expect(metrics.find((m) => m.id === 'physical.dbFileBytes')!.unit).toBe('bytes')
  })
  it('throws on non-finite or negative physical values', () => {
    expect(() =>
      buildM4PhysicalMetrics({ pageCount: Number.NaN, pageSize: 4096, freelistCount: 0, dbFileBytes: 1000 })
    ).toThrow(/non-finite/)
    expect(() =>
      buildM4PhysicalMetrics({ pageCount: -1, pageSize: 4096, freelistCount: 0, dbFileBytes: 1000 })
    ).toThrow(/non-finite/)
    expect(() => buildM4PhysicalMetrics({ pageCount: 1, pageSize: 0, freelistCount: 0, dbFileBytes: 1000 })).toThrow(
      /page_size/
    )
  })
  it('ids are stable ASCII without path segments', () => {
    const metrics = buildM4PhysicalMetrics({ pageCount: 2, pageSize: 4096, freelistCount: 0, dbFileBytes: 8192 })
    for (const m of metrics) {
      expect(m.id).toMatch(/^[A-Za-z0-9._]+$/)
      expect(m.id).not.toMatch(/[\\/]/)
    }
  })
})

describe('WAL checkpoint busy/status parsing — fail-closed before stat/artifact', () => {
  it('parses busy=0 from number shape (simple:true)', () => {
    expect(parseCheckpointBusy(0)).toBe(0)
    expect(parseCheckpointBusy(1)).toBe(1)
  })
  it('parses busy from array shape (simple:false)', () => {
    expect(parseCheckpointBusy([{ busy: 0, log: 0, checkpointed: 0 }])).toBe(0)
    expect(parseCheckpointBusy([{ busy: 1, log: 5, checkpointed: 2 }])).toBe(1)
  })
  it('parses busy from object shape (prepare.get)', () => {
    expect(parseCheckpointBusy({ busy: 0, log: 0, checkpointed: 0 })).toBe(0)
    expect(parseCheckpointBusy({ busy: 1, log: 1, checkpointed: 0 })).toBe(1)
  })
  it('throws on unverifiable shape — fail closed', () => {
    expect(() => parseCheckpointBusy(undefined)).toThrow(/unverifiable/)
    expect(() => parseCheckpointBusy(null)).toThrow(/unverifiable/)
    expect(() => parseCheckpointBusy({})).toThrow(/unverifiable/)
    expect(() => parseCheckpointBusy([])).toThrow(/unverifiable/)
    expect(() => parseCheckpointBusy('busy')).toThrow(/unverifiable/)
  })
  it('assertCheckpointComplete passes only when busy==0', () => {
    expect(() => assertCheckpointComplete(0)).not.toThrow()
    expect(() => assertCheckpointComplete([{ busy: 0, log: 0, checkpointed: 0 }])).not.toThrow()
    expect(() => assertCheckpointComplete({ busy: 0, log: 0, checkpointed: 0 })).not.toThrow()
    expect(() => assertCheckpointComplete(1)).toThrow(/incomplete\/busy/)
    expect(() => assertCheckpointComplete([{ busy: 1, log: 0, checkpointed: 0 }])).toThrow(/incomplete\/busy/)
  })
  it('assertCheckpointComplete fails closed on unverifiable shape', () => {
    expect(() => assertCheckpointComplete(undefined)).toThrow(/unverifiable/)
  })
})

describe('M4 privacy audit — checkpoint/stat failure messages are path-free', () => {
  const fakeDbPath = '/tmp/chatdb-m4-fts-dup-abc123/chat.db'
  const fakePathError = new Error(`disk I/O error at ${fakeDbPath}: SQLITE_IOERR`)

  function assertPathFree(message: string): void {
    // Path-like means temp dir, DB filename, or synthetic prefix — not generic slash in "stat/artifact" / "incomplete/busy"
    expect(message).not.toContain('/tmp')
    expect(message).not.toContain('/var/folders')
    expect(message).not.toContain('chat.db')
    expect(message).not.toContain(fakeDbPath)
    expect(message).not.toContain('chatdb-m4-fts-dup')
    expect(message).not.toContain('/private')
    // Also ensure no Windows path fragment
    expect(message).not.toContain(':\\')
  }

  it('buildM4CheckpointFailureMessage is fixed path-free category', () => {
    const msg = buildM4CheckpointFailureMessage()
    expect(msg).toContain(M4_CHECKPOINT_FAILURE_CATEGORY)
    assertPathFree(msg)
    // Must not interpolate native error text even when error contains path
    expect(msg).not.toContain(fakeDbPath)
    expect(msg).not.toContain(fakePathError.message)
  })

  it('buildM4StatFailureMessage is fixed path-free category', () => {
    const msg = buildM4StatFailureMessage()
    expect(msg).toContain(M4_STAT_FAILURE_CATEGORY)
    assertPathFree(msg)
    expect(msg).not.toContain(fakeDbPath)
    expect(msg).not.toContain(fakePathError.message)
  })

  it('buildM4BusyCheckpointFailureMessage is path-free and encodes busy only', () => {
    for (const busy of [0, 1, 'unverifiable'] as const) {
      const msg = buildM4BusyCheckpointFailureMessage(busy)
      expect(msg).toContain(`busy=${String(busy)}`)
      assertPathFree(msg)
      expect(msg).not.toContain(fakeDbPath)
    }
  })

  it('assertCheckpointComplete failure messages are path-free', () => {
    const cases: unknown[] = [
      { busy: 1, log: 0, checkpointed: 0 },
      1,
      [{ busy: 1, log: 0, checkpointed: 0 }],
      undefined
    ]
    for (const raw of cases) {
      try {
        assertCheckpointComplete(raw)
        throw new Error('expected throw')
      } catch (e) {
        const msg = (e as Error).message
        // Should not contain path separators or dbPath text
        assertPathFree(msg)
        expect(msg).not.toContain(fakeDbPath)
      }
    }
  })

  it('parseCheckpointBusy failure messages are path-free', () => {
    const cases: unknown[] = [undefined, null, {}, [], 'busy']
    for (const raw of cases) {
      try {
        parseCheckpointBusy(raw)
        throw new Error('expected throw')
      } catch (e) {
        const msg = (e as Error).message
        assertPathFree(msg)
        expect(msg).not.toContain(fakeDbPath)
      }
    }
  })

  it('sanitized helpers remain path-free even when underlying error contains path', () => {
    // Simulate bench catch where native error has path; helper must not leak it
    const nativeWithPath = new Error(`/var/folders/abc/T/chatdb-m4-fts-dup-xyz/chat.db: unable to open`)
    const checkpointMsg = buildM4CheckpointFailureMessage()
    const statMsg = buildM4StatFailureMessage()
    const busyMsg = buildM4BusyCheckpointFailureMessage('unverifiable')
    for (const msg of [checkpointMsg, statMsg, busyMsg]) {
      expect(msg).not.toContain(nativeWithPath.message)
      expect(msg).not.toContain('/var/folders')
      expect(msg).not.toContain('chat.db')
      assertPathFree(msg)
    }
  })
})

describe('M4 FTS smoke failure detail is fixed path-free category (audit M4 — no native path leak)', () => {
  const pathShapedNativeErrors: Array<{ label: string; error: Error }> = [
    { label: 'macOS /tmp', error: new Error('no such table: /tmp/chatdb-m4-fts-dup-abc123/chat.db') },
    {
      label: 'macOS /private/tmp',
      error: new Error('disk I/O error at /private/tmp/chatdb-m4-fts-dup-xyz/chat.db: SQLITE_IOERR')
    },
    {
      label: 'macOS /var/folders',
      error: new Error('/var/folders/ab/cd/T/chatdb-m4-fts-dup-xyz/chat.db: unable to open')
    },
    { label: 'macOS /private/var/folders', error: new Error('FTS error at /private/var/folders/zz/T/m4-fts/chat.db') },
    {
      label: 'Windows C:\\',
      error: new Error('SQLITE_CANTOPEN: C:\\Users\\test\\AppData\\Temp\\chatdb-m4-fts-dup\\chat.db')
    },
    {
      label: 'Windows D:\\ with backslash',
      error: new Error('failed at D:\\tmp\\chatdb-m4-fts-dup\\chat.db: permission denied')
    },
    { label: 'Windows relative backslash', error: new Error('error at .\\chat.db: not found') },
    { label: 'relative ./', error: new Error('no such file: ./chatdb-m4-fts-dup/chat.db') },
    { label: 'relative ../', error: new Error('attempt at ../tmp/chat.db failed') },
    { label: 'relative tmp/', error: new Error('tmp/chat.db: SQLITE_ERROR') },
    { label: 'POSIX absolute', error: new Error('/tmp/m4-smoke/chat.db: virtual table missing') }
  ]

  function assertSmokePathFree(detail: string): void {
    expect(detail).not.toContain('/tmp')
    expect(detail).not.toContain('/private')
    expect(detail).not.toContain('/var/folders')
    expect(detail).not.toContain('chat.db')
    expect(detail).not.toContain('chatdb-m4-fts-dup')
    expect(detail).not.toContain(':\\')
    // Also ensure no relative path fragment leaked
    expect(detail).not.toContain('./')
    expect(detail).not.toContain('../')
  }

  it('buildM4FtsSmokeFailureDetail returns fixed category without native text', () => {
    const detail = buildM4FtsSmokeFailureDetail()
    expect(detail).toContain(M4_FTS_SMOKE_FAILURE_CATEGORY)
    expect(detail).toContain('FTS smoke failed')
    assertSmokePathFree(detail)
    expect(Buffer.byteLength(detail, 'utf8')).toBeLessThanOrEqual(256)
  })

  it('fixed detail does not interpolate macOS/private/Windows/relative path-shaped native errors', () => {
    for (const { error } of pathShapedNativeErrors) {
      const fixed = buildM4FtsSmokeFailureDetail()
      // Simulate old vulnerable interpolation would have leaked error.message
      // Fixed detail must not contain any fragment of the native error path
      expect(fixed).not.toContain(error.message)
      // Explicit path substrings must not appear
      if (error.message.includes('/tmp')) expect(fixed).not.toContain('/tmp')
      if (error.message.includes('/private')) expect(fixed).not.toContain('/private')
      if (error.message.includes('/var/folders')) expect(fixed).not.toContain('/var/folders')
      if (error.message.includes(':\\')) expect(fixed).not.toContain(':\\')
      if (error.message.includes('chat.db')) expect(fixed).not.toContain('chat.db')
      assertSmokePathFree(fixed)
    }
  })

  it('FTS smoke gate detail via fixed helper is bounded, path-free, and fails closed', () => {
    const fixedDetail = buildM4FtsSmokeFailureDetail()
    const gates = buildM4FtsDuplicationGates({
      canonicalRows: 10,
      normalizedRows: 10,
      ftsRows: 10,
      ftsSmokePassed: false,
      ftsSmokeDetail: fixedDetail,
      corpusBlocks: 10,
      finitePassed: true,
      finiteDetail: 'finite ok'
    })
    const smokeGate = gates.find((g) => g.id === 'fts.smoke')!
    expect(smokeGate.passed).toBe(false)
    expect(smokeGate.detail).toBe(fixedDetail)
    expect(smokeGate.detail).toContain(M4_FTS_SMOKE_FAILURE_CATEGORY)
    assertSmokePathFree(smokeGate.detail!)
    expect(Buffer.byteLength(smokeGate.detail!, 'utf8')).toBeLessThanOrEqual(256)
    // Ensure even when native error contains every path form, the gate detail remains path-free
    for (const { error } of pathShapedNativeErrors) {
      expect(smokeGate.detail).not.toContain(error.message.slice(0, 20))
    }
  })

  it('sanitized FTS smoke detail remains path-free when bench catch swallows native path error', () => {
    for (const { error } of pathShapedNativeErrors) {
      let detail = ''
      try {
        throw error
      } catch (_e) {
        detail = buildM4FtsSmokeFailureDetail()
      }
      assertSmokePathFree(detail)
      expect(detail).not.toContain(error.message)
    }
  })
})
