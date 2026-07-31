import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Sandbox self-containment guard for the chatImport preload.
 *
 * The chatImport window runs sandboxed (sandbox:true), so its preload can only
 * require() Electron — any bundled helper chunk emitted as a relative require
 * (e.g. out/preload/IpcChannel-*.js) throws at load time and prevents
 * window.chatImport from being exposed. This guard is the durable regression
 * net for that constraint:
 *
 *  - Source-level (always runs in `pnpm test`): the preload source must not
 *    import the shared IpcChannel enum at runtime, must carry the exact narrow
 *    channel literals locally, and must expose every narrow bridge method.
 *  - Artifact-level (runs when a fresh `pnpm build` output is present): the
 *    built out/preload/chat-import-preload.js must contain no relative require
 *    and must require nothing other than Electron.
 */

const REPO_ROOT = process.cwd()
const PRELOAD_SOURCE_PATH = join(REPO_ROOT, 'src', 'preload', 'chatImport', 'index.ts')
const BUILT_PRELOAD_PATH = join(REPO_ROOT, 'out', 'preload', 'chat-import-preload.js')

/** Exact channel strings this preload is allowed to use (LOCK-P2). */
const EXPECTED_CHANNELS = [
  'app:log-to-main',
  'chat-import:ready',
  'chat-import:discover',
  'chat-import:read-page',
  'chat-import:cancel',
  'chat-import:complete',
  'chat-import:error'
] as const

/** Narrow bridge surface exposed as window.chatImport. */
const EXPECTED_METHODS = [
  'ready',
  'log',
  'discoverResult',
  'readPageResult',
  'complete',
  'error',
  'onDiscover',
  'onReadPage',
  'onCancel'
] as const

const source = readFileSync(PRELOAD_SOURCE_PATH, 'utf8')

describe('chatImport preload source self-containment (LOCK-P2)', () => {
  it('has no runtime import of the shared IpcChannel module', () => {
    // Matches `import { ... } from '@shared/IpcChannel'` but NOT `import type`.
    const runtimeImports = source.match(/^\s*import\s+(?!type\b)[^\n]*from\s+['"]@shared\/IpcChannel['"]/gm)
    expect(runtimeImports).toBeNull()
  })

  it('carries every expected channel literal in the local narrow channel map', () => {
    const mapDeclaration = source.slice(source.indexOf('CHAT_IMPORT_CHANNELS'), source.indexOf('const chatImport'))
    for (const channel of EXPECTED_CHANNELS) {
      expect(mapDeclaration).toContain(`'${channel}'`)
    }
  })

  it('exposes every narrow bridge method', () => {
    for (const method of EXPECTED_METHODS) {
      expect(source).toContain(method)
    }
  })
})

const builtPreloadExists = existsSync(BUILT_PRELOAD_PATH)

describe.skipIf(!builtPreloadExists)('chatImport preload built artifact (requires fresh pnpm build)', () => {
  const artifact = readFileSync(BUILT_PRELOAD_PATH, 'utf8')

  it('contains no relative require', () => {
    expect(artifact).not.toMatch(/require\(\s*["']\.\.?\//)
  })

  it('requires nothing other than the external electron module', () => {
    const requiredModules = [...artifact.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1])
    expect(requiredModules).toEqual(['electron'])
  })

  it('exposes window.chatImport with every narrow method and exact channel string', () => {
    expect(artifact).toContain('chatImport')
    for (const method of EXPECTED_METHODS) {
      expect(artifact).toContain(method)
    }
    for (const channel of EXPECTED_CHANNELS) {
      expect(artifact).toContain(channel)
    }
  })
})
