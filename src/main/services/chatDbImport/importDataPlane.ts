/**
 * Candidate data plane for the ChatImport pipeline (Phase 4.2).
 *
 * Converts validated Phase 4.1 {@link ReadPageResponse} pages into exact
 * target domain rows and writes each page as one atomic candidate DB
 * transaction through `createImportWriter(tx)`.
 *
 * Responsibilities:
 * - Strict source validation with contextual errors (table, page index, id).
 * - Canonical topic projection (id/messages/deletedAt only — LOCK-D2).
 * - Embedded-message projection with array-index sortOrder (LOCK-D3) and
 *   outer-topic ownership canonicalization (LOCK-OWN-1): a PRESENT valid
 *   non-empty `message.topicId` that differs from the outer `topic.id` is
 *   canonicalized to the outer topic on the projected MessageData. Missing/
 *   empty/wrong-type topicId still reject, and every other ownership/
 *   identity validation (duplicate IDs, block owner, segment membership,
 *   file-reference derivation) stays strict. Normalizations are counted
 *   Main-only and aggregated exactly once by the orchestrator (LOCK-OWN-2)
 *   — never warned per message, never with IDs/content/source values.
 * - Deterministic message identity (LOCK-MID-1/2/3): every message
 *   occurrence maps via `(outerTopicId, legacyMessageId)` →
 *   `computeMessageTargetId` — no occurrence retains its legacy ID.
 *   Same-tuple duplicates (same legacy id twice inside one outer topic)
 *   and derived target-ID collisions are detected explicitly during
 *   projection, traversal-order independent and transactional with the
 *   page commit (a rejected page commits nothing and leaks no indexes).
 * - askId semantics (LOCK-ASK-1/2): a same-topic askId that resolves to a
 *   source occurrence maps to that occurrence's target ID; a dangling
 *   askId keeps its original non-empty JSON-safe string (never nulled,
 *   inferred, or cross-topic bound). After ALL target IDs are known,
 *   finalize() strictly rejects any preserved dangling value that equals a
 *   target message ID. Committed dangling-preserved count only.
 * - Streaming relation indexes: occurrence tuples and
 *   blockId→{owner tuple, targetId, sortOrder, seen} (LOCK-D4/D-REF).
 * - Block projection with parent-index sortOrder and file-reference
 *   derivation via `projectFileReferences` (LOCK-D5). Embedded block owner
 *   is authoritative (LOCK-REF-1): the source row claim is checked against
 *   the owner's legacy tuple, then the persisted block.messageId is
 *   rewritten to the owner target ID; file-reference blockId is unchanged.
 *   Skip rules at the source projection boundary:
 *   - Unreachable orphan (LOCK-BLOCK-1): block id in NO message.blocks[]
 *     AND claimed messageId in NO imported message → skipped; counted
 *     Main-only as unreachableBlockSkipCount.
 *   - Existing-owner unembedded (LOCK-BLOCK-1X): block id in NO
 *     message.blocks[] AND claimed messageId resolves to EXACTLY ONE
 *     imported source occurrence → skipped (prevents reconstruction
 *     resurrection); counted Main-only as
 *     skippedExistingOwnerUnembeddedBlockCount. An ambiguous claim
 *     (legacy id in multiple topics) rejects.
 *   - All other conflicts (owner mismatch, referenced-block missing,
 *     duplicate source block ids, cross-owner) reject strictly via the
 *     transactional source-seen registry.
 *   Both skips produce no target rows, file references, manifest evidence,
 *   writer inserts, or seen markers, and are never warned with
 *   IDs/content/source values (LOCK-BLOCK-2). Orphan classification uses
 *   the LEGACY occurrence index, never target IDs (LOCK-ORPH-1).
 * - Segment/membership projection with ownership checks (LOCK-D6) and the
 *   LOCK-SEG-1 skip boundary: a segment is skipped ONLY when its topic is
 *   absent AND every member legacy ID resolves to no imported occurrence
 *   anywhere (counted Main-only as skippedSegmentRowCount and
 *   skippedSegmentMembershipCount). Topic-present segments stay strict:
 *   any missing/wrong-topic member rejects; absent topic with any
 *   globally resolvable member rejects. Memberships persist as target IDs
 *   resolved by (segment.topicId, legacyMessageId). Never truncate
 *   memberships or infer a target.
 * - `files` pages as validated count-diagnostics only (LOCK-D7).
 * - One outer transaction per page; all-or-nothing (LOCK-D8).
 * - Stats accounting for committed rows/pages only (LOCK-D9).
 * - finalize() rejection of referenced-but-missing blocks and
 *   non-aliased stats snapshots (LOCK-D10).
 * - Source verification evidence (Phase 4.3.1, LOCK-4301): manifest deltas
 *   staged from the target-equivalent StagedPage projections and committed
 *   only after the page transaction succeeds; the deep-frozen manifest is
 *   exposed Main-only via getSourceVerificationManifest() after finalize().
 *
 * Boundaries (LOCK-D11):
 * - Main-only. Receives an already initialized Drizzle candidate DB.
 * - Does NOT create/seal/discard candidate resources, does NOT touch the
 *   live DB, and does NOT perform IPC/state orchestration or Phase 4.3
 *   integrity verification.
 */

import type {
  FileReferenceData,
  MessageBlockData,
  MessageData,
  TopicData,
  TopicSegmentData
} from '@main/services/chatDb/domain/types'
import { createImportWriter } from '@main/services/chatDb/repository/ImportWriter'
import { isValidL2TrashRetentionMarker, L2_TRASH_RETENTION_MARKER } from '@main/services/chatDb/trashRetention'
import { projectFileReferences, wireToBlock, wireToMessage } from '@main/services/chatDb/wireAdapters'
import type { JsonObject } from '@shared/chatDb'
import {
  BLOCK_JSON_PROFILE,
  createProfileBytes,
  MAX_ARRAY_LENGTH,
  validateJsonObject,
  validateJsonObjectBlock,
  ValidationError
} from '@shared/chatDb/validation'
import type { CandidateImportStats, ReadPageResponse, SourceReadStats } from '@shared/chatImport/types'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import { computeMessageTargetId, MessageIdentityError } from './identity/messageIdentity'
import type { SourceVerificationManifest } from './verification/sourceManifest'
import { SourceVerificationManifestBuilder } from './verification/sourceManifest'

// ---------------------------------------------------------------------------
// Entity order contract (LOCK-D1)
// ---------------------------------------------------------------------------

/**
 * Source entities in their mandatory arrival order (LOCK-D1/ORDER-1).
 *
 * Pages must arrive contiguously: a page may repeat the current table
 * (pagination) or advance exactly one table — never jump forward over a
 * required entity and never move backward. The first page MUST be `topics`.
 */
export const IMPORT_ENTITY_ORDER = ['topics', 'message_blocks', 'topic_segments', 'files'] as const

export type ImportEntityName = (typeof IMPORT_ENTITY_ORDER)[number]

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export type ImportDataPlaneErrorCode =
  | 'UNKNOWN_TABLE'
  | 'ENTITY_ORDER_VIOLATION'
  | 'INVALID_ROW'
  | 'DUPLICATE_RELATION'
  | 'OWNERSHIP_MISMATCH'
  | 'MISSING_BLOCKS'
  | 'TARGET_COLLISION'
  | 'FINALIZED'
  | 'NOT_FINALIZED'

/**
 * Rejection raised by the data plane. Carries a machine-readable code plus
 * table/entity context for diagnostics. Messages contain only source IDs —
 * never filesystem paths.
 */
export class ChatImportDataPlaneError extends Error {
  readonly code: ImportDataPlaneErrorCode
  readonly tableName: string | null
  readonly entityId: string | null

  constructor(code: ImportDataPlaneErrorCode, detail: string, context?: { tableName?: string; entityId?: string }) {
    super(`Import data-plane rejection (${code}): ${detail}`)
    this.name = 'ChatImportDataPlaneError'
    this.code = code
    this.tableName = context?.tableName ?? null
    this.entityId = context?.entityId ?? null
  }
}

/**
 * Fixed production table names allowed in a data-plane rejection summary
 * (LOCK-PRIV-3). These are the exact IMPORT_ENTITY_ORDER tables; any other
 * value — including an untrusted string supplied by the renderer and a null
 * context — is rendered as the static `unknown` label. No untrusted string
 * is ever interpolated into a summary.
 */
const SUMMARY_TABLE_ALLOWLIST: ReadonlySet<string> = new Set<string>(IMPORT_ENTITY_ORDER)

/**
 * Fixed production data-plane rejection codes (LOCK-PRIV-10). The allowlist
 * is typed against {@link ImportDataPlaneErrorCode} so every member is one
 * of the exact production codes; any other value — including an untrusted
 * string supplied by a hostile subclass or Proxy — is rendered as the static
 * UNKNOWN label. No arbitrary string is ever interpolated into a summary.
 */
const DATA_PLANE_ERROR_CODE_ALLOWLIST: ReadonlySet<ImportDataPlaneErrorCode> = new Set<ImportDataPlaneErrorCode>([
  'UNKNOWN_TABLE',
  'ENTITY_ORDER_VIOLATION',
  'INVALID_ROW',
  'DUPLICATE_RELATION',
  'OWNERSHIP_MISMATCH',
  'MISSING_BLOCKS',
  'TARGET_COLLISION',
  'FINALIZED',
  'NOT_FINALIZED'
])

/** Static label rendered for any code not in the fixed production allowlist. */
const UNKNOWN_DATA_PLANE_ERROR_CODE = 'UNKNOWN'

/**
 * LOCK-PRIV-10: bound a data-plane rejection code to the fixed
 * {@link ImportDataPlaneErrorCode} allowlist or the static UNKNOWN label.
 * Never interpolates an untrusted string.
 */
export function boundDataPlaneErrorCode(
  code: unknown
): ImportDataPlaneErrorCode | typeof UNKNOWN_DATA_PLANE_ERROR_CODE {
  return typeof code === 'string' && DATA_PLANE_ERROR_CODE_ALLOWLIST.has(code as ImportDataPlaneErrorCode)
    ? (code as ImportDataPlaneErrorCode)
    : UNKNOWN_DATA_PLANE_ERROR_CODE
}

/**
 * Bounded, privacy-safe summary of a data-plane rejection (LOCK-PRIV-2/3/10).
 *
 * Intended for the import orchestration log boundary (`session.fail`) and
 * the renderer IPC acknowledgement boundary (`callbackFailure`). It exposes
 * ONLY the machine error code plus the bounded source table name — never
 * entityId, source/target IDs, `error.detail`, paths, content, SQL, stack,
 * or the raw `error.message`. The reason-family context is the error code
 * itself, and LOCK-PRIV-10 guarantees the summary code is one fixed
 * {@link ImportDataPlaneErrorCode} member or the static UNKNOWN label —
 * an arbitrary or oversized hostile `code` string degrades to UNKNOWN.
 */
export function summarizeDataPlaneRejection(error: ChatImportDataPlaneError): string {
  // LOCK-PRIV-7: property reads are guarded — a hostile subclass with a
  // throwing `code`/`tableName` getter degrades to static fallbacks instead
  // of throwing the boundary. LOCK-PRIV-10: the code is re-bounded through
  // the fixed production allowlist, so even a benign-looking but arbitrary
  // `code` string renders as static UNKNOWN. `tableName` renders as
  // `unknown` unless it is a fixed production table.
  const table = readBoundString(error, 'tableName')
  const tableLabel = table !== null && SUMMARY_TABLE_ALLOWLIST.has(table) ? table : 'unknown'
  const code = boundDataPlaneErrorCode(readBoundString(error, 'code'))
  return `DATA_PLANE_REJECTION(${code}, table=${tableLabel})`
}

/**
 * LOCK-PRIV-7: guarded read of a sanitizer property, returning the value
 * only when it is a string. A hostile getter or Proxy trap degrades to null.
 */
function readBoundString(value: object, key: string): string | null {
  try {
    const raw = (value as Record<string, unknown>)[key]
    return typeof raw === 'string' ? raw : null
  } catch {
    return null
  }
}

/**
 * Bounds for the data-plane rejection tree search (LOCK-PRIV-4/8).
 *
 * Conservative: a rejection nested deeper than 8 cause/aggregate levels, or
 * reachable only beyond 32 dequeued nodes, is treated as NOT found and falls
 * back to the stable generic failure path. The bounds make the search
 * terminate deterministically regardless of adversarial tree shapes (deep
 * chains, wide aggregate fan-out, cycles, sparse/huge arrays). The node
 * budget is a REAL resource bound (LOCK-PRIV-8): it is decremented for every
 * dequeued node and children are enumerated/enqueued at most up to the
 * remaining budget — never more.
 */
const REJECTION_TREE_MAX_DEPTH = 8
const REJECTION_TREE_MAX_NODES = 32

/**
 * LOCK-PRIV-4/7/8: find the first deterministic data-plane rejection inside
 * an error tree.
 *
 * Searches the failure value's tree — Error.cause chains and
 * AggregateError.errors arrays — breadth-first, cycle-safe via a visited
 * set, bounded by depth and dequeued-node count. Unknown values are never
 * stringified during traversal. Every proxy-sensitive operation is guarded
 * (LOCK-PRIV-7): the `instanceof` check and every structural read
 * (`cause`, `errors`, array length, array index) is wrapped so a revoked
 * proxy, hostile getter, throwing iterator, or hostile Proxy trap can never
 * throw the search — an unsafe inspection degrades to "no such property"
 * and the search continues past it as a leaf. Children are enumerated and
 * enqueued ONLY up to the remaining node budget (LOCK-PRIV-8): sparse or
 * huge `errors` arrays and throwing iterators cannot cause unbounded work.
 * The first data-plane rejection in BFS order deterministically defines the
 * code/table summary.
 */
export function findDataPlaneRejection(root: unknown): ChatImportDataPlaneError | null {
  const visited = new Set<object>()
  const queue: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }]
  let budget = REJECTION_TREE_MAX_NODES
  let head = 0
  while (head < queue.length && budget > 0) {
    const { node, depth } = queue[head++]
    budget -= 1
    if (isDataPlaneRejectionInstance(node)) {
      return node
    }
    if (depth >= REJECTION_TREE_MAX_DEPTH || typeof node !== 'object' || node === null) {
      continue
    }
    if (visited.has(node)) {
      continue
    }
    visited.add(node)
    const nextDepth = depth + 1
    const cause = readErrorTreeProperty(node, 'cause')
    if (cause !== undefined && budget > 0) {
      queue.push({ node: cause, depth: nextDepth })
    }
    const errors = readErrorTreeProperty(node, 'errors')
    if (errors !== undefined && budget > 0) {
      // LOCK-PRIV-8: never enumerate/enqueue more children than the
      // remaining budget. Length and index reads are guarded so hostile
      // proxies/iterators degrade to zero entries instead of throwing.
      const entryCount = readBoundedArrayLength(errors, budget)
      for (let i = 0; i < entryCount; i += 1) {
        const entry = readArrayEntryAt(errors, i)
        if (entry !== undefined) {
          queue.push({ node: entry, depth: nextDepth })
        }
      }
    }
  }
  return null
}

/**
 * LOCK-PRIV-7: guarded `instanceof` used by the error-tree search. A
 * revoked/hostile proxy throws on `instanceof` (its getPrototypeOf trap) —
 * treated as "not a data-plane rejection" so the search never throws.
 */
function isDataPlaneRejectionInstance(value: unknown): value is ChatImportDataPlaneError {
  try {
    return value instanceof ChatImportDataPlaneError
  } catch {
    return false
  }
}

/**
 * Guarded structural read used by the error-tree search (LOCK-PRIV-4/7).
 * A hostile getter or Proxy trap throws → treated as "no such property" so
 * the search always terminates. Never stringifies the value.
 */
function readErrorTreeProperty(target: object, key: 'cause' | 'errors'): unknown {
  try {
    return (target as { cause?: unknown; errors?: unknown })[key]
  } catch {
    return undefined
  }
}

/**
 * LOCK-PRIV-8: bounded read of an `errors`-like array's effective entry
 * count. The value is accepted only when `Array.isArray` succeeds, the
 * `length` read is guarded, and the returned count is capped at the
 * remaining node budget — a sparse or huge array can never force more than
 * `cap` enumeration steps.
 */
function readBoundedArrayLength(value: unknown, cap: number): number {
  // LOCK-PRIV-7: `Array.isArray` is guarded too — on a revoked proxy it
  // throws (its [[ProxyTarget]] is no longer reachable), which must degrade
  // to zero entries instead of throwing the sanitizer.
  let isArray: boolean
  try {
    isArray = Array.isArray(value)
  } catch {
    return 0
  }
  if (!isArray) {
    return 0
  }
  let length: unknown
  try {
    length = (value as unknown[]).length
  } catch {
    return 0
  }
  if (typeof length !== 'number' || !Number.isFinite(length) || length <= 0) {
    return 0
  }
  return Math.min(length, cap)
}

/**
 * LOCK-PRIV-7/8: guarded read of one `errors` array index. A hostile Proxy
 * get trap or a throwing getter degrades to `undefined` (a sparse hole is
 * also `undefined`) so the search never throws and never iterates a value.
 */
function readArrayEntryAt(value: unknown, index: number): unknown {
  try {
    return (value as unknown[])[index]
  } catch {
    return undefined
  }
}

/**
 * LOCK-PRIV-5: single summary decision for the logging and IPC
 * acknowledgement boundaries.
 *
 * If the error tree contains a data-plane rejection (found via
 * findDataPlaneRejection), ONLY the bounded code/table summary is used —
 * wrapper and raw messages never leak. If no data-plane rejection is
 * present, the existing stable generic-error behavior is preserved for
 * trusted Main-origin values (Error.message, else String(value)) — but the
 * fallback is TOTAL and bounded (LOCK-PRIV-7/9): every read is guarded and
 * any unsafe inspection degrades to a static generic label without
 * String(value). Renderer-origin reports are bounded separately at their
 * call sites (LOCK-PRIV-6), never through this generic path.
 */
export function summarizeDataPlaneFailure(error: unknown): string {
  const rejection = findDataPlaneRejection(error)
  if (rejection !== null) {
    return summarizeDataPlaneRejection(rejection)
  }
  return genericFailureMessage(error)
}

/**
 * Static generic failure label used whenever the generic fallback cannot be
 * read safely (revoked/hostile proxy, throwing getter, throwing
 * Symbol.toPrimitive) — LOCK-PRIV-7.
 */
const GENERIC_FAILURE_LABEL = 'unknown import failure'

/** Maximum length of a retained generic error message (LOCK-PRIV-7 bounded). */
const GENERIC_MESSAGE_MAX_LENGTH = 512

/** Truncate a string to {@link GENERIC_MESSAGE_MAX_LENGTH} with an ellipsis. */
function boundText(text: string): string {
  if (text.length <= GENERIC_MESSAGE_MAX_LENGTH) {
    return text
  }
  return `${text.slice(0, GENERIC_MESSAGE_MAX_LENGTH - 1)}…`
}

/**
 * LOCK-PRIV-7/9: stable, total generic-error fallback for trees WITHOUT a
 * data-plane rejection. Retains the pre-existing Error.message /
 * String(value) behavior for trusted Main-origin values — strings and other
 * primitives keep String(value), genuine Errors keep their message — but
 * every proxy-sensitive read (instanceof, `.message`) is guarded and the
 * returned text is length-bounded. Arbitrary OBJECTS (including arrays,
 * hostile proxies, and values with throwing Symbol.toPrimitive) degrade to
 * the static generic label without String(value): their stringification
 * could invoke hostile user code or embed nested error messages. Unsafe
 * inspection always degrades to the static label instead of throwing.
 */
function genericFailureMessage(error: unknown): string {
  if (typeof error === 'string') {
    return boundText(error)
  }
  if (typeof error === 'object' || typeof error === 'function') {
    // Genuine Errors keep their message (LOCK-PRIV-9). Everything else —
    // objects, arrays, proxies — degrades to the static label: never String().
    if (error !== null) {
      let message: unknown
      try {
        message = error instanceof Error ? error.message : undefined
      } catch {
        return GENERIC_FAILURE_LABEL
      }
      return typeof message === 'string' ? boundText(message) : GENERIC_FAILURE_LABEL
    }
  }
  // Primitives keep the pre-existing String() fallback (guarded + bounded).
  try {
    return boundText(String(error))
  } catch {
    return GENERIC_FAILURE_LABEL
  }
}

// ---------------------------------------------------------------------------
// Renderer-controlled value bounding (LOCK-PRIV-6)
// ---------------------------------------------------------------------------

/** Static label rendered for any table name not in the fixed allowlist. */
const UNKNOWN_TABLE_LABEL = 'unknown'

/**
 * LOCK-PRIV-6: bound a renderer-supplied table name to a fixed allowlisted
 * production label or the static `unknown` label. No renderer-controlled
 * table name or discovery table entry may ever be interpolated into a log —
 * callers use this helper at every direct log site.
 */
export function boundImportTableLabel(tableName: unknown): string {
  return typeof tableName === 'string' && SUMMARY_TABLE_ALLOWLIST.has(tableName) ? tableName : UNKNOWN_TABLE_LABEL
}

/**
 * LOCK-PRIV-6: fixed renderer-origin error code family. These are the only
 * codes the import renderer can legitimately report, plus the Main-origin
 * RENDERER_GONE render-process-gone signal. Any other value — including an
 * untrusted string supplied by the renderer — renders as the static UNKNOWN
 * label.
 */
const RENDERER_ERROR_CODE_ALLOWLIST: ReadonlySet<string> = new Set([
  'WRONG_ORIGIN',
  'DISCOVERY_REJECTED',
  'DISCOVERY_FAILED',
  'READPAGE_REJECTED',
  'READ_FAILED',
  'RENDERER_GONE'
])

const UNKNOWN_RENDERER_ERROR_CODE = 'UNKNOWN'

/**
 * LOCK-PRIV-6: bound a renderer-supplied error code to the fixed allowlisted
 * family or the static UNKNOWN label. Never interpolates an untrusted string.
 */
export function boundRendererErrorCode(code: unknown): string {
  return typeof code === 'string' && RENDERER_ERROR_CODE_ALLOWLIST.has(code) ? code : UNKNOWN_RENDERER_ERROR_CODE
}

/**
 * LOCK-PRIV-6: bounded summary of a renderer-reported error payload for the
 * log boundary. Exposes ONLY the allowlisted code/reason family — the
 * renderer-controlled `message` is never interpolated. Static text only.
 */
export function summarizeRendererError(error: { code?: unknown; message?: unknown }): string {
  return `RENDERER_ERROR(${boundRendererErrorCode(error.code)})`
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Main-only normalization accounting (LOCK-OWN-1/2, LOCK-BLOCK-1/1X,
 * LOCK-ASK-2, LOCK-SEG-1, LOCK-STAT-1).
 *
 * Counts ONLY — never IDs, names, message content, paths, or source values.
 * `topicIdNormalizationCount` is the number of PRESENT valid non-empty
 * embedded `message.topicId` values that differed from the authoritative
 * outer `topic.id` and were canonicalized during L2 topic/message
 * projection. `unreachableBlockSkipCount` is the number of source
 * `message_blocks` rows skipped at the projection boundary because their
 * block id was referenced by no imported message AND their claimed
 * `messageId` existed in no imported message (LOCK-BLOCK-1).
 * `skippedExistingOwnerUnembeddedBlockCount` is the number of source
 * `message_blocks` rows skipped because their block id was referenced by
 * no imported message AND their claimed legacy `messageId` resolved to
 * exactly one imported source occurrence (LOCK-BLOCK-1X, prevents
 * reconstruction resurrection). `danglingAskIdPreservedCount` is the number
 * of committed messages whose non-empty askId did not resolve to a
 * same-topic source occurrence and was preserved verbatim (LOCK-ASK-1/2).
 * `skippedSegmentRowCount` / `skippedSegmentMembershipCount` count committed
 * skipped segment rows and their memberships when the segment's topic was
 * absent and every member legacy ID resolved to no imported occurrence
 * anywhere (LOCK-SEG-1). Every field uses committed-page semantics
 * (LOCK-D9/LOCK-STAT-1): the aggregate advances only after a page's
 * candidate transaction commits; a rolled-back or rejected page never leaks
 * its delta. Main-only — never exposed over IPC/shared types.
 */
export interface DataPlaneNormalizationStats {
  readonly topicIdNormalizationCount: number
  readonly unreachableBlockSkipCount: number
  readonly skippedExistingOwnerUnembeddedBlockCount: number
  readonly danglingAskIdPreservedCount: number
  readonly skippedSegmentRowCount: number
  readonly skippedSegmentMembershipCount: number
}

/** Bounded per-block index entry (LOCK-D4/REF-1). Values kept minimal. */
interface BlockOwnerEntry {
  /** Legacy source message id — the row claim must match this. */
  legacyMessageId: string
  /** Outer topic of the owning message occurrence. */
  topicId: string
  /** Deterministic target id of the owning message occurrence (LOCK-MID-1). */
  targetId: string
  sortOrder: number
  seen: boolean
}

/** Segment membership staged for the page transaction. */
interface StagedMembership {
  segmentId: string
  messageIds: string[]
}

/**
 * Fully validated/projected page, plus the relation-index deltas that must
 * only be merged into the streaming indexes after a successful commit.
 */
interface StagedPage {
  topics: TopicData[]
  messages: MessageData[]
  blocks: MessageBlockData[]
  fileReferences: FileReferenceData[]
  segments: TopicSegmentData[]
  memberships: StagedMembership[]
  /** Index deltas (merged post-commit only). */
  newTopicIds: string[]
  /**
   * IndexedDB-authoritative deletedAt per staged topic id (LOCK-PROD-3).
   * Merged post-commit into the projection facts registry.
   */
  newTopicDeletedAt: Array<[string, string | null]>
  newBlockOwners: Array<[string, BlockOwnerEntry]>
  seenBlockIds: string[]
  newSegmentIds: string[]
  membershipRowCount: number
  /**
   * Every source `message_blocks` row id in this page — imported AND
   * skipped orphans (LOCK-BLOCK-1/1X). Merged post-commit into the separate
   * source-seen registry so duplicate source block rows across all
   * pages (including skipped ones) always reject.
   */
  sourceSeenBlockIds: string[]
  /**
   * Canonicalized embedded-message topicId count staged for this page
   * (LOCK-OWN-1). Merged into the aggregate only on commit, exactly like
   * the relation-index deltas (LOCK-D9).
   */
  topicIdNormalizationCount: number
  /**
   * Unreachable orphan `message_blocks` rows skipped at the projection
   * boundary for this page (LOCK-BLOCK-1). Merged into the aggregate only
   * on commit, exactly like the relation-index deltas (LOCK-D9).
   */
  orphanBlockSkipCount: number
  /**
   * Existing-owner unembedded `message_blocks` rows skipped at the
   * projection boundary for this page (LOCK-BLOCK-1X): block id in no
   * message.blocks[] AND claimed legacy messageId resolving to exactly one
   * imported occurrence. Committed-page semantics (LOCK-D9/LOCK-STAT-1).
   */
  existingOwnerUnembeddedBlockSkipCount: number
  /**
   * Message occurrence tuples committed on this page:
   * [outerTopicId, legacyMessageId]. Merged post-commit for same-tuple
   * duplicate detection across pages (LOCK-MID-3).
   */
  newMessageTuples: Array<[string, string]>
  /**
   * Legacy occurrence index deltas for this page (LOCK-ORPH-1):
   * [legacyMessageId, {topicId, targetId}]. Merged post-commit into the
   * legacy occurrence index used by orphan/segment classification.
   */
  newLegacyOccurrences: Array<[string, { topicId: string; targetId: string }]>
  /**
   * Target-ID → occurrence deltas for this page (LOCK-MID-3): enables the
   * derived-collision check and the finalize askId target-set.
   */
  newMessageTargets: Array<[string, { topicId: string; legacyId: string }]>
  /**
   * Preserved dangling askId values on messages committed this page
   * (LOCK-ASK-1/2). Values are non-empty JSON-safe strings; merged
   * post-commit and checked against the target-ID set at finalize.
   */
  newPreservedDanglingAskIds: string[]
  /**
   * Dangling askId messages committed on this page (LOCK-ASK-2). Merged
   * into the aggregate only on commit (LOCK-D9/LOCK-STAT-1).
   */
  danglingAskIdPreservedCount: number
  /**
   * Segment rows skipped this page (LOCK-SEG-1): topic absent AND every
   * member legacy ID unresolvable anywhere. Committed-page semantics.
   */
  skippedSegmentRowCount: number
  /** Memberships of the skipped segment rows (LOCK-SEG-1). */
  skippedSegmentMembershipCount: number
}

function emptyStagedPage(): StagedPage {
  return {
    topics: [],
    messages: [],
    blocks: [],
    fileReferences: [],
    segments: [],
    memberships: [],
    newTopicIds: [],
    newTopicDeletedAt: [],
    newBlockOwners: [],
    seenBlockIds: [],
    newSegmentIds: [],
    membershipRowCount: 0,
    sourceSeenBlockIds: [],
    topicIdNormalizationCount: 0,
    orphanBlockSkipCount: 0,
    existingOwnerUnembeddedBlockSkipCount: 0,
    newMessageTuples: [],
    newLegacyOccurrences: [],
    newMessageTargets: [],
    newPreservedDanglingAskIds: [],
    danglingAskIdPreservedCount: 0,
    skippedSegmentRowCount: 0,
    skippedSegmentMembershipCount: 0
  }
}

// ---------------------------------------------------------------------------
// Field sets
// ---------------------------------------------------------------------------

/** Promoted segment columns; everything else except messageIds → overflow (LOCK-D6). */
const SEGMENT_FIELDS = new Set(['id', 'topicId', 'name', 'createdAt', 'updatedAt'])

// ---------------------------------------------------------------------------
// Row-level validation helpers
// ---------------------------------------------------------------------------

interface RowContext {
  tableName: string
  index: number
  entityId?: string
}

function rowLabel(ctx: RowContext): string {
  return ctx.entityId !== undefined
    ? `${ctx.tableName}[${ctx.index}] (id=${ctx.entityId})`
    : `${ctx.tableName}[${ctx.index}]`
}

/**
 * Canonical, unambiguous pair key for the source identity tuple
 * `(outerTopicId, legacyMessageId)` (LOCK-MID-1). JSON encoding is exact
 * for every JSON-safe string pair (no separator-injection ambiguity).
 */
function tupleKey(outerTopicId: string, legacyMessageId: string): string {
  return JSON.stringify([outerTopicId, legacyMessageId])
}

function invalidRow(ctx: RowContext, detail: string): ChatImportDataPlaneError {
  return new ChatImportDataPlaneError('INVALID_ROW', `${rowLabel(ctx)}: ${detail}`, {
    tableName: ctx.tableName,
    entityId: ctx.entityId
  })
}

/** Require a plain object; reject arrays/null/primitives. */
function requirePlainObject(value: unknown, ctx: RowContext): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidRow(ctx, 'expected a plain object')
  }
  return value as JsonObject
}

/** Require a JSON-safe plain object (contextual wrapper over shared validation). */
function requireJsonSafeObject(value: unknown, ctx: RowContext): JsonObject {
  const obj = requirePlainObject(value, ctx)
  try {
    validateJsonObject(obj, rowLabel(ctx))
  } catch (error) {
    if (error instanceof ValidationError) {
      throw invalidRow(ctx, `not JSON-safe: ${error.message}`)
    }
    throw error
  }
  return obj
}

/**
 * LOCK-LB-3/4: require a plain object that satisfies the named block-specific
 * JSON profile (per-string 8 MiB, per-row 16 MiB) and charge the page-level
 * aggregate budget (64 MiB) for EVERY incoming `message_blocks` row —
 * including rows later skipped as orphans/unembedded residuals. The page
 * accountant is created fresh per page and thrown away on rejection, so a
 * rolled-back page leaks no aggregate state (LOCK-LB-4).
 */
function requireBlockProfileSafeObject(
  value: unknown,
  ctx: RowContext,
  pageBytes: { rowBytes: number; aggregateBytes: number }
): JsonObject {
  const obj = requirePlainObject(value, ctx)
  try {
    validateJsonObjectBlock(obj, rowLabel(ctx), BLOCK_JSON_PROFILE, pageBytes)
  } catch (error) {
    if (error instanceof ValidationError) {
      throw invalidRow(ctx, `not block-profile JSON-safe: ${error.message}`)
    }
    throw error
  }
  return obj
}

/** Require a non-empty string field. */
function requireNonEmptyString(obj: JsonObject, field: string, ctx: RowContext): string {
  const value = obj[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidRow(ctx, `field '${field}' must be a non-empty string (got ${describeValue(value)})`)
  }
  return value
}

/** Optional string field: missing/null → null; any other non-string rejects. */
function optionalNullableString(obj: JsonObject, field: string, ctx: RowContext): string | null {
  const value = obj[field]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw invalidRow(ctx, `field '${field}' must be a string or null (got ${describeValue(value)})`)
  }
  return value
}

/** Unique array of non-empty strings. Empty array allowed. */
function requireUniqueStringArray(value: unknown, field: string, ctx: RowContext): string[] {
  if (!Array.isArray(value)) {
    throw invalidRow(ctx, `field '${field}' must be an array (got ${describeValue(value)})`)
  }
  const seen = new Set<string>()
  for (let i = 0; i < value.length; i++) {
    const entry = value[i]
    if (typeof entry !== 'string' || entry.length === 0) {
      throw invalidRow(ctx, `field '${field}'[${i}] must be a non-empty string (got ${describeValue(entry)})`)
    }
    if (seen.has(entry)) {
      throw invalidRow(ctx, `field '${field}' contains duplicate id '${entry}'`)
    }
    seen.add(entry)
  }
  return value as string[]
}

function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

// ---------------------------------------------------------------------------
// ChatImportDataPlane
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ChatImportDataPlane construction options (LOCK-TRASH-2/3)
// ---------------------------------------------------------------------------

/**
 * Optional construction options for {@link ChatImportDataPlane}.
 */
export interface ChatImportDataPlaneOptions {
  /**
   * LOCK-TRASH-2: exactly one immutable retention baseline per import
   * operation/session, captured from the injectable Main clock by the
   * orchestrator. All topics of that import share the identical canonical
   * string. When absent (legacy/no-baseline mode) no marker is written.
   */
  readonly l2TrashRetentionBaseline?: string
}

/**
 * Streaming page-to-candidate converter. One instance per import session.
 *
 * Usage:
 *   const plane = createImportDataPlane(candidateDrizzleDb)
 *   plane.processPage(pageResponse)   // once per ReadPageResponse
 *   ...
 *   const { sourceReadStats, candidateImportStats } = plane.finalize()
 */
export class ChatImportDataPlane {
  private readonly db: BetterSQLite3Database<any>

  /**
   * LOCK-TRASH-2/3/5: importer-owned immutable retention baseline injected
   * into every projected soft-deleted topic BEFORE source-manifest staging
   * and candidate write. `undefined` disables marker injection (legacy mode).
   * Strict-canonical validated at construction (LOCK-TRASH-5).
   */
  private readonly l2TrashRetentionBaseline: string | undefined

  // Streaming relation indexes (LOCK-D4). Values kept minimal.
  private readonly topicIds = new Set<string>()
  /**
   * IndexedDB-authoritative deletedAt per imported topic id (LOCK-PROD-3).
   * Populated at commit time; exposed via getImportedTopicFacts() for the
   * L2 navigation projection join.
   */
  private readonly topicDeletedById = new Map<string, string | null>()
  /**
   * Committed same-tuple occurrence set (LOCK-MID-3): canonical tuple keys
   * of every committed occurrence. Merged only after a successful page
   * commit so same-tuple duplicate detection is traversal-order independent
   * and transactional (a rolled-back page never poisons the set).
   */
  private readonly committedMessageTuples = new Set<string>()
  /**
   * Committed tuple → target ID (LOCK-MID-1). Enables same-topic askId
   * resolution and segment membership resolution.
   */
  private readonly committedTupleToTarget = new Map<string, string>()
  /**
   * Legacy occurrence index (LOCK-ORPH-1): legacyMessageId → committed
   * occurrences [{topicId, targetId}]. Orphan/segment classification uses
   * THIS legacy index — never target IDs. All occurrences of one topic
   * arrive in a single topics page, so this is complete before any
   * message_blocks/topic_segments page is processed (LOCK-D1 order).
   */
  private readonly legacyOccurrencesById = new Map<string, Array<{ topicId: string; targetId: string }>>()
  /**
   * Target ID → source tuple (LOCK-MID-3). Enables the derived-collision
   * detection during projection and the finalize askId target-set check.
   */
  private readonly targetByOccurrence = new Map<string, { topicId: string; legacyId: string }>()
  /**
   * Preserved dangling askId values on COMMITTED messages (LOCK-ASK-1).
   * The values are checked against the full target-ID set at finalize
   * (LOCK-ASK-1 post-map collision rejection).
   */
  private readonly preservedDanglingAskIds = new Set<string>()
  private readonly blockOwnerById = new Map<string, BlockOwnerEntry>()
  private readonly segmentIds = new Set<string>()

  /**
   * Source-seen block id registry (LOCK-BLOCK-1). Records EVERY source
   * `message_blocks` row id observed on a COMMITTED page — imported AND
   * skipped orphans — so duplicate source block rows reject across all
   * rows/pages. Transactional like the relation indexes: merged only after
   * a successful page commit, so a failed page never poisons the registry
   * and a retry of the same rows remains valid.
   */
  private readonly sourceSeenBlockIds = new Set<string>()

  /**
   * Current entity-order position (LOCK-D1/ORDER-1). -1 means no table has
   * been committed yet: the first page MUST be `topics` (index 0). After a
   * committed page the cursor is the committed table's index; a page may
   * repeat that index (pagination) or advance by exactly one.
   */
  private entityCursor = -1
  private finalized = false

  /**
   * Source verification evidence (LOCK-4301). Deltas are staged from the
   * target-equivalent StagedPage projections and committed ONLY after the
   * page's DB transaction succeeds. Frozen snapshot cached at finalize().
   */
  private readonly manifestBuilder = new SourceVerificationManifestBuilder()
  private sourceManifest: SourceVerificationManifest | null = null

  // Stats accumulators — mutated only after successful page commit (LOCK-D9).
  private readonly sourceStats: SourceReadStats = {
    topicRecordCount: 0,
    blockRecordCount: 0,
    segmentRecordCount: 0,
    sourceFileRecordCount: 0
  }
  private readonly candidateStats: CandidateImportStats = {
    topicCount: 0,
    messageCount: 0,
    blockCount: 0,
    segmentCount: 0,
    segmentMembershipCount: 0,
    fileReferenceCount: 0,
    pageCount: 0,
    elapsedMs: 0
  }

  // Main-only normalization accounting (LOCK-OWN-1/2, LOCK-BLOCK-1/2).
  // Mutated ONLY in commitStaged, after a successful page commit (LOCK-D9
  // semantics) — a rejected/rolled-back page never advances the aggregate.
  // The private shape is deliberately mutable; getNormalizationStats()
  // exposes the readonly {@link DataPlaneNormalizationStats} contract.
  private readonly normalizationStats: {
    topicIdNormalizationCount: number
    unreachableBlockSkipCount: number
    skippedExistingOwnerUnembeddedBlockCount: number
    danglingAskIdPreservedCount: number
    skippedSegmentRowCount: number
    skippedSegmentMembershipCount: number
  } = {
    topicIdNormalizationCount: 0,
    unreachableBlockSkipCount: 0,
    skippedExistingOwnerUnembeddedBlockCount: 0,
    danglingAskIdPreservedCount: 0,
    skippedSegmentRowCount: 0,
    skippedSegmentMembershipCount: 0
  }

  /**
   * @param db  Already initialized Drizzle candidate DB (LOCK-D11). The data
   *            plane never initializes, seals, or discards this resource.
   * @param options  Optional L2 trash retention baseline (LOCK-TRASH-2/5).
   *            A present baseline must satisfy the strict canonical UTC ISO
   *            check — the orchestrator generates it via
   *            generateL2TrashRetentionBaseline, which is canonical by
   *            construction.
   * @throws {Error} when a provided baseline is not strict canonical
   *         (programming-error seam, fixed context — never a source row).
   */
  constructor(db: BetterSQLite3Database<any>, options?: ChatImportDataPlaneOptions) {
    this.db = db
    const baseline = options?.l2TrashRetentionBaseline
    if (baseline !== undefined) {
      // LOCK-TRASH-5: reject an ill-formed baseline at construction so a
      // marker that fails strict validation can never reach projection.
      if (!isValidL2TrashRetentionMarker(baseline)) {
        throw new Error('Invalid L2 trash retention baseline: must be a strict canonical UTC ISO timestamp.')
      }
      this.l2TrashRetentionBaseline = baseline
    }
  }

  /**
   * Process one ReadPageResponse as one outer candidate DB transaction
   * (LOCK-D8). Validation is performed before any write; database constraint
   * failures inside the transaction roll back every row of the page.
   *
   * LOCK-ORDER-1: the page's table must be contiguous with the committed
   * stream — repeat the current table (pagination) or advance exactly one
   * table in IMPORT_ENTITY_ORDER. Forward jumps over required entities and
   * backward moves reject before any projection/write.
   *
   * Indexes and stats are updated only after the page commits (LOCK-D9).
   *
   * @throws {ChatImportDataPlaneError} on any validation/ownership rejection.
   */
  processPage(response: ReadPageResponse): void {
    if (this.finalized) {
      throw new ChatImportDataPlaneError('FINALIZED', 'processPage called after finalize()')
    }

    const entity = this.resolveEntity(response.tableName)
    const entityIndex = IMPORT_ENTITY_ORDER.indexOf(entity)
    // LOCK-ORDER-1: contiguous table order. A page may repeat the current
    // table (pagination) or advance exactly one table in IMPORT_ENTITY_ORDER
    // — it can never jump forward over a required entity or move backward.
    if (entityIndex !== this.entityCursor && entityIndex !== this.entityCursor + 1) {
      const detail =
        entityIndex < this.entityCursor
          ? `page for '${entity}' arrived after '${IMPORT_ENTITY_ORDER[this.entityCursor]}' pages started (backward move)`
          : `page for '${entity}' jumped forward over required table '${IMPORT_ENTITY_ORDER[this.entityCursor + 1]}'`
      throw new ChatImportDataPlaneError(
        'ENTITY_ORDER_VIOLATION',
        `${detail}; expected contiguous order: ${IMPORT_ENTITY_ORDER.join(' → ')}`,
        { tableName: response.tableName }
      )
    }

    // Phase 1 — pure validation + projection. No writes happen before this
    // completes, so any rejection leaves the candidate DB untouched.
    // LOCK-LB-9: defense-in-depth ingress cap for `message_blocks` pages —
    // an oversized page is rejected BEFORE projector iteration, so it
    // produces no stats/index/manifest/writes. Normal renderer page size
    // remains 500; MAX_ARRAY_LENGTH is the shared 100k wire cap.
    if (entity === 'message_blocks' && response.items.length > MAX_ARRAY_LENGTH) {
      throw new ChatImportDataPlaneError(
        'INVALID_ROW',
        `message_blocks page contains ${response.items.length} rows, exceeding the maximum (${MAX_ARRAY_LENGTH})`
      )
    }
    const staged = this.projectPage(entity, response.items)

    // Phase 1b — stage the source-evidence delta from the target-equivalent
    // projections (LOCK-4301). Pure: builder state is untouched, so a
    // failing transaction below simply drops the delta.
    const manifestDelta = this.manifestBuilder.stagePageDelta({
      entity,
      topics: staged.topics,
      messages: staged.messages,
      blocks: staged.blocks,
      fileReferences: staged.fileReferences,
      segments: staged.segments,
      memberships: staged.memberships,
      sourceRowCount: response.items.length
    })

    // Phase 2 — one outer transaction per page (LOCK-D8). No nested
    // transactions; the writer runs directly on the provided executor.
    this.db.transaction((tx) => {
      const writer = createImportWriter(tx as BetterSQLite3Database<any>)
      if (staged.topics.length > 0) writer.insertTopics(staged.topics)
      if (staged.messages.length > 0) writer.insertMessages(staged.messages)
      if (staged.blocks.length > 0) writer.insertBlocks(staged.blocks)
      if (staged.fileReferences.length > 0) writer.insertFileReferences(staged.fileReferences)
      if (staged.segments.length > 0) writer.insertSegments(staged.segments)
      for (const membership of staged.memberships) {
        writer.insertSegmentMembership(membership.segmentId, membership.messageIds)
      }
    })

    // Phase 3 — merge index deltas + stats + evidence only after a
    // successful commit (LOCK-D9, LOCK-4301).
    this.commitStaged(entity, staged, response.items.length)
    this.manifestBuilder.commitPageDelta(manifestDelta)
    this.entityCursor = entityIndex
  }

  /**
   * End-of-stream check (LOCK-D10, LOCK-ASK-1):
   * - Rejects any block ID referenced by an imported message that was never
   *   observed in a `message_blocks` page.
   * - After ALL target IDs are known, strictly rejects any preserved
   *   dangling askId value that equals a target message ID (LOCK-ASK-1
   *   post-map collision rejection). Count-only detail — never the values.
   *
   * Does NOT run Phase 4.3 integrity/hash verification.
   *
   * @returns Non-aliased stats snapshots.
   * @throws {ChatImportDataPlaneError} code MISSING_BLOCKS when references
   *         dangle; code TARGET_COLLISION on a preserved-dangling askId
   *         colliding with a target message ID.
   */
  finalize(): { sourceReadStats: SourceReadStats; candidateImportStats: CandidateImportStats } {
    const missing: string[] = []
    for (const [blockId, entry] of this.blockOwnerById) {
      if (!entry.seen) missing.push(blockId)
    }
    if (missing.length > 0) {
      const preview = missing.slice(0, 10).join(', ')
      const suffix = missing.length > 10 ? `, … (${missing.length} total)` : ''
      throw new ChatImportDataPlaneError(
        'MISSING_BLOCKS',
        `${missing.length} referenced block ID(s) never appeared in message_blocks: ${preview}${suffix}`
      )
    }

    // LOCK-ASK-1 post-map collision rejection: now that every target ID is
    // known, a preserved dangling askId value that equals a target message
    // ID would create a false relation — reject strictly. Count-only detail.
    if (this.preservedDanglingAskIds.size > 0) {
      let collisions = 0
      for (const value of this.preservedDanglingAskIds) {
        if (this.targetByOccurrence.has(value)) collisions += 1
      }
      if (collisions > 0) {
        throw new ChatImportDataPlaneError(
          'TARGET_COLLISION',
          `${collisions} preserved dangling askId value(s) equal a target message ID ` +
            'after deterministic remapping; refusing to create a false relation (LOCK-ASK-1)'
        )
      }
    }

    this.finalized = true
    // Freeze the source evidence exactly once (LOCK-4301). The builder's
    // own exact-once guard makes double finalization impossible.
    if (this.sourceManifest === null) {
      this.sourceManifest = this.manifestBuilder.finalize()
    }
    return {
      sourceReadStats: this.getSourceReadStats(),
      candidateImportStats: this.getCandidateImportStats()
    }
  }

  /**
   * Deep-frozen source verification manifest (LOCK-4301). Main-only —
   * never expose over IPC. Available only after a successful finalize();
   * repeated calls return the same frozen snapshot.
   *
   * @throws {ChatImportDataPlaneError} code NOT_FINALIZED before finalize().
   */
  getSourceVerificationManifest(): SourceVerificationManifest {
    if (this.sourceManifest === null) {
      throw new ChatImportDataPlaneError(
        'NOT_FINALIZED',
        'getSourceVerificationManifest called before a successful finalize()'
      )
    }
    return this.sourceManifest
  }

  /** Snapshot of source-read accounting. New object per call (no aliasing). */
  getSourceReadStats(): SourceReadStats {
    return { ...this.sourceStats }
  }

  /** Snapshot of candidate construction accounting. New object per call (no aliasing). */
  getCandidateImportStats(): CandidateImportStats {
    return { ...this.candidateStats }
  }

  /**
   * Snapshot of Main-only normalization accounting (LOCK-OWN-1/2,
   * LOCK-BLOCK-1/1X/2, LOCK-ASK-2, LOCK-SEG-1, LOCK-STAT-1). New object
   * per call (no aliasing). Stable after finalize(): no further commits are
   * possible once the plane is finalized, so the counts can no longer
   * change. Main-only — never expose over IPC.
   */
  getNormalizationStats(): DataPlaneNormalizationStats {
    return { ...this.normalizationStats }
  }

  /**
   * IndexedDB-authoritative topic facts (id + deletedAt) for the L2
   * navigation projection join (LOCK-PROD-3). Snapshot, no aliasing.
   * Main-only — never expose over IPC. Only callable after a successful
   * finalize().
   *
   * @throws {ChatImportDataPlaneError} code NOT_FINALIZED before finalize().
   */
  getImportedTopicFacts(): Array<{ id: string; deletedAt: string | null }> {
    if (!this.finalized) {
      throw new ChatImportDataPlaneError('NOT_FINALIZED', 'getImportedTopicFacts called before a successful finalize()')
    }
    const facts: Array<{ id: string; deletedAt: string | null }> = []
    for (const [id, deletedAt] of this.topicDeletedById) {
      facts.push({ id, deletedAt })
    }
    return facts
  }

  // -------------------------------------------------------------------------
  // Internals — entity resolution + staged commit
  // -------------------------------------------------------------------------

  private resolveEntity(tableName: string): ImportEntityName {
    if ((IMPORT_ENTITY_ORDER as readonly string[]).includes(tableName)) {
      return tableName as ImportEntityName
    }
    throw new ChatImportDataPlaneError(
      'UNKNOWN_TABLE',
      `unknown source table '${tableName}'; expected one of: ${IMPORT_ENTITY_ORDER.join(', ')}`,
      { tableName }
    )
  }

  private commitStaged(entity: ImportEntityName, staged: StagedPage, sourceRowCount: number): void {
    for (const id of staged.newTopicIds) this.topicIds.add(id)
    for (const [topicId, deletedAt] of staged.newTopicDeletedAt) this.topicDeletedById.set(topicId, deletedAt)
    for (const [topicId, legacyId] of staged.newMessageTuples)
      this.committedMessageTuples.add(tupleKey(topicId, legacyId))
    // LOCK-MID-1: every committed tuple resolves to its deterministic target.
    for (const [topicId, legacyId] of staged.newMessageTuples) {
      const targetId = computeMessageTargetId(topicId, legacyId)
      this.committedTupleToTarget.set(tupleKey(topicId, legacyId), targetId)
      this.targetByOccurrence.set(targetId, { topicId, legacyId })
    }
    // LOCK-ORPH-1: legacy occurrence index (legacy id → committed occurrences).
    for (const [legacyId, occurrence] of staged.newLegacyOccurrences) {
      let list = this.legacyOccurrencesById.get(legacyId)
      if (!list) {
        list = []
        this.legacyOccurrencesById.set(legacyId, list)
      }
      list.push(occurrence)
    }
    // LOCK-ASK-1: preserved dangling values recorded on commit only.
    for (const value of staged.newPreservedDanglingAskIds) this.preservedDanglingAskIds.add(value)
    for (const [blockId, entry] of staged.newBlockOwners) this.blockOwnerById.set(blockId, entry)
    for (const blockId of staged.seenBlockIds) {
      const entry = this.blockOwnerById.get(blockId)
      if (entry) entry.seen = true
    }
    // Source-seen registry (LOCK-BLOCK-1): committed only after the page
    // transaction succeeded, covering imported AND skipped orphan rows.
    for (const blockId of staged.sourceSeenBlockIds) this.sourceSeenBlockIds.add(blockId)
    for (const id of staged.newSegmentIds) this.segmentIds.add(id)

    // Source-read accounting (LOCK-D9): successful source rows per entity.
    switch (entity) {
      case 'topics':
        this.sourceStats.topicRecordCount += sourceRowCount
        break
      case 'message_blocks':
        this.sourceStats.blockRecordCount += sourceRowCount
        break
      case 'topic_segments':
        this.sourceStats.segmentRecordCount += sourceRowCount
        break
      case 'files':
        this.sourceStats.sourceFileRecordCount += sourceRowCount
        break
    }

    // Candidate accounting: committed target rows only (LOCK-D9).
    this.candidateStats.topicCount += staged.topics.length
    this.candidateStats.messageCount += staged.messages.length
    this.candidateStats.blockCount += staged.blocks.length
    this.candidateStats.segmentCount += staged.segments.length
    this.candidateStats.segmentMembershipCount += staged.membershipRowCount
    this.candidateStats.fileReferenceCount += staged.fileReferences.length
    this.candidateStats.pageCount += 1

    // Normalization accounting (LOCK-OWN-1/2, LOCK-BLOCK-1/1X/2,
    // LOCK-ASK-2, LOCK-SEG-1, LOCK-STAT-1): merge the staged deltas only
    // now that the page transaction committed.
    this.normalizationStats.topicIdNormalizationCount += staged.topicIdNormalizationCount
    this.normalizationStats.unreachableBlockSkipCount += staged.orphanBlockSkipCount
    this.normalizationStats.skippedExistingOwnerUnembeddedBlockCount += staged.existingOwnerUnembeddedBlockSkipCount
    this.normalizationStats.danglingAskIdPreservedCount += staged.danglingAskIdPreservedCount
    this.normalizationStats.skippedSegmentRowCount += staged.skippedSegmentRowCount
    this.normalizationStats.skippedSegmentMembershipCount += staged.skippedSegmentMembershipCount
  }

  // -------------------------------------------------------------------------
  // Internals — per-entity projection (pure; no DB access)
  // -------------------------------------------------------------------------

  private projectPage(entity: ImportEntityName, items: JsonObject[]): StagedPage {
    switch (entity) {
      case 'topics':
        return this.projectTopicsPage(items)
      case 'message_blocks':
        return this.projectBlocksPage(items)
      case 'topic_segments':
        return this.projectSegmentsPage(items)
      case 'files':
        return this.projectFilesPage(items)
    }
  }

  /**
   * Topics page (LOCK-D2/D3/D4, LOCK-OWN-1/2, LOCK-MID-1/2/3,
   * LOCK-ASK-1/2):
   * - Accept only id/messages/deletedAt; ignore leaked UI topic metadata.
   * - Extract embedded messages; never store `messages` in topics.extra.
   * - Missing topic name/assistant/timestamps remain null.
   * - Each embedded message: strict required fields, JSON-safe shape,
   *   non-empty-string topicId, sortOrder = array index, existing
   *   wireToMessage/overflow semantics preserved (no inference).
   * - A PRESENT valid non-empty `message.topicId` that differs from the
   *   outer `topic.id` is canonicalized to the outer topic on the projected
   *   MessageData and counted (LOCK-OWN-1). Missing/empty/wrong-type still
   *   reject; the raw JsonObject is never mutated.
   * - Deterministic identity (LOCK-MID-1/2): every occurrence maps to
   *   `computeMessageTargetId(outerTopicId, legacyMessageId)` — no
   *   occurrence retains its legacy ID. Same-tuple duplicates (the same
   *   legacy id twice inside one outer topic, staged or committed) and
   *   derived target-ID collisions (two different tuples hashing to one
   *   target) reject explicitly during projection, before any write
   *   (LOCK-MID-3, transactional with the page). Cross-topic reuse of a
   *   legacy id is a legitimate distinct occurrence.
   * - askId (LOCK-ASK-1/2): missing/null → null; empty/non-string rejects
   *   (never silently accepted); a non-empty same-topic askId that resolves
   *   to a source occurrence maps to that occurrence's target ID; a
   *   dangling askId keeps its original non-empty JSON-safe value and is
   *   counted as committed-only (LOCK-ASK-2). Resolution is
   *   traversal-order independent (two-pass: occurrences of the page are
   *   known before any askId is resolved).
   * - message.blocks: unique non-empty IDs registered in the block index.
   */
  private projectTopicsPage(items: JsonObject[]): StagedPage {
    const staged = emptyStagedPage()
    const stagedTopicIds = new Set<string>()
    const stagedTupleKeys = new Set<string>()
    const stagedTupleToTarget = new Map<string, string>()
    const stagedTargetToTupleKey = new Map<string, string>()
    const stagedBlockIds = new Set<string>()
    /** [topicId, legacyMessageId] validated in pass 1, projected in pass 2. */
    const validatedMessages: Array<{ topicId: string; legacyId: string; msgJson: JsonObject }> = []

    for (let i = 0; i < items.length; i++) {
      const ctx: RowContext = { tableName: 'topics', index: i }
      const raw = requirePlainObject(items[i], ctx)
      const topicId = requireNonEmptyString(raw, 'id', ctx)
      ctx.entityId = topicId

      if (this.topicIds.has(topicId) || stagedTopicIds.has(topicId)) {
        throw new ChatImportDataPlaneError('DUPLICATE_RELATION', `${rowLabel(ctx)}: duplicate topic id '${topicId}'`, {
          tableName: 'topics',
          entityId: topicId
        })
      }

      const deletedAt = optionalNullableString(raw, 'deletedAt', ctx)

      // Canonical projection (LOCK-D2): only id/messages/deletedAt are read.
      // Leaked UI metadata (name, assistantId, timestamps, pinned, …) is
      // deliberately ignored — NOT copied to columns and NOT stored in extra.
      //
      // LOCK-TRASH-1/3/4: for imported soft-deleted topics ONLY, carry the
      // importer-owned five-day retention baseline in the top-level internal
      // overflow key. The marker is injected here — BEFORE source-manifest
      // staging and candidate write — so the writer, record digest, overflow
      // digest, and verifier all consume the same marker-bearing object. No
      // post-finalize/promotion mutation. Active topics receive no marker.
      // The source projection reads only id/messages/deletedAt, so a source
      // ZIP row can never set or override the marker key (LOCK-TRASH-4).
      const overflow: Record<string, unknown> = {}
      if (deletedAt !== null && this.l2TrashRetentionBaseline !== undefined) {
        overflow[L2_TRASH_RETENTION_MARKER] = this.l2TrashRetentionBaseline
      }
      staged.topics.push({
        id: topicId,
        assistantId: null,
        name: null,
        createdAt: null,
        updatedAt: null,
        deletedAt,
        overflow
      })
      stagedTopicIds.add(topicId)
      staged.newTopicIds.push(topicId)
      // LOCK-PROD-3: record the IndexedDB-authoritative deletedAt fact for
      // the navigation projection join.
      staged.newTopicDeletedAt.push([topicId, deletedAt])

      // Embedded messages (LOCK-D3).
      const rawMessages = raw.messages
      if (rawMessages !== undefined && !Array.isArray(rawMessages)) {
        throw invalidRow(ctx, `field 'messages' must be an array (got ${describeValue(rawMessages)})`)
      }
      const messages = (rawMessages ?? []) as unknown[]

      // Pass 1 — strict validation + identity computation (LOCK-MID-3).
      for (let m = 0; m < messages.length; m++) {
        const msgJson = requireJsonSafeObject(messages[m], {
          tableName: 'topics',
          index: i,
          entityId: `${topicId}.messages[${m}]`
        })
        const messageId = requireNonEmptyString(msgJson, 'id', {
          tableName: 'topics',
          index: i,
          entityId: `${topicId}.messages[${m}]`
        })
        const messageCtx: RowContext = {
          tableName: 'topics',
          index: i,
          entityId: `${topicId}.messages[${m}] ${messageId}`
        }
        requireNonEmptyString(msgJson, 'role', messageCtx)
        requireNonEmptyString(msgJson, 'status', messageCtx)
        requireNonEmptyString(msgJson, 'createdAt', messageCtx)
        // LOCK-OWN-1: retain the STRICT non-empty-string requirement for
        // `topicId` — missing/empty/number/null/object still reject as
        // INVALID_ROW. Only a present valid non-empty string that differs
        // from the authoritative outer topic is normalized (never moved to
        // another topic): it is counted and the projected MessageData is
        // canonicalized to the outer topic below.
        const msgTopicId = requireNonEmptyString(msgJson, 'topicId', messageCtx)
        if (msgTopicId !== topicId) {
          staged.topicIdNormalizationCount += 1
        }

        // LOCK-MID-1: outer topic containment is the authoritative tuple.
        const tupleKeyValue = tupleKey(topicId, messageId)
        if (this.committedMessageTuples.has(tupleKeyValue) || stagedTupleKeys.has(tupleKeyValue)) {
          throw new ChatImportDataPlaneError(
            'DUPLICATE_RELATION',
            `${rowLabel(messageCtx)}: duplicate message occurrence (topic '${topicId}', legacy id '${messageId}')`,
            { tableName: 'topics', entityId: messageId }
          )
        }
        stagedTupleKeys.add(tupleKeyValue)

        // LOCK-MID-2: deterministic all-occurrence target. Ill-formed
        // inputs (lone surrogates) reject before UTF-8 encoding.
        let targetId: string
        try {
          targetId = computeMessageTargetId(topicId, messageId)
        } catch (error) {
          if (error instanceof MessageIdentityError) {
            throw invalidRow(messageCtx, error.message)
          }
          throw error
        }
        // LOCK-MID-3: a derived target must never collide with a different
        // committed/staged tuple. Detection is traversal-order independent
        // and transactional with the page (nothing written yet).
        const existingOccurrence = this.targetByOccurrence.get(targetId)
        if (existingOccurrence && tupleKey(existingOccurrence.topicId, existingOccurrence.legacyId) !== tupleKeyValue) {
          throw new ChatImportDataPlaneError(
            'TARGET_COLLISION',
            `${rowLabel(messageCtx)}: deterministic target ID collides with a different source occurrence (LOCK-MID-3)`,
            { tableName: 'topics', entityId: messageId }
          )
        }
        const stagedCollision = stagedTargetToTupleKey.get(targetId)
        if (stagedCollision !== undefined && stagedCollision !== tupleKeyValue) {
          throw new ChatImportDataPlaneError(
            'TARGET_COLLISION',
            `${rowLabel(messageCtx)}: deterministic target ID collides with a different source occurrence (LOCK-MID-3)`,
            { tableName: 'topics', entityId: messageId }
          )
        }
        stagedTupleToTarget.set(tupleKeyValue, targetId)
        stagedTargetToTupleKey.set(targetId, tupleKeyValue)

        // Block relationship registration (LOCK-D4).
        const blockIds = requireUniqueStringArray(msgJson.blocks, 'blocks', messageCtx)
        for (let b = 0; b < blockIds.length; b++) {
          const blockId = blockIds[b]
          if (this.blockOwnerById.has(blockId) || stagedBlockIds.has(blockId)) {
            throw new ChatImportDataPlaneError(
              'DUPLICATE_RELATION',
              `${rowLabel(messageCtx)}: block id '${blockId}' is already claimed by another message`,
              { tableName: 'topics', entityId: blockId }
            )
          }
          stagedBlockIds.add(blockId)
          staged.newBlockOwners.push([
            blockId,
            { legacyMessageId: messageId, topicId, targetId, sortOrder: b, seen: false }
          ])
        }

        validatedMessages.push({ topicId, legacyId: messageId, msgJson })
      }
    }

    // Pass 2 — deterministic projection with traversal-order-independent
    // askId resolution (LOCK-ASK-1) and legacy occurrence index staging
    // (LOCK-ORPH-1). All page occurrences are known before any askId maps.
    // sortOrder is the embedded array index WITHIN the topic row (LOCK-D3).
    const stagedLegacyOccurrences = new Map<string, Array<{ topicId: string; targetId: string }>>()
    let lastTopicId: string | null = null
    let topicMessageIndex = 0
    for (const { topicId, legacyId, msgJson } of validatedMessages) {
      if (topicId !== lastTopicId) {
        lastTopicId = topicId
        topicMessageIndex = 0
      }
      const targetId = stagedTupleToTarget.get(tupleKey(topicId, legacyId))!
      const messageCtx: RowContext = {
        tableName: 'topics',
        index: -1,
        entityId: `${topicId}.messages ${legacyId}`
      }

      // LOCK-ASK-1: askId resolution — missing/null → null; empty/non-string
      // never silently accepted; same-topic occurrence → target ID;
      // otherwise preserve the original non-empty value as dangling.
      let askId: string | null = null
      const rawAskId = msgJson.askId
      if (rawAskId !== undefined && rawAskId !== null) {
        if (typeof rawAskId !== 'string') {
          throw invalidRow(messageCtx, `field 'askId' must be a string or null (got ${describeValue(rawAskId)})`)
        }
        if (rawAskId.length === 0) {
          throw invalidRow(messageCtx, `field 'askId' must not be an empty string when present`)
        }
        const resolvedTarget =
          this.committedTupleToTarget.get(tupleKey(topicId, rawAskId)) ??
          stagedTupleToTarget.get(tupleKey(topicId, rawAskId))
        if (resolvedTarget !== undefined) {
          askId = resolvedTarget
        } else {
          // Dangling: keep the original value verbatim (never nulled,
          // inferred, or cross-topic bound). The post-map collision check
          // against the full target set runs at finalize (LOCK-ASK-1).
          askId = rawAskId
          staged.newPreservedDanglingAskIds.push(rawAskId)
          staged.danglingAskIdPreservedCount += 1
        }
      }

      // Existing wire semantics preserve structured model and all unknown
      // message JSON (including `blocks`) in overflow (LOCK-D3).
      const messageData: MessageData = wireToMessage(msgJson)
      // LOCK-MID-1: the candidate message id is the deterministic target —
      // no occurrence retains its legacy ID.
      messageData.id = targetId
      // LOCK-OWN-1: the authoritative outer topic is ALWAYS projected —
      // a matching value is a no-op, a valid stale value is canonicalized
      // (never the embedded claim). The raw JsonObject is untouched.
      messageData.topicId = topicId // outer Topic containment is authoritative
      messageData.sortOrder = topicMessageIndex // array index within the topic (LOCK-D3)
      messageData.askId = askId
      staged.messages.push(messageData)
      topicMessageIndex++

      staged.newMessageTuples.push([topicId, legacyId])
      let occurrences = stagedLegacyOccurrences.get(legacyId)
      if (!occurrences) {
        occurrences = []
        stagedLegacyOccurrences.set(legacyId, occurrences)
      }
      occurrences.push({ topicId, targetId })
    }

    // Merge the staged legacy occurrence deltas in page order (LOCK-ORPH-1).
    for (const [legacyId, list] of stagedLegacyOccurrences) {
      for (const occurrence of list) staged.newLegacyOccurrences.push([legacyId, occurrence])
    }

    return staged
  }

  /**
   * message_blocks page (LOCK-D5, LOCK-BLOCK-1/1X, LOCK-REF-1,
   * LOCK-ORPH-1, LOCK-LB-3/4):
   * - LOCK-LB-3 order: each incoming row is FIRST bounded by the named
   *   block-specific JSON profile (per-string 8 MiB, per-row 16 MiB, page
   *   aggregate 64 MiB) — sufficient to bound the received row/page — THEN
   *   id/messageId are extracted, the source-seen duplicate gate runs, and
   *   unembedded residuals are classified with the legacy indexes. Skipped
   *   rows need NOT satisfy the persist-only required fields
   *   type/status/createdAt, but MUST satisfy block-profile JSON safety /
   *   resource limits and carry valid id + messageId. Reachable rows then
   *   validate type/status/createdAt and persist.
   * - LOCK-LB-4: the page cumulative budget includes EVERY incoming row,
   *   including rows later skipped. The accountant is page-local; a
   *   rejected/rolled-back page throws before commit and leaks no
   *   stats/manifest/index state.
   * - Duplicate source block id detection takes precedence: after
   *   block-profile validation and id/messageId extraction and BEFORE
   *   ownership/orphan classification, a block id already seen on a
   *   committed page or staged on this page rejects as DUPLICATE_RELATION —
   *   even a duplicate that would otherwise classify as an orphan or an
   *   ownership mismatch.
   * - Embedded owner is authoritative (LOCK-REF-1): the source row claim
   *   is checked against the owner's LEGACY tuple, and the persisted
   *   block.messageId is rewritten to the owner's target ID. File
   *   reference blockId is unchanged.
   * - Unembedded rows are classified with the LEGACY occurrence index,
   *   never target IDs (LOCK-ORPH-1):
   *   - Unreachable orphan (LOCK-BLOCK-1): block id in NO message.blocks[]
   *     AND claimed messageId in NO imported message → skipped; counted
   *     as unreachableBlockSkipCount.
   *   - Existing-owner unembedded (LOCK-BLOCK-1X): block id in NO
   *     message.blocks[] AND claimed messageId resolves to EXACTLY ONE
   *     imported source occurrence → skipped (prevents reconstruction
   *     resurrection); counted as skippedExistingOwnerUnembeddedBlockCount.
   *   - Ambiguous claim (legacy id in MULTIPLE topics) → strict
   *     OWNERSHIP_MISMATCH.
   * - Both skips: no target rows, no file references, no manifest
   *   evidence, no writer insert, no seen marker — aggregate counts only.
   * - sortOrder comes ONLY from the parent message.blocks index.
   * - Unknown/tool/content/file JSON preserved through wireToBlock.
   * - Target file references derived ONLY via projectFileReferences(block).
   */
  private projectBlocksPage(items: JsonObject[]): StagedPage {
    const staged = emptyStagedPage()
    const stagedSourceSeen = new Set<string>()
    // LOCK-LB-4: ONE page-level aggregate accountant charged by EVERY
    // incoming row (imported AND later-skipped). Fresh per page; a rejected
    // page throws before any commit, so it never leaks.
    const pageBytes = createProfileBytes()

    for (let i = 0; i < items.length; i++) {
      const baseCtx: RowContext = { tableName: 'message_blocks', index: i }
      // LOCK-LB-3 step 1: bound the received row/page with the block profile
      // (JSON safety + per-string/per-row resource limits + page aggregate).
      const raw = requireBlockProfileSafeObject(items[i], baseCtx, pageBytes)
      // LOCK-LB-3 step 2: extract the block identity fields.
      const blockId = requireNonEmptyString(raw, 'id', baseCtx)
      const ctx: RowContext = { tableName: 'message_blocks', index: i, entityId: blockId }
      const messageId = requireNonEmptyString(raw, 'messageId', ctx)

      // LOCK-BLOCK-1 precedence: the duplicate source block id gate runs
      // after block-profile validation + identity extraction and BEFORE
      // ownership/orphan classification. A duplicate row (committed across
      // pages or staged on this page) always rejects as DUPLICATE_RELATION,
      // even when it would otherwise classify as an orphan or ownership
      // mismatch.
      if (this.sourceSeenBlockIds.has(blockId) || stagedSourceSeen.has(blockId)) {
        throw new ChatImportDataPlaneError(
          'DUPLICATE_RELATION',
          `${rowLabel(ctx)}: duplicate message_blocks row for block '${blockId}'`,
          { tableName: 'message_blocks', entityId: blockId }
        )
      }

      const owner = this.blockOwnerById.get(blockId)
      if (!owner) {
        // LOCK-ORPH-1: classify with the LEGACY occurrence index. A row
        // claiming a messageId that resolves to NO imported occurrence is
        // an unreachable orphan (LOCK-BLOCK-1); a claim resolving to
        // EXACTLY ONE occurrence is an existing-owner unembedded row
        // skipped to prevent reconstruction resurrection (LOCK-BLOCK-1X);
        // a claim resolving to MULTIPLE occurrences is ambiguous and stays
        // a strict OWNERSHIP_MISMATCH. Skipped rows do NOT need
        // type/status/createdAt (LOCK-LB-3) — only block-profile safety,
        // resource limits, and valid id/messageId (already enforced above).
        const occurrences = this.legacyOccurrencesById.get(messageId) ?? []
        if (occurrences.length === 0) {
          // Skip: no target rows, no file references, no manifest evidence,
          // no writer insert, no seen marker — aggregate count only.
          stagedSourceSeen.add(blockId)
          staged.sourceSeenBlockIds.push(blockId)
          staged.orphanBlockSkipCount += 1
          continue
        }
        if (occurrences.length === 1) {
          // LOCK-BLOCK-1X skip: block id in no message.blocks[] AND the
          // claimed legacy messageId resolves to exactly one occurrence.
          stagedSourceSeen.add(blockId)
          staged.sourceSeenBlockIds.push(blockId)
          staged.existingOwnerUnembeddedBlockSkipCount += 1
          continue
        }
        throw new ChatImportDataPlaneError(
          'OWNERSHIP_MISMATCH',
          `${rowLabel(ctx)}: unembedded block claims legacy messageId present in multiple imported topics (ambiguous)`,
          { tableName: 'message_blocks', entityId: blockId }
        )
      }
      if (owner.legacyMessageId !== messageId) {
        throw new ChatImportDataPlaneError(
          'OWNERSHIP_MISMATCH',
          `${rowLabel(ctx)}: block.messageId '${messageId}' does not match index owner '${owner.legacyMessageId}'`,
          { tableName: 'message_blocks', entityId: blockId }
        )
      }

      // LOCK-LB-3: reachable rows validate the persist-only required fields
      // and persist normally.
      requireNonEmptyString(raw, 'type', ctx)
      requireNonEmptyString(raw, 'status', ctx)
      requireNonEmptyString(raw, 'createdAt', ctx)

      const blockData: MessageBlockData = wireToBlock(raw)
      blockData.sortOrder = owner.sortOrder // parent index only (LOCK-D5)
      // LOCK-REF-1: the persisted block.messageId is the owner's
      // deterministic target ID — never the legacy claim.
      blockData.messageId = owner.targetId
      staged.blocks.push(blockData)
      stagedSourceSeen.add(blockId)
      staged.sourceSeenBlockIds.push(blockId)
      staged.seenBlockIds.push(blockId)

      // Target file references derived only via the existing projection
      // (file reference blockId remains the source block id — LOCK-REF-1).
      const refs = projectFileReferences(blockData)
      for (const ref of refs) staged.fileReferences.push(ref)
    }

    return staged
  }

  /**
   * topic_segments page (LOCK-D6, LOCK-SEG-1):
   * - Strict required fields; unique non-empty-string messageIds (empty OK).
   * - Topic-present segments stay strict: segment topic must be imported
   *   and every membership messageId must resolve by
   *   (segment.topicId, legacyMessageId) to a same-topic occurrence;
   *   missing or wrong-topic members reject. Memberships persist as
   *   target IDs (LOCK-REF-1). Never truncate memberships or infer a
   *   target.
   * - LOCK-SEG-1 skip: a segment is skipped ONLY when its topic is absent
   *   AND every member legacy ID resolves to no imported occurrence
   *   anywhere. An absent topic with any globally resolvable member
   *   rejects strictly. Skipped rows produce no segment row, no
   *   memberships, and no manifest evidence; they are counted Main-only
   *   as skippedSegmentRowCount / skippedSegmentMembershipCount
   *   (committed-page semantics, LOCK-STAT-1).
   * - Segment sortOrder is neutral 0; membership sortOrder is array index.
   * - color/unknown fields preserved in segment overflow; messageIds is
   *   relationship data and is NOT stored in overflow.
   */
  private projectSegmentsPage(items: JsonObject[]): StagedPage {
    const staged = emptyStagedPage()
    const stagedSegmentIds = new Set<string>()

    for (let i = 0; i < items.length; i++) {
      const baseCtx: RowContext = { tableName: 'topic_segments', index: i }
      const raw = requireJsonSafeObject(items[i], baseCtx)
      const segmentId = requireNonEmptyString(raw, 'id', baseCtx)
      const ctx: RowContext = { tableName: 'topic_segments', index: i, entityId: segmentId }
      const topicId = requireNonEmptyString(raw, 'topicId', ctx)
      const name = requireNonEmptyString(raw, 'name', ctx)
      const createdAt = requireNonEmptyString(raw, 'createdAt', ctx)
      const updatedAt = requireNonEmptyString(raw, 'updatedAt', ctx)
      const messageIds = requireUniqueStringArray(raw.messageIds, 'messageIds', ctx)

      if (this.segmentIds.has(segmentId) || stagedSegmentIds.has(segmentId)) {
        throw new ChatImportDataPlaneError(
          'DUPLICATE_RELATION',
          `${rowLabel(ctx)}: duplicate segment id '${segmentId}'`,
          { tableName: 'topic_segments', entityId: segmentId }
        )
      }

      if (!this.topicIds.has(topicId)) {
        // LOCK-SEG-1: absent topic. Skip ONLY when every member resolves to
        // no imported occurrence anywhere; otherwise reject strictly.
        const anyResolvableMember = messageIds.some((memberId) => this.legacyOccurrencesById.has(memberId))
        if (anyResolvableMember) {
          throw new ChatImportDataPlaneError(
            'OWNERSHIP_MISMATCH',
            `${rowLabel(ctx)}: segment.topicId '${topicId}' does not match any imported topic and a membership ` +
              'messageId resolves to an imported occurrence (LOCK-SEG-1)',
            { tableName: 'topic_segments', entityId: segmentId }
          )
        }
        // Skip the whole segment row + memberships: no target rows, no
        // manifest evidence — aggregate counts only (LOCK-SEG-1).
        staged.skippedSegmentRowCount += 1
        staged.skippedSegmentMembershipCount += messageIds.length
        continue
      }

      // LOCK-REF-1: memberships resolve by (segment.topicId, legacyMessageId)
      // and persist as target IDs.
      const targetMessageIds: string[] = []
      for (let m = 0; m < messageIds.length; m++) {
        const memberId = messageIds[m]
        const targetId = this.committedTupleToTarget.get(tupleKey(topicId, memberId))
        if (targetId === undefined) {
          const occurrences = this.legacyOccurrencesById.get(memberId) ?? []
          if (occurrences.length === 0) {
            throw new ChatImportDataPlaneError(
              'OWNERSHIP_MISMATCH',
              `${rowLabel(ctx)}: messageIds[${m}] '${memberId}' does not match any imported message`,
              { tableName: 'topic_segments', entityId: segmentId }
            )
          }
          throw new ChatImportDataPlaneError(
            'OWNERSHIP_MISMATCH',
            `${rowLabel(ctx)}: messageIds[${m}] '${memberId}' belongs to topic '${occurrences[0].topicId}', ` +
              `not segment topic '${topicId}'`,
            { tableName: 'topic_segments', entityId: segmentId }
          )
        }
        targetMessageIds.push(targetId)
      }

      // Overflow: preserve color and every unknown field; exclude promoted
      // columns and the relationship array (LOCK-D6).
      const overflow: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(raw)) {
        if (SEGMENT_FIELDS.has(key) || key === 'messageIds') continue
        overflow[key] = value
      }

      const segmentData: TopicSegmentData = {
        id: segmentId,
        topicId,
        name,
        createdAt,
        updatedAt,
        sortOrder: 0, // neutral — do not infer collection order (LOCK-D6)
        overflow
      }
      staged.segments.push(segmentData)
      stagedSegmentIds.add(segmentId)
      staged.newSegmentIds.push(segmentId)
      staged.memberships.push({ segmentId, messageIds: targetMessageIds })
      staged.membershipRowCount += targetMessageIds.length
    }

    return staged
  }

  /**
   * files page (LOCK-D7): validated / count-diagnostic only. Inserts no
   * target rows, never influences fileReferenceCount, and retains no
   * source file payloads.
   */
  private projectFilesPage(items: JsonObject[]): StagedPage {
    for (let i = 0; i < items.length; i++) {
      const ctx: RowContext = { tableName: 'files', index: i }
      const raw = requirePlainObject(items[i], ctx)
      requireNonEmptyString(raw, 'id', ctx)
      // Payload intentionally not retained (LOCK-D7).
    }
    return emptyStagedPage()
  }
}

/**
 * Create a data plane bound to an already initialized Drizzle candidate DB.
 *
 * @param db  Candidate database executor (from CandidateDbResource.getDatabase()).
 */
export function createImportDataPlane(
  db: BetterSQLite3Database<any>,
  options?: ChatImportDataPlaneOptions
): ChatImportDataPlane {
  return new ChatImportDataPlane(db, options)
}
