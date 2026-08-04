/**
 * Unit tests for the post-close readonly SQLite verification helper.
 *
 * Covers the full failure matrix (LOCK-QDB-1), cleanup discipline on
 * write/spawn/parse/exit (LOCK-QDB-2), the fixed batched verification plan in
 * ONE child (LOCK-QDB-3), bounded transient retry / permanent no-retry /
 * deadline enforcement (LOCK-QDB-4), strict envelope/rows fail-closed
 * behavior (LOCK-QDB-5/7), the dynamic per-attempt timeout clamp
 * (LOCK-QDB-15/16), the exact deletedTopics sibling (LOCK-QDB-17), and the
 * privacy surface (no raw error/path/SQL in any outcome).
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { SpawnSyncReturns } from 'node:child_process'
import { describe, expect, it } from 'vitest'

import {
  QUERY_FAILURE_CODES,
  QUERY_MAX_ATTEMPT_TIMEOUT_MS,
  RETRYABLE_FAILURE_CODES,
  VERIFICATION_TABLES,
  clampMaxAttempts,
  clampTotalDeadlineMs,
  encodeJsStringLiteral,
  isExactEmptyForeignKeyCheck,
  isExactIntegrityOk,
  isExactKeySet,
  isNonNegativeSafeInteger,
  isRetryableFailureCode,
  isValidCountsRecord,
  queryChatDbWithBoundedRetry,
  resolveAttemptTimeoutMs,
  runChatDbQueryAttempt,
  runChatDbVerifyAttempt,
  sanitizeElapsedMs,
  sanitizeExitCode,
  type QueryChatDbDependencies,
  type QueryChatDbOutcome
} from './query-chat-db-electron'

/** Stub spawn result with a string-encoded stdout, matching the runner's use. */
type SpawnSyncLike = SpawnSyncReturns<string>

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-query-helper-test-'))
}

function makeDeps(overrides: Partial<QueryChatDbDependencies> = {}): QueryChatDbDependencies {
  return {
    electronPath: process.execPath,
    betterSqlitePath: '/tmp/better-sqlite3',
    ...overrides
  }
}

/** Stub spawn result with a string-encoded stdout, matching the runner's use. */
function makeSpawnResult(overrides: Partial<SpawnSyncLike> = {}): SpawnSyncLike {
  return {
    pid: 1,
    output: ['', '', ''],
    stdout: '',
    stderr: '',
    status: 0,
    signal: null,
    ...overrides
  } as SpawnSyncLike
}

/** Valid batched verification envelope for the fixed plan (LOCK-QDB-17). */
function verifyEnvelope(counts: Record<string, unknown>, deletedTopics: unknown = 0): string {
  return JSON.stringify({
    ok: true,
    value: { integrity: [{ integrity_check: 'ok' }], fk: [], counts, deletedTopics }
  })
}

const VALID_COUNTS: Record<string, number> = {
  topics: 2,
  messages: 3,
  message_blocks: 4,
  topic_segments: 1,
  topic_segment_messages: 5,
  file_references: 6
}

describe('queryChatDbViaElectron — typed outcomes (LOCK-QDB-1/5)', () => {
  it('returns a typed success with rows and cleans its script', () => {
    const tmpDir = makeTempRoot()
    let scriptPath = ''
    let spawnEnv: NodeJS.ProcessEnv | undefined
    let writtenScript = ''
    try {
      const result = runChatDbQueryAttempt(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: (_command, args, options) => {
            scriptPath = String(args[0])
            spawnEnv = options?.env
            return makeSpawnResult({ stdout: '{"ok":true,"rows":[{"value":1}]}\n' })
          },
          writeFileSyncImpl: (p: string, content: string) => {
            writtenScript = content
            fs.writeFileSync(p, content)
          }
        })
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.rows).toEqual([{ value: 1 }])
        expect(result.attempt).toBe(1)
        expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
      }
      expect(spawnEnv).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir })
      expect(fs.existsSync(scriptPath)).toBe(false)
      expect(writtenScript).toContain('SELECT 1')
      expect(writtenScript).toContain('readonly: true')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it.each([
    ['SQL', 'no such table: chat_messages'],
    ['BUSY', 'SQLITE_BUSY: database is locked'],
    ['BUSY', 'database is busy'],
    ['LOCKED', 'SQLITE_LOCKED: database table is locked']
  ])('classifies a child failure message as %s', (expectedCode, message) => {
    const tmpDir = makeTempRoot()
    try {
      const result = runChatDbQueryAttempt(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => makeSpawnResult({ stdout: JSON.stringify({ ok: false, message }) })
        })
      )
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe(expectedCode)
        // LOCK-QDB-1: the raw message never reaches the outcome.
        expect(JSON.stringify(result)).not.toContain(message)
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('maps a spawn error to SPAWN without surfacing the raw error', () => {
    const tmpDir = makeTempRoot()
    try {
      const result = runChatDbQueryAttempt(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => makeSpawnResult({ error: new Error('spawn secret-detail ENOENT failed') })
        })
      )
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('SPAWN')
        expect(JSON.stringify(result)).not.toContain('secret-detail')
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('maps a timeout to TIMEOUT and keeps bounded numerics', () => {
    const tmpDir = makeTempRoot()
    try {
      const result = runChatDbQueryAttempt(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => {
            const error = new Error('spawn ETIMEDOUT') as Error & { code?: string }
            error.code = 'ETIMEDOUT'
            return makeSpawnResult({ error, signal: 'SIGTERM' })
          }
        })
      )
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('TIMEOUT')
        expect(result.signal).toBeUndefined()
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('maps a signal termination to SIGNAL with an allowlisted signal only', () => {
    const tmpDir = makeTempRoot()
    try {
      const result = runChatDbQueryAttempt(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => makeSpawnResult({ signal: 'SIGKILL' })
        })
      )
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('SIGNAL')
        expect(result.signal).toBe('SIGKILL')
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('maps a nonzero exit to EXIT with the bounded exitCode', () => {
    const tmpDir = makeTempRoot()
    try {
      const result = runChatDbQueryAttempt(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => makeSpawnResult({ status: 7, stderr: 'secret stderr content' })
        })
      )
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('EXIT')
        expect(result.exitCode).toBe(7)
        expect(JSON.stringify(result)).not.toContain('secret stderr')
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('maps empty stdout to EMPTY_OUTPUT', () => {
    const tmpDir = makeTempRoot()
    try {
      const result = runChatDbQueryAttempt(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => makeSpawnResult({ stdout: '' })
        })
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('EMPTY_OUTPUT')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('maps malformed JSON stdout to PARSE', () => {
    const tmpDir = makeTempRoot()
    try {
      const result = runChatDbQueryAttempt(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => makeSpawnResult({ stdout: '{"ok": true, broken' })
        })
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('PARSE')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('treats output without any envelope line as EMPTY_OUTPUT', () => {
    const tmpDir = makeTempRoot()
    try {
      const result = runChatDbQueryAttempt(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => makeSpawnResult({ stdout: JSON.stringify([1, 2, 3]) })
        })
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('EMPTY_OUTPUT')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('picks the last envelope line when earlier lines are noise', () => {
    const tmpDir = makeTempRoot()
    try {
      const result = runChatDbQueryAttempt(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => makeSpawnResult({ stdout: 'warning noise\n{"ok":true,"rows":[{"value":2}]}\n' })
        })
      )
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.rows).toEqual([{ value: 2 }])
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it.each([
    ['missing rows', { ok: true }],
    ['non-array rows', { ok: true, rows: 'nope' }],
    ['non-object row', { ok: true, rows: [42] }],
    ['missing message', { ok: false }],
    ['non-string message', { ok: false, message: 42 }],
    ['unknown ok value', { ok: 'maybe', rows: [] }]
  ])('fails closed on %s', (_label, envelope) => {
    const tmpDir = makeTempRoot()
    try {
      const result = runChatDbQueryAttempt(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => makeSpawnResult({ stdout: JSON.stringify(envelope) })
        })
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('INVALID_ENVELOPE')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('returns WRITE for an invalid tmpDir without calling spawn', () => {
    const parent = makeTempRoot()
    const realDir = path.join(parent, 'real')
    fs.mkdirSync(realDir)
    const symlinkTmp = path.join(parent, 'link')
    fs.symlinkSync(realDir, symlinkTmp, 'dir')
    let spawned = false
    try {
      const result = runChatDbQueryAttempt(
        '/tmp/chat.db',
        'SELECT 1',
        symlinkTmp,
        makeDeps({
          spawnSyncImpl: () => {
            spawned = true
            return makeSpawnResult({ stdout: '{"ok":true,"rows":[]}' })
          }
        })
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('WRITE')
      expect(spawned).toBe(false)
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it('returns WRITE when writing the script fails and cleans nothing left behind', () => {
    const tmpDir = makeTempRoot()
    let spawnCalled = false
    try {
      const result = runChatDbQueryAttempt(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => {
            spawnCalled = true
            return makeSpawnResult({ stdout: '{"ok":true,"rows":[]}' })
          },
          writeFileSyncImpl: () => {
            throw new Error('disk full')
          }
        })
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('WRITE')
      expect(spawnCalled).toBe(false)
      expect(fs.readdirSync(tmpDir)).toEqual([])
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('returns CLEANUP when the temp script cannot be removed even on success', () => {
    const tmpDir = makeTempRoot()
    try {
      const result = runChatDbQueryAttempt(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => makeSpawnResult({ stdout: '{"ok":true,"rows":[{"value":1}]}' }),
          unlinkSyncImpl: () => {
            throw new Error('permission denied')
          }
        })
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('CLEANUP')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('returns CLEANUP when the script still exists after unlink (verify absence)', () => {
    const tmpDir = makeTempRoot()
    try {
      const result = runChatDbQueryAttempt(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => makeSpawnResult({ stdout: '{"ok":true,"rows":[]}' }),
          existsSyncImpl: () => true
        })
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('CLEANUP')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('returns CLEANUP when the exists verification itself throws (LOCK-QDB-10)', () => {
    const tmpDir = makeTempRoot()
    try {
      const result = runChatDbQueryAttempt(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => makeSpawnResult({ stdout: '{"ok":true,"rows":[]}' }),
          unlinkSyncImpl: () => undefined,
          existsSyncImpl: () => {
            throw new Error('secret cleanup probe panic')
          }
        })
      )
      // The cleanup throw becomes a typed CLEANUP — it never escapes the helper.
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('CLEANUP')
        expect(JSON.stringify(result)).not.toContain('cleanup probe panic')
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('sanitizes a malformed injectable clock into bounded elapsedMs (LOCK-QDB-13)', () => {
    const tmpDir = makeTempRoot()
    try {
      const result = runChatDbQueryAttempt(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => makeSpawnResult({ stdout: '{"ok":true,"rows":[]}' }),
          now: () => Number.NaN
        })
      )
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.elapsedMs).toBe(0)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('drops malformed child exit codes from the typed outcome (LOCK-QDB-13)', () => {
    const tmpDir = makeTempRoot()
    try {
      for (const status of [Number.NaN, Number.POSITIVE_INFINITY, -3, 1.5, 1e15]) {
        const result = runChatDbQueryAttempt(
          '/tmp/chat.db',
          'SELECT 1',
          tmpDir,
          makeDeps({
            spawnSyncImpl: () => makeSpawnResult({ status })
          })
        )
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.code).toBe('EXIT')
          expect(result.exitCode).toBeUndefined()
        }
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('cleans the script on a spawn failure (LOCK-QDB-2)', () => {
    const tmpDir = makeTempRoot()
    try {
      const result = runChatDbQueryAttempt(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => makeSpawnResult({ error: new Error('spawn failed') })
        })
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('SPAWN')
      expect(fs.readdirSync(tmpDir)).toEqual([])
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('cleans the script on a parse failure and on a nonzero exit', () => {
    const tmpDir = makeTempRoot()
    try {
      const parseResult = runChatDbQueryAttempt(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => makeSpawnResult({ stdout: '{"ok": true, broken' })
        })
      )
      expect(parseResult.ok).toBe(false)
      if (!parseResult.ok) expect(parseResult.code).toBe('PARSE')
      expect(fs.readdirSync(tmpDir)).toEqual([])

      const exitResult = runChatDbQueryAttempt(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => makeSpawnResult({ status: 3 })
        })
      )
      expect(exitResult.ok).toBe(false)
      if (!exitResult.ok) expect(exitResult.code).toBe('EXIT')
      expect(fs.readdirSync(tmpDir)).toEqual([])
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('maps an unexpected runner throw to a fixed SPAWN code without the raw error', () => {
    const tmpDir = makeTempRoot()
    try {
      const result = runChatDbQueryAttempt(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => {
            throw new Error('secret runner panic')
          }
        })
      )
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('SPAWN')
        expect(JSON.stringify(result)).not.toContain('runner panic')
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('uses an injectable clock for elapsedMs', () => {
    const tmpDir = makeTempRoot()
    let time = 1000
    try {
      const result = runChatDbQueryAttempt(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => {
            time = 1500
            return makeSpawnResult({ stdout: '{"ok":true,"rows":[]}' })
          },
          now: () => time
        })
      )
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.elapsedMs).toBe(500)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('completely JS-encodes the SQL and db path into the child script (LOCK-QDB-11)', () => {
    const tmpDir = makeTempRoot()
    let writtenScript = ''
    try {
      runChatDbQueryAttempt(
        "/tmp/chat'\\db",
        "SELECT 'it''s'",
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => makeSpawnResult({ stdout: '{"ok":true,"rows":[]}' }),
          writeFileSyncImpl: (p: string, content: string) => {
            writtenScript = content
            fs.writeFileSync(p, content)
          }
        })
      )
      // The child script carries the complete JSON-literal form: the `'` stays
      // inside the double-quoted literal and the backslash becomes `\\`.
      expect(writtenScript).toContain(encodeJsStringLiteral("/tmp/chat'\\db"))
      expect(writtenScript).toContain(encodeJsStringLiteral("SELECT 'it''s'"))
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('keeps newline/CR/U+2028/U+2029 literals from breaking the child script (LOCK-QDB-11)', () => {
    const tmpDir = makeTempRoot()
    let writtenScript = ''
    try {
      const evilDbPath = '/tmp/chat\'\ndb\rCR\u2028LS\u2029PS"q'
      const evilSql = "SELECT 'a'\n-- c\r\n\u2028\u2029;"
      runChatDbQueryAttempt(
        evilDbPath,
        evilSql,
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => makeSpawnResult({ stdout: '{"ok":true,"rows":[]}' }),
          writeFileSyncImpl: (p: string, content: string) => {
            writtenScript = content
            fs.writeFileSync(p, content)
          }
        })
      )
      // The raw values (which contain line terminators) never appear verbatim.
      expect(writtenScript).not.toContain(evilDbPath)
      expect(writtenScript).not.toContain(evilSql)
      // The complete JS-literal forms appear and round-trip to the originals.
      const encodedDb = encodeJsStringLiteral(evilDbPath)
      const encodedSql = encodeJsStringLiteral(evilSql)
      expect(writtenScript).toContain(encodedDb)
      expect(writtenScript).toContain(encodedSql)
      // eslint-disable-next-line no-new-func
      expect(new Function(`return ${encodedDb}`)()).toBe(evilDbPath)
      // eslint-disable-next-line no-new-func
      expect(new Function(`return ${encodedSql}`)()).toBe(evilSql)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('encodeJsStringLiteral round-trips hostile values exactly (LOCK-QDB-11)', () => {
    const hostile = ["a'b", 'a\\b', 'line1\nline2', 'cr\rx', 'quote"d', '\u2028ls\u2029ps', 'tab\tx', 'ctrl\u0001']
    for (const value of hostile) {
      // The encoded literal must be a single valid JS string that round-trips.
      // eslint-disable-next-line no-new-func
      expect(new Function(`return ${encodeJsStringLiteral(value)}`)()).toBe(value)
    }
    // Line terminators are never embedded raw inside the literal.
    for (const value of ['line1\nline2', '\u2028ls', 'cr\rx']) {
      expect(encodeJsStringLiteral(value)).not.toContain(value)
    }
  })
})

describe('verifyChatDbViaElectron — fixed batched plan (LOCK-QDB-3/7)', () => {
  it('runs the whole plan in ONE child and returns fixed booleans/counts', () => {
    const tmpDir = makeTempRoot()
    let spawnCount = 0
    let writtenScript = ''
    try {
      const result = runChatDbVerifyAttempt(
        '/tmp/chat.db',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => {
            spawnCount += 1
            return makeSpawnResult({ stdout: verifyEnvelope(VALID_COUNTS) })
          },
          writeFileSyncImpl: (p: string, content: string) => {
            writtenScript = content
            fs.writeFileSync(p, content)
          }
        })
      )
      expect(spawnCount).toBe(1)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value).toEqual({
          integrityOk: true,
          foreignKeyViolations: 0,
          counts: VALID_COUNTS,
          deletedTopics: 0
        })
        expect(Object.keys(result.value.counts).sort()).toEqual([...VERIFICATION_TABLES].sort())
        expect(result.attempt).toBe(1)
      }
      // Fixed plan content: one connection, integrity + FK + the allowlisted
      // counts + the exact deleted-topics sibling (LOCK-QDB-17).
      expect(writtenScript).toContain('PRAGMA integrity_check')
      expect(writtenScript).toContain('PRAGMA foreign_key_check')
      for (const table of VERIFICATION_TABLES) {
        expect(writtenScript).toContain(table)
        expect(writtenScript).toContain('SELECT COUNT(*) AS n FROM "' + table + '"')
      }
      expect(writtenScript).toContain('SELECT COUNT(*) AS n FROM "topics" WHERE deleted_at IS NOT NULL')
      expect(writtenScript).toContain('deletedTopics')
      expect(writtenScript).toContain('readonly: true')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('carries the exact deletedTopics sibling from the same batched plan (LOCK-QDB-17)', () => {
    const tmpDir = makeTempRoot()
    try {
      const result = runChatDbVerifyAttempt(
        '/tmp/chat.db',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => makeSpawnResult({ stdout: verifyEnvelope(VALID_COUNTS, 3) })
        })
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.deletedTopics).toBe(3)
        // LOCK-QDB-17: the six counts keep their exact keys — deletedTopics is
        // a sibling, never a seventh counts key.
        expect(Object.keys(result.value.counts).sort()).toEqual([...VERIFICATION_TABLES].sort())
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it.each([
    ['no integrity rows', { ...VALID_COUNTS }, { integrity: [] }],
    ['two integrity rows', { ...VALID_COUNTS }, { integrity: [{ integrity_check: 'ok' }, { integrity_check: 'ok' }] }],
    ['non-ok integrity value', { ...VALID_COUNTS }, { integrity: [{ integrity_check: 'not ok' }] }],
    ['non-object integrity row', { ...VALID_COUNTS }, { integrity: ['ok'] }],
    ['extra key on integrity row', { ...VALID_COUNTS }, { integrity: [{ integrity_check: 'ok', extra: 1 }] }],
    ['missing integrity key on row', { ...VALID_COUNTS }, { integrity: [{ status: 'ok' }] }],
    ['non-empty FK', { ...VALID_COUNTS }, { fk: [{ table: 'topics', rowid: 1 }] }],
    ['missing counts table', { topics: 1 }, {}],
    ['negative count', { ...VALID_COUNTS, topics: -1 }, {}],
    ['fractional count', { ...VALID_COUNTS, messages: 1.5 }, {}],
    ['non-numeric count', { ...VALID_COUNTS, message_blocks: '4' }, {}],
    ['extra table in counts', { ...VALID_COUNTS, sqlite_sequence: 1 }, {}],
    ['missing deletedTopics', { ...VALID_COUNTS }, { deletedTopics: undefined }],
    ['negative deletedTopics', { ...VALID_COUNTS }, { deletedTopics: -1 }],
    ['fractional deletedTopics', { ...VALID_COUNTS }, { deletedTopics: 1.5 }],
    ['non-numeric deletedTopics', { ...VALID_COUNTS }, { deletedTopics: '3' }],
    ['extra key on verification value', { ...VALID_COUNTS }, { extraKey: true }],
    ['missing key on verification value', { ...VALID_COUNTS }, { fk: undefined, counts: VALID_COUNTS }]
  ])('fails closed when the batch is malformed: %s', (_label, counts, valueOverrides) => {
    const tmpDir = makeTempRoot()
    try {
      const stdout = JSON.stringify({
        ok: true,
        value: { integrity: [{ integrity_check: 'ok' }], fk: [], counts, deletedTopics: 0, ...valueOverrides }
      })
      const result = runChatDbVerifyAttempt(
        '/tmp/chat.db',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => makeSpawnResult({ stdout })
        })
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('INVALID_ENVELOPE')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('maps a child SQL failure inside the verify plan to a fixed code', () => {
    const tmpDir = makeTempRoot()
    try {
      const result = runChatDbVerifyAttempt(
        '/tmp/chat.db',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () =>
            makeSpawnResult({ stdout: JSON.stringify({ ok: false, message: 'SQLITE_BUSY: database is locked' }) })
        })
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('BUSY')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('cleans its script even when the batch validation fails', () => {
    const tmpDir = makeTempRoot()
    try {
      const result = runChatDbVerifyAttempt(
        '/tmp/chat.db',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => makeSpawnResult({ stdout: verifyEnvelope({ topics: -1 }) })
        })
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('INVALID_ENVELOPE')
      expect(fs.readdirSync(tmpDir)).toEqual([])
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('bounded retry (LOCK-QDB-4)', () => {
  it('recovers from a transient failure on a later attempt and stamps attempt', async () => {
    const tmpDir = makeTempRoot()
    let spawnCount = 0
    try {
      const outcome = await queryChatDbWithBoundedRetry(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => {
            spawnCount += 1
            return spawnCount === 1
              ? makeSpawnResult({ error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) })
              : makeSpawnResult({ stdout: '{"ok":true,"rows":[{"value":1}]}' })
          },
          sleep: async () => undefined
        })
      )
      expect(spawnCount).toBe(2)
      expect(outcome.ok).toBe(true)
      if (outcome.ok) expect(outcome.attempt).toBe(2)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('gives a deterministic 20s plan a >=20s first-attempt timeout and succeeds without retry (LOCK-QDB-15/16)', async () => {
    const tmpDir = makeTempRoot()
    let time = 0
    let spawnCount = 0
    const spawnTimeouts: number[] = []
    try {
      const outcome = await queryChatDbWithBoundedRetry(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: (_command, _args, options) => {
            spawnCount += 1
            spawnTimeouts.push(options?.timeout ?? 0)
            // Deterministic 20s plan: the child consumes exactly 20s and
            // succeeds — the 55s max budget comfortably covers it.
            time += 20_000
            return makeSpawnResult({ stdout: '{"ok":true,"rows":[{"value":1}]}' })
          },
          now: () => time
        })
      )
      // A successful first long attempt avoids any retry (LOCK-QDB-15).
      expect(spawnCount).toBe(1)
      expect(spawnTimeouts[0], 'first-attempt spawn timeout must cover a 20s plan').toBeGreaterThanOrEqual(20_000)
      expect(outcome.ok).toBe(true)
      if (outcome.ok) {
        expect(outcome.attempt).toBe(1)
        expect(outcome.elapsedMs).toBe(20_000)
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('clamps every spawn timeout to the remaining budget so a persistent timeout never exceeds the 60s total (LOCK-QDB-15/16)', async () => {
    const tmpDir = makeTempRoot()
    let time = 0
    let spawnCount = 0
    const spawnTimeouts: number[] = []
    try {
      const outcome = await queryChatDbWithBoundedRetry(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: (_command, _args, options) => {
            spawnCount += 1
            const timeout = options?.timeout ?? 0
            spawnTimeouts.push(timeout)
            // Realistic persistent-timeout child: burns exactly its own budget
            // (spawnSync kills it at the timeout) then reports a timeout.
            time += Math.min(20_000, timeout)
            return makeSpawnResult({ error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) })
          },
          now: () => time,
          sleep: async (ms: number) => {
            time += ms
          }
        })
      )
      // Attempt 1: min(55000, 60000)=55000; attempt 2: min(55000, 39750)=39750;
      // attempt 3: min(55000, 19250)=19250 — each clamped to the remaining
      // budget so no in-flight attempt can exceed the total deadline.
      expect(spawnCount).toBe(3)
      expect(spawnTimeouts).toEqual([55_000, 39_750, 19_250])
      // Total wall time never exceeds the fixed 60s total deadline.
      expect(time).toBeLessThanOrEqual(60_000)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.code).toBe('TIMEOUT')
        expect(outcome.attempt).toBe(3)
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('clamps each per-attempt spawn timeout to min(maxAttemptTimeout, remaining) (LOCK-QDB-15)', async () => {
    const tmpDir = makeTempRoot()
    let time = 0
    const spawnTimeouts: number[] = []
    try {
      const outcome = await queryChatDbWithBoundedRetry(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: (_command, _args, options) => {
            spawnTimeouts.push(options?.timeout ?? 0)
            time += 10_000
            return makeSpawnResult({ error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) })
          },
          now: () => time,
          sleep: async () => undefined
        }),
        { totalDeadlineMs: 30_000 }
      )
      // Attempt 1 is clamped by the caller deadline (30000); each later attempt
      // is clamped to the remaining budget: 30000 -> 20000 -> 10000.
      expect(spawnTimeouts).toEqual([30_000, 20_000, 10_000])
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.code).toBe('TIMEOUT')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('never starts an attempt when the remaining budget is exactly zero (LOCK-QDB-16)', async () => {
    const tmpDir = makeTempRoot()
    let time = 0
    let spawnCount = 0
    try {
      const outcome = await queryChatDbWithBoundedRetry(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => {
            spawnCount += 1
            time += 100
            return makeSpawnResult({ error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) })
          },
          now: () => time,
          sleep: async () => undefined
        }),
        { totalDeadlineMs: 100 }
      )
      // Attempt 1 consumes the entire 100ms budget; remaining is exactly 0, so
      // the retry wrapper must NOT start attempt 2.
      expect(spawnCount).toBe(1)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.code).toBe('TIMEOUT')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('never spawns when the pre-first-spawn remaining budget is already <= 0 (LOCK-QDB-16)', async () => {
    const tmpDir = makeTempRoot()
    let time = 0
    let spawnCount = 0
    try {
      const outcome = await queryChatDbWithBoundedRetry(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => {
            spawnCount += 1
            return makeSpawnResult({ error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) })
          },
          // Advancing clock: every read moves time forward, so with the
          // clamped 1ms deadline the remaining budget is already <= 0 when
          // computed before the first spawn.
          now: () => {
            time += 2
            return time
          }
        }),
        { totalDeadlineMs: 1 }
      )
      // No attempt, including attempt 1, may start once the remaining total
      // deadline is <= 0 — the guard fails closed without spawning.
      expect(spawnCount).toBe(0)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.code).toBe('TIMEOUT')
        // Typed surface carries only bounded numerics (LOCK-QDB-13).
        expect(Object.keys(outcome).sort()).toEqual(['attempt', 'code', 'elapsedMs', 'ok'])
        expect(outcome.attempt).toBe(1)
        expect(Number.isSafeInteger(outcome.elapsedMs)).toBe(true)
        expect(outcome.elapsedMs).toBeGreaterThanOrEqual(0)
        expect(outcome.elapsedMs).toBe(0)
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('exhausts all attempts for a persistent transient failure', async () => {
    const tmpDir = makeTempRoot()
    let spawnCount = 0
    const sleeps: number[] = []
    try {
      const outcome = await queryChatDbWithBoundedRetry(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => {
            spawnCount += 1
            return makeSpawnResult({ error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) })
          },
          sleep: async (ms: number) => {
            sleeps.push(ms)
          }
        })
      )
      expect(spawnCount).toBe(3)
      expect(sleeps).toEqual([250, 500])
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.code).toBe('TIMEOUT')
        expect(outcome.attempt).toBe(3)
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('never retries a permanent failure code', async () => {
    const tmpDir = makeTempRoot()
    let spawnCount = 0
    try {
      const outcome = await queryChatDbWithBoundedRetry(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => {
            spawnCount += 1
            return makeSpawnResult({ status: 1 })
          }
        })
      )
      expect(spawnCount).toBe(1)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.code).toBe('EXIT')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('honors the fixed total deadline and stops retrying when exhausted', async () => {
    const tmpDir = makeTempRoot()
    let time = 0
    let spawnCount = 0
    try {
      const outcome = await queryChatDbWithBoundedRetry(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => {
            spawnCount += 1
            time += 100
            return makeSpawnResult({ error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) })
          },
          now: () => time,
          sleep: async (ms: number) => {
            time += ms
          }
        }),
        { totalDeadlineMs: 10 }
      )
      // After attempt 1 (time=100) the deadline (10) is already exhausted.
      expect(spawnCount).toBe(1)
      expect(outcome.ok).toBe(false)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('bounds each backoff by the remaining deadline', async () => {
    const tmpDir = makeTempRoot()
    let time = 0
    const sleeps: number[] = []
    try {
      const outcome = await queryChatDbWithBoundedRetry(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => makeSpawnResult({ error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }),
          now: () => time,
          sleep: async (ms: number) => {
            sleeps.push(ms)
            time += ms
          }
        }),
        { totalDeadlineMs: 300 }
      )
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        // backoff 1 clamps 250 → 300 remaining, so the deadline bounds the wait.
        expect(sleeps[0]).toBeLessThanOrEqual(300)
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it.each([
    ['Infinity', Number.POSITIVE_INFINITY, 3],
    ['NaN', Number.NaN, 3],
    ['undefined', undefined, 3],
    ['huge (1e12)', 1e12, 3],
    ['negative (-5)', -5, 1],
    ['zero', 0, 1],
    ['fractional (2.9)', 2.9, 2],
    ['two', 2, 2]
  ])('clamps maxAttempts %s into [1,3] (LOCK-QDB-8)', async (_label, maxAttempts, expectedSpawns) => {
    const tmpDir = makeTempRoot()
    let spawnCount = 0
    try {
      await queryChatDbWithBoundedRetry(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => {
            spawnCount += 1
            return makeSpawnResult({ error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) })
          },
          sleep: async () => undefined
        }),
        { maxAttempts }
      )
      expect(spawnCount).toBe(expectedSpawns)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('clamps totalDeadlineMs into a finite [1,60000] bound (LOCK-QDB-8)', async () => {
    const tmpDir = makeTempRoot()
    // A caller-supplied negative/zero deadline still yields a minimum viable
    // 1ms deadline, and an absurdly huge/NaN/Infinity deadline yields the
    // fixed 60s production bound — never Infinity/NaN.
    expect(clampTotalDeadlineMs(-100)).toBe(1)
    expect(clampTotalDeadlineMs(0)).toBe(1)
    expect(clampTotalDeadlineMs(1e12)).toBe(60_000)
    expect(clampTotalDeadlineMs(Number.POSITIVE_INFINITY)).toBe(60_000)
    expect(clampTotalDeadlineMs(Number.NaN)).toBe(60_000)
    expect(clampTotalDeadlineMs(undefined)).toBe(60_000)
    expect(clampTotalDeadlineMs(300)).toBe(300)

    // With the clamped 1ms bound the deadline is exhausted after attempt 1.
    let time = 0
    let spawnCount = 0
    try {
      await queryChatDbWithBoundedRetry(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => {
            spawnCount += 1
            time += 100
            return makeSpawnResult({ error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) })
          },
          now: () => time,
          sleep: async () => undefined
        }),
        { totalDeadlineMs: -50 }
      )
      expect(spawnCount).toBe(1)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('does not start another attempt when the sleep overshoots the deadline (LOCK-QDB-8)', async () => {
    const tmpDir = makeTempRoot()
    let time = 0
    let spawnCount = 0
    try {
      const outcome = await queryChatDbWithBoundedRetry(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => {
            spawnCount += 1
            time += 100
            return makeSpawnResult({ error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) })
          },
          now: () => time,
          sleep: async (ms: number) => {
            // The sleep consumes the full remaining budget plus an overshoot.
            time += ms + 50
          }
        }),
        { totalDeadlineMs: 300 }
      )
      // Attempt 1 ends at time=100; remaining=200; backoff=min(250,200)=200;
      // the sleep overshoots to 350 >= deadline 300 → the retry stops.
      expect(spawnCount).toBe(1)
      expect(outcome.ok).toBe(false)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('privacy surface (LOCK-QDB-1/6)', () => {
  it('never exposes stderr/stdout/path/SQL/raw error in any outcome', () => {
    const tmpDir = makeTempRoot()
    const secret = {
      path: '/private/var/secret-user/Data/chat.db',
      sql: 'SELECT * FROM messages WHERE content LIKE "%secret%"',
      stderr: 'secret-stderr-payload',
      raw: 'secret-raw-error'
    }
    try {
      const outcomes: QueryChatDbOutcome[] = [
        runChatDbQueryAttempt(
          secret.path,
          secret.sql,
          tmpDir,
          makeDeps({
            spawnSyncImpl: () => makeSpawnResult({ error: new Error(secret.raw) })
          })
        ),
        runChatDbQueryAttempt(
          secret.path,
          secret.sql,
          tmpDir,
          makeDeps({
            spawnSyncImpl: () => makeSpawnResult({ status: 9, stderr: secret.stderr })
          })
        ),
        runChatDbQueryAttempt(
          secret.path,
          secret.sql,
          tmpDir,
          makeDeps({
            spawnSyncImpl: () => makeSpawnResult({ stdout: `${secret.stderr} {"ok":false,"message":"${secret.raw}"}` })
          })
        ),
        runChatDbQueryAttempt(
          secret.path,
          secret.sql,
          tmpDir,
          makeDeps({
            spawnSyncImpl: () => makeSpawnResult({ stdout: '{"ok":true,"rows":[]}' }),
            unlinkSyncImpl: () => {
              throw new Error(secret.raw)
            }
          })
        )
      ]
      for (const outcome of outcomes) {
        const serialized = JSON.stringify(outcome)
        for (const decoy of Object.values(secret)) {
          expect(serialized.includes(decoy), `outcome must not contain decoy`).toBe(false)
        }
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('exposes only allowlisted codes and bounded numerics on failure', () => {
    const tmpDir = makeTempRoot()
    try {
      const outcome = runChatDbQueryAttempt(
        '/tmp/chat.db',
        'SELECT 1',
        tmpDir,
        makeDeps({
          spawnSyncImpl: () => makeSpawnResult({ status: 2 })
        })
      )
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(QUERY_FAILURE_CODES).toContain(outcome.code)
        expect(Object.keys(outcome).sort()).toEqual(['attempt', 'code', 'elapsedMs', 'exitCode', 'ok'])
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('pure validation helpers (LOCK-QDB-7)', () => {
  it('isExactIntegrityOk', () => {
    expect(isExactIntegrityOk([{ integrity_check: 'ok' }])).toBe(true)
    expect(isExactIntegrityOk([])).toBe(false)
    expect(isExactIntegrityOk([{ integrity_check: 'ok' }, { integrity_check: 'ok' }])).toBe(false)
    expect(isExactIntegrityOk([{ integrity_check: 'corrupt' }])).toBe(false)
    expect(isExactIntegrityOk(['ok'])).toBe(false)
    expect(isExactIntegrityOk(null)).toBe(false)
    expect(isExactIntegrityOk({})).toBe(false)
    // LOCK-QDB-9: the integrity row must carry EXACTLY the integrity_check key.
    expect(isExactIntegrityOk([{ integrity_check: 'ok', extra: 1 }])).toBe(false)
    expect(isExactIntegrityOk([{ status: 'ok' }])).toBe(false)
  })

  it('isExactEmptyForeignKeyCheck', () => {
    expect(isExactEmptyForeignKeyCheck([])).toBe(true)
    expect(isExactEmptyForeignKeyCheck([{ table: 'topics' }])).toBe(false)
    expect(isExactEmptyForeignKeyCheck(null)).toBe(false)
    expect(isExactEmptyForeignKeyCheck({})).toBe(false)
    expect(isExactEmptyForeignKeyCheck('[]')).toBe(false)
  })

  it('isNonNegativeSafeInteger', () => {
    expect(isNonNegativeSafeInteger(0)).toBe(true)
    expect(isNonNegativeSafeInteger(42)).toBe(true)
    expect(isNonNegativeSafeInteger(-1)).toBe(false)
    expect(isNonNegativeSafeInteger(1.5)).toBe(false)
    expect(isNonNegativeSafeInteger(Number.MAX_SAFE_INTEGER)).toBe(true)
    expect(isNonNegativeSafeInteger(Number.MAX_SAFE_INTEGER + 1)).toBe(false)
    expect(isNonNegativeSafeInteger('4')).toBe(false)
    expect(isNonNegativeSafeInteger(null)).toBe(false)
  })

  it('isValidCountsRecord', () => {
    expect(isValidCountsRecord(VALID_COUNTS)).toBe(true)
    expect(isValidCountsRecord({ ...VALID_COUNTS, topics: -1 })).toBe(false)
    expect(isValidCountsRecord({ topics: 1 })).toBe(false)
    expect(isValidCountsRecord({})).toBe(false)
    expect(isValidCountsRecord(null)).toBe(false)
    expect(isValidCountsRecord([])).toBe(false)
  })

  it('isRetryableFailureCode matches the retry allowlist only', () => {
    expect(RETRYABLE_FAILURE_CODES).toEqual(['TIMEOUT', 'SPAWN', 'SIGNAL', 'BUSY', 'LOCKED'])
    for (const code of RETRYABLE_FAILURE_CODES) expect(isRetryableFailureCode(code)).toBe(true)
    for (const code of QUERY_FAILURE_CODES) {
      if (!RETRYABLE_FAILURE_CODES.includes(code)) expect(isRetryableFailureCode(code)).toBe(false)
    }
  })

  it('isExactKeySet (LOCK-QDB-9)', () => {
    expect(isExactKeySet({ integrity: 1, fk: [], counts: {} }, ['integrity', 'fk', 'counts'])).toBe(true)
    expect(isExactKeySet({ counts: {}, fk: [], integrity: 1 }, ['integrity', 'fk', 'counts'])).toBe(true)
    expect(isExactKeySet({ integrity: 1, fk: [] }, ['integrity', 'fk', 'counts'])).toBe(false)
    expect(isExactKeySet({ integrity: 1, fk: [], counts: {}, extra: true }, ['integrity', 'fk', 'counts'])).toBe(false)
    expect(isExactKeySet({ integrity: 1, fk: [], counts: {} }, ['integrity', 'counts'])).toBe(false)
  })

  it('sanitizeElapsedMs bounds every outcome timestamp (LOCK-QDB-13)', () => {
    expect(sanitizeElapsedMs(0)).toBe(0)
    expect(sanitizeElapsedMs(42)).toBe(42)
    expect(sanitizeElapsedMs(Number.NaN)).toBe(0)
    expect(sanitizeElapsedMs(Number.POSITIVE_INFINITY)).toBe(0)
    expect(sanitizeElapsedMs(-5)).toBe(0)
    expect(sanitizeElapsedMs(1e9)).toBe(600_000)
    expect(sanitizeElapsedMs(1.9)).toBe(1)
  })

  it('sanitizeExitCode keeps only valid bounded statuses (LOCK-QDB-13)', () => {
    expect(sanitizeExitCode(0)).toBe(0)
    expect(sanitizeExitCode(255)).toBe(255)
    expect(sanitizeExitCode(65535)).toBe(65535)
    expect(sanitizeExitCode(Number.NaN)).toBeUndefined()
    expect(sanitizeExitCode(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(sanitizeExitCode(-1)).toBeUndefined()
    expect(sanitizeExitCode(1.5)).toBeUndefined()
    expect(sanitizeExitCode(1e15)).toBeUndefined()
    expect(sanitizeExitCode(65536)).toBeUndefined()
    expect(sanitizeExitCode(null)).toBeUndefined()
    expect(sanitizeExitCode(undefined)).toBeUndefined()
  })

  it('clampMaxAttempts stays within [1,3] (LOCK-QDB-8)', () => {
    expect(clampMaxAttempts(undefined)).toBe(3)
    expect(clampMaxAttempts(Number.POSITIVE_INFINITY)).toBe(3)
    expect(clampMaxAttempts(Number.NaN)).toBe(3)
    expect(clampMaxAttempts(1e12)).toBe(3)
    expect(clampMaxAttempts(-5)).toBe(1)
    expect(clampMaxAttempts(0)).toBe(1)
    expect(clampMaxAttempts(2.9)).toBe(2)
    expect(clampMaxAttempts(2)).toBe(2)
  })

  it('resolveAttemptTimeoutMs = min(maxAttemptTimeout, remaining), never 0 (LOCK-QDB-15)', () => {
    expect(QUERY_MAX_ATTEMPT_TIMEOUT_MS).toBe(55_000)
    // Full remaining budgets clamp to the fixed 55s max.
    expect(resolveAttemptTimeoutMs(60_000)).toBe(55_000)
    expect(resolveAttemptTimeoutMs(55_000)).toBe(55_000)
    // Smaller remaining budgets pass through exactly.
    expect(resolveAttemptTimeoutMs(20_000)).toBe(20_000)
    expect(resolveAttemptTimeoutMs(39_750)).toBe(39_750)
    // A fractional positive remaining floors to at least 1ms — never a
    // spawnSync `timeout: 0` (which means "no timeout").
    expect(resolveAttemptTimeoutMs(0.5)).toBe(1)
    // Invalid inputs fall back to the fixed max budget (fail-closed: no
    // caller-supplied value can create a no-timeout spawn).
    expect(resolveAttemptTimeoutMs(0)).toBe(55_000)
    expect(resolveAttemptTimeoutMs(-5)).toBe(55_000)
    expect(resolveAttemptTimeoutMs(Number.NaN)).toBe(55_000)
    expect(resolveAttemptTimeoutMs(Number.POSITIVE_INFINITY)).toBe(55_000)
  })
})
