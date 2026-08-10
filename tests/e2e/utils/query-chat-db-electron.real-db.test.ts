/**
 * LOCK-QDB-14/17: real disposable SQLite integration test.
 *
 * Runs the ACTUAL generated batched verification script (the same script the
 * helper writes for `runChatDbVerifyAttempt`) under the installed Electron
 * binary (ABI 145) with the real better-sqlite3 native module, against a real
 * disposable SQLite file. Proves, end to end:
 *
 *   1. integrity_check returns exactly one `ok` row on a well-formed DB,
 *   2. foreign_key_check is exactly empty on an FK-consistent DB and is
 *      detected (fail-closed INVALID_ENVELOPE) on a DB with an orphan row,
 *   3. the six allowlisted table counts are exact and typed,
 *   4. LOCK-QDB-17: the `deletedTopics` sibling is the EXACT
 *      `SELECT COUNT(*) ... WHERE deleted_at IS NOT NULL` count from the SAME
 *      readonly child/connection — 0 on a fixture with no deleted topics and
 *      3 on a fixture with exactly 3 deleted topics,
 *   5. the plan is readonly — the DB file stays byte-identical and no WAL/SHM
 *      sidecar appears,
 *   6. one-spawn semantics — the verify plan runs in exactly ONE child.
 *
 * The mocked failure-matrix tests in `query-chat-db-electron.test.ts` are
 * KEPT — this file adds the real-binding proof on top.
 *
 * This file is a Node-lane Vitest unit test (`e2e-utils` project, covered by
 * the Node-lane `pnpm test` aggregate) — NOT a Playwright E2E spec, and it
 * never requires a manual Electron ABI preflight (`pnpm native:check:electron`).
 * It spawns the installed Electron binary (as node) to execute the generated
 * verify script; the Electron child can load the better-sqlite3 binding only
 * when the current checkout binding is Electron ABI145. The supported
 * Node-lane invocations (`pnpm test` / `pnpm test:e2e-utils`) self-ensure the
 * Node ABI137 binding for the duration of the run, so this file's real-DB
 * assertions intentionally skip there — a deliberate, non-flaky skip. The
 * integrated real Electron binding proof is provided by the Playwright E2E
 * fixture specs under the canonical `pnpm test:e2e`, which self-ensures the
 * Electron ABI145 lane before launching.
 *
 * Runtime is bounded: a handful of small Electron spawns (~1-2s each) plus
 * per-test cleanup that removes the exact disposable temp dir.
 */
import { createRequire } from 'node:module'
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { encodeJsStringLiteral, runChatDbVerifyAttempt, type VerificationCounts } from './query-chat-db-electron'

const require = createRequire(import.meta.url)
const electronPath = (): string => require('electron') as string
const betterSqlitePath = (): string => require.resolve('better-sqlite3')

/** Minimal production-shaped schema for the six allowlisted tables. */
const FIXTURE_SCHEMA = `
  CREATE TABLE topics (
    id TEXT PRIMARY KEY,
    assistant_id TEXT,
    name TEXT,
    created_at TEXT,
    updated_at TEXT,
    deleted_at TEXT,
    extra TEXT
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES topics(id),
    role TEXT,
    content TEXT,
    status TEXT,
    ask_id TEXT,
    model TEXT,
    created_at TEXT,
    sort_order INTEGER,
    extra TEXT
  );
  CREATE TABLE message_blocks (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id),
    type TEXT,
    content TEXT,
    sort_order INTEGER,
    extra TEXT
  );
  CREATE TABLE topic_segments (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES topics(id),
    sort_order INTEGER,
    extra TEXT
  );
  CREATE TABLE topic_segment_messages (
    segment_id TEXT NOT NULL REFERENCES topic_segments(id),
    message_id TEXT NOT NULL REFERENCES messages(id),
    sort_order INTEGER,
    PRIMARY KEY (segment_id, message_id)
  );
  CREATE TABLE file_references (
    id TEXT PRIMARY KEY,
    message_id TEXT REFERENCES messages(id),
    file_id TEXT NOT NULL,
    file_name TEXT,
    file_path TEXT,
    file_type TEXT,
    count INTEGER,
    extra TEXT
  );
`

/** Exact six-count expectation for the well-formed fixture DB. */
const FIXTURE_COUNTS: VerificationCounts = {
  topics: 2,
  messages: 3,
  message_blocks: 4,
  topic_segments: 1,
  topic_segment_messages: 2,
  file_references: 1
}

/** FK-consistent fixture rows matching FIXTURE_COUNTS. */
const FIXTURE_ROWS = `
  INSERT INTO topics (id) VALUES ('t1'), ('t2');
  INSERT INTO messages (id, topic_id, role, status, content) VALUES
    ('m1', 't1', 'user', 'success', 'a'),
    ('m2', 't1', 'assistant', 'success', 'b'),
    ('m3', 't2', 'user', 'success', 'c');
  INSERT INTO message_blocks (id, message_id, type, content) VALUES
    ('b1', 'm1', 'text', 'a'),
    ('b2', 'm2', 'text', 'b'),
    ('b3', 'm3', 'text', 'c'),
    ('b4', 'm1', 'text', 'a2');
  INSERT INTO topic_segments (id, topic_id) VALUES ('s1', 't1');
  INSERT INTO topic_segment_messages (segment_id, message_id) VALUES ('s1', 'm1'), ('s1', 'm2');
  INSERT INTO file_references (id, message_id, file_id, file_name) VALUES ('f1', 'm1', 'fid-1', 'photo.png');
`

/**
 * FK-violating fixture: an orphan `messages` row whose topic_id references a
 * topic that does not exist (created without foreign_keys enforcement so the
 * row is insertable; `PRAGMA foreign_key_check` still reports it).
 */
const FK_VIOLATION_ROWS = `
  INSERT INTO topics (id) VALUES ('t1');
  INSERT INTO messages (id, topic_id, role, status, content) VALUES ('m-orphan', 'ghost-topic', 'user', 'success', 'x');
`

/**
 * LOCK-QDB-17: deleted-topics fixture — exactly three topics with a
 * non-NULL `deleted_at` (and no others), so the exact
 * `SELECT COUNT(*) ... WHERE deleted_at IS NOT NULL` sibling must be 3.
 */
const DELETED_TOPICS_ROWS = `
  INSERT INTO topics (id, deleted_at) VALUES
    ('t-del-1', '2026-01-01T00:00:00.000Z'),
    ('t-del-2', '2026-02-01T00:00:00.000Z'),
    ('t-del-3', '2026-03-01T00:00:00.000Z');
`

function makeTempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

/** Spawn a generated JS script under the installed Electron binary (as node). */
function runElectronScript(scriptPath: string): {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
} {
  const result = spawnSync(electronPath(), [scriptPath], {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error }
}

/**
 * Create the fixture DB by writing a generated create-script into the temp dir
 * and running it under Electron. The script is created and removed inside this
 * function; the DB file itself is caller-owned (removed with the temp root).
 *
 * better-sqlite3 enables `foreign_keys` by default, so `enforceForeignKeys`
 * must be false to insert an intentionally violating row (the verify child's
 * `PRAGMA foreign_key_check` still reports the violation on its own
 * connection regardless of the pragma).
 */
function createFixtureDb(dbPath: string, rows: string, enforceForeignKeys = true): void {
  const scriptPath = path.join(path.dirname(dbPath), 'create-fixture-db.js')
  const pragma = enforceForeignKeys ? 'db.pragma("foreign_keys = ON");' : 'db.pragma("foreign_keys = OFF");'
  const script = `
    const Database = require(${encodeJsStringLiteral(betterSqlitePath())});
    const db = new Database(${encodeJsStringLiteral(dbPath)});
    ${pragma}
    db.exec(${encodeJsStringLiteral(FIXTURE_SCHEMA)});
    db.exec(${encodeJsStringLiteral(rows)});
    db.close();
    console.log(JSON.stringify({ ok: true }));
  `
  try {
    fs.writeFileSync(scriptPath, script)
    const result = runElectronScript(scriptPath)
    if (result.status !== 0 || result.error) {
      throw new Error(
        `fixture DB creation failed: status=${String(result.status)} error=${result.error ? 'yes' : 'no'}`
      )
    }
  } finally {
    try {
      fs.unlinkSync(scriptPath)
    } catch {
      // Best-effort: the temp root teardown owns the definitive cleanup.
    }
  }
}

/** ABI probe: can the installed Electron binary load better-sqlite3? */
function probeElectronAbi(): { ok: boolean } {
  const tmpDir = makeTempRoot('e2e-qdb-abi-probe-')
  try {
    const scriptPath = path.join(tmpDir, 'abi-probe.js')
    const script = `
      const Database = require(${encodeJsStringLiteral(betterSqlitePath())});
      const db = new Database(':memory:');
      const ok = db.prepare('select 1 as ok').get().ok;
      db.close();
      console.log(JSON.stringify({ ok: ok === 1 }));
    `
    fs.writeFileSync(scriptPath, script)
    const result = runElectronScript(scriptPath)
    if (result.status !== 0 || result.error || !result.stdout.includes('"ok":true')) {
      return { ok: false }
    }
    return { ok: true }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

const abiProbe = probeElectronAbi()
console.log(
  `[E2E] real-DB helper ABI probe: ${abiProbe.ok ? 'PASS (Electron ABI145 binding)' : 'SKIP (no Electron-ABI better-sqlite3 binding)'}`
)

describe('real disposable SQLite verification under Electron (LOCK-QDB-14)', () => {
  it.skipIf(!abiProbe.ok)(
    'runs the generated batched verify plan against a real DB: integrity/FK/six counts/readonly/one-spawn',
    () => {
      const tmpDir = makeTempRoot('e2e-qdb-real-db-')
      const dbPath = path.join(tmpDir, 'fixture-chat.db')
      try {
        createFixtureDb(dbPath, FIXTURE_ROWS)
        expect(fs.existsSync(dbPath), 'fixture DB must be created').toBe(true)
        const beforeHash = sha256File(dbPath)

        // One-spawn semantics: wrap the real spawnSync to count children.
        let spawnCount = 0
        const realSpawnSync = spawnSync
        const outcome = runChatDbVerifyAttempt(dbPath, tmpDir, {
          electronPath: electronPath(),
          betterSqlitePath: betterSqlitePath(),
          spawnSyncImpl: (command, args, options: SpawnSyncOptionsWithStringEncoding) => {
            spawnCount += 1
            return realSpawnSync(command, args, options) as SpawnSyncReturns<string>
          }
        })

        // The whole plan ran in exactly ONE real Electron child.
        expect(spawnCount).toBe(1)

        // Integrity / FK / exact typed six counts.
        expect(outcome.ok, `real verify failed: ${outcome.ok ? 'n/a' : outcome.code}`).toBe(true)
        if (outcome.ok) {
          expect(outcome.value.integrityOk).toBe(true)
          expect(outcome.value.foreignKeyViolations).toBe(0)
          expect(outcome.value.counts).toEqual(FIXTURE_COUNTS)
          // LOCK-QDB-17: no topic in FIXTURE_ROWS carries a deleted_at, so the
          // exact deletedTopics sibling from the same snapshot is 0.
          expect(outcome.value.deletedTopics).toBe(0)
          // Fixed typed shape: exactly the six allowlisted tables, all safe
          // non-negative integers.
          expect(Object.keys(outcome.value.counts).sort()).toEqual([
            'file_references',
            'message_blocks',
            'messages',
            'topic_segment_messages',
            'topic_segments',
            'topics'
          ])
        }

        // Readonly: the DB file is byte-identical after the readonly plan and
        // no WAL/SHM sidecar appeared.
        expect(sha256File(dbPath)).toBe(beforeHash)
        expect(fs.existsSync(`${dbPath}-wal`)).toBe(false)
        expect(fs.existsSync(`${dbPath}-shm`)).toBe(false)
        expect(fs.existsSync(`${dbPath}-journal`)).toBe(false)
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    },
    60_000
  )

  it.skipIf(!abiProbe.ok)(
    'detects real foreign-key violations fail-closed (INVALID_ENVELOPE)',
    () => {
      const tmpDir = makeTempRoot('e2e-qdb-real-fk-')
      const dbPath = path.join(tmpDir, 'fk-violation-chat.db')
      try {
        createFixtureDb(dbPath, FK_VIOLATION_ROWS, false)
        const outcome = runChatDbVerifyAttempt(dbPath, tmpDir, {
          electronPath: electronPath(),
          betterSqlitePath: betterSqlitePath()
        })
        // A non-empty foreign_key_check is an exact-envelope violation.
        expect(outcome.ok).toBe(false)
        if (!outcome.ok) expect(outcome.code).toBe('INVALID_ENVELOPE')
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    },
    60_000
  )

  it.skipIf(!abiProbe.ok)(
    'proves deletedTopics is the exact COUNT(*) WHERE deleted_at IS NOT NULL in the same readonly child (LOCK-QDB-17)',
    () => {
      const tmpDir = makeTempRoot('e2e-qdb-real-deleted-')
      const dbPath = path.join(tmpDir, 'deleted-topics-chat.db')
      try {
        createFixtureDb(dbPath, DELETED_TOPICS_ROWS)
        expect(fs.existsSync(dbPath), 'fixture DB must be created').toBe(true)
        const beforeHash = sha256File(dbPath)

        let spawnCount = 0
        const realSpawnSync = spawnSync
        const outcome = runChatDbVerifyAttempt(dbPath, tmpDir, {
          electronPath: electronPath(),
          betterSqlitePath: betterSqlitePath(),
          spawnSyncImpl: (command, args, options: SpawnSyncOptionsWithStringEncoding) => {
            spawnCount += 1
            return realSpawnSync(command, args, options) as SpawnSyncReturns<string>
          }
        })

        // The deleted-topics proof still runs in exactly ONE real child.
        expect(spawnCount).toBe(1)
        expect(outcome.ok, `real verify failed: ${outcome.ok ? 'n/a' : outcome.code}`).toBe(true)
        if (outcome.ok) {
          expect(outcome.value.integrityOk).toBe(true)
          expect(outcome.value.foreignKeyViolations).toBe(0)
          // Exactly three topics exist and ALL of them are deleted — the
          // sibling count is exact in the same snapshot as the six counts.
          expect(outcome.value.counts.topics).toBe(3)
          expect(outcome.value.deletedTopics).toBe(3)
          // The active algebra is provable from the SAME snapshot.
          expect(outcome.value.counts.topics - outcome.value.deletedTopics).toBe(0)
          for (const table of [
            'messages',
            'message_blocks',
            'topic_segments',
            'topic_segment_messages',
            'file_references'
          ]) {
            expect(outcome.value.counts[table as keyof typeof outcome.value.counts]).toBe(0)
          }
        }

        // Readonly: the DB file is byte-identical and no sidecar appeared.
        expect(sha256File(dbPath)).toBe(beforeHash)
        expect(fs.existsSync(`${dbPath}-wal`)).toBe(false)
        expect(fs.existsSync(`${dbPath}-shm`)).toBe(false)
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    },
    60_000
  )
})
