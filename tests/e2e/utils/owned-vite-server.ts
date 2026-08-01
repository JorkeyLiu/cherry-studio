import { type ChildProcess, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'

const PORT = 5173
const READINESS_TIMEOUT_MS = 90_000
const STOP_GRACE_MS = 5_000
const CHAT_IMPORT_PATH = '/src/windows/chatImport/chatImport.html'
const CHAT_IMPORT_ENTRY_PATH = '/src/windows/chatImport/entryPoint.ts'

export interface OwnedViteServer {
  readonly pid: number
  stop(): Promise<void>
}

interface ChildReadyMessage {
  type: 'ready'
  port: number
  host: string
  origin: string
  base: string
  url: string
}

interface ChildErrorMessage {
  type: 'error'
  message: string
}

type ChildMessage = ChildReadyMessage | ChildErrorMessage

export interface OwnedViteServerOptions {
  childModulePath?: string
  port?: number
  readinessTimeoutMs?: number
  stopGraceMs?: number
  spawnImpl?: typeof spawn
  assertPortAvailableImpl?: (port: number) => Promise<void>
  probeReadyImpl?: (port: number, timeoutMs: number) => Promise<boolean>
}

export function httpGet(url: string, timeoutMs: number): Promise<{ status: number; ok: boolean }> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      response.resume()
      const status = response.statusCode ?? 0
      resolve({ status, ok: status === 200 })
    })
    request.once('error', reject)
    request.once('timeout', () => {
      request.destroy()
      reject(new Error(`HTTP probe timed out after ${timeoutMs}ms: ${url}`))
    })
  })
}

async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = http.createServer()
    server.once('error', reject)
    server.listen(port, 'localhost', () => server.close(() => resolve()))
  })
}

async function probeChatImportReady(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const [html, entry] = await Promise.all([
        httpGet(`http://localhost:${port}${CHAT_IMPORT_PATH}`, 5000),
        httpGet(`http://localhost:${port}${CHAT_IMPORT_ENTRY_PATH}`, 5000)
      ])
      if (html.status === 200 && entry.status === 200) return true
    } catch {
      // Continue probing while Vite starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

function childIsAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
}

export function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode)
      return
    }

    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    const onExit = (code: number | null) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(code)
    }
    const onError = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(`Child process did not exit within ${timeoutMs}ms`))
    }, timeoutMs)

    child.once('exit', onExit)
    child.once('error', onError)
  })
}

function validateReadyMessage(message: ChildMessage, port: number): ChildReadyMessage {
  if (!message || message.type !== 'ready') {
    throw new Error(`[E2E] Vite child reported an invalid readiness message: ${JSON.stringify(message)}`)
  }
  const expectedOrigin = `http://localhost:${port}`
  if (
    message.host !== 'localhost' ||
    message.port !== port ||
    message.origin !== expectedOrigin ||
    message.base !== '/' ||
    message.url !== expectedOrigin
  ) {
    throw new Error(
      `[E2E] Vite child readiness mismatch: expected host=localhost port=${port} origin=${expectedOrigin} base=/ url=${expectedOrigin}; ` +
        `received ${JSON.stringify(message)}`
    )
  }
  return message
}

async function confirmChildAlive(child: ChildProcess): Promise<void> {
  if (!childIsAlive(child)) throw new Error('[E2E] Vite child exited before HTTP readiness settled')
  await new Promise<void>((resolve) => setImmediate(resolve))
  if (!childIsAlive(child)) throw new Error('[E2E] Vite child exited before HTTP readiness settled')
}

async function waitForReadiness(
  child: ChildProcess,
  port: number,
  timeoutMs: number,
  probeReady: (port: number, timeoutMs: number) => Promise<boolean>,
  stdoutCapture: () => string,
  stderrCapture: () => string
): Promise<ChildReadyMessage> {
  return new Promise((resolve, reject) => {
    let settled = false
    let readyMessage: ChildReadyMessage | null = null
    let probing = false
    const cleanup = () => {
      clearTimeout(timer)
      child.off('message', onMessage)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    const settleError = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const settleReady = async () => {
      if (settled || !readyMessage) return
      try {
        await confirmChildAlive(child)
        settled = true
        cleanup()
        resolve(readyMessage)
      } catch (error) {
        settleError(error instanceof Error ? error : new Error(String(error)))
      }
    }
    const probeAfterIpcReady = async () => {
      if (probing || settled || !readyMessage) return
      probing = true
      try {
        if (!(await probeReady(port, timeoutMs))) {
          settleError(new Error(`[E2E] Vite HTTP readiness failed for ${readyMessage.url}`))
          return
        }
        await settleReady()
      } catch (error) {
        settleError(error instanceof Error ? error : new Error(String(error)))
      } finally {
        probing = false
      }
    }
    const onMessage = (message: ChildMessage) => {
      if (settled || readyMessage) return
      if (message?.type === 'error') {
        settleError(new Error(`[E2E] Vite child reported error: ${message.message}`))
        return
      }
      try {
        readyMessage = validateReadyMessage(message, port)
        void probeAfterIpcReady()
      } catch (error) {
        settleError(error instanceof Error ? error : new Error(String(error)))
      }
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const detail = code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`
      settleError(
        new Error(
          `[E2E] Vite child exited with ${detail} before HTTP readiness. stdout: ${stdoutCapture()} stderr: ${stderrCapture()}`
        )
      )
    }
    const onError = (error: Error) => settleError(new Error(`[E2E] Vite child process error: ${error.message}`))
    const timer = setTimeout(
      () =>
        settleError(
          new Error(
            `[E2E] Vite child did not become ready within ${timeoutMs}ms. stdout: ${stdoutCapture()} stderr: ${stderrCapture()}`
          )
        ),
      timeoutMs
    )
    child.on('message', onMessage)
    child.on('exit', onExit)
    child.on('error', onError)
    if (!childIsAlive(child)) onExit(child.exitCode, child.signalCode)
  })
}

async function terminateOwnedChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (!childIsAlive(child)) return
  try {
    child.kill('SIGTERM')
  } catch {
    // The child may already have exited.
  }
  try {
    await waitForChildExit(child, graceMs)
    return
  } catch {
    // Escalate only the exact child process handle we spawned.
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // The child may already have exited.
  }
  await waitForChildExit(child, graceMs).catch(() => undefined)
}

function validateOwnedTmpRoot(ownedTmpRoot: string): string {
  const absoluteRoot = path.resolve(ownedTmpRoot)
  if (!path.isAbsolute(ownedTmpRoot)) throw new Error(`ownedTmpRoot must be absolute: ${ownedTmpRoot}`)
  const stat = fs.lstatSync(absoluteRoot)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`ownedTmpRoot must be a real non-symlink directory: ${ownedTmpRoot}`)
  }
  return absoluteRoot
}

async function startOwnedViteServerImpl(
  projectRoot: string,
  ownedTmpRoot: string,
  options: OwnedViteServerOptions = {}
): Promise<OwnedViteServer> {
  const port = options.port ?? PORT
  const readinessTimeoutMs = options.readinessTimeoutMs ?? READINESS_TIMEOUT_MS
  const stopGraceMs = options.stopGraceMs ?? STOP_GRACE_MS
  const ownedRoot = validateOwnedTmpRoot(ownedTmpRoot)
  const assertAvailable = options.assertPortAvailableImpl ?? assertPortAvailable
  const probeReady = options.probeReadyImpl ?? probeChatImportReady
  await assertAvailable(port)

  const childModulePath =
    options.childModulePath ?? path.join(projectRoot, 'tests', 'e2e', 'utils', 'vite-server-child.mjs')
  const spawnImpl = options.spawnImpl ?? spawn
  const child = spawnImpl(process.execPath, [childModulePath, projectRoot, String(port)], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      FORCE_COLOR: '0',
      TMPDIR: ownedRoot,
      TMP: ownedRoot,
      TEMP: ownedRoot,
      CHERRY_E2E_VITE_PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += String(chunk)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += String(chunk)
  })

  try {
    await waitForReadiness(
      child,
      port,
      readinessTimeoutMs,
      probeReady,
      () => stdout.slice(0, 500),
      () => stderr.slice(0, 500)
    )
  } catch (error) {
    await terminateOwnedChild(child, 2000)
    try {
      await assertAvailable(port)
    } catch (portError) {
      throw new AggregateError([error, portError], `Vite startup failed and port ${port} remains occupied`)
    }
    throw error
  }

  let stopped = false
  return {
    pid: child.pid!,
    stop: async () => {
      if (stopped) return
      await terminateOwnedChild(child, stopGraceMs)
      if (childIsAlive(child)) throw new Error(`Vite child ${child.pid} did not exit; cleanup is retryable`)
      await assertAvailable(port)
      stopped = true
    }
  }
}

export function startOwnedViteServer(projectRoot: string, ownedTmpRoot: string): Promise<OwnedViteServer> {
  return startOwnedViteServerImpl(projectRoot, ownedTmpRoot)
}

/** Test-only entry point; production callers remain fixed to the exact origin contract. */
export function startOwnedViteServerForTest(
  projectRoot: string,
  ownedTmpRoot: string,
  options: OwnedViteServerOptions
): Promise<OwnedViteServer> {
  return startOwnedViteServerImpl(projectRoot, ownedTmpRoot, options)
}

export async function probeChatImportEntry(): Promise<{ ok: boolean; status: number }> {
  try {
    const [html, entry] = await Promise.all([
      httpGet(`http://localhost:${PORT}${CHAT_IMPORT_PATH}`, 10_000),
      httpGet(`http://localhost:${PORT}${CHAT_IMPORT_ENTRY_PATH}`, 10_000)
    ])
    return { status: html.status, ok: html.status === 200 && entry.status === 200 }
  } catch {
    return { ok: false, status: 0 }
  }
}
