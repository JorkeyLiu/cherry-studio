/**
 * Post-close readonly SQLite verification through the Electron binary
 * (ABI-safe better-sqlite3 loading).
 *
 * LOCK-QDB-1: Every entry point returns a discriminated typed outcome — never
 * null. Failures carry a fixed code from the QUERY_FAILURE_CODES allowlist and
 * only bounded numerics (exitCode/elapsedMs/attempt) plus an allowlisted
 * signal/code. stderr/stdout/paths/SQL/raw errors never reach the outcome.
 *
 * LOCK-QDB-2: The temp query script is created INSIDE the cleanup scope. Every
 * branch attempts cleanup; a cleanup failure is a fixed-code fail-closed
 * outcome (CLEANUP) that never embeds paths.
 *
 * LOCK-QDB-3: `runChatDbVerifyAttempt` runs ONE fixed batched readonly plan in
 * ONE child/connection/snapshot: exact one-row integrity='ok', an exactly
 * empty foreign_key_check, exact one valid non-negative integer count per
 * allowlisted CandidateImportStats table, and the exact sibling
 * `deletedTopics` count (LOCK-QDB-17) from `SELECT COUNT(*) ... WHERE
 * deleted_at IS NOT NULL` in the SAME child/connection. No caller-supplied
 * arbitrary SQL.
 *
 * LOCK-QDB-4: The retry wrappers apply bounded retry ONLY for
 * TIMEOUT/SPAWN/SIGNAL/BUSY/LOCKED — max 3 attempts, fixed total deadline
 * <=60s, short bounded backoff. Permanent codes fail immediately. Every
 * attempt is readonly. There is no fixed sleep-as-evidence.
 *
 * LOCK-QDB-15: The fixed max per-attempt timeout budget is 55,000ms
 * (60s deadline minus a 5s reserve). Each ACTUAL spawn timeout is computed
 * immediately before spawn as min(maxAttemptTimeout, remaining deadline), so
 * no in-flight attempt can ever exceed the total deadline. The timeout is
 * threaded through runAttempt/runChildScript into the spawnSync options —
 * dependency-injected spawn stubs observe it. A successful first long attempt
 * (e.g. a deterministic 20s plan) simply returns and avoids any retry.
 *
 * LOCK-QDB-16: retryBounded never STARTS an attempt when remaining <= 0. The
 * remaining budget is computed BEFORE the first spawn — a clamped 1ms deadline
 * with an already-advancing clock fails closed as a typed TIMEOUT with zero
 * spawns — and rechecked after every bounded backoff sleep so an overshooting
 * sleep can never start another attempt. All existing clamp semantics
 * (LOCK-QDB-8) remain.
 *
 * LOCK-QDB-5: The generic query stays compatible with existing callers, but
 * malformed/missing/non-array rows fail closed (INVALID_ENVELOPE) — callers
 * must never default to `rows ?? []`.
 *
 * LOCK-QDB-7: Pure validation helpers (isExactIntegrityOk,
 * isExactEmptyForeignKeyCheck, isNonNegativeSafeInteger, isValidCountsRecord)
 * back the batched plan shape checks and are unit-tested directly.
 *
 * LOCK-QDB-8: retryBounded clamps caller-supplied maxAttempts to [1,3] and
 * totalDeadlineMs to a finite [1,60000] internal bound regardless of caller
 * input (Infinity/NaN/huge/negative). The deadline is rechecked AFTER the
 * backoff sleep so an overshooting sleep can never start another attempt.
 *
 * LOCK-QDB-9: Exact key sets at every batched verification level — the
 * verification value has exactly integrity/fk/counts/deletedTopics, the
 * integrity row has exactly `integrity_check`, and the counts object has
 * exactly the six allowlisted tables. Extra or missing keys reject
 * INVALID_ENVELOPE.
 *
 * LOCK-QDB-10: The cleanup helper is total — any exists/unlink/verification
 * throw becomes a typed CLEANUP outcome and never escapes runChildScript.
 * Script write stays inside the cleanup scope.
 *
 * LOCK-QDB-11: Complete JS string literal encoding (JSON.stringify literal
 * plus U+2028/U+2029 escaping) for DB paths and generic SQL — newline/CR/
 * U+2028/U+2029 can never break the generated child script syntax.
 *
 * LOCK-QDB-13: elapsedMs/exitCode numerics are sanitized into fixed bounded
 * values before any outcome is built; a malformed runner/clock cannot violate
 * the typed privacy surface.
 *
 * LOCK-QDB-17: The batched verification sibling field `deletedTopics` is an
 * exact non-negative safe integer taken from `SELECT COUNT(*) ... WHERE
 * deleted_at IS NOT NULL` in the SAME readonly child/connection as the six
 * counts — the active/total/deleted topic algebra is provable from one
 * snapshot. `counts` keeps EXACTLY its six keys; the verification envelope
 * has EXACTLY integrity/fk/counts/deletedTopics. Malformed/missing/extra
 * fields reject INVALID_ENVELOPE.
 */
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ---------------------------------------------------------------------------
// Fixed allowlists (LOCK-QDB-1/3/7)
// ---------------------------------------------------------------------------

/** Fixed failure-code allowlist. Every failure outcome carries exactly one. */
export const QUERY_FAILURE_CODES = [
  'TIMEOUT',
  'SPAWN',
  'SIGNAL',
  'EXIT',
  'EMPTY_OUTPUT',
  'PARSE',
  'INVALID_ENVELOPE',
  'SQL',
  'BUSY',
  'LOCKED',
  'CLEANUP',
  'WRITE'
] as const

export type QueryFailureCode = (typeof QUERY_FAILURE_CODES)[number]

/**
 * Tables required by CandidateImportStats (LOCK-QDB-3): the fixed batched
 * plan counts exactly these tables. `pageCount`/`elapsedMs` are not tables.
 */
export const VERIFICATION_TABLES = [
  'topics',
  'messages',
  'message_blocks',
  'topic_segments',
  'topic_segment_messages',
  'file_references'
] as const

export type VerificationTable = (typeof VERIFICATION_TABLES)[number]

/** Fixed counts record shape returned by a successful batched verification. */
export type VerificationCounts = Readonly<Record<VerificationTable, number>>

/**
 * Transient codes that the bounded retry wrapper re-attempts (LOCK-QDB-4).
 * Everything else fails immediately.
 */
export const RETRYABLE_FAILURE_CODES: readonly QueryFailureCode[] = ['TIMEOUT', 'SPAWN', 'SIGNAL', 'BUSY', 'LOCKED']

export const QUERY_MAX_ATTEMPTS = 3
export const QUERY_RETRY_TOTAL_DEADLINE_MS = 60_000

/**
 * Fixed max per-attempt spawnSync timeout budget (LOCK-QDB-15): 60s total
 * deadline minus a fixed 5s reserve. The actual timeout passed to every spawn
 * is min(QUERY_MAX_ATTEMPT_TIMEOUT_MS, remaining deadline) computed
 * immediately before the spawn, so a 3-attempt plan can never overshoot the
 * total deadline while a single long attempt gets the full 55s budget.
 */
export const QUERY_MAX_ATTEMPT_TIMEOUT_MS = 55_000

/**
 * Fixed cap for surfaced elapsedMs (LOCK-QDB-13). Every outcome timestamp is
 * sanitized into a finite non-negative integer <= this bound — a malformed
 * injectable clock (NaN/Infinity/negative/regression) can never leak through.
 */
const QUERY_ELAPSED_MS_CAP = 600_000

/**
 * Bound a child exit status (LOCK-QDB-13): only non-negative safe integers in
 * the platform status range surface; anything else (NaN/Infinity/negative/
 * fractional/absurd) is dropped from the typed outcome.
 */
const QUERY_MAX_EXIT_CODE = 0xffff

/** Short bounded backoff between retry attempts (LOCK-QDB-4). */
const QUERY_BACKOFF_MS: readonly number[] = [250, 500]

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Child SQL failure classification: BUSY/LOCKED are retryable, SQL is not. */
const BUSY_FAILURE_PATTERN = /SQLITE_BUSY|database is (busy|locked)/i
const LOCKED_FAILURE_PATTERN = /SQLITE_LOCKED|database table is locked/i

/** Fixed signal allowlist — a signal outside this set is never surfaced. */
const ALLOWED_SIGNALS: ReadonlySet<string> = new Set([
  'SIGHUP',
  'SIGINT',
  'SIGQUIT',
  'SIGILL',
  'SIGTRAP',
  'SIGABRT',
  'SIGBUS',
  'SIGFPE',
  'SIGKILL',
  'SIGUSR1',
  'SIGSEGV',
  'SIGUSR2',
  'SIGPIPE',
  'SIGALRM',
  'SIGTERM',
  'SIGCHLD',
  'SIGCONT',
  'SIGSTOP',
  'SIGTSTP',
  'SIGTTIN',
  'SIGTTOU',
  'SIGURG',
  'SIGXCPU',
  'SIGXFSZ',
  'SIGVTALRM',
  'SIGPROF',
  'SIGWINCH',
  'SIGIO',
  'SIGPWR',
  'SIGSYS'
])

// ---------------------------------------------------------------------------
// Outcome types (LOCK-QDB-1)
// ---------------------------------------------------------------------------

export interface QueryChatDbOutcomeSuccess {
  readonly ok: true
  readonly rows: readonly Record<string, unknown>[]
  readonly elapsedMs: number
  readonly attempt: number
}

export interface QueryChatDbOutcomeFailure {
  readonly ok: false
  readonly code: QueryFailureCode
  readonly elapsedMs: number
  readonly attempt: number
  /** Bounded numeric child exit code, when the failure was a nonzero exit. */
  readonly exitCode?: number
  /** Allowlisted signal name, when the child was terminated by a signal. */
  readonly signal?: string
}

export type QueryChatDbOutcome = QueryChatDbOutcomeSuccess | QueryChatDbOutcomeFailure

/** Value carried by a successful batched verification (fixed booleans/counts). */
export interface VerifyChatDbValue {
  readonly integrityOk: true
  readonly foreignKeyViolations: 0
  readonly counts: VerificationCounts
  /**
   * LOCK-QDB-17: exact non-negative safe integer from `SELECT COUNT(*) ...
   * WHERE deleted_at IS NOT NULL` on the topics table in the SAME readonly
   * child/connection/snapshot as `counts`.
   */
  readonly deletedTopics: number
}

export type VerifyChatDbOutcome =
  | { readonly ok: true; readonly value: VerifyChatDbValue; readonly elapsedMs: number; readonly attempt: number }
  | QueryChatDbOutcomeFailure

export interface QueryChatDbDependencies {
  electronPath: string
  betterSqlitePath: string
  /**
   * Injectable process runner. The simplified signature is a subset of the
   * real `spawnSync` overload set, so the real implementation is assignable
   * while test stubs stay trivially typed.
   */
  spawnSyncImpl?: (
    command: string,
    args: readonly string[],
    options: SpawnSyncOptionsWithStringEncoding
  ) => SpawnSyncReturns<string>
  writeFileSyncImpl?: (filePath: string, data: string) => void
  unlinkSyncImpl?: (filePath: string) => void
  existsSyncImpl?: (filePath: string) => boolean
  lstatSyncImpl?: (filePath: string) => fs.Stats
  /** Injectable clock for deterministic elapsedMs in tests. */
  now?: () => number
  /** Injectable sleep for deterministic retry backoff in tests. */
  sleep?: (ms: number) => Promise<void>
}

// ---------------------------------------------------------------------------
// Pure validation helpers (LOCK-QDB-7)
// ---------------------------------------------------------------------------

export function isNonNegativeSafeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Exactly one row whose single `integrity_check` key is exactly 'ok'
 * (LOCK-QDB-9: the integrity row has EXACTLY the `integrity_check` key — extra
 * or missing keys fail closed).
 */
export function isExactIntegrityOk(rows: unknown): boolean {
  if (!Array.isArray(rows) || rows.length !== 1) return false
  const row = rows[0]
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return false
  const record = row as Record<string, unknown>
  if (Object.keys(record).length !== 1) return false
  return record.integrity_check === 'ok'
}

/** A present array that is exactly empty (no FK violations). */
export function isExactEmptyForeignKeyCheck(rows: unknown): boolean {
  return Array.isArray(rows) && rows.length === 0
}

/**
 * Exact one valid non-negative integer count per allowlisted table and
 * nothing else (LOCK-QDB-6: batch result shape exactly). Extra or missing
 * keys fail closed.
 */
export function isValidCountsRecord(counts: unknown): counts is VerificationCounts {
  if (counts === null || typeof counts !== 'object' || Array.isArray(counts)) return false
  const record = counts as Record<string, unknown>
  for (const table of VERIFICATION_TABLES) {
    if (!isNonNegativeSafeInteger(record[table])) return false
  }
  if (Object.keys(record).length !== VERIFICATION_TABLES.length) return false
  return true
}

/**
 * Complete JS string literal encoding (LOCK-QDB-11): JSON.stringify produces
 * a double-quoted literal with every control character, quote and backslash
 * escaped; U+2028/U+2029 are additionally escaped so no line terminator can
 * ever break the generated child script. Round-trips exactly via eval.
 */
export function encodeJsStringLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * Clamp a caller-supplied maxAttempts into the fixed [1, QUERY_MAX_ATTEMPTS]
 * internal bound (LOCK-QDB-8). Infinity/NaN/undefined and absurd values fall
 * back to the production default; values below 1 clamp to 1.
 */
export function clampMaxAttempts(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return QUERY_MAX_ATTEMPTS
  const floor = Math.floor(value)
  if (floor < 1) return 1
  if (floor > QUERY_MAX_ATTEMPTS) return QUERY_MAX_ATTEMPTS
  return floor
}

/**
 * Clamp a caller-supplied totalDeadlineMs into the fixed finite
 * [1, QUERY_RETRY_TOTAL_DEADLINE_MS] internal bound (LOCK-QDB-8).
 * Infinity/NaN/undefined fall back to the production default; values below
 * 1 clamp to 1 (a minimum viable deadline).
 */
export function clampTotalDeadlineMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return QUERY_RETRY_TOTAL_DEADLINE_MS
  const floor = Math.floor(value)
  if (floor < 1) return 1
  if (floor > QUERY_RETRY_TOTAL_DEADLINE_MS) return QUERY_RETRY_TOTAL_DEADLINE_MS
  return floor
}

/**
 * LOCK-QDB-15/16: the actual per-attempt spawn timeout is
 * `min(QUERY_MAX_ATTEMPT_TIMEOUT_MS, remaining deadline)`, computed
 * immediately before the spawn. A non-finite/non-positive input falls back to
 * the fixed max budget (defensive for direct single-attempt callers); a
 * fractional/zero positive remaining can never produce a spawnSync
 * `timeout: 0` (which means "no timeout"), so the result is always in
 * [1, QUERY_MAX_ATTEMPT_TIMEOUT_MS].
 */
export function resolveAttemptTimeoutMs(remainingMs: number): number {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return QUERY_MAX_ATTEMPT_TIMEOUT_MS
  const floor = Math.floor(remainingMs)
  const clamped = Math.min(QUERY_MAX_ATTEMPT_TIMEOUT_MS, floor)
  return clamped >= 1 ? clamped : 1
}

/**
 * Sanitize a raw elapsed duration into a fixed bounded value (LOCK-QDB-13):
 * non-finite or negative raw values become 0, and values above the fixed cap
 * clamp to the cap. Never NaN/Infinity/negative.
 */
export function sanitizeElapsedMs(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0
  const floor = Math.floor(value)
  return floor > QUERY_ELAPSED_MS_CAP ? QUERY_ELAPSED_MS_CAP : floor
}

/**
 * Sanitize a child exit status into the typed surface (LOCK-QDB-13). Only a
 * non-negative safe integer within the platform status range is kept; any
 * malformed value (NaN/Infinity/negative/fractional/absurd) is dropped.
 */
export function sanitizeExitCode(value: number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 0 || value > QUERY_MAX_EXIT_CODE) return undefined
  return value
}

/** True when a failure code is transient and the retry wrapper may re-attempt. */
export function isRetryableFailureCode(code: QueryFailureCode): boolean {
  return (RETRYABLE_FAILURE_CODES as readonly QueryFailureCode[]).includes(code)
}

/**
 * LOCK-QDB-9: the record has EXACTLY the given keys (order-insensitive).
 * Extra or missing keys fail closed.
 */
export function isExactKeySet(record: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const keys = Object.keys(record).sort()
  const expected = [...expectedKeys].sort()
  if (keys.length !== expected.length) return false
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] !== expected[i]) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Internal plumbing
// ---------------------------------------------------------------------------

/** Strictly parse the child envelope into rows or a fixed failure code. */
function classifyQueryEnvelope(
  envelope: unknown
): { kind: 'ok'; payload: readonly Record<string, unknown>[] } | { kind: 'failure'; code: QueryFailureCode } {
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { kind: 'failure', code: 'INVALID_ENVELOPE' }
  }
  const parsed = envelope as Record<string, unknown>
  if (parsed.ok === true) {
    // LOCK-QDB-5: malformed/missing/non-array rows fail closed.
    if (!isValidRowsArray(parsed.rows)) return { kind: 'failure', code: 'INVALID_ENVELOPE' }
    return { kind: 'ok', payload: parsed.rows as readonly Record<string, unknown>[] }
  }
  if (parsed.ok === false) {
    if (typeof parsed.message !== 'string' || parsed.message.length === 0) {
      return { kind: 'failure', code: 'INVALID_ENVELOPE' }
    }
    return { kind: 'failure', code: classifyChildFailure(parsed.message) }
  }
  return { kind: 'failure', code: 'INVALID_ENVELOPE' }
}

function isValidRowsArray(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  for (const row of value) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return false
  }
  return true
}

/** Strictly parse the batched verification envelope into fixed values/counts. */
function classifyVerifyEnvelope(
  envelope: unknown
): { kind: 'ok'; payload: VerifyChatDbValue } | { kind: 'failure'; code: QueryFailureCode } {
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { kind: 'failure', code: 'INVALID_ENVELOPE' }
  }
  const parsed = envelope as Record<string, unknown>
  if (parsed.ok === true) {
    const value = parsed.value
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { kind: 'failure', code: 'INVALID_ENVELOPE' }
    }
    const record = value as Record<string, unknown>
    // LOCK-QDB-9/17: the verification value carries EXACTLY
    // integrity/fk/counts/deletedTopics.
    if (!isExactKeySet(record, ['integrity', 'fk', 'counts', 'deletedTopics'])) {
      return { kind: 'failure', code: 'INVALID_ENVELOPE' }
    }
    // LOCK-QDB-7/9: exact one-row integrity 'ok' with exactly one key; FK
    // exactly empty; counts exactly the six allowlisted tables; deletedTopics
    // an exact non-negative safe integer (LOCK-QDB-17).
    if (!isExactIntegrityOk(record.integrity)) return { kind: 'failure', code: 'INVALID_ENVELOPE' }
    if (!isExactEmptyForeignKeyCheck(record.fk)) return { kind: 'failure', code: 'INVALID_ENVELOPE' }
    if (!isValidCountsRecord(record.counts)) return { kind: 'failure', code: 'INVALID_ENVELOPE' }
    if (!isNonNegativeSafeInteger(record.deletedTopics)) return { kind: 'failure', code: 'INVALID_ENVELOPE' }
    return {
      kind: 'ok',
      payload: {
        integrityOk: true,
        foreignKeyViolations: 0,
        counts: record.counts,
        deletedTopics: record.deletedTopics as number
      }
    }
  }
  if (parsed.ok === false) {
    if (typeof parsed.message !== 'string' || parsed.message.length === 0) {
      return { kind: 'failure', code: 'INVALID_ENVELOPE' }
    }
    return { kind: 'failure', code: classifyChildFailure(parsed.message) }
  }
  return { kind: 'failure', code: 'INVALID_ENVELOPE' }
}

/** Map a child failure message to a fixed code — the raw message is discarded. */
function classifyChildFailure(message: string): QueryFailureCode {
  if (LOCKED_FAILURE_PATTERN.test(message)) return 'LOCKED'
  if (BUSY_FAILURE_PATTERN.test(message)) return 'BUSY'
  return 'SQL'
}

function allowlistedSignal(signal: NodeJS.Signals | null | undefined): string | undefined {
  return signal !== null && signal !== undefined && ALLOWED_SIGNALS.has(signal) ? signal : undefined
}

/**
 * Validate the temp dir for script placement. Returns null (fail-closed WRITE)
 * instead of throwing so no path can surface in a message.
 */
function validateTmpDir(tmpDir: string, lstatSync: (filePath: string) => fs.Stats): string | null {
  if (!path.isAbsolute(tmpDir)) return null
  let stat: fs.Stats
  try {
    stat = lstatSync(path.resolve(tmpDir))
  } catch {
    return null
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return null
  return path.resolve(tmpDir)
}

/**
 * Unlink the temp script and verify absence. Total (LOCK-QDB-10): ANY throw
 * from unlink or the exists verification becomes a failed cleanup — it never
 * escapes into the caller.
 */
function attemptScriptCleanup(
  tmpScript: string,
  unlink: (path: string) => void,
  exists: (path: string) => boolean
): boolean {
  try {
    unlink(tmpScript)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
  }
  try {
    return !exists(tmpScript)
  } catch {
    return false
  }
}

type ClassifiedEnvelope = { kind: 'ok'; payload: unknown } | { kind: 'failure'; code: QueryFailureCode }

type ChildRunResult =
  | { kind: 'ok'; payload: unknown; elapsedMs: number; attempt: number }
  | { kind: 'failure'; code: QueryFailureCode; elapsedMs: number; attempt: number; exitCode?: number; signal?: string }

/**
 * Run one readonly child with the given script body. LOCK-QDB-2: script
 * creation is inside the cleanup scope; every branch attempts cleanup and a
 * cleanup failure becomes a fail-closed CLEANUP outcome. Never throws.
 *
 * LOCK-QDB-15: `timeoutMs` is the per-attempt spawn timeout computed by the
 * caller immediately before spawn — never the fixed module constant — so an
 * in-flight attempt can never exceed the remaining total deadline.
 */
function runChildScript(
  scriptBody: string,
  tmpDir: string,
  dependencies: QueryChatDbDependencies,
  classifyEnvelope: (envelope: unknown) => ClassifiedEnvelope,
  timeoutMs: number
): ChildRunResult {
  const now = dependencies.now ?? Date.now
  const startedAt = now()
  // LOCK-QDB-13: every outcome timestamp is a sanitized bounded value.
  const elapsedMs = (): number => sanitizeElapsedMs(now() - startedAt)
  const writeFile = dependencies.writeFileSyncImpl ?? fs.writeFileSync
  const unlink = dependencies.unlinkSyncImpl ?? fs.unlinkSync
  const exists = dependencies.existsSyncImpl ?? fs.existsSync
  const lstatSync = dependencies.lstatSyncImpl ?? fs.lstatSync

  let tmpScript: string | null = null
  let scriptWritten = false
  let outcome: ChildRunResult
  try {
    const validatedTmpDir = validateTmpDir(tmpDir, lstatSync)
    if (validatedTmpDir === null) {
      outcome = { kind: 'failure', code: 'WRITE', elapsedMs: elapsedMs(), attempt: 1 }
      return outcome
    }
    tmpScript = path.join(validatedTmpDir, `e2e-sqlite-query-${now()}-${Math.random().toString(36).slice(2)}.js`)
    writeFile(tmpScript, scriptBody)
    scriptWritten = true

    const spawn = dependencies.spawnSyncImpl ?? spawnSync
    const result = spawn(dependencies.electronPath, [tmpScript], {
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        TMPDIR: validatedTmpDir,
        TMP: validatedTmpDir,
        TEMP: validatedTmpDir
      }
    }) as SpawnSyncReturns<string>
    outcome = classifySpawnResult(result, classifyEnvelope, elapsedMs())
  } catch {
    // Never surface the raw runner error (LOCK-QDB-1).
    outcome = { kind: 'failure', code: scriptWritten ? 'SPAWN' : 'WRITE', elapsedMs: elapsedMs(), attempt: 1 }
  } finally {
    if (tmpScript !== null && !attemptScriptCleanup(tmpScript, unlink, exists)) {
      // Fail-closed: a cleanup failure overrides any prior outcome (LOCK-QDB-2).
      outcome = { kind: 'failure', code: 'CLEANUP', elapsedMs: elapsedMs(), attempt: 1 }
    }
  }
  return outcome
}

function classifySpawnResult(
  result: SpawnSyncReturns<string>,
  classifyEnvelope: (envelope: unknown) => ClassifiedEnvelope,
  elapsedMs: number
): ChildRunResult {
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      return { kind: 'failure', code: 'TIMEOUT', elapsedMs, attempt: 1 }
    }
    if (result.signal) {
      return { kind: 'failure', code: 'SIGNAL', signal: allowlistedSignal(result.signal), elapsedMs, attempt: 1 }
    }
    return { kind: 'failure', code: 'SPAWN', elapsedMs, attempt: 1 }
  }
  if (result.signal !== null && result.signal !== undefined) {
    return { kind: 'failure', code: 'SIGNAL', signal: allowlistedSignal(result.signal), elapsedMs, attempt: 1 }
  }
  if (result.status !== 0) {
    return {
      kind: 'failure',
      code: 'EXIT',
      exitCode: sanitizeExitCode(result.status),
      elapsedMs,
      attempt: 1
    }
  }
  const stdout = (result.stdout ?? '').trim()
  if (stdout.length === 0) {
    return { kind: 'failure', code: 'EMPTY_OUTPUT', elapsedMs, attempt: 1 }
  }
  let envelope: unknown = null
  for (const line of stdout.split('\n').reverse()) {
    const candidate = line.trim()
    if (!candidate.startsWith('{')) continue
    try {
      envelope = JSON.parse(candidate)
    } catch {
      return { kind: 'failure', code: 'PARSE', elapsedMs, attempt: 1 }
    }
    break
  }
  if (envelope === null) {
    return { kind: 'failure', code: 'EMPTY_OUTPUT', elapsedMs, attempt: 1 }
  }
  const classified = classifyEnvelope(envelope)
  if (classified.kind === 'ok') {
    return { kind: 'ok', payload: classified.payload, elapsedMs, attempt: 1 }
  }
  return { kind: 'failure', code: classified.code, elapsedMs, attempt: 1 }
}

function buildQueryScript(dbPath: string, sql: string, betterSqlitePath: string): string {
  // LOCK-QDB-11: complete JS string literal encoding for the module path, DB
  // path and generic SQL — no newline/CR/U+2028/U+2029 can break the script.
  return `
    const Database = require(${encodeJsStringLiteral(betterSqlitePath)});
    let db = null;
    try {
      db = new Database(${encodeJsStringLiteral(dbPath)}, { readonly: true });
      const rows = db.prepare(${encodeJsStringLiteral(sql)}).all();
      db.close();
      db = null;
      console.log(JSON.stringify({ ok: true, rows }));
    } catch (err) {
      console.log(JSON.stringify({ ok: false, message: err && err.message ? String(err.message) : 'unknown query failure' }));
    }
  `
}

function buildVerifyScript(dbPath: string, betterSqlitePath: string): string {
  const tableLines = VERIFICATION_TABLES.map(
    (table) =>
      `counts[${encodeJsStringLiteral(table)}] = db.prepare('SELECT COUNT(*) AS n FROM ${encodeJsStringLiteral(table)}').get().n;`
  ).join('\n      ')
  // LOCK-QDB-17: the exact deleted-topics count comes from the SAME readonly
  // child/connection as the six counts (topics.deleted_at IS NOT NULL).
  const deletedTopicsLine = `const deletedTopics = db.prepare('SELECT COUNT(*) AS n FROM "topics" WHERE deleted_at IS NOT NULL').get().n;`
  return `
    const Database = require(${encodeJsStringLiteral(betterSqlitePath)});
    let db = null;
    try {
      db = new Database(${encodeJsStringLiteral(dbPath)}, { readonly: true });
      const integrity = db.prepare('PRAGMA integrity_check').all();
      const fk = db.prepare('PRAGMA foreign_key_check').all();
      const counts = {};
      ${tableLines}
      ${deletedTopicsLine}
      db.close();
      db = null;
      console.log(JSON.stringify({ ok: true, value: { integrity, fk, counts, deletedTopics } }));
    } catch (err) {
      console.log(JSON.stringify({ ok: false, message: err && err.message ? String(err.message) : 'unknown verification failure' }));
    }
  `
}

// ---------------------------------------------------------------------------
// Single-attempt entry points (LOCK-QDB-1/3/5)
// ---------------------------------------------------------------------------

/** Build a failure outcome with only the optional keys that are present. */
function toFailureOutcome(result: Extract<ChildRunResult, { kind: 'failure' }>): QueryChatDbOutcomeFailure {
  const base = { ok: false as const, code: result.code, elapsedMs: result.elapsedMs, attempt: result.attempt }
  if (result.exitCode !== undefined) return { ...base, exitCode: result.exitCode }
  if (result.signal !== undefined) return { ...base, signal: result.signal }
  return base
}

export function runChatDbQueryAttempt(
  dbPath: string,
  sql: string,
  tmpDir: string,
  dependencies: QueryChatDbDependencies,
  timeoutMs?: number
): QueryChatDbOutcome {
  const result = runChildScript(
    buildQueryScript(dbPath, sql, dependencies.betterSqlitePath),
    tmpDir,
    dependencies,
    classifyQueryEnvelope,
    resolveAttemptTimeoutMs(timeoutMs ?? QUERY_MAX_ATTEMPT_TIMEOUT_MS)
  )
  if (result.kind === 'failure') {
    return toFailureOutcome(result)
  }
  return {
    ok: true,
    rows: result.payload as readonly Record<string, unknown>[],
    elapsedMs: result.elapsedMs,
    attempt: result.attempt
  }
}

export function runChatDbVerifyAttempt(
  dbPath: string,
  tmpDir: string,
  dependencies: QueryChatDbDependencies,
  timeoutMs?: number
): VerifyChatDbOutcome {
  const result = runChildScript(
    buildVerifyScript(dbPath, dependencies.betterSqlitePath),
    tmpDir,
    dependencies,
    classifyVerifyEnvelope,
    resolveAttemptTimeoutMs(timeoutMs ?? QUERY_MAX_ATTEMPT_TIMEOUT_MS)
  )
  if (result.kind === 'failure') {
    return toFailureOutcome(result)
  }
  return {
    ok: true,
    value: result.payload as VerifyChatDbValue,
    elapsedMs: result.elapsedMs,
    attempt: result.attempt
  }
}

// ---------------------------------------------------------------------------
// Bounded retry wrappers (LOCK-QDB-4)
// ---------------------------------------------------------------------------

export interface RetryOptions {
  maxAttempts?: number
  totalDeadlineMs?: number
}

/**
 * Bounded retry core: re-attempts ONLY transient codes, at most maxAttempts
 * times within a fixed total deadline with short bounded backoff. Permanent
 * codes fail immediately. Each attempt is a fresh readonly child.
 *
 * LOCK-QDB-8: caller-supplied maxAttempts/totalDeadlineMs are clamped to fixed
 * internal bounds regardless of input (Infinity/NaN/huge/negative). The
 * deadline is rechecked AFTER the backoff sleep so an overshooting sleep can
 * never start another attempt past the bound.
 *
 * LOCK-QDB-15: `runAttempt` receives the per-attempt spawn timeout computed
 * immediately before spawn as `min(QUERY_MAX_ATTEMPT_TIMEOUT_MS, remaining
 * deadline)`, so no in-flight attempt can exceed the total deadline.
 *
 * LOCK-QDB-16: an attempt is NEVER started when the remaining budget is
 * <= 0 — the remaining budget is computed before the first spawn (fail-closed
 * TIMEOUT, no spawn at all) and rechecked after every backoff sleep; the
 * attempt timeout itself is clamped to that remaining budget.
 */
export async function retryBounded<T extends { ok: boolean; code?: QueryFailureCode }>(
  runAttempt: (attempt: number, timeoutMs: number) => T,
  dependencies: QueryChatDbDependencies,
  options: RetryOptions = {}
): Promise<T> {
  const now = dependencies.now ?? Date.now
  const sleep = dependencies.sleep ?? defaultSleep
  const maxAttempts = clampMaxAttempts(options.maxAttempts)
  const totalDeadlineMs = clampTotalDeadlineMs(options.totalDeadlineMs)
  const deadline = now() + totalDeadlineMs

  // LOCK-QDB-16: compute the remaining budget BEFORE the first spawn. When it
  // is already non-finite or <= 0 (e.g. a clamped 1ms deadline with an
  // advancing clock) NO attempt may start — fail closed with a typed TIMEOUT
  // outcome carrying only bounded numerics, and never call runAttempt. Both
  // concrete T instantiations (QueryChatDbOutcome / VerifyChatDbOutcome)
  // include this exact failure shape, so the assertion is sound.
  const remaining0 = deadline - now()
  if (!Number.isFinite(remaining0) || remaining0 <= 0) {
    return { ok: false, code: 'TIMEOUT', elapsedMs: 0, attempt: 1 } as unknown as T
  }

  // LOCK-QDB-15/16: first attempt timeout is min(max, remaining) at t0.
  let last = runAttempt(1, resolveAttemptTimeoutMs(remaining0))
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (last.ok || !isRetryableFailureCode(last.code as QueryFailureCode)) return last
    if (attempt >= maxAttempts) return last
    const remaining = deadline - now()
    if (!Number.isFinite(remaining) || remaining <= 0) return last
    const backoff = Math.min(QUERY_BACKOFF_MS[attempt - 1] ?? QUERY_BACKOFF_MS[QUERY_BACKOFF_MS.length - 1], remaining)
    await sleep(backoff)
    // LOCK-QDB-8/16: recheck the deadline AFTER the sleep — an overshooting
    // sleep can never start another attempt.
    const afterSleep = now()
    if (!Number.isFinite(afterSleep) || afterSleep >= deadline) return last
    const nextRemaining = deadline - afterSleep
    if (!Number.isFinite(nextRemaining) || nextRemaining <= 0) return last
    last = runAttempt(attempt + 1, resolveAttemptTimeoutMs(nextRemaining))
  }
  return last
}

export async function queryChatDbWithBoundedRetry(
  dbPath: string,
  sql: string,
  tmpDir: string,
  dependencies: QueryChatDbDependencies,
  options?: RetryOptions
): Promise<QueryChatDbOutcome> {
  return retryBounded(
    (attempt, timeoutMs) => ({ ...runChatDbQueryAttempt(dbPath, sql, tmpDir, dependencies, timeoutMs), attempt }),
    dependencies,
    options
  )
}

export async function verifyChatDbWithBoundedRetry(
  dbPath: string,
  tmpDir: string,
  dependencies: QueryChatDbDependencies,
  options?: RetryOptions
): Promise<VerifyChatDbOutcome> {
  return retryBounded(
    (attempt, timeoutMs) => ({ ...runChatDbVerifyAttempt(dbPath, tmpDir, dependencies, timeoutMs), attempt }),
    dependencies,
    options
  )
}
