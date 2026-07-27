/**
 * Phase 4.3.4 verification benchmark — deterministic 10,000-message
 * candidate verified end-to-end with real SQLite (LOCK-4301…4305).
 *
 * Builds the SAME 10k source stream as the Phase 4.2 import benchmark
 * through the real Phase 4.2 path (CandidateDbResource + real migrations +
 * createImportDataPlane), finalizes the manifest from the SAME data plane,
 * seals the candidate, then proves:
 * - all 13 verification dimensions pass with zero diagnostics at 10k scale,
 * - per-dimension checked counts match the fixture arithmetic,
 * - measured wall-clock verification time (test evidence only — a generous
 *   hang ceiling, NOT a production performance threshold),
 * - approximate manifest memory via serialized evidence size, proving the
 *   manifest carries digests/IDs only — never raw chat content,
 * - abort (signal) and close() cancellation mid-verification on the large
 *   candidate are deterministic and leak-free,
 * - the readonly handle closes on every outcome: the candidate stays
 *   removable after verification (discard succeeds, directory gone).
 *
 * Benchmark output is test stdout evidence only — no committed artifacts.
 */

import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

// Mock @main/config so importing chatDb modules never touches getDataPath().
// Every resource in this file injects an explicit temp dataRoot.
vi.mock('@main/config', () => ({ DATA_PATH: '/mock/data' }))

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import type * as schema from '../../../chatDb/schema'
import {
  EXPECTED_FILE_REFERENCES,
  EXPECTED_PAGE_COUNT,
  SOURCE_FILE_RECORDS,
  streamAllPages,
  TOPIC_COUNT,
  TOTAL_BLOCKS,
  TOTAL_MEMBERSHIPS,
  TOTAL_MESSAGES,
  TOTAL_SEGMENTS
} from '../../__tests__/benchmarkFixture10k'
import { CandidateDbResource } from '../../candidateDb'
import { createImportDataPlane } from '../../importDataPlane'
import { createCandidateVerifier } from '../candidateVerifier'
import type { SourceVerificationManifest } from '../sourceManifest'
import type { CandidateVerificationReport } from '../verificationContracts'
import { VERIFICATION_DIMENSIONS } from '../verificationContracts'

/** Generous ceiling so a pathological hang fails fast. NOT a perf threshold. */
const BENCHMARK_CEILING_MS = 120_000

const SESSION_ID = 'bench-4304-verify-session'

function bench(line: string): void {
  // Reporter-safe benchmark emission (test stdout only; no production log,
  // no committed artifact).
  process.stdout.write(`[chatdb-verify-benchmark] ${line}\n`)
}

describe('chatDbImport Phase 4.3.4 — 10k-message candidate verification benchmark', () => {
  let dataRoot: string
  let resource: CandidateDbResource
  let dbPath: string
  let manifest: SourceVerificationManifest

  beforeAll(async () => {
    dataRoot = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-bench-verify-'))
    resource = new CandidateDbResource({ sessionId: SESSION_ID, dataRoot })
    await resource.initialize() // real ChatDbService + real migrations

    const plane = createImportDataPlane(resource.getDatabase() as BetterSQLite3Database<typeof schema>)
    const buildStartedAt = performance.now()
    streamAllPages(plane)
    plane.finalize()
    manifest = plane.getSourceVerificationManifest()
    resource.seal()
    dbPath = resource.getDbPath()
    bench(
      `10k candidate build+finalize+manifest+seal: ${(performance.now() - buildStartedAt).toFixed(1)} ms ` +
        `(${TOTAL_MESSAGES} messages, ${TOTAL_BLOCKS} blocks, ${EXPECTED_PAGE_COUNT} pages)`
    )
  }, BENCHMARK_CEILING_MS)

  afterAll(() => {
    realFs.rmSync(dataRoot, { recursive: true, force: true })
    expect(realFs.existsSync(dataRoot)).toBe(false)
  })

  it(
    'verifies all 13 dimensions pass on the 10k candidate with measured time and bounded evidence',
    async () => {
      const verifier = createCandidateVerifier({ dbPath, manifest })
      const startedAt = performance.now()
      const report = await verifier.run()
      const elapsedMs = performance.now() - startedAt

      expect(verifier.getState()).toBe('done')
      expect(elapsedMs).toBeGreaterThan(0)
      expect(elapsedMs).toBeLessThan(BENCHMARK_CEILING_MS)

      // --- All 13 dimensions pass with zero/bounded diagnostics ---
      expect(report.status).toBe('pass')
      expect(report.fatal).toBeNull()
      expect(report.dimensions.map((d) => d.dimension)).toEqual([...VERIFICATION_DIMENSIONS])
      for (const result of report.dimensions) {
        expect(result.status).toBe('pass')
        expect(result.diagnostics).toEqual([])
        expect(result.truncatedDiagnosticCount).toBe(0)
      }

      // --- Checked counts match the fixture arithmetic exactly ---
      const dim = (id: string) => report.dimensions.find((d) => d.dimension === id)!
      const totalEntities = TOPIC_COUNT + TOTAL_MESSAGES + TOTAL_BLOCKS + EXPECTED_FILE_REFERENCES + TOTAL_SEGMENTS
      expect(dim('id_sets').checkedCount).toBe(totalEntities)
      expect(dim('field_digests').checkedCount).toBe(totalEntities)
      expect(dim('overflow').checkedCount).toBe(totalEntities)
      expect(dim('table_counts').checkedCount).toBe(6) // 5 entity sections + memberships
      expect(dim('order').checkedCount).toBe(TOTAL_MESSAGES + TOTAL_BLOCKS)
      expect(dim('structured_json').checkedCount).toBe(TOTAL_MESSAGES + TOTAL_BLOCKS)
      expect(dim('segments').checkedCount).toBe(TOTAL_SEGMENTS) // incl. empty segment's empty membership
      expect(dim('fk_references').checkedCount).toBe(
        TOTAL_MESSAGES + TOTAL_BLOCKS + EXPECTED_FILE_REFERENCES + TOTAL_SEGMENTS + 2 * TOTAL_MEMBERSHIPS
      )
      expect(dim('integrity_check').checkedCount).toBe(1)
      expect(dim('sample_reads').checkedCount).toBeGreaterThan(0)

      // --- Manifest counts mirror the candidate exactly (LOCK-4301) ---
      expect(manifest.topics.count).toBe(TOPIC_COUNT)
      expect(manifest.messages.count).toBe(TOTAL_MESSAGES)
      expect(manifest.blocks.count).toBe(TOTAL_BLOCKS)
      expect(manifest.fileReferences.count).toBe(EXPECTED_FILE_REFERENCES)
      expect(manifest.segments.count).toBe(TOTAL_SEGMENTS)
      expect(manifest.memberships.rowCount).toBe(TOTAL_MEMBERSHIPS)
      expect(manifest.sourceFiles.recordCount).toBe(SOURCE_FILE_RECORDS)
      expect(manifest.committedPageCount).toBe(EXPECTED_PAGE_COUNT)

      // --- Evidence size / memory proxy: digests + IDs only, no raw content ---
      const serializedManifest = JSON.stringify(manifest)
      const serializedReport = JSON.stringify(report)
      expect(serializedManifest).not.toContain('bench message') // block content
      expect(serializedManifest).not.toContain('/bench/') // file paths
      expect(serializedManifest).not.toContain('Bench segment') // segment names
      expect(serializedReport).not.toContain('bench message')
      expect(serializedReport).not.toContain(dataRoot)
      expect(serializedReport).not.toContain('chat.db')

      bench(
        `10k verification (13 dimensions): ${elapsedMs.toFixed(1)} ms — ` +
          `manifest evidence ${(serializedManifest.length / 1024).toFixed(1)} KiB serialized ` +
          `(${totalEntities} entity entries), report ${(serializedReport.length / 1024).toFixed(1)} KiB`
      )
    },
    BENCHMARK_CEILING_MS
  )

  it(
    'aborts deterministically mid-verification on the large candidate without leaking the handle',
    async () => {
      const runAbortedAt = async (n: number): Promise<CandidateVerificationReport> => {
        const controller = new AbortController()
        let count = 0
        const verifier = createCandidateVerifier({
          dbPath,
          manifest,
          signal: controller.signal,
          onCheckpoint: () => {
            count += 1
            if (count === n) controller.abort()
          }
        })
        const report = await verifier.run()
        expect(verifier.getState()).toBe('done')
        return report
      }

      // Checkpoint 10 lands mid message-scan (10,000 rows / 500-row chunks).
      const first = await runAbortedAt(10)
      const second = await runAbortedAt(10)

      expect(first.status).toBe('aborted')
      expect(second.status).toBe('aborted')
      expect(first.fatal).toBeNull()
      // Determinism: identical per-dimension outcomes on both aborted runs.
      expect(first.dimensions.map((d) => `${d.dimension}:${d.status}`)).toEqual(
        second.dimensions.map((d) => `${d.dimension}:${d.status}`)
      )
      expect(first.dimensions.some((d) => d.status === 'skipped')).toBe(true)
    },
    BENCHMARK_CEILING_MS
  )

  it(
    'close() cancels a running 10k verification cooperatively and ends closed',
    async () => {
      const verifier = createCandidateVerifier({ dbPath, manifest })
      const pending = verifier.run()
      verifier.close()
      const report = await pending

      expect(report.status).toBe('aborted')
      expect(verifier.getState()).toBe('closed')
      verifier.close() // idempotent
      expect(verifier.getState()).toBe('closed')
    },
    BENCHMARK_CEILING_MS
  )

  it(
    'leaves the candidate removable after every verification outcome (handles closed)',
    async () => {
      const candidateDir = resource.getCandidateDir()
      expect(realFs.existsSync(dbPath)).toBe(true)

      // All verifier handles above are closed — the discard must fully
      // remove the candidate directory (db + WAL/SHM).
      await resource.discard()

      expect(resource.getState()).toBe('discarded')
      expect(realFs.existsSync(candidateDir)).toBe(false)
      expect(realFs.existsSync(dbPath)).toBe(false)
      expect(realFs.existsSync(`${dbPath}-wal`)).toBe(false)
      expect(realFs.existsSync(`${dbPath}-shm`)).toBe(false)
    },
    BENCHMARK_CEILING_MS
  )
})
