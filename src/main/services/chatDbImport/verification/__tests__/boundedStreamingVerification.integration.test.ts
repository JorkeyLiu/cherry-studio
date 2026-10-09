/**
 * Bounded streaming verification — deterministic small synthetic candidate
 * verified end-to-end with real SQLite (LOCK-4301…4305, LOCK-SP-1..4).
 *
 * Right-sized from the former 10k-message benchmark (10k is NOT a product
 * semantic). Builds the SAME bounded source stream as the multi-page import
 * suite through the real import path (CandidateDbResource + real migrations
 * + createImportDataPlane), finalizes the manifest from the SAME data plane,
 * seals the candidate, then proves the contracts that small single-chunk
 * fixtures cannot:
 * - the full 14-dimension pass with the derived search projection merged
 *   across MULTIPLE chunks (explicit small chunkSize: 24 message/projection
 *   rows over chunkSize 6 → ≥3 chunks per scan; object inventory + count
 *   parity + canonical↔normalized merge + exact FTS↔normalized ordered
 *   merge + MATCH smoke, LOCK-SP-1..4),
 * - abort (signal) mid message-scan is deterministic and leak-free,
 * - close() cancels a running verification cooperatively and ends closed,
 * - the readonly handle closes on every outcome: the candidate stays
 *   removable after verification (discard succeeds, directory gone).
 *
 * Deliberately NOT re-asserted here (covered by the focused small-fixture
 * candidateVerifier suite): per-dimension checked-count matrices for the 13
 * non-search dimensions, manifest count mirrors, serialized evidence
 * size/privacy probes, and reseal byte-stability (promotion install tests).
 * No wall-clock timing is asserted or printed (observation only, never a
 * contract).
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
import { BLOCK_PAGE_SIZE, streamAllPages, TOTAL_BLOCKS, TOTAL_MESSAGES } from '../../__tests__/boundedImportFixture'
import { CandidateDbResource } from '../../candidateDb'
import { createImportDataPlane } from '../../importDataPlane'
import { createCandidateVerifier } from '../candidateVerifier'
import type { SourceVerificationManifest } from '../sourceManifest'
import type { CandidateVerificationReport } from '../verificationContracts'

/** Generous ceiling so a pathological hang fails fast. NOT a perf threshold. */
const BENCHMARK_CEILING_MS = 60_000

const SESSION_ID = 'bench-4304-verify-session'

/**
 * Verifier chunk size for the bounded suite. 24 message/projection rows over
 * 6 → 4 chunks per scan (messages, blocks, canonical↔normalized and
 * FTS↔normalized merges alike), so the ordered merge provably spans chunk
 * boundaries while the suite stays fast. Technically derived from the
 * fixture (one topic's message fan-out), not an arbitrary N.
 */
const VERIFY_CHUNK_SIZE = 6

describe('chatDbImport — bounded streaming candidate verification', () => {
  let dataRoot: string
  let resource: CandidateDbResource
  let dbPath: string
  let manifest: SourceVerificationManifest

  beforeAll(async () => {
    dataRoot = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-bench-verify-'))
    resource = new CandidateDbResource({ sessionId: SESSION_ID, dataRoot })
    await resource.initialize() // real ChatDbService + real migrations

    const plane = createImportDataPlane(resource.getDatabase() as BetterSQLite3Database<typeof schema>)
    streamAllPages(plane)
    plane.finalize()
    manifest = plane.getSourceVerificationManifest()
    resource.seal()
    dbPath = resource.getDbPath()
  }, BENCHMARK_CEILING_MS)

  afterAll(() => {
    realFs.rmSync(dataRoot, { recursive: true, force: true })
    expect(realFs.existsSync(dataRoot)).toBe(false)
  })

  it(
    'verifies all 14 dimensions with the search-projection ordered merge spanning multiple chunks',
    async () => {
      // Invariant evidence: the bounded stream really spans pages and the
      // verifier really spans chunks (≥2 block pages, ≥3 scan chunks).
      expect(Math.ceil(TOTAL_BLOCKS / BLOCK_PAGE_SIZE)).toBeGreaterThanOrEqual(2)
      expect(TOTAL_MESSAGES / VERIFY_CHUNK_SIZE).toBeGreaterThanOrEqual(3)

      const verifier = createCandidateVerifier({ dbPath, manifest, chunkSize: VERIFY_CHUNK_SIZE })
      const report = await verifier.run()

      expect(verifier.getState()).toBe('done')
      expect(report.status).toBe('pass')
      expect(report.fatal).toBeNull()
      expect(report.dimensions).toHaveLength(14)

      // LOCK-SP-1..4: dimension ⑭ scans the derived search projection fully
      // across chunks. Every base block is MAIN_TEXT with content → the
      // canonical predicate count is TOTAL_MESSAGES (tool/file/image extras
      // are excluded). 6 objects + 2 count pairs + TOTAL_MESSAGES×2
      // (message_id + content merge) + TOTAL_MESSAGES (exact
      // normalized↔FTS ordered merge rows) + 1 merge count parity + 1 MATCH
      // smoke.
      const searchProjection = report.dimensions.find((d) => d.dimension === 'search_projection')!
      expect(searchProjection.status).toBe('pass')
      expect(searchProjection.checkedCount).toBe(6 + 2 + TOTAL_MESSAGES * 2 + TOTAL_MESSAGES + 1 + 1)
    },
    BENCHMARK_CEILING_MS
  )

  it(
    'aborts deterministically mid-verification on the bounded candidate without leaking the handle',
    async () => {
      const runAbortedAt = async (n: number): Promise<CandidateVerificationReport> => {
        const controller = new AbortController()
        let count = 0
        const verifier = createCandidateVerifier({
          dbPath,
          manifest,
          chunkSize: VERIFY_CHUNK_SIZE,
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

      // Checkpoint 4 lands in the second message-scan chunk (topics fit one
      // chunk of 6; 24 messages need 4 chunks) — mid real scan.
      const first = await runAbortedAt(4)
      const second = await runAbortedAt(4)

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
    'close() cancels a running bounded verification cooperatively and ends closed',
    async () => {
      const verifier = createCandidateVerifier({ dbPath, manifest, chunkSize: VERIFY_CHUNK_SIZE })
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
