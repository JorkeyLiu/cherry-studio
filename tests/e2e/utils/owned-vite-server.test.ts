import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { httpGet, startOwnedViteServerForTest } from './owned-vite-server'
import { validatePromotedCandidateShell } from './import-artifact-validation'

const tempDirs: string[] = []

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-utils-test-'))
  tempDirs.push(directory)
  return directory
}

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve))
  const address = server.address() as net.AddressInfo
  const port = address.port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function expectPortFree(port: number): Promise<void> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, 'localhost', resolve)
  })
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

function writeChildScript(directory: string, mode: string): string {
  const fixture = path.join(directory, `${mode}.mjs`)
  fs.writeFileSync(
    fixture,
    `import http from 'node:http'
import fs from 'node:fs'
const mode = ${JSON.stringify(mode)}
const port = Number(process.argv[2])
const paths = new Set(['/src/windows/chatImport/chatImport.html', '/src/windows/chatImport/entryPoint.ts'])
if (mode === 'signal-before-ready') setTimeout(() => process.kill(process.pid, 'SIGTERM'), 10)
if (mode === 'nonzero-exit') process.exit(7)
if (mode === 'timeout') setTimeout(() => {}, 10000)
if (mode === 'ready-then-exit') {
  process.send?.({ type: 'ready', port, host: 'localhost', origin: 'http://localhost:' + port, base: '/', url: 'http://localhost:' + port })
  process.exit(0)
}
if (mode === 'timeout') await new Promise(() => {})
const server = http.createServer((request, response) => {
  response.writeHead(paths.has(request.url) ? 200 : 404)
  response.end('ok')
})
server.listen(port, 'localhost', () => {
  fs.writeFileSync(process.env.TMPDIR + '/observed-vite-tmp.txt', process.env.TMPDIR)
  const ready = mode === 'mismatched-ready'
    ? { type: 'ready', port: port + 1, host: '127.0.0.1', origin: 'http://127.0.0.1:' + (port + 1), base: '/wrong', url: 'http://127.0.0.1:' + (port + 1) }
    : { type: 'ready', port, host: 'localhost', origin: 'http://localhost:' + port, base: '/', url: 'http://localhost:' + port }
  process.send?.(ready)
})
if (mode === 'ignore-term') process.on('SIGTERM', () => {})
`,
    'utf8'
  )
  return fixture
}

function startWithScript(mode: string, port: number, options: Record<string, unknown> = {}) {
  const ownedTmpRoot = tempDir()
  const fixture = writeChildScript(ownedTmpRoot, mode)
  return {
    ownedTmpRoot,
    start: startOwnedViteServerForTest(ownedTmpRoot, ownedTmpRoot, {
      childModulePath: fixture,
      port,
      // General child startup tests: 5000ms absorbs full-suite I/O contention
      // (unloaded child 78-183ms; contention can exceed 500ms). Deliberate
      // no-readiness coverage overrides this to a bounded 1000ms.
      readinessTimeoutMs: 5000,
      stopGraceMs: 50,
      spawnImpl: ((
        _command: string,
        args: readonly string[] | undefined,
        spawnOptions: import('node:child_process').SpawnOptions | undefined
      ) => spawn(process.execPath, [fixture, String(args?.at(-1))], spawnOptions ?? {})) as typeof spawn,
      ...options
    })
  }
}

async function probeExactEntry(port: number, timeoutMs: number): Promise<boolean> {
  const [html, entry] = await Promise.all([
    httpGet(`http://localhost:${port}/src/windows/chatImport/chatImport.html`, timeoutMs),
    httpGet(`http://localhost:${port}/src/windows/chatImport/entryPoint.ts`, timeoutMs)
  ])
  return html.status === 200 && entry.status === 200
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('httpGet', () => {
  it('accepts only exact HTTP 200', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200)
      response.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address() as net.AddressInfo
    try {
      await expect(httpGet(`http://localhost:${address.port}`, 1000)).resolves.toEqual({ status: 200, ok: true })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('candidate shell validation', () => {
  it('accepts an empty real directory', () => {
    const shell = path.join(tempDir(), 'candidate-empty')
    fs.mkdirSync(shell)
    expect(validatePromotedCandidateShell(shell)).toBeNull()
  })

  it.each(['file', 'nested-dir'])('rejects a %s child', (kind) => {
    const shell = path.join(tempDir(), `candidate-${kind}`)
    fs.mkdirSync(shell)
    const child = path.join(shell, 'child')
    if (kind === 'file') fs.writeFileSync(child, 'payload')
    else fs.mkdirSync(child)
    expect(validatePromotedCandidateShell(shell)).toMatch(/contains (file|nested directory)/)
  })

  it('rejects a symlink child and a symlink root', () => {
    const parent = tempDir()
    const target = path.join(parent, 'target')
    const shell = path.join(parent, 'candidate-shell')
    fs.mkdirSync(target)
    fs.mkdirSync(shell)
    fs.symlinkSync(target, path.join(shell, 'link'), 'dir')
    expect(validatePromotedCandidateShell(shell)).toContain('symlink')
    const rootLink = path.join(parent, 'candidate-root-link')
    fs.symlinkSync(shell, rootLink, 'dir')
    expect(validatePromotedCandidateShell(rootLink)).toContain('symlink')
  })

  it('rejects a FIFO on darwin', () => {
    if (process.platform !== 'darwin') return
    const shell = path.join(tempDir(), 'candidate-fifo')
    fs.mkdirSync(shell)
    const fifo = path.join(shell, 'child.fifo')
    const result = require('node:child_process').spawnSync('mkfifo', [fifo])
    expect(result.status).toBe(0)
    expect(validatePromotedCandidateShell(shell)).toContain('non-standard')
  })

  it('rejects a Unix socket child', async () => {
    const shell = path.join(tempDir(), 'candidate-socket')
    fs.mkdirSync(shell)
    const socketPath = path.join(shell, 'child.sock')
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    try {
      expect(validatePromotedCandidateShell(shell)).toContain('non-standard')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('startOwnedViteServer readiness lifecycle', () => {
  it('starts on exact localhost paths, contains child temp env, and stops', async () => {
    const port = await freePort()
    const harness = startWithScript('success', port, { probeReadyImpl: probeExactEntry })
    const server = await harness.start
    expect(await probeExactEntry(port, 500)).toBe(true)
    expect(fs.readFileSync(path.join(harness.ownedTmpRoot, 'observed-vite-tmp.txt'), 'utf8')).toBe(harness.ownedTmpRoot)
    await expect(server.stop()).resolves.toBeUndefined()
    await expect(httpGet(`http://localhost:${port}/src/windows/chatImport/chatImport.html`, 100)).rejects.toThrow()
  })

  it('rejects promptly when IPC ready is followed by exit before HTTP readiness', async () => {
    const port = await freePort()
    const startedAt = Date.now()
    const harness = startWithScript('ready-then-exit', port, { probeReadyImpl: () => new Promise<boolean>(() => {}) })
    await expect(harness.start).rejects.toThrow(/exited/i)
    // Promptness intent: the child self-exits, so rejection must not wait on the
    // readiness timer. Relaxed from 500ms so full-suite contention cannot flake
    // the spawn + IPC round trip, while still far below the production 90s timeout.
    expect(Date.now() - startedAt).toBeLessThan(2000)
    await expectPortFree(port)
  })

  it('rejects promptly on signal exit before ready', async () => {
    const port = await freePort()
    const harness = startWithScript('signal-before-ready', port)
    await expect(harness.start).rejects.toThrow(/signal|exited/i)
    await expectPortFree(port)
  })

  it('rejects mismatched host, port, origin, or base', async () => {
    const port = await freePort()
    const harness = startWithScript('mismatched-ready', port)
    await expect(harness.start).rejects.toThrow(/readiness mismatch/i)
    await expectPortFree(port)
  })

  it('escalates an uncooperative child to SIGKILL and remains idempotently retryable', async () => {
    const port = await freePort()
    const harness = startWithScript('ignore-term', port, { probeReadyImpl: probeExactEntry })
    const server = await harness.start
    await expect(server.stop()).resolves.toBeUndefined()
    await expect(server.stop()).resolves.toBeUndefined()
    await expect(httpGet(`http://localhost:${port}/src/windows/chatImport/chatImport.html`, 100)).rejects.toThrow()
  })

  it.each(['nonzero-exit', 'timeout'])('rejects and cleans up on %s', async (mode) => {
    const port = await freePort()
    const harness = startWithScript(
      mode,
      port,
      // The deliberate no-readiness 'timeout' mode never becomes ready; cap it
      // at 1000ms so the coverage stays bounded even while general startup
      // tests use the 5000ms contention-tolerant default.
      mode === 'timeout' ? { readinessTimeoutMs: 1000 } : {}
    )
    await expect(harness.start).rejects.toThrow()
    await expectPortFree(port)
  })

  it('rejects a relative or symlink owned temp root', async () => {
    const port = await freePort()
    const realRoot = tempDir()
    const symlinkRoot = path.join(tempDir(), 'owned-root-link')
    fs.symlinkSync(realRoot, symlinkRoot, 'dir')
    const fixture = writeChildScript(realRoot, 'success')

    await expect(
      startOwnedViteServerForTest(realRoot, symlinkRoot, {
        childModulePath: fixture,
        port,
        readinessTimeoutMs: 100
      })
    ).rejects.toThrow(/real non-symlink directory/i)
  })

  it('uses the exact production port when 5173 is available', async ({ skip }) => {
    const probe = net.createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject)
        probe.listen(5173, 'localhost', resolve)
      })
    } catch {
      return skip('Port 5173 is occupied by an external process')
    } finally {
      if (probe.listening) await new Promise<void>((resolve) => probe.close(() => resolve()))
    }

    const harness = startWithScript('success', 5173, { probeReadyImpl: probeExactEntry })
    const server = await harness.start
    await expect(server.stop()).resolves.toBeUndefined()
  })
})
