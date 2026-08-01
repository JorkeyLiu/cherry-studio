import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface QueryChatDbDependencies {
  electronPath: string
  betterSqlitePath: string
  spawnSyncImpl?: typeof spawnSync
  writeFileSyncImpl?: typeof fs.writeFileSync
  unlinkSyncImpl?: typeof fs.unlinkSync
  existsSyncImpl?: typeof fs.existsSync
}

function escapeJavaScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function parseResult(output: string): Record<string, unknown> | null {
  for (const line of output.trim().split('\n').reverse()) {
    if (line.trim().startsWith('{')) return JSON.parse(line) as Record<string, unknown>
  }
  return null
}

function validateTmpDir(tmpDir: string): string {
  if (!path.isAbsolute(tmpDir)) throw new Error(`tmpDir must be absolute: ${tmpDir}`)
  const absoluteTmpDir = path.resolve(tmpDir)
  const stat = fs.lstatSync(absoluteTmpDir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`tmpDir must be a real non-symlink directory: ${tmpDir}`)
  }
  return absoluteTmpDir
}

export function queryChatDbViaElectron(
  dbPath: string,
  sql: string,
  tmpDir: string,
  dependencies: QueryChatDbDependencies
): Record<string, unknown> | null {
  const validatedTmpDir = validateTmpDir(tmpDir)
  const tmpScript = path.join(
    validatedTmpDir,
    `e2e-sqlite-query-${Date.now()}-${Math.random().toString(36).slice(2)}.js`
  )
  const script = `
    const Database = require('${escapeJavaScriptString(dependencies.betterSqlitePath)}');
    try {
      const db = new Database('${escapeJavaScriptString(dbPath)}', { readonly: true });
      const result = db.prepare('${escapeJavaScriptString(sql)}').all();
      console.log(JSON.stringify({ ok: true, rows: result }));
      db.close();
    } catch (err) {
      console.log(JSON.stringify({ ok: false, error: err.message }));
    }
  `
  const writeFile = dependencies.writeFileSyncImpl ?? fs.writeFileSync
  const unlink = dependencies.unlinkSyncImpl ?? fs.unlinkSync
  const exists = dependencies.existsSyncImpl ?? fs.existsSync
  const spawn = dependencies.spawnSyncImpl ?? spawnSync
  writeFile(tmpScript, script, 'utf8')
  let pendingError: unknown = null
  try {
    const result = spawn(dependencies.electronPath, [tmpScript], {
      timeout: 15000,
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
    if (result.error) {
      pendingError = result.error
      return null
    }
    if (result.status !== 0) {
      pendingError = new Error(`Electron query exited ${result.status}: ${String(result.stderr ?? '').trim()}`)
      return null
    }
    return parseResult(result.stdout ?? '')
  } catch (error) {
    pendingError = error
    throw error
  } finally {
    let cleanupError: Error | null = null
    try {
      unlink(tmpScript)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        cleanupError = new Error(
          `Failed to remove query script ${tmpScript}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    if (!cleanupError && exists(tmpScript)) cleanupError = new Error(`Query script still exists: ${tmpScript}`)
    if (cleanupError) {
      const message = pendingError instanceof Error ? pendingError.message : pendingError ? String(pendingError) : ''
      throw new Error(`${cleanupError.message}${message ? ` (original error: ${message})` : ''}`)
    }
  }
}
