/**
 * Fresh-profile boot contract (startup ordering races).
 *
 * On a truly fresh disposable profile the app must:
 *   1. reach the ordinary home with the initial assistant carrying translated
 *      names (never raw `chat.default.*` keys) — i.e. App/store/fresh-assistant
 *      factories evaluated only after initial i18n resource activation;
 *   2. have the initial topic row present in Main SQLite before HomePage can
 *      read it (fresh-bootstrap create-only ensure ran before readiness).
 *
 * Evidence classes (§7):
 *   - Redux oracle: initial assistant/topic identity + translated names.
 *   - Live ChatDb IPC: `topicExists` for the exact initial topic ID.
 *   - SQLite persistence: exact topic row via Electron-binary query at the
 *     runtime path (live query — same pattern as the trash-lifecycle spec).
 *   - Boot log files: no fresh-default `Missing key` lines and no
 *     `Topic <id> does not exist` for the initial topic ID.
 *
 * LOCK-001: unique disposable profile via the shared fixture; no live data.
 * LOCK-002: mock provider only (fixture-seeded); no live APIs.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  expect,
  getChatDbPath,
  getRuntimeAppDataPath,
  queryChatDbViaElectron,
  test
} from '../../fixtures/electron.fixture'
import { waitForAppReady } from '../../utils/wait-helpers'

const esc = (value: string): string => value.replace(/'/g, "''")

/** Fail-closed SQLite row accessor: fixed failure code throws; rows only on success. */
function queryRows(dbPath: string, sql: string): any[] {
  const result = queryChatDbViaElectron(dbPath, sql)
  if (!result.ok) throw new Error(`SQLite query failed: ${result.code}`)
  return result.rows as any[]
}

/** Concatenate all renderer/main boot log files under the runtime appData path. */
function readBootLogs(appDataPath: string): string {
  const logsDir = path.join(appDataPath, 'logs')
  if (!fs.existsSync(logsDir)) return ''
  return fs
    .readdirSync(logsDir)
    .filter((file) => file.endsWith('.log'))
    .map((file) => {
      try {
        return fs.readFileSync(path.join(logsDir, file), 'utf-8')
      } catch {
        return ''
      }
    })
    .join('\n')
}

test.describe('Fresh-profile boot', () => {
  test('initial assistant/topic are translated and the initial topic exists in SQLite', async ({ mainWindow }) => {
    await waitForAppReady(mainWindow)

    // 1. Ordinary home is ready with the initial assistant (Redux oracle).
    const initial = await mainWindow.evaluate(() => {
      const s = (window as any).store.getState()
      const assistant = s.assistants.assistants.find((a: any) => a.id === 'default') ?? s.assistants.assistants[0]
      const topic = assistant?.topics?.[0]
      return {
        assistantId: assistant?.id ?? '',
        assistantName: assistant?.name ?? '',
        topicId: topic?.id ?? '',
        topicName: topic?.name ?? ''
      }
    })
    expect(initial.assistantId).toBe('default')
    // Translated values — never the raw i18n keys (any configured language).
    expect(initial.assistantName).not.toBe('chat.default.name')
    expect(initial.assistantName.length).toBeGreaterThan(0)
    expect(initial.topicId.length).toBeGreaterThan(0)
    expect(initial.topicName).not.toBe('chat.default.topic.name')
    expect(initial.topicName.length).toBeGreaterThan(0)

    // 2. Live ChatDb IPC: the initial topic exists (fresh-bootstrap ensure ran
    //    before the ordinary tree became ready).
    const existsResult = await mainWindow.evaluate(
      async ({ topicId }: { topicId: string }) => {
        return (window as any).api.chatDb.topicExists({ topicId })
      },
      { topicId: initial.topicId }
    )
    expect(existsResult?.ok).toBe(true)
    expect(existsResult?.value).toBe(true)

    // 3. Durable proof: the exact topic row is in chat.db at the runtime path.
    const dbPath = getChatDbPath()
    expect(dbPath).not.toBeNull()
    const rows = queryRows(
      dbPath as string,
      `SELECT id, assistant_id, name FROM topics WHERE id = '${esc(initial.topicId)}'`
    )
    expect(rows.length).toBe(1)
    expect(rows[0].assistant_id).toBe('default')

    // 4. Boot logs carry no fresh-default missing-key lines and no NOT_FOUND
    // for the initial topic ID. The log corpus must be non-empty — otherwise
    // the absence assertions would pass vacuously.
    const appDataPath = getRuntimeAppDataPath()
    expect(appDataPath).not.toBeNull()
    const logs = readBootLogs(appDataPath as string)
    expect(logs.length).toBeGreaterThan(0)
    expect(logs).not.toContain('Missing key: chat.default.name')
    expect(logs).not.toContain('Missing key: chat.default.topic.name')
    expect(logs).not.toContain(`Topic ${initial.topicId} does not exist`)
  })
})
