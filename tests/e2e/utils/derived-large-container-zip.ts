/**
 * Bounded synthetic large-container fixture for L2 selective extraction
 * (LOCK-L1..L4).
 *
 * The production zip intake rejects the old 500 MiB *compressed file stat*
 * cap via `validateFileStat` (Layer 1) and proves, in mocked unit tests, that
 * >500 MiB and >1 GiB NON-selected central-directory entries never count
 * toward the selected byte totals (LOCK-L2 keeps that proof in unit-mocked
 * central metadata because a real >500 MiB compressed container needs >500 MiB
 * of disk).
 *
 * This fixture proves the OTHER half of the claim against a real container:
 * a ZIP whose CENTRAL DIRECTORY describes an irrelevant entry with >500 MiB
 * of UNCOMPRESSED logical payload, while the archive on disk stays tiny
 * because the payload is streamed as a highly-compressible repeated pattern.
 * The production reader (node-stream-zip) sees a genuine entry of that
 * logical size; selective extraction must NOT materialize it because it lives
 * under `Data/Files/...` (never selected), and must keep the selected
 * IndexedDB / Local Storage subset byte-for-byte identical to the seed.
 *
 * Resource bounds (LOCK-L2):
 * - Nothing buffers the logical payload: the irrelevant entry is produced by
 *   a backpressure-respecting Readable that emits fixed 64 KiB chunks of a
 *   repeated ASCII pattern and lets zlib/deflate do the compression.
 * - Default logical size 600 MiB (>500 MiB) compresses to a few MiB, so the
 *   resulting archive stays well under the 20 MiB budget.
 * - Default generation is <2 s on a laptop (measured); bounded by a hard
 *   archive-bytes budget enforced after write.
 * - A pre-stream guard rejects absurd logical sizes (>4 GiB) before any write.
 *
 * Ownership (LOCK-L1/LOCK-T1): every artifact lives under the caller-owned
 * temp root in a uniquely named work dir; `cleanup()` removes exactly that
 * work dir + derived ZIP and verifies absence, throwing on leftovers. On ANY
 * error the partial output and work dir are removed before the error
 * propagates (no process holds these files, so removal is always safe).
 *
 * Contract (LOCK-L3): the derived ZIP is a REPACKAGE of the seed ZIP — every
 * seed entry (names, logical sizes, directory markers) is preserved and the
 * selected-prefix entry set (IndexedDB/<origin>.indexeddb.leveldb/**,
 * IndexedDB/<origin>.indexeddb.blob/**, Local Storage/leveldb/**) is provably
 * identical to the seed. Only the single irrelevant `Data/Files/...` entry is
 * added. Expected selected/ignored facts are exposed via `evidence`.
 *
 * LIMITATION (returned to the hub): this E2E fixture does NOT independently
 * cross the compressed >500 MiB file-stat cap — that branch is owned by the
 * production unit tests with mocked central-directory metadata (a real
 * compressed >500 MiB container would need >500 MiB of disk). The fixture
 * proves the selected-subset-small / irrelevant-never-extracted behavior on a
 * real archive whose central directory already exceeds the old 500 MiB
 * logical cap.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Readable } from 'node:stream'

import archiver from 'archiver'
import StreamZip from 'node-stream-zip'

import { removeOwnedSeedArtifacts, validateOwnedRoot } from './run-ownership'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default irrelevant entry logical (uncompressed) size: 600 MiB — comfortably
 * above the old 500 MiB container cap so the CENTRAL DIRECTORY itself already
 * exceeds the legacy limit while the archive on disk stays tiny.
 */
export const DEFAULT_IRRELEVANT_LOGICAL_BYTES = 600 * 1024 * 1024

/**
 * Default irrelevant entry name. `Data/` is the Chromium profile subtree the
 * production intake NEVER selects, so a spec can assert "never extracted"
 * with the exact production selection prefixes.
 */
export const DEFAULT_IRRELEVANT_ENTRY_NAME = 'Data/Files/e2e-large/irrelevant-bulk.bin'

/**
 * Hard archive-size budget (LOCK-L2: <20 MiB preferred). The helper throws
 * after write if the derived archive exceeds this; the focused test asserts it.
 */
export const DEFAULT_MAX_ARCHIVE_BYTES = 20 * 1024 * 1024

/**
 * Pre-stream guard: reject logical sizes beyond 4 GiB before any write.
 * Mirrors production `MAX_ZIP_SIZE_BYTES` as a fail-closed sanity bound for a
 * "bounded" fixture — nothing in the fixture intent needs more than a few GiB
 * of logical payload.
 */
export const MAX_IRRELEVANT_LOGICAL_BYTES = 4 * 1024 * 1024 * 1024

/** Chunk size for the streamed compressible payload (memory bound). */
const STREAM_CHUNK_BYTES = 64 * 1024

/**
 * Repeated ASCII pattern that fills every chunk; deflate collapses it to a
 * tiny output. Kept in one line so the pattern is obviously synthetic.
 */
const REPEAT_PATTERN = Buffer.from('CherryStudioE2EIrrelevantPayload|')

/** Work-dir prefix under the caller-owned temp root. */
const DERIVED_PREFIX = 'cherry-e2e-derived-large-'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One ZIP entry in the selected-subset snapshots. */
export interface ZipEntryFact {
  name: string
  /** Uncompressed logical size in bytes (central directory). */
  size: number
}

export interface LargeContainerFixtureEvidence {
  /** Absolute path of the input seed ZIP. */
  seedZipPath: string
  /** Absolute path of the derived ZIP. */
  derivedZipPath: string
  /** Name of the added irrelevant `Data/Files/...` entry. */
  irrelevantEntryName: string
  /** Logical (uncompressed) size of the irrelevant entry, per central directory. */
  irrelevantLogicalBytes: number
  /** Compressed size of the irrelevant entry, per central directory. */
  irrelevantCompressedBytes: number
  /** Actual on-disk size of the derived archive (compressed file stat). */
  derivedArchiveBytes: number
  /** Hard archive-size budget the derived archive must not exceed. */
  maxArchiveBytes: number
  /** True when derivedArchiveBytes <= maxArchiveBytes. */
  archiveBounded: boolean
  /** Central-directory entry count of the seed ZIP. */
  seedEntryCount: number
  /** Central-directory entry count of the derived ZIP (= seed + 1). */
  derivedEntryCount: number
  /**
   * Selected-subset facts (LOCK-L3): entries under the production selection
   * prefixes (IndexedDB/<origin>.indexeddb.leveldb/**, the matching
   * `.indexeddb.blob/**` subtree, and Local Storage/leveldb/**) as read from
   * the DERIVED ZIP. This is exactly what selective extraction materializes.
   */
  selectedEntries: ZipEntryFact[]
  /** Cumulative logical size of the selected subset (must stay small). */
  selectedLogicalBytes: number
  /**
   * True when the irrelevant entry is NOT under any production selection
   * prefix — i.e. selective extraction must never materialize it.
   */
  irrelevantNeverSelected: boolean
}

export interface DerivedLargeContainerZip {
  /** Absolute path to the derived ZIP (caller should import THIS path). */
  zipPath: string
  /** Owned work dir holding the derived ZIP (lives under the owned root). */
  workDir: string
  /** Selected/ignored facts for downstream spec assertions (LOCK-L3). */
  evidence: LargeContainerFixtureEvidence
  /**
   * Remove the owned work dir + derived ZIP and verify absence. Idempotent;
   * throws on leftovers (LOCK-T1).
   */
  cleanup(): Promise<void>
}

export interface CreateDerivedLargeContainerZipOptions {
  /**
   * Logical (uncompressed) size of the irrelevant entry. Default 600 MiB
   * (DEFAULT_IRRELEVANT_LOGICAL_BYTES). Must be > 0 and <= 4 GiB.
   */
  irrelevantLogicalBytes?: number
  /**
   * Entry name for the irrelevant payload. Default
   * `Data/Files/e2e-large/irrelevant-bulk.bin` (never selected by production).
   */
  irrelevantEntryName?: string
  /**
   * Hard on-disk archive budget. Default 20 MiB
   * (DEFAULT_MAX_ARCHIVE_BYTES). Throws after write if exceeded.
   */
  maxArchiveBytes?: number
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Backpressure-respecting Readable that yields exactly `totalBytes` of a
 * fixed repeated ASCII pattern in `chunkBytes` chunks. Nothing is buffered:
 * archiver pulls via `read()` and zlib compresses each chunk in flight.
 */
function createCompressibleByteStream(totalBytes: number, chunkBytes: number): Readable {
  const chunk = Buffer.allocUnsafe(chunkBytes)
  for (let offset = 0; offset < chunkBytes; offset += REPEAT_PATTERN.length) {
    const len = Math.min(REPEAT_PATTERN.length, chunkBytes - offset)
    REPEAT_PATTERN.copy(chunk, offset, 0, len)
  }
  let remaining = totalBytes
  return new Readable({
    read() {
      if (remaining <= 0) {
        this.push(null)
        return
      }
      const n = Math.min(chunk.length, remaining)
      this.push(n === chunk.length ? chunk : chunk.subarray(0, n))
      remaining -= n
    }
  })
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * Production-selection prefixes (LOCK-PROD-8/9 mirror): the accepted origin
 * IndexedDB subtree, its matching `.indexeddb.blob` subtree, and the bounded
 * `Local Storage/leveldb` subtree. Returns null when the seed has no
 * `.indexeddb.leveldb` origin with `.ldb` entries (mirroring
 * `selectExtractionEntries` classification).
 */
function resolveSelectedPrefixes(entries: Record<string, StreamZip.ZipEntry>): string[] | null {
  const originCandidates = new Set<string>()
  for (const entry of Object.values(entries)) {
    if (entry.isDirectory) continue
    const match = /^IndexedDB\/([^/]+\.indexeddb\.leveldb)\//.exec(entry.name)
    if (!match) continue
    if (entry.name.endsWith('.ldb')) originCandidates.add(match[1])
  }
  if (originCandidates.size === 0) return null
  // Ambiguity is a seed defect; fail closed on more than one origin.
  if (originCandidates.size > 1) {
    throw new Error(`Seed ZIP has multiple IndexedDB origins: ${Array.from(originCandidates).join(', ')}`)
  }
  const originDir = Array.from(originCandidates)[0]
  const blobDir = originDir.replace(/\.indexeddb\.leveldb$/, '.indexeddb.blob')
  return [`IndexedDB/${originDir}/`, `IndexedDB/${blobDir}/`, 'Local Storage/leveldb/']
}

function isSelected(name: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => name.startsWith(prefix))
}

/** Snapshot selected-subset facts from a ZIP's central directory. */
async function snapshotSelected(
  zipPath: string,
  prefixes: readonly string[]
): Promise<{ entries: ZipEntryFact[]; logicalBytes: number }> {
  const zip = new StreamZip.async({ file: zipPath })
  try {
    const entries = await zip.entries()
    const facts: ZipEntryFact[] = []
    let logicalBytes = 0
    for (const entry of Object.values(entries)) {
      if (entry.isDirectory) continue
      if (!isSelected(entry.name, prefixes)) continue
      const size = (entry as { size?: number }).size ?? 0
      facts.push({ name: entry.name, size })
      logicalBytes += size
    }
    facts.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return { entries: facts, logicalBytes }
  } finally {
    await zip.close()
  }
}

/**
 * Repackage `seedZipPath` into `derivedZipPath` by streaming every seed entry
 * (data never buffered) and appending the compressible irrelevant entry.
 * Throws on any stream/output error; the caller owns cleanup of the partial.
 */
async function streamRepackage(
  seedZipPath: string,
  derivedZipPath: string,
  irrelevantEntryName: string,
  irrelevantLogicalBytes: number
): Promise<void> {
  const zip = new StreamZip.async({ file: seedZipPath })
  const output = fs.createWriteStream(derivedZipPath)
  const archive = archiver('zip', { zlib: { level: 1 }, zip64: true })
  archive.pipe(output)

  // Settled flag prevents double resolve/reject when both output and archive
  // error handlers fire (mirrors BackupManager LOCK-6013 pattern).
  const done = new Promise<void>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true
        fn()
      }
    }
    output.on('close', () => settle(resolve))
    output.on('error', (err) => {
      try {
        archive.abort()
      } catch {
        /* best-effort — archive may already be finalised */
      }
      settle(() => reject(err))
    })
    archive.on('error', (err) => {
      try {
        archive.abort()
      } catch {
        /* best-effort */
      }
      output.destroy(err instanceof Error ? err : new Error(String(err)))
      settle(() => reject(err))
    })
  })

  try {
    const entries = await zip.entries()
    for (const entry of Object.values(entries)) {
      if (entry.isDirectory) {
        // Preserve directory markers (trailing-slash names).
        archive.append(null, { name: entry.name })
      } else {
        const stream = await zip.stream(entry.name)
        archive.append(stream, { name: entry.name })
      }
    }
    archive.append(createCompressibleByteStream(irrelevantLogicalBytes, STREAM_CHUNK_BYTES), {
      name: irrelevantEntryName
    })
    await archive.finalize()
    await done
  } finally {
    await zip.close()
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create an owned derived ZIP from a disposable seed ZIP (LOCK-L3): preserves
 * every seed entry byte-for-byte (via streaming) and appends a single
 * irrelevant `Data/Files/...` entry whose CENTRAL-DIRECTORY logical size is
 * `irrelevantLogicalBytes` (default 600 MiB) but whose streamed
 * highly-compressible payload keeps the archive on disk tiny.
 *
 * Fail-closed behavior:
 * - ownedTmpRoot must be a valid owned root (run-ownership contract);
 * - seed ZIP must be readable and contain an IndexedDB origin with `.ldb`
 *   entries (production classification requires it);
 * - requested logical size must be > 0 and <= 4 GiB (pre-stream guard);
 * - after write, the derived archive must be <= maxArchiveBytes and its
 *   central directory must satisfy every preservation/selection invariant.
 *
 * On ANY failure the partial output + owned work dir are removed before the
 * error propagates. Callers MUST call `cleanup()` on success; cleanup
 * failures throw (LOCK-T1).
 */
export async function createDerivedLargeContainerZip(
  seedZipPath: string,
  ownedTmpRoot: string,
  options: CreateDerivedLargeContainerZipOptions = {}
): Promise<DerivedLargeContainerZip> {
  const irrelevantLogicalBytes = options.irrelevantLogicalBytes ?? DEFAULT_IRRELEVANT_LOGICAL_BYTES
  const irrelevantEntryName = options.irrelevantEntryName ?? DEFAULT_IRRELEVANT_ENTRY_NAME
  const maxArchiveBytes = options.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES

  if (!Number.isSafeInteger(irrelevantLogicalBytes) || irrelevantLogicalBytes <= 0) {
    throw new Error(`Irrelevant logical size must be a positive safe integer, got: ${irrelevantLogicalBytes}`)
  }
  if (irrelevantLogicalBytes > MAX_IRRELEVANT_LOGICAL_BYTES) {
    throw new Error(
      `Irrelevant logical size (${irrelevantLogicalBytes} bytes) exceeds the bounded fixture cap ` +
        `(${MAX_IRRELEVANT_LOGICAL_BYTES} bytes) — refused before any write (LOCK-L2)`
    )
  }
  if (typeof irrelevantEntryName !== 'string' || irrelevantEntryName.length === 0) {
    throw new Error(`Irrelevant entry name must be a non-empty string, got: ${JSON.stringify(irrelevantEntryName)}`)
  }

  const canonicalRoot = validateOwnedRoot(ownedTmpRoot)
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const workDir = path.join(canonicalRoot, `${DERIVED_PREFIX}${unique}`)
  const zipPath = path.join(workDir, 'derived-large-container.zip')
  fs.mkdirSync(workDir, { recursive: true })

  const cleanupArtifacts = (): void => {
    removeOwnedSeedArtifacts([workDir], zipPath)
  }

  try {
    // ---- Read the seed central directory + selection prefixes -----------
    const seedZip = new StreamZip.async({ file: seedZipPath })
    let seedEntries: Record<string, StreamZip.ZipEntry>
    try {
      seedEntries = await seedZip.entries()
    } finally {
      await seedZip.close()
    }
    const seedEntryCount = Object.keys(seedEntries).length
    if (seedEntryCount === 0) {
      throw new Error(`Seed ZIP has no entries: ${seedZipPath}`)
    }
    const selectedPrefixes = resolveSelectedPrefixes(seedEntries)
    if (selectedPrefixes === null) {
      throw new Error(
        `Seed ZIP has no IndexedDB origin with .ldb entries: ${seedZipPath} — ` +
          'production origin classification would reject it'
      )
    }
    const seedSelected = await snapshotSelected(seedZipPath, selectedPrefixes)

    // ---- Stream-repackage + append the irrelevant entry -----------------
    await streamRepackage(seedZipPath, zipPath, irrelevantEntryName, irrelevantLogicalBytes)

    // ---- Post-write verification (fail closed) ---------------------------
    let derivedStat: fs.Stats
    try {
      derivedStat = fs.statSync(zipPath)
    } catch (error) {
      if (isEnoent(error)) throw new Error(`Derived ZIP was not produced at ${zipPath}`)
      throw error
    }
    const derivedArchiveBytes = derivedStat.size
    if (derivedArchiveBytes > maxArchiveBytes) {
      throw new Error(
        `Derived archive (${derivedArchiveBytes} bytes on disk) exceeds the bounded budget ` +
          `(${maxArchiveBytes} bytes) — the compressible payload did not compress as expected (LOCK-L2)`
      )
    }

    const verifyZip = new StreamZip.async({ file: zipPath })
    let derivedEntries: Record<string, StreamZip.ZipEntry>
    try {
      derivedEntries = await verifyZip.entries()
    } finally {
      await verifyZip.close()
    }
    const derivedEntryCount = Object.keys(derivedEntries).length
    if (derivedEntryCount !== seedEntryCount + 1) {
      throw new Error(
        `Derived ZIP entry count ${derivedEntryCount} != seed count + 1 (${seedEntryCount + 1}) — ` +
          'seed entries were not preserved exactly'
      )
    }
    // Every seed entry must survive with the identical logical size.
    for (const seedEntry of Object.values(seedEntries)) {
      const derived = derivedEntries[seedEntry.name]
      if (!derived) {
        throw new Error(`Derived ZIP lost seed entry "${seedEntry.name}"`)
      }
      if (!seedEntry.isDirectory) {
        const expectedSize = (seedEntry as { size?: number }).size ?? 0
        const actualSize = (derived as { size?: number }).size ?? 0
        if (actualSize !== expectedSize) {
          throw new Error(`Derived ZIP changed logical size of "${seedEntry.name}": ${expectedSize} -> ${actualSize}`)
        }
      }
    }
    const irrelevantEntry = derivedEntries[irrelevantEntryName]
    if (!irrelevantEntry || irrelevantEntry.isDirectory) {
      throw new Error(`Derived ZIP is missing the irrelevant entry "${irrelevantEntryName}"`)
    }
    const irrelevantLogical = (irrelevantEntry as { size?: number }).size ?? 0
    if (irrelevantLogical !== irrelevantLogicalBytes) {
      throw new Error(
        `Irrelevant entry central-directory size (${irrelevantLogical}) != requested (${irrelevantLogicalBytes})`
      )
    }
    const irrelevantCompressedBytes = (irrelevantEntry as { compressedSize?: number }).compressedSize ?? 0
    const irrelevantNeverSelected = !isSelected(irrelevantEntryName, selectedPrefixes)
    if (!irrelevantNeverSelected) {
      throw new Error(`Irrelevant entry "${irrelevantEntryName}" collides with a production selection prefix`)
    }

    // Selected subset of the DERIVED zip must equal the seed's exactly.
    const derivedSelected = await snapshotSelected(zipPath, selectedPrefixes)
    if (derivedSelected.entries.length !== seedSelected.entries.length) {
      throw new Error(
        `Selected subset changed: ${seedSelected.entries.length} seed entries vs ` +
          `${derivedSelected.entries.length} derived entries`
      )
    }
    for (let i = 0; i < seedSelected.entries.length; i++) {
      const seed = seedSelected.entries[i]
      const derived = derivedSelected.entries[i]
      if (seed.name !== derived.name || seed.size !== derived.size) {
        throw new Error(
          `Selected subset changed at index ${i}: seed ${seed.name}@${seed.size} vs derived ${derived.name}@${derived.size}`
        )
      }
    }

    return {
      zipPath,
      workDir,
      evidence: {
        seedZipPath,
        derivedZipPath: zipPath,
        irrelevantEntryName,
        irrelevantLogicalBytes: irrelevantLogical,
        irrelevantCompressedBytes,
        derivedArchiveBytes,
        maxArchiveBytes,
        archiveBounded: derivedArchiveBytes <= maxArchiveBytes,
        seedEntryCount,
        derivedEntryCount,
        selectedEntries: derivedSelected.entries,
        selectedLogicalBytes: derivedSelected.logicalBytes,
        irrelevantNeverSelected
      },
      cleanup: async () => {
        cleanupArtifacts()
      }
    }
  } catch (error) {
    // Cancellation/error cleanup: no process ever holds these files, so the
    // partial output + work dir are always safe to remove. Cleanup failure
    // combines with, never masks, the original error.
    let cleanupError: string | null = null
    try {
      cleanupArtifacts()
    } catch (cleanupErr) {
      cleanupError = asMessage(cleanupErr)
    }
    if (cleanupError !== null) {
      const original = asMessage(error)
      throw new Error(`${original} (derived-fixture cleanup also failed: ${cleanupError})`)
    }
    throw error
  }
}
