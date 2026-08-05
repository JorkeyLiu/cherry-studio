/**
 * Destructive promotion executor tests — v2 three-artifact sequence
 * (Phase 4.4.2 LOCK-4421..4428 + Phase 2 LOCK-PROMO-2/4/5/6/9 +
 * LOCK-EXEC-1..8).
 *
 * Real temp-dir filesystem + REAL journal store (v2) + REAL closed-live-proof
 * minting against a REAL maintenance coordinator/lease; the install/verify/
 * catalog primitives are high-fidelity injected fakes that perform genuine
 * filesystem effects, grouping the equivalent bounded gates already covered
 * by the real install/verifier suites.
 *
 * Every side-effect/journal boundary carries direct injected-failure proof:
 * - start gates: absent/invalid/v1/wrong-phase/identity/receipt journal
 *   mismatches refuse BEFORE any live mutation.
 * - close + mint: close refusal/throw, mint witness/authorization refusal.
 * - install + every journal advance: crash windows keep the journal at the
 *   PRIOR phase (no premature advance) and classify post-install.
 * - catalog apply: already-match, timeout, throw, post-apply facts mismatch,
 *   pre-apply receipt mismatch — journal stays catalog-pending.
 * - reopen + exact verification: reopen throw, DB receipt tamper, Files
 *   per-row parity tamper, Files aggregate-receipt tamper, catalog facts
 *   mismatch — journal stays at the exact prior phase.
 * - terminal: no premature replacement-verified, cleanup/restart refusal,
 *   exact-once run(), lease never released by the executor, bounded privacy.
 */

import crypto from 'node:crypto'
import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')

vi.mock('@main/config', () => ({ DATA_PATH: '/mock/data' }))

import {
  acquirePromotionLease,
  createMaintenanceCoordinator,
  type MaintenanceCoordinator,
  type PromotionLeaseHandle,
  validatePromotionAuthorization
} from '../../../chatDb/maintenanceCoordination'
import { computeCatalogReceipt, computeFilesReceipt, emptyArtifactReceipts } from '../artifactReceipts'
import type { CatalogBoundary, PromotionExecutionPrimitives, PromotionExecutor } from '../execution'
import { createPromotionExecutor } from '../execution'
import type { FilesInstallResult } from '../filesInstall'
import type { CandidateInstallResult, InstallReceipt } from '../install'
import type { PromotionArtifactReceipts, PromotionJournalV2 } from '../journal'
import { PROMOTION_JOURNAL_VERSION_V2 } from '../journal'
import {
  advancePromotionJournalV2,
  PromotionJournalStoreError,
  readPromotionJournal,
  writeCandidatesReadyPromotionJournal
} from '../journalStore'
import type { ExecutingPromotionCapability } from '../preparation'
import type { ReplacementVerificationResult } from '../replacementVerifier'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const SESSION_ID = 'import-exec-session'
const CANDIDATE_ID = 'candidate-import-exec-session'
const LIVE_ORIGINAL = Buffer.from('live-original-bytes')
const CANDIDATE_BYTES = Buffer.from('candidate-installed-bytes')
const RETAINED_SENTINEL = Buffer.from('retained-rollback-snapshot-sentinel')
const SHA256_HELLO = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'

function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

/**
 * EXACT real receipts — the single source of truth shared by the durable
 * journal AND the capability (LOCK-EXEC-1: both must agree). The executor
 * re-derives these during verification (LOCK-EXEC-5), so placeholders would
 * make every happy-path assertion false.
 */
const RECEIPTS: { candidate: PromotionArtifactReceipts; old: PromotionArtifactReceipts } = {
  candidate: {
    db: { sha256: sha256(CANDIDATE_BYTES), size: CANDIDATE_BYTES.length },
    files: computeFilesReceipt([{ name: 'f1.png', size: 5, sha256: SHA256_HELLO }]),
    catalog: computeCatalogReceipt([{ id: 'f1', name: 'f1.png', size: 5, count: 1 }])
  },
  old: {
    db: { sha256: sha256(LIVE_ORIGINAL), size: LIVE_ORIGINAL.length },
    files: computeFilesReceipt([]),
    catalog: computeCatalogReceipt([])
  }
}

const JOURNAL_PATH = 'chat-import-promotion.journal.json'

let dataRoot: string
let livePath: string
let retainedPath: string
let candidatePath: string
let candidateCatalogPath: string
let liveFilesDir: string
let candidateFilesDir: string
let coordinator: MaintenanceCoordinator
let authorization: PromotionLeaseHandle
let capability: ExecutingPromotionCapability

interface LiveDbFake {
  state: { open: boolean }
  closeForPromotion: ReturnType<typeof vi.fn>
  reopenForPromotion: ReturnType<typeof vi.fn>
  isInitialised: ReturnType<typeof vi.fn>
}

let liveDb: LiveDbFake

function makeLiveDb(): LiveDbFake {
  const state = { open: true }
  const fake: LiveDbFake = {
    state,
    closeForPromotion: vi.fn((auth: PromotionLeaseHandle) => {
      const verdict = validatePromotionAuthorization(auth, coordinator)
      if (!verdict.authorized) throw new Error(`promotion authorization invalid (${verdict.reason})`)
      state.open = false
      return true
    }),
    reopenForPromotion: vi.fn(async (auth: PromotionLeaseHandle) => {
      const verdict = validatePromotionAuthorization(auth, coordinator)
      if (!verdict.authorized) throw new Error(`promotion authorization invalid (${verdict.reason})`)
      state.open = true
    }),
    isInitialised: vi.fn(() => state.open)
  }
  return fake
}

/** High-fidelity db-install fake: deletes live sidecars, true atomic rename. */
function makeInstallOk() {
  return vi.fn((options: { candidateId: string }): CandidateInstallResult => {
    realFs.rmSync(`${livePath}-wal`, { force: true })
    realFs.rmSync(`${livePath}-shm`, { force: true })
    realFs.renameSync(candidatePath, livePath)
    const receipt: InstallReceipt = {
      candidateId: options.candidateId,
      livePath,
      identity: { dev: 1n, ino: 1n, size: BigInt(CANDIDATE_BYTES.length) },
      installedAtMs: 0
    }
    return { ok: true as const, receipt }
  })
}

/** High-fidelity files-install fake: candidate Files dir → live Files dir. */
function makeInstallFilesOk() {
  return vi.fn((): FilesInstallResult => {
    if (realFs.existsSync(liveFilesDir)) {
      realFs.renameSync(liveFilesDir, realPath.join(dataRoot, 'Files.promote-staging'))
    }
    realFs.renameSync(candidateFilesDir, liveFilesDir)
    return {
      ok: true as const,
      receipt: RECEIPTS.candidate.files as NonNullable<PromotionArtifactReceipts['files']>,
      kind: 'populated',
      liveFilesDir
    }
  })
}

function makeVerifyOk() {
  return vi.fn((): ReplacementVerificationResult => ({ ok: true as const }))
}

/** Catalog boundary double — apply + query both succeed with EXACT facts. */
function makeCatalogBoundaryOk(): CatalogBoundary {
  return {
    applyCandidate: vi.fn(async () => ({
      ok: true as const,
      facts: RECEIPTS.candidate.catalog as { count: number; sha256: string }
    })),
    queryFacts: vi.fn(async () => ({
      ok: true as const,
      facts: RECEIPTS.candidate.catalog as { count: number; sha256: string }
    }))
  }
}

let installFake: ReturnType<typeof makeInstallOk>
let installFilesFake: ReturnType<typeof makeInstallFilesOk>
let verifyFake: ReturnType<typeof makeVerifyOk>
let catalogBoundary: CatalogBoundary

/** Write a v2 journal at `snapshots-ready` (executor start state). */
async function writeCustomSnapshotsReadyJournal(
  partial: {
    sessionId?: string
    candidateId?: string
    receipts?: { candidate: PromotionArtifactReceipts; old: PromotionArtifactReceipts }
  } = {}
): Promise<void> {
  const sessionId = partial.sessionId ?? SESSION_ID
  const candidateId = partial.candidateId ?? CANDIDATE_ID
  const receipts = partial.receipts ?? RECEIPTS
  const candidates: PromotionJournalV2 = {
    version: PROMOTION_JOURNAL_VERSION_V2,
    sessionId,
    candidateId,
    phase: 'candidates-ready',
    receipts: { candidate: receipts.candidate, old: emptyArtifactReceipts() }
  }
  await writeCandidatesReadyPromotionJournal(candidates, dataRoot)
  const snapshotsReady: PromotionJournalV2 = {
    version: PROMOTION_JOURNAL_VERSION_V2,
    sessionId,
    candidateId,
    phase: 'snapshots-ready',
    receipts
  }
  await advancePromotionJournalV2(snapshotsReady, 'candidates-ready', dataRoot)
}

async function clearJournal(): Promise<void> {
  realFs.rmSync(realPath.join(dataRoot, JOURNAL_PATH), { force: true })
  realFs.rmSync(realPath.join(dataRoot, `${JOURNAL_PATH}.staging`), { force: true })
}

function makeExecutor(
  primitives: Partial<PromotionExecutionPrimitives> = {},
  options: { capability?: ExecutingPromotionCapability; coordinator?: MaintenanceCoordinator } = {}
): PromotionExecutor {
  return createPromotionExecutor({
    capability: options.capability ?? capability,
    dataRoot,
    liveDb,
    coordinator: options.coordinator ?? coordinator,
    catalogBoundary,
    primitives: {
      install: installFake as unknown as PromotionExecutionPrimitives['install'],
      installFiles: installFilesFake as unknown as PromotionExecutionPrimitives['installFiles'],
      verify: verifyFake as unknown as PromotionExecutionPrimitives['verify'],
      ...primitives
    }
  })
}

async function journalPhase(): Promise<string> {
  const read = await readPromotionJournal(dataRoot)
  expect(read.status).toBe('valid')
  return read.status === 'valid' ? read.journal.phase : 'unreadable'
}

function liveBytes(): Buffer {
  return realFs.readFileSync(livePath)
}

/** The SAME promotion lease is still the current holder (LOCK-4422). */
function expectLeaseStillHeld(): void {
  expect(capability.isReleased()).toBe(false)
  expect(coordinator.currentHolder()).toEqual({ kind: 'promotion', ownerId: CANDIDATE_ID })
}

function expectJournalPresent(): void {
  expect(realFs.existsSync(realPath.join(dataRoot, JOURNAL_PATH))).toBe(true)
}

beforeEach(async () => {
  dataRoot = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-exec-'))
  livePath = realPath.join(dataRoot, 'chat.db')
  retainedPath = realPath.join(dataRoot, 'chat.db.pre-import-backup')
  candidatePath = realPath.join(dataRoot, 'chat-import-candidates', CANDIDATE_ID, 'chat.db')
  candidateCatalogPath = realPath.join(dataRoot, 'chat-import-candidates', CANDIDATE_ID, 'files-catalog.json')
  liveFilesDir = realPath.join(dataRoot, 'Files')
  candidateFilesDir = realPath.join(dataRoot, 'chat-import-candidates', CANDIDATE_ID, 'Files')

  realFs.writeFileSync(livePath, LIVE_ORIGINAL)
  realFs.writeFileSync(`${livePath}-wal`, 'stale-wal')
  realFs.writeFileSync(`${livePath}-shm`, 'stale-shm')
  realFs.writeFileSync(retainedPath, RETAINED_SENTINEL)
  realFs.mkdirSync(realPath.dirname(candidatePath), { recursive: true })
  realFs.writeFileSync(candidatePath, CANDIDATE_BYTES)
  realFs.mkdirSync(candidateFilesDir, { recursive: true })
  realFs.writeFileSync(realPath.join(candidateFilesDir, 'f1.png'), 'hello')
  realFs.writeFileSync(
    candidateCatalogPath,
    JSON.stringify({
      version: 1,
      sessionId: SESSION_ID,
      createdAt: new Date().toISOString(),
      rows: [
        {
          id: 'f1',
          name: 'f1.png',
          origin_name: 'f1.png',
          size: 5,
          sha256: SHA256_HELLO,
          ext: '.png',
          type: null,
          created_at: null,
          count: 1,
          path: 'Files/f1.png'
        }
      ],
      referenced: { referencedFileIdCount: 1 },
      degraded: {
        missingPayload: 0,
        missingCatalogRow: 0,
        metadataMismatch: 0,
        payloadReadFailure: 0,
        lostContent: 0,
        invalidTargetName: 0,
        duplicateCatalogRow: 0
      },
      skipped: { payloadWithoutCatalog: 0 }
    }),
    'utf8'
  )

  coordinator = createMaintenanceCoordinator()
  authorization = acquirePromotionLease(CANDIDATE_ID, coordinator)
  capability = {
    token: 'promotion-exec-token',
    sessionId: SESSION_ID,
    candidateId: CANDIDATE_ID,
    retainedSnapshotPath: retainedPath,
    candidateDbPath: candidatePath,
    retainedFilesSnapshotDir: realPath.join(dataRoot, 'Files.pre-import-backup'),
    catalogSnapshotPath: realPath.join(dataRoot, 'files-catalog.snapshot.json'),
    receipts: RECEIPTS,
    authorization,
    release: (() => {
      authorization.release()
    }) as ExecutingPromotionCapability['release'],
    isReleased: () => authorization.isReleased()
  }

  liveDb = makeLiveDb()
  installFake = makeInstallOk()
  installFilesFake = makeInstallFilesOk()
  verifyFake = makeVerifyOk()
  catalogBoundary = makeCatalogBoundaryOk()

  // Durable v2 snapshots-ready journal — the Phase 4.4.1 end state.
  await writeCustomSnapshotsReadyJournal()
})

afterEach(() => {
  vi.restoreAllMocks()
  realFs.rmSync(dataRoot, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Success path + sequence ordering
// ---------------------------------------------------------------------------

describe('promotion executor (v2) — success path', () => {
  it('executes the exact non-reorderable sequence and stops at the replacement-verified handoff', async () => {
    const trace: string[] = []
    liveDb.closeForPromotion.mockImplementation((auth: PromotionLeaseHandle) => {
      const verdict = validatePromotionAuthorization(auth, coordinator)
      if (!verdict.authorized) throw new Error(`invalid (${verdict.reason})`)
      trace.push('close')
      liveDb.state.open = false
      return true
    })
    liveDb.reopenForPromotion.mockImplementation(async (auth: PromotionLeaseHandle) => {
      const verdict = validatePromotionAuthorization(auth, coordinator)
      if (!verdict.authorized) throw new Error(`invalid (${verdict.reason})`)
      trace.push('reopen')
      liveDb.state.open = true
    })
    const { mintClosedLiveProof } = await import('../install')
    installFake.mockImplementation((options: { candidateId: string }) => {
      trace.push('install-db')
      realFs.rmSync(`${livePath}-wal`, { force: true })
      realFs.rmSync(`${livePath}-shm`, { force: true })
      realFs.renameSync(candidatePath, livePath)
      const receipt: InstallReceipt = {
        candidateId: options.candidateId,
        livePath,
        identity: { dev: 1n, ino: 1n, size: BigInt(CANDIDATE_BYTES.length) },
        installedAtMs: 0
      }
      return { ok: true as const, receipt }
    })
    installFilesFake.mockImplementation(() => {
      trace.push('install-files')
      if (realFs.existsSync(liveFilesDir)) {
        realFs.renameSync(liveFilesDir, realPath.join(dataRoot, 'Files.promote-staging'))
      }
      realFs.renameSync(candidateFilesDir, liveFilesDir)
      return {
        ok: true as const,
        receipt: RECEIPTS.candidate.files as NonNullable<PromotionArtifactReceipts['files']>,
        kind: 'populated',
        liveFilesDir
      }
    })
    verifyFake.mockImplementation(() => {
      trace.push('verify')
      return { ok: true as const }
    })
    catalogBoundary.applyCandidate = vi.fn(async () => {
      trace.push('catalog-apply')
      return { ok: true as const, facts: RECEIPTS.candidate.catalog as { count: number; sha256: string } }
    })
    catalogBoundary.queryFacts = vi.fn(async () => {
      trace.push('catalog-query')
      return { ok: true as const, facts: RECEIPTS.candidate.catalog as { count: number; sha256: string } }
    })
    const v2Advance = async (journal: PromotionJournalV2, prior: never, root: string) => {
      trace.push(`journal-${journal.phase}`)
      await advancePromotionJournalV2(journal, prior, root)
    }

    const executor = makeExecutor({
      mintProof: ((options: Parameters<typeof mintClosedLiveProof>[0]) => {
        trace.push('mint')
        return mintClosedLiveProof(options)
      }) as PromotionExecutionPrimitives['mintProof'],
      advanceDbInstalled: (async (journal, prior, root) => v2Advance(journal, prior as never, root)) as never,
      advanceFilesInstalled: (async (journal, prior, root) => v2Advance(journal, prior as never, root)) as never,
      advanceCatalogPending: (async (journal, prior, root) => v2Advance(journal, prior as never, root)) as never,
      advanceCatalogApplied: (async (journal, prior, root) => v2Advance(journal, prior as never, root)) as never,
      advanceReplacementVerified: (async (journal, prior, root) => v2Advance(journal, prior as never, root)) as never
    })

    const result = await executor.run()
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Exact, non-reorderable order (LOCK-PROMO-2/4/5/6).
    expect(trace).toEqual([
      'close',
      'mint',
      'install-db',
      'journal-db-installed',
      'install-files',
      'journal-files-installed',
      'journal-catalog-pending',
      'catalog-apply',
      'journal-catalog-applied',
      'reopen',
      'verify',
      'catalog-query',
      'journal-replacement-verified'
    ])

    // Handoff carries the full generation facts.
    expect(result.handoff.candidateId).toBe(CANDIDATE_ID)
    expect(result.handoff.receipt.livePath).toBe(livePath)
    expect(result.handoff.receipts.candidate.catalog?.sha256).toBe(RECEIPTS.candidate.catalog?.sha256)

    // Journal reached replacement-verified (LOCK-4424).
    expect(await journalPhase()).toBe('replacement-verified')
    // Live bytes are the installed candidate.
    expect(liveBytes().equals(CANDIDATE_BYTES)).toBe(true)
    // Live Files dir is the installed candidate dir.
    expect(realFs.readFileSync(realPath.join(liveFilesDir, 'f1.png'), 'utf8')).toBe('hello')

    // LOCK-4422/LOCK-4428: the executor NEVER releases the lease, never
    // cleans the journal, and never restarts/relaunches — it stops at the
    // replacement-verified handoff.
    expectLeaseStillHeld()
    expectJournalPresent()
    expect(realFs.existsSync(retainedPath)).toBe(true)
    expect(realFs.existsSync(realPath.join(dataRoot, 'Files.pre-import-backup'))).toBe(false)
    expect(realFs.existsSync(realPath.join(dataRoot, 'files-catalog.snapshot.json'))).toBe(false)
  })

  it('catalog already matching: the apply still runs and the journal path is identical (LOCK-EXEC-6)', async () => {
    catalogBoundary.queryFacts = vi.fn(async () => ({
      ok: true as const,
      facts: RECEIPTS.candidate.catalog as { count: number; sha256: string }
    }))
    const applySpy = catalogBoundary.applyCandidate
    const result = await makeExecutor().run()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(applySpy).toHaveBeenCalledTimes(1)
    expect(await journalPhase()).toBe('replacement-verified')
    expectLeaseStillHeld()
  })
})

// ---------------------------------------------------------------------------
// Start gates — journal read + exact identity/receipts (LOCK-EXEC-1)
// ---------------------------------------------------------------------------

describe('promotion executor (v2) — start gates (before any live mutation)', () => {
  it('absent journal is a pre-install JOURNAL_READ_FAILED and never closes the live DB', async () => {
    await clearJournal()
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('JOURNAL_READ_FAILED')
    expect(result.failure.safeCode).toBe('ABSENT')
    expect(result.failure.classification).toBe('pre-install')
    expect(result.failure.recoveryRequired).toBe(false)
    expect(result.failure.liveDisposition).toBe('open')
    expect(liveDb.closeForPromotion).not.toHaveBeenCalled()
    expectLeaseStillHeld()
  })

  it('codec-invalid journal is a pre-install JOURNAL_READ_FAILED', async () => {
    realFs.writeFileSync(realPath.join(dataRoot, JOURNAL_PATH), 'not-json{{{')
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('JOURNAL_READ_FAILED')
    expect(result.failure.safeCode).toBe('INVALID')
    expect(result.failure.classification).toBe('pre-install')
    expect(liveDb.closeForPromotion).not.toHaveBeenCalled()
    expectLeaseStillHeld()
  })

  it('v1 journal is refused (v2 protocol only, LOCK-PROMO-10)', async () => {
    await clearJournal()
    realFs.writeFileSync(
      realPath.join(dataRoot, JOURNAL_PATH),
      JSON.stringify({ version: 1, sessionId: SESSION_ID, candidateId: CANDIDATE_ID, phase: 'snapshot-ready' })
    )
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('JOURNAL_READ_FAILED')
    expect(result.failure.safeCode).toBe('NOT_V2')
    expect(result.failure.classification).toBe('pre-install')
    expect(liveDb.closeForPromotion).not.toHaveBeenCalled()
    expectLeaseStillHeld()
  })

  it('a journal already past snapshots-ready is refused without mutation', async () => {
    // Advance the harness journal to db-installed (simulating a crashed
    // prior execution) — the executor must refuse to re-enter.
    const doc: PromotionJournalV2 = {
      version: PROMOTION_JOURNAL_VERSION_V2,
      sessionId: SESSION_ID,
      candidateId: CANDIDATE_ID,
      phase: 'db-installed',
      receipts: RECEIPTS
    }
    await advancePromotionJournalV2(doc, 'snapshots-ready', dataRoot)
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('JOURNAL_READ_FAILED')
    expect(result.failure.safeCode).toBe('PHASE_db-installed')
    expect(result.failure.classification).toBe('pre-install')
    expect(liveDb.closeForPromotion).not.toHaveBeenCalled()
    expectLeaseStillHeld()
  })

  it('session identity mismatch between journal and capability is refused (LOCK-EXEC-1)', async () => {
    await clearJournal()
    await writeCustomSnapshotsReadyJournal({ sessionId: 'other-session-id' })
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('JOURNAL_IDENTITY_MISMATCH')
    expect(result.failure.safeCode).toBe('SESSION_OR_CANDIDATE_ID')
    expect(result.failure.classification).toBe('pre-install')
    expect(result.failure.recoveryRequired).toBe(false)
    expect(liveDb.closeForPromotion).not.toHaveBeenCalled()
    expectLeaseStillHeld()
  })

  it('candidate identity mismatch between journal and capability is refused (LOCK-EXEC-1)', async () => {
    await clearJournal()
    await writeCustomSnapshotsReadyJournal({ candidateId: 'other-candidate' })
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('JOURNAL_IDENTITY_MISMATCH')
    expect(result.failure.safeCode).toBe('SESSION_OR_CANDIDATE_ID')
    expect(liveDb.closeForPromotion).not.toHaveBeenCalled()
    expectLeaseStillHeld()
  })

  it('diverged journal receipts vs capability receipts are refused (LOCK-EXEC-1)', async () => {
    await clearJournal()
    await writeCustomSnapshotsReadyJournal({
      receipts: {
        candidate: { ...RECEIPTS.candidate, db: { sha256: '9'.repeat(64), size: 1 } },
        old: RECEIPTS.old
      }
    })
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('JOURNAL_IDENTITY_MISMATCH')
    expect(result.failure.safeCode).toBe('RECEIPTS_DIVERGED')
    expect(result.failure.classification).toBe('pre-install')
    expect(liveDb.closeForPromotion).not.toHaveBeenCalled()
    expectLeaseStillHeld()
  })

  it('a journal read I/O failure is a bounded pre-install JOURNAL_READ_FAILED', async () => {
    const executor = makeExecutor({
      readJournal: (async () => {
        throw new PromotionJournalStoreError('READ_IO_FAILED', 'io')
      }) as never
    })
    const result = await executor.run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('JOURNAL_READ_FAILED')
    expect(result.failure.safeCode).toBe('READ_IO_FAILED')
    expect(result.failure.classification).toBe('pre-install')
    expect(liveDb.closeForPromotion).not.toHaveBeenCalled()
    expectLeaseStillHeld()
  })
})

// ---------------------------------------------------------------------------
// Close + mint boundary (LOCK-EXEC-2)
// ---------------------------------------------------------------------------

describe('promotion executor (v2) — authorized close + closed-live proof', () => {
  it('close returned false is a pre-install failure with the live DB still open', async () => {
    liveDb.closeForPromotion.mockReturnValue(false)
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('LIVE_CLOSE_FAILED')
    expect(result.failure.safeCode).toBe('CLOSE_RETURNED_FALSE')
    expect(result.failure.classification).toBe('pre-install')
    expect(result.failure.recoveryRequired).toBe(false)
    expect(result.failure.liveDisposition).toBe('open')
    expect(await journalPhase()).toBe('snapshots-ready')
    expectLeaseStillHeld()
  })

  it('close throwing is a pre-install failure with a bounded safe code', async () => {
    liveDb.closeForPromotion.mockImplementation(() => {
      throw new Error('close exploded')
    })
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('LIVE_CLOSE_FAILED')
    expect(result.failure.safeCode).toBe('Error')
    expect(result.failure.classification).toBe('pre-install')
    expect(result.failure.liveDisposition).toBe('open')
    expect(await journalPhase()).toBe('snapshots-ready')
    expectLeaseStillHeld()
  })

  it('stale capability refuses the close and never calls closeForPromotion', async () => {
    authorization.release()
    const executor = makeExecutor()
    const result = await executor.run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('CAPABILITY_STALE')
    expect(result.failure.safeCode).toBe('released')
    expect(result.failure.classification).toBe('pre-install')
    expect(liveDb.closeForPromotion).not.toHaveBeenCalled()
    expect(await journalPhase()).toBe('snapshots-ready')
  })

  it('forged (never-minted) authorization is refused as capability misuse', async () => {
    const forged = {
      ...capability,
      authorization: {
        ownerId: CANDIDATE_ID,
        isReleased: () => false,
        release: () => false
      } as unknown as PromotionLeaseHandle
    }
    const executor = makeExecutor({}, { capability: forged })
    const result = await executor.run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('CAPABILITY_STALE')
    expect(result.failure.safeCode).toBe('unrecognized-handle')
    expect(liveDb.closeForPromotion).not.toHaveBeenCalled()
    expect(await journalPhase()).toBe('snapshots-ready')
  })

  it('foreign-coordinator authorization is refused as capability misuse', async () => {
    const other = createMaintenanceCoordinator()
    const executor = makeExecutor({}, { coordinator: other })
    const result = await executor.run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('CAPABILITY_STALE')
    expect(result.failure.safeCode).toBe('foreign-coordinator')
    expect(liveDb.closeForPromotion).not.toHaveBeenCalled()
    expect(await journalPhase()).toBe('snapshots-ready')
  })

  it('proof mint refused when the closed-live witness still reports open handles', async () => {
    // close returns true but the witness stays "open" → mint refuses.
    liveDb.closeForPromotion.mockImplementation((auth: PromotionLeaseHandle) => {
      const verdict = validatePromotionAuthorization(auth, coordinator)
      if (!verdict.authorized) throw new Error(`invalid (${verdict.reason})`)
      return true
    })
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('PROOF_MINT_FAILED')
    expect(result.failure.safeCode).toBe('LIVE_NOT_CLOSED')
    expect(result.failure.classification).toBe('pre-install')
    expect(result.failure.liveDisposition).toBe('open')
    expect(await journalPhase()).toBe('snapshots-ready')
    expectLeaseStillHeld()
  })

  it('proof mint refused when the lease is released between close and mint', async () => {
    liveDb.closeForPromotion.mockImplementation((auth: PromotionLeaseHandle) => {
      const verdict = validatePromotionAuthorization(auth, coordinator)
      if (!verdict.authorized) throw new Error(`invalid (${verdict.reason})`)
      authorization.release()
      liveDb.state.open = false
      return true
    })
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('PROOF_MINT_FAILED')
    expect(result.failure.safeCode).toBe('AUTHORIZATION_RELEASED')
    expect(result.failure.classification).toBe('pre-install')
    // Reopen is refused for the released authorization → live stays closed.
    expect(result.failure.liveDisposition).toBe('closed')
    expect(authorization.isReleased()).toBe(true)
    expect(await journalPhase()).toBe('snapshots-ready')
  })
})

// ---------------------------------------------------------------------------
// DB install + db-installed journal (crash windows, no premature advance)
// ---------------------------------------------------------------------------

describe('promotion executor (v2) — db install + journal-db-installed', () => {
  it('pre-install install failure reopens the live DB and keeps the candidate intact', async () => {
    installFake.mockReturnValue({ ok: false, phase: 'pre-install', code: 'CANDIDATE_MISSING', safeCode: 'ENOENT' })
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('INSTALL_FAILED')
    expect(result.failure.safeCode).toBe('CANDIDATE_MISSING:ENOENT')
    expect(result.failure.classification).toBe('pre-install')
    expect(result.failure.recoveryRequired).toBe(false)
    expect(result.failure.liveDisposition).toBe('open')
    expect(liveDb.reopenForPromotion).toHaveBeenCalled()
    expect(liveDb.state.open).toBe(true)
    expect(await journalPhase()).toBe('snapshots-ready')
    expect(realFs.existsSync(candidatePath)).toBe(true)
    expect(realFs.existsSync(retainedPath)).toBe(true)
    expectLeaseStillHeld()
  })

  it('post-install install failure is recovery-required with the live DB closed', async () => {
    installFake.mockReturnValue({
      ok: false,
      phase: 'post-install',
      code: 'LIVE_DIRECTORY_SYNC_FAILED',
      safeCode: 'IO'
    })
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('INSTALL_FAILED')
    expect(result.failure.classification).toBe('post-install')
    expect(result.failure.recoveryRequired).toBe(true)
    expect(result.failure.liveDisposition).toBe('closed')
    expect(await journalPhase()).toBe('snapshots-ready')
    expect(realFs.existsSync(retainedPath)).toBe(true)
    expectLeaseStillHeld()
  })

  it('crash between the db rename and journal-db-installed never advances the journal', async () => {
    const executor = makeExecutor()
    installFake.mockImplementation((options: { candidateId: string }) => {
      executor.requestAbort()
      realFs.rmSync(`${livePath}-wal`, { force: true })
      realFs.rmSync(`${livePath}-shm`, { force: true })
      realFs.renameSync(candidatePath, livePath)
      const receipt: InstallReceipt = {
        candidateId: options.candidateId,
        livePath,
        identity: { dev: 1n, ino: 1n, size: BigInt(CANDIDATE_BYTES.length) },
        installedAtMs: 0
      }
      return { ok: true as const, receipt }
    })
    const result = await executor.run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('ABORT_REQUESTED')
    expect(result.failure.safeCode).toBe('BEFORE_JOURNAL_DB_INSTALLED')
    expect(result.failure.classification).toBe('post-install')
    expect(result.failure.recoveryRequired).toBe(true)
    // The durable journal is still snapshots-ready — NO premature advance.
    expect(await journalPhase()).toBe('snapshots-ready')
    expect(liveBytes().equals(CANDIDATE_BYTES)).toBe(true)
    expectLeaseStillHeld()
  })

  it('stale capability between the db rename and the journal advance refuses forward progress', async () => {
    installFake.mockImplementation((options: { candidateId: string }) => {
      authorization.release()
      realFs.rmSync(`${livePath}-wal`, { force: true })
      realFs.rmSync(`${livePath}-shm`, { force: true })
      realFs.renameSync(candidatePath, livePath)
      const receipt: InstallReceipt = {
        candidateId: options.candidateId,
        livePath,
        identity: { dev: 1n, ino: 1n, size: BigInt(CANDIDATE_BYTES.length) },
        installedAtMs: 0
      }
      return { ok: true as const, receipt }
    })
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('CAPABILITY_STALE')
    expect(result.failure.safeCode).toBe('released')
    expect(result.failure.recoveryRequired).toBe(true)
    expect(await journalPhase()).toBe('snapshots-ready')
    expect(result.failure.liveDisposition).toBe('closed')
  })

  it('journal-db-installed advance failure keeps the journal at snapshots-ready', async () => {
    const badAdvance = vi.fn(async () => {
      throw new PromotionJournalStoreError('PUBLISH_RENAME_FAILED', 'guarded')
    })
    const executor = makeExecutor({
      advanceDbInstalled: badAdvance as unknown as PromotionExecutionPrimitives['advanceDbInstalled']
    })
    const result = await executor.run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('JOURNAL_DB_INSTALLED_FAILED')
    expect(result.failure.safeCode).toBe('PUBLISH_RENAME_FAILED')
    expect(result.failure.recoveryRequired).toBe(true)
    expect(await journalPhase()).toBe('snapshots-ready')
    expectLeaseStillHeld()
  })
})

// ---------------------------------------------------------------------------
// Files install + files-installed/catalog-pending journals
// ---------------------------------------------------------------------------

describe('promotion executor (v2) — files install + journal advances', () => {
  it('files install failure is post-install recovery-required (db already installed)', async () => {
    installFilesFake.mockReturnValue({
      ok: false,
      phase: 'pre-install',
      code: 'CANDIDATE_CATALOG_INVALID',
      safeCode: 'CATALOG_UNREADABLE'
    })
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('FILES_INSTALL_FAILED')
    expect(result.failure.safeCode).toBe('CANDIDATE_CATALOG_INVALID:CATALOG_UNREADABLE')
    expect(result.failure.recoveryRequired).toBe(true)
    expect(await journalPhase()).toBe('db-installed')
    expectLeaseStillHeld()
  })

  it('crash between the files swap and journal-files-installed never advances the journal', async () => {
    const executor = makeExecutor()
    installFilesFake.mockImplementation(() => {
      executor.requestAbort()
      if (realFs.existsSync(liveFilesDir)) {
        realFs.renameSync(liveFilesDir, realPath.join(dataRoot, 'Files.promote-staging'))
      }
      realFs.renameSync(candidateFilesDir, liveFilesDir)
      return {
        ok: true as const,
        receipt: RECEIPTS.candidate.files as NonNullable<PromotionArtifactReceipts['files']>,
        kind: 'populated',
        liveFilesDir
      }
    })
    const result = await executor.run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('ABORT_REQUESTED')
    expect(result.failure.safeCode).toBe('BEFORE_JOURNAL_FILES_INSTALLED')
    expect(result.failure.recoveryRequired).toBe(true)
    expect(await journalPhase()).toBe('db-installed')
    expect(realFs.readFileSync(realPath.join(liveFilesDir, 'f1.png'), 'utf8')).toBe('hello')
    expectLeaseStillHeld()
  })

  it('journal-files-installed advance failure keeps the journal at db-installed', async () => {
    const badAdvance = vi.fn(async () => {
      throw new PromotionJournalStoreError('TRANSITION_PHASE_MISMATCH', 'guarded')
    })
    const executor = makeExecutor({
      advanceFilesInstalled: badAdvance as unknown as PromotionExecutionPrimitives['advanceFilesInstalled']
    })
    const result = await executor.run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('JOURNAL_FILES_INSTALLED_FAILED')
    expect(result.failure.recoveryRequired).toBe(true)
    expect(await journalPhase()).toBe('db-installed')
    expectLeaseStillHeld()
  })

  it('journal-catalog-pending advance failure keeps the journal at files-installed', async () => {
    const badAdvance = vi.fn(async () => {
      throw new PromotionJournalStoreError('TRANSITION_IDENTITY_MISMATCH', 'guarded')
    })
    const executor = makeExecutor({
      advanceCatalogPending: badAdvance as unknown as PromotionExecutionPrimitives['advanceCatalogPending']
    })
    const result = await executor.run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('JOURNAL_CATALOG_PENDING_FAILED')
    expect(result.failure.recoveryRequired).toBe(true)
    expect(await journalPhase()).toBe('files-installed')
    expectLeaseStillHeld()
  })
})

// ---------------------------------------------------------------------------
// Catalog apply boundary (LOCK-EXEC-2/6)
// ---------------------------------------------------------------------------

describe('promotion executor (v2) — single-transaction catalog apply', () => {
  it('catalog apply failure after catalog-pending is post-install recovery-required', async () => {
    catalogBoundary.applyCandidate = vi.fn(async () => ({ ok: false as const, code: 'DEXIE_FAILED' }))
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.classification).toBe('post-install')
    expect(result.failure.recoveryRequired).toBe(true)
    expect(result.failure.code).toBe('CATALOG_APPLY_FAILED')
    expect(result.failure.subphase).toBe('applying-catalog')
    // Journal stays at catalog-pending (ordinary UI blocked, LOCK-PROMO-7).
    expect(await journalPhase()).toBe('catalog-pending')
    // Live bytes retained (installed candidate), no rollback.
    expect(liveBytes().equals(CANDIDATE_BYTES)).toBe(true)
    expectLeaseStillHeld()
  })

  it('catalog boundary timeout stays catalog-pending for recovery (LOCK-EXEC-6)', async () => {
    catalogBoundary.applyCandidate = vi.fn(async () => ({ ok: false as const, code: 'TIMEOUT' }))
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('CATALOG_APPLY_FAILED')
    expect(result.failure.safeCode).toBe('TIMEOUT')
    expect(result.failure.recoveryRequired).toBe(true)
    expect(await journalPhase()).toBe('catalog-pending')
    expectLeaseStillHeld()
  })

  it('catalog boundary throw stays catalog-pending for recovery', async () => {
    catalogBoundary.applyCandidate = vi.fn(async () => {
      throw new Error('dexie exploded')
    })
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('CATALOG_APPLY_FAILED')
    expect(result.failure.safeCode).toBe('Error')
    expect(result.failure.recoveryRequired).toBe(true)
    expect(await journalPhase()).toBe('catalog-pending')
    expectLeaseStillHeld()
  })

  it('post-apply facts mismatch refuses catalog-applied (LOCK-EXEC-2)', async () => {
    catalogBoundary.applyCandidate = vi.fn(async () => ({
      ok: true as const,
      facts: { count: 999, sha256: 'z'.repeat(64) }
    }))
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('CATALOG_APPLY_FAILED')
    expect(result.failure.safeCode).toBe('FACTS_MISMATCH')
    expect(result.failure.recoveryRequired).toBe(true)
    // The single transaction may have committed — but the journal must NOT
    // advance past catalog-pending.
    expect(await journalPhase()).toBe('catalog-pending')
    expectLeaseStillHeld()
  })

  it('tampered candidate catalog (receipt diverged) is refused before the apply (LOCK-EXEC-6)', async () => {
    const catalog = JSON.parse(realFs.readFileSync(candidateCatalogPath, 'utf8'))
    catalog.rows[0].count = 2
    realFs.writeFileSync(candidateCatalogPath, JSON.stringify(catalog))
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('CANDIDATE_CATALOG_UNAVAILABLE')
    expect(result.failure.safeCode).toBe('CATALOG_RECEIPT_MISMATCH')
    expect(result.failure.recoveryRequired).toBe(true)
    expect(await journalPhase()).toBe('catalog-pending')
    expect(catalogBoundary.applyCandidate).not.toHaveBeenCalled()
    expectLeaseStillHeld()
  })

  it('missing candidate catalog (moved/absent) fails at catalog apply', async () => {
    realFs.rmSync(candidateCatalogPath, { force: true })
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('CANDIDATE_CATALOG_UNAVAILABLE')
    expect(result.failure.recoveryRequired).toBe(true)
    expect(await journalPhase()).toBe('catalog-pending')
    expectLeaseStillHeld()
  })

  it('crash between the catalog apply and journal-catalog-applied never advances the journal', async () => {
    const executor = makeExecutor()
    catalogBoundary.applyCandidate = vi.fn(async () => {
      executor.requestAbort()
      return { ok: true as const, facts: RECEIPTS.candidate.catalog as { count: number; sha256: string } }
    })
    const result = await executor.run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('ABORT_REQUESTED')
    expect(result.failure.safeCode).toBe('BEFORE_CATALOG_APPLIED')
    expect(result.failure.recoveryRequired).toBe(true)
    expect(await journalPhase()).toBe('catalog-pending')
    expectLeaseStillHeld()
  })

  it('journal-catalog-applied advance failure keeps the journal at catalog-pending', async () => {
    const badAdvance = vi.fn(async () => {
      throw new PromotionJournalStoreError('TRANSITION_PHASE_MISMATCH', 'guarded')
    })
    const executor = makeExecutor({
      advanceCatalogApplied: badAdvance as unknown as PromotionExecutionPrimitives['advanceCatalogApplied']
    })
    const result = await executor.run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('JOURNAL_CATALOG_APPLIED_FAILED')
    expect(result.failure.recoveryRequired).toBe(true)
    expect(await journalPhase()).toBe('catalog-pending')
    expectLeaseStillHeld()
  })
})

// ---------------------------------------------------------------------------
// Reopen + exact verification boundary (LOCK-EXEC-5/7)
// ---------------------------------------------------------------------------

describe('promotion executor (v2) — reopen + exact verification', () => {
  it('reopen failure after catalog-applied leaves the journal for recovery (LOCK-EXEC-7)', async () => {
    liveDb.reopenForPromotion.mockImplementation(async () => {
      throw new Error('reopen exploded')
    })
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('LIVE_REOPEN_FAILED')
    expect(result.failure.recoveryRequired).toBe(true)
    expect(result.failure.liveDisposition).toBe('closed')
    expect(await journalPhase()).toBe('catalog-applied')
    expectLeaseStillHeld()
  })

  it('stale capability after the catalog apply refuses the journal advance', async () => {
    catalogBoundary.applyCandidate = vi.fn(async () => {
      authorization.release()
      return { ok: true as const, facts: RECEIPTS.candidate.catalog as { count: number; sha256: string } }
    })
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('CAPABILITY_STALE')
    expect(result.failure.recoveryRequired).toBe(true)
    // The stale check fires BEFORE journal-catalog-applied: no premature
    // advance past catalog-pending (LOCK-EXEC-2/4).
    expect(await journalPhase()).toBe('catalog-pending')
  })

  it('db verification failure is post-install recovery-required', async () => {
    verifyFake.mockReturnValue({ ok: false, code: 'REPLACEMENT_INTEGRITY_FAILED', safeCode: null })
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('REPLACEMENT_VERIFICATION_FAILED')
    expect(result.failure.recoveryRequired).toBe(true)
    expect(await journalPhase()).toBe('catalog-applied')
    expectLeaseStillHeld()
  })

  it('tampered live DB bytes fail the exact receipt verification (LOCK-EXEC-5)', async () => {
    verifyFake.mockImplementation(() => {
      realFs.writeFileSync(livePath, Buffer.from('tampered-live-db-bytes'))
      return { ok: true as const }
    })
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('REPLACEMENT_VERIFICATION_FAILED')
    expect(result.failure.safeCode).toBe('DB_RECEIPT_MISMATCH')
    expect(result.failure.recoveryRequired).toBe(true)
    expect(await journalPhase()).toBe('catalog-applied')
    expectLeaseStillHeld()
  })

  it('tampered live Files payload fails per-row parity verification (LOCK-EXEC-5)', async () => {
    liveDb.reopenForPromotion.mockImplementation(async (auth: PromotionLeaseHandle) => {
      const verdict = validatePromotionAuthorization(auth, coordinator)
      if (!verdict.authorized) throw new Error(`invalid (${verdict.reason})`)
      realFs.writeFileSync(realPath.join(liveFilesDir, 'f1.png'), 'tampered')
      liveDb.state.open = true
    })
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('REPLACEMENT_VERIFICATION_FAILED')
    expect(result.failure.safeCode).toBe('FILES_PARITY_PAYLOAD_SIZE_MISMATCH')
    expect(result.failure.recoveryRequired).toBe(true)
    expect(await journalPhase()).toBe('catalog-applied')
    expectLeaseStillHeld()
  })

  it('consistently tampered Files + handoff fail the aggregate receipt check (LOCK-EXEC-5)', async () => {
    // Rewrite the on-disk handoff AND the live Files consistently to a
    // DIFFERENT generation: per-row parity passes but the derived aggregate
    // receipt diverges from the journaled candidate files receipt.
    verifyFake.mockImplementation(() => {
      realFs.rmSync(realPath.join(liveFilesDir, 'f1.png'), { force: true })
      realFs.writeFileSync(realPath.join(liveFilesDir, 'x1.bin'), 'evil')
      realFs.writeFileSync(
        candidateCatalogPath,
        JSON.stringify({
          version: 1,
          sessionId: SESSION_ID,
          createdAt: new Date().toISOString(),
          rows: [
            {
              id: 'x1',
              name: 'x1.bin',
              origin_name: 'x1.bin',
              size: 4,
              sha256: sha256('evil'),
              ext: '.bin',
              type: null,
              created_at: null,
              count: 1,
              path: 'Files/x1.bin'
            }
          ],
          referenced: { referencedFileIdCount: 1 },
          degraded: {
            missingPayload: 0,
            missingCatalogRow: 0,
            metadataMismatch: 0,
            payloadReadFailure: 0,
            lostContent: 0,
            invalidTargetName: 0,
            duplicateCatalogRow: 0
          },
          skipped: { payloadWithoutCatalog: 0 }
        }),
        'utf8'
      )
      return { ok: true as const }
    })
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('REPLACEMENT_VERIFICATION_FAILED')
    expect(result.failure.safeCode).toBe('FILES_RECEIPT_MISMATCH')
    expect(result.failure.recoveryRequired).toBe(true)
    expect(await journalPhase()).toBe('catalog-applied')
    expectLeaseStillHeld()
  })

  it('catalog facts mismatch during verification is post-install recovery-required', async () => {
    catalogBoundary.queryFacts = vi.fn(async () => ({
      ok: true as const,
      facts: { count: 999, sha256: 'z'.repeat(64) }
    }))
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('REPLACEMENT_VERIFICATION_FAILED')
    expect(result.failure.safeCode).toBe('CATALOG_FACTS_MISMATCH')
    expect(result.failure.recoveryRequired).toBe(true)
    expect(await journalPhase()).toBe('catalog-applied')
    expectLeaseStillHeld()
  })

  it('catalog facts query throw is a bounded verification failure', async () => {
    catalogBoundary.queryFacts = vi.fn(async () => {
      throw new Error('boundary dead')
    })
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('REPLACEMENT_VERIFICATION_FAILED')
    expect(result.failure.safeCode).toBe('CATALOG_FACTS_MISMATCH')
    expect(result.failure.recoveryRequired).toBe(true)
    expect(await journalPhase()).toBe('catalog-applied')
    expectLeaseStillHeld()
  })

  it('crash between verification and journal-replacement-verified never advances the journal', async () => {
    const executor = makeExecutor()
    verifyFake.mockImplementation(() => {
      executor.requestAbort()
      return { ok: true as const }
    })
    const result = await executor.run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('ABORT_REQUESTED')
    expect(result.failure.safeCode).toBe('BEFORE_JOURNAL_REPLACEMENT_VERIFIED')
    expect(result.failure.recoveryRequired).toBe(true)
    expect(await journalPhase()).toBe('catalog-applied')
    expectLeaseStillHeld()
  })

  it('journal-replacement-verified advance failure keeps the journal at catalog-applied', async () => {
    const badAdvance = vi.fn(async () => {
      throw new PromotionJournalStoreError('TRANSITION_PHASE_MISMATCH', 'guarded')
    })
    const executor = makeExecutor({
      advanceReplacementVerified: badAdvance as unknown as PromotionExecutionPrimitives['advanceReplacementVerified']
    })
    const result = await executor.run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('JOURNAL_REPLACEMENT_VERIFIED_FAILED')
    expect(result.failure.recoveryRequired).toBe(true)
    expect(await journalPhase()).toBe('catalog-applied')
    expectLeaseStillHeld()
  })
})

// ---------------------------------------------------------------------------
// Executor semantics — exact-once, abort, cleanup/restart refusal, privacy
// ---------------------------------------------------------------------------

describe('promotion executor (v2) — executor semantics', () => {
  it('run() is exact-once: a second call rejects', async () => {
    const executor = makeExecutor()
    const first = await executor.run()
    expect(first.ok).toBe(true)
    await expect(executor.run()).rejects.toThrow(/exact-once/)
  })

  it('abort before the DB install is a cooperative pre-install failure', async () => {
    const executor = makeExecutor()
    executor.requestAbort()
    const result = await executor.run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('ABORT_REQUESTED')
    expect(result.failure.classification).toBe('pre-install')
    expect(await journalPhase()).toBe('snapshots-ready')
  })

  it('reports subphase and settles exactly once', async () => {
    const executor = makeExecutor()
    const settled = executor.whenSettled()
    expect(executor.isSettled()).toBe(false)
    const result = await executor.run()
    await settled
    expect(executor.isSettled()).toBe(true)
    expect(result.ok).toBe(true)
  })

  it('post-install failure keeps every artifact, the journal, and the lease', async () => {
    verifyFake.mockReturnValue({ ok: false, code: 'REPLACEMENT_INTEGRITY_FAILED', safeCode: null })
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    // Cleanup/restart refusal: journal + retained snapshot + installed
    // artifacts all remain; the executor never rolls back or restarts.
    expect(await journalPhase()).toBe('catalog-applied')
    expectJournalPresent()
    expect(realFs.existsSync(retainedPath)).toBe(true)
    expect(liveBytes().equals(CANDIDATE_BYTES)).toBe(true)
    expect(realFs.existsSync(realPath.join(liveFilesDir, 'f1.png'))).toBe(true)
    expectLeaseStillHeld()
  })

  it('UNEXPECTED_FAILURE keeps a bounded safeCode and never exposes the raw cause in it', async () => {
    installFake.mockImplementation(() => {
      throw new Error('boom /Users/secret/private-path/chat.db')
    })
    const result = await makeExecutor().run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('UNEXPECTED_FAILURE')
    expect(result.failure.safeCode).toBe('Error')
    expect(result.failure.safeCode).not.toContain('secret')
    expect(result.failure.safeCode).not.toContain('/')
    expect(result.failure.classification).toBe('pre-install')
    // The raw cause stays Main-local (in-memory only, never on the result
    // contract exposed to UI/orchestrator).
    expect(result.failure.cause).toBeInstanceOf(Error)
    expectLeaseStillHeld()
  })
})
