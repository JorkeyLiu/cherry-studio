import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { classifyMainTestFiles, enumerateMainTestFiles } from '../mainLanes'

/**
 * Static/config tests for the resource-safe Vitest lane scheduling.
 *
 * These tests resolve the lane manifests against the repository at test time
 * (never against machine-local state), so they stay correct as the main suite
 * grows. They also pin the package.json test script chain and the root safety
 * caps so the bounded lane sequence cannot silently regress.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8')
}

describe('main lane manifests', () => {
  const lanes = classifyMainTestFiles()
  const allFiles = enumerateMainTestFiles()

  it('assigns every main test file to exactly one lane (no overlap, no gap)', () => {
    const coreSet = new Set(lanes.core)
    const nativeSet = new Set(lanes.native)

    for (const file of allFiles) {
      const assignments = [coreSet.has(file), nativeSet.has(file)].filter(Boolean).length
      expect(assignments, `file assigned ${assignments} times: ${file}`).toBe(1)
    }

    const union = [...lanes.core, ...lanes.native].sort()
    expect(new Set(union).size).toBe(union.length)
    expect(union).toEqual([...allFiles].sort())
    expect(union.length).toBe(allFiles.length)
  })

  it('every direct better-sqlite3 importer is native, never core', () => {
    const nativeSet = new Set(lanes.native)
    for (const file of allFiles) {
      const content = readRepoFile(file)
      const importsNative = /from\s+['"]better-sqlite3['"]|require\(\s*['"]better-sqlite3['"]\)/.test(content)
      if (importsNative) {
        expect(nativeSet.has(file), `native importer misrouted: ${file}`).toBe(true)
      }
    }
  })

  it('every explicit vi.unmock / vi.doUnmock real-environment test is native, never core', () => {
    const nativeSet = new Set(lanes.native)
    for (const file of allFiles) {
      const content = readRepoFile(file)
      if (/\bvi\.(unmock|doUnmock)\(/.test(content)) {
        expect(nativeSet.has(file), `unmock real-environment test misrouted: ${file}`).toBe(true)
      }
    }
    // The inverse is NOT asserted: pure-FS tests that only vi.mock + importActual
    // node modules intentionally stay core unless they also import better-sqlite3
    // or call vi.unmock/vi.doUnmock. The lane contract is that the native binding
    // is never loaded in a thread-pool worker, not that every real-filesystem
    // test is native.
  })
})

describe('package.json lane scripts', () => {
  const pkg = JSON.parse(readRepoFile('package.json')) as { scripts: Record<string, string> }
  const { scripts } = pkg

  it('test:main executes core -> native sequentially through the node lane wrapper', () => {
    expect(scripts['test:main']).toBe('pnpm native:run node -- pnpm test:main:run')
    expect(scripts['test:main:run']).toBe('pnpm test:main:core && pnpm test:main:native')
    expect(scripts['test:main:core']).toBe('pnpm native:run node -- vitest run --project main')
    expect(scripts['test:main:native']).toBe('pnpm native:run node -- vitest run --project main-native')
    expect(scripts).not.toHaveProperty('test:main:heavy')
  })

  it('aggregate test declares the node lane and chains suites sequentially through the internal chain helper', () => {
    expect(scripts['test']).toBe('pnpm native:run node -- pnpm test:run')
    expect(scripts['test:run']).toBe(
      [
        'pnpm test:main',
        'pnpm test:renderer',
        'pnpm test:aicore',
        'pnpm test:shared',
        'pnpm test:scripts',
        'pnpm test:e2e-utils'
      ].join(' && ')
    )
  })

  it('every main lane has a focused script and a matching project flag', () => {
    expect(scripts['test:main:core']).toContain('--project main')
    expect(scripts['test:main:native']).toContain('--project main-native')
  })

  it('CI commands keep using pnpm test:main so the bounded lane sequence applies automatically', () => {
    // .github/workflows/ci.yml and the ci:test-check chain both call
    // `pnpm test:main` (the latter through the shared test:run helper), which
    // runs the sequential lane chain — no workflow churn required.
    const ciYml = readRepoFile('.github/workflows/ci.yml')
    expect(ciYml).toContain('pnpm test:main')
    expect(scripts['ci:test-check']).toContain('pnpm test:run')
    expect(scripts['test:run']).toContain('pnpm test:main')
  })

  it('CI general-test and the ci:test-check chain each cover the e2e-utils focused suite exactly once', () => {
    // Finding F2: the e2e-utils suite (vitest project `e2e-utils`) must run in
    // CI through the general-test job AND the ci:test-check chain (whose shared
    // test:run body lists it once), alongside the existing sequential focused
    // suites, never duplicated or dropped.
    const ciYml = readRepoFile('.github/workflows/ci.yml')
    expect(ciYml.match(/pnpm test:e2e-utils/g)).toHaveLength(1)
    expect(scripts['test:run'].match(/pnpm test:e2e-utils/g)).toHaveLength(1)
  })
})

describe('vitest.config.ts root safety caps', () => {
  const config = readRepoFile('vitest.config.ts')

  it('caps thread and fork pools at the root so a direct vitest run stays bounded', () => {
    expect(config).toContain('maxThreads: 2')
    expect(config).toContain('maxForks: 1')
    // min values must not force more workers than the caps allow
    expect(config).not.toMatch(/minThreads:\s*[3-9]/)
    expect(config).not.toMatch(/minForks:\s*[2-9]/)
  })

  it('routes main via two lane projects instead of deprecated poolMatchGlobs', () => {
    expect(config).toContain("name: 'main-native'")
    expect(config).not.toContain("name: 'main-heavy'")
    expect(config).not.toContain('passWithNoTests')
    expect(config).toContain('classifyMainTestFiles')
  })

  it('retains poolMatchGlobs ONLY for the unrelated renderer Shiki isolation (LOCK-STAB)', () => {
    // The deprecated poolMatchGlobs main routing is retired. The only remaining
    // usage is the renderer-scoped Shiki exact-HTML fork pin, which is
    // deliberately kept for renderer full-suite stability and must not touch
    // main-process routing.
    const match = config.match(/poolMatchGlobs:\s*\[\[([^\]]+)\]\]/g)
    expect(match).not.toBeNull()
    for (const entry of match ?? []) {
      expect(entry).toContain('ShikiStreamTokenizer.test.ts')
      expect(entry).not.toContain('promotion')
      expect(entry).not.toContain('src/main')
    }
    // No main-process promotion files may appear in any poolMatchGlobs entry.
    expect(config).not.toMatch(/poolMatchGlobs[\s\S]*recoveryV2/)
  })
})
