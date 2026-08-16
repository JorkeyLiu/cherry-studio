import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  classifyMainBenchFiles,
  classifyMainTestFiles,
  enumerateMainBenchFiles,
  enumerateMainTestFiles,
  HEAVY_FILES,
  LEGACY_FORK_PINNED_FILES
} from '../mainLanes'

/**
 * Static/config tests for the resource-safe Vitest lane scheduling
 * (LOCK-TEST-001..006).
 *
 * These tests resolve the lane manifests against the repository at test time
 * (never against machine-local state), so they stay correct as the main suite
 * grows. They also pin the package.json script chain (test and bench), the
 * root safety caps, and the bench-lane resolution so the bounded lane sequence
 * and the benchmark commands cannot silently regress.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8')
}

describe('main lane manifests (LOCK-TEST-001..003)', () => {
  const lanes = classifyMainTestFiles()
  const allFiles = enumerateMainTestFiles()

  it('assigns every main test file to exactly one lane (no overlap, no gap)', () => {
    const coreSet = new Set(lanes.core)
    const nativeSet = new Set(lanes.native)
    const heavySet = new Set(lanes.heavy)

    for (const file of allFiles) {
      const assignments = [coreSet.has(file), nativeSet.has(file), heavySet.has(file)].filter(Boolean).length
      expect(assignments, `file assigned ${assignments} times: ${file}`).toBe(1)
    }

    const union = [...lanes.core, ...lanes.native, ...lanes.heavy].sort()
    expect(new Set(union).size).toBe(union.length)
    expect(union).toEqual([...allFiles].sort())
    expect(union.length).toBe(allFiles.length)
  })

  it('heavy lane contains exactly the declared heavy files (LOCK-TEST-003)', () => {
    expect([...lanes.heavy].sort()).toEqual([...HEAVY_FILES].sort())
  })

  it('every direct better-sqlite3 importer is native or heavy, never core', () => {
    const nativeSet = new Set(lanes.native)
    const heavySet = new Set(lanes.heavy)
    for (const file of allFiles) {
      const content = readRepoFile(file)
      const importsNative = /from\s+['"]better-sqlite3['"]|require\(\s*['"]better-sqlite3['"]\)/.test(content)
      if (importsNative) {
        expect(nativeSet.has(file) || heavySet.has(file), `native importer misrouted: ${file}`).toBe(true)
      }
    }
  })

  it('every legacy fork-pinned promotion file stays native or heavy', () => {
    const nativeSet = new Set(lanes.native)
    const heavySet = new Set(lanes.heavy)
    for (const file of LEGACY_FORK_PINNED_FILES) {
      expect(nativeSet.has(file) || heavySet.has(file), `legacy fork-pinned misrouted: ${file}`).toBe(true)
    }
  })

  it('every explicit vi.unmock / vi.doUnmock real-environment test is native or heavy, never core', () => {
    const nativeSet = new Set(lanes.native)
    const heavySet = new Set(lanes.heavy)
    for (const file of allFiles) {
      const content = readRepoFile(file)
      if (/\bvi\.(unmock|doUnmock)\(/.test(content)) {
        expect(nativeSet.has(file) || heavySet.has(file), `unmock real-environment test misrouted: ${file}`).toBe(true)
      }
    }
    // The inverse is NOT asserted: pure-FS tests that only vi.mock + importActual
    // node modules intentionally stay core unless they also import better-sqlite3,
    // are legacy fork-pinned, or call vi.unmock/vi.doUnmock. The lane contract is
    // "native binding never loaded in a thread-pool worker" (LOCK-ABI-2), not
    // "every real-filesystem test is native".
  })

  it('main bench files are classified by the same native/heavy predicate', () => {
    const bench = classifyMainBenchFiles()
    const allLaneFiles = [...bench.core, ...bench.native, ...bench.heavy]
    expect(new Set(allLaneFiles).size).toBe(allLaneFiles.length)
  })
})

describe('package.json lane scripts (LOCK-TEST-001, 004)', () => {
  const pkg = JSON.parse(readRepoFile('package.json')) as { scripts: Record<string, string> }
  const { scripts } = pkg

  it('test:main executes core -> native -> heavy sequentially through the node lane wrapper', () => {
    expect(scripts['test:main']).toBe('pnpm native:run node -- pnpm test:main:run')
    expect(scripts['test:main:run']).toBe('pnpm test:main:core && pnpm test:main:native && pnpm test:main:heavy')
    expect(scripts['test:main:core']).toBe('pnpm native:run node -- vitest run --project main')
    expect(scripts['test:main:native']).toBe('pnpm native:run node -- vitest run --project main-native')
    expect(scripts['test:main:heavy']).toBe('pnpm native:run node -- vitest run --project main-heavy')
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
    expect(scripts['test:main:heavy']).toContain('--project main-heavy')
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

describe('package.json main bench scripts (bench lane audit)', () => {
  const pkg = JSON.parse(readRepoFile('package.json')) as { scripts: Record<string, string> }
  const { scripts } = pkg
  const bench = classifyMainBenchFiles()

  // vitest.config.ts maps project `main` / `main-native` / `main-heavy` onto
  // the core / native / heavy bench lane manifests respectively.
  const benchByProject: Record<string, string[]> = {
    main: bench.core,
    'main-native': bench.native,
    'main-heavy': bench.heavy
  }

  function projectsOf(script: string): string[] {
    const projects = [...script.matchAll(/--project\s+(\S+)/g)].map((match) => match[1])
    expect(projects.length, 'bench script must select at least one project').toBeGreaterThan(0)
    return projects
  }

  function benchFilesOf(script: string): string[] {
    const files = new Set<string>()
    for (const project of projectsOf(script)) {
      for (const file of benchByProject[project] ?? []) files.add(file)
    }
    return [...files].sort()
  }

  it('removed always-failing empty focused bench scripts stay removed', () => {
    // bench:main:core and bench:main:heavy always exited 1 because those lanes
    // contain zero bench files (vitest: "No bench files found, exiting with
    // code 1" when no file matches across the selected projects).
    expect(scripts['bench:main:core']).toBeUndefined()
    expect(scripts['bench:main:heavy']).toBeUndefined()
  })

  it('aggregate and native bench commands each resolve the main bench files exactly once', () => {
    const allBench = enumerateMainBenchFiles().sort()
    expect(allBench).toEqual([
      'src/main/services/chatDb/__tests__/search.bench.ts',
      'src/main/services/chatDb/__tests__/searchStage.bench.ts',
      'src/main/services/chatDb/__tests__/searchStagePlan.bench.ts',
      'src/main/services/chatDb/__tests__/sqlite-runtime.perf.bench.ts',
      'src/main/services/chatDb/__tests__/streamPersistDifferential.bench.ts'
    ])
    for (const scriptName of ['bench:main', 'bench:main:native']) {
      expect(scripts[scriptName]).toBeDefined()
      expect(benchFilesOf(scripts[scriptName]), scriptName).toEqual(allBench)
    }
  })

  it('every focused bench:main:* script targets a non-empty bench lane', () => {
    // Guards against a focused bench script silently targeting an empty lane,
    // which would make `pnpm bench:main:<lane>` always exit 1 again.
    for (const [name, script] of Object.entries(scripts)) {
      if (!name.startsWith('bench:main:')) continue
      for (const project of projectsOf(script)) {
        expect(
          (benchByProject[project] ?? []).length,
          `${name} targets an empty bench lane: ${project}`
        ).toBeGreaterThan(0)
      }
    }
  })
})

describe('vitest.config.ts root safety caps (LOCK-TEST-005)', () => {
  const config = readRepoFile('vitest.config.ts')

  it('caps thread and fork pools at the root so a direct vitest run stays bounded', () => {
    expect(config).toContain('maxThreads: 2')
    expect(config).toContain('maxForks: 1')
    // min values must not force more workers than the caps allow
    expect(config).not.toMatch(/minThreads:\s*[3-9]/)
    expect(config).not.toMatch(/minForks:\s*[2-9]/)
  })

  it('routes main via three lane projects instead of deprecated poolMatchGlobs', () => {
    expect(config).toContain("name: 'main-native'")
    expect(config).toContain("name: 'main-heavy'")
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
