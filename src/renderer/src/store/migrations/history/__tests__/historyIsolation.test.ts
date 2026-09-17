/**
 * History-isolation boundary for the built-in provider/model catalogs.
 * Stock inputs support replay through current migration 224. Only migrations
 * up to 221 actually read stock (provider adds through 200, model backfills
 * at 9/95/111/117/123/139/194/198/204, and migration 221 deep-equality);
 * migrations 222-224 operate on the migrating state's own providers.
 * The frozen 62-ID brand identity (`brandIds.ts`) carries the retired
 * `SystemProviderId` union/map plus `isSystemProviderId`/`isSystemProvider`;
 * no active type-layer module defines or re-exports these symbols.
 * This boundary proves:
 *  - history stock keeps migration 221 deep-equality drop/preserve semantics;
 *  - historically missing dead ids stay absent (replay no-op unchanged);
 *  - no active source outside `store/migrate*` imports history modules or
 *    the retired `config/providers` / `config/models/default|logo` paths.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import migrate from '../../../migrate'
import { isSystemProvider, isSystemProviderId, SystemProviderIdList, SystemProviderIds } from '../brandIds'
import { qwenModel, SYSTEM_MODELS } from '../systemModels'
import { SYSTEM_PROVIDERS, SYSTEM_PROVIDERS_CONFIG } from '../systemProviders'

const DEAD_IDS = ['zhinao', 'gitee-ai', 'o3', 'cherryin', 'cherryai', 'qwenlm'] as const

// Anchored to this test module, never process.cwd(): this file lives at
// <repo>/src/renderer/src/store/migrations/history/__tests__/.
const HERE = dirname(fileURLToPath(import.meta.url))
const HISTORY_DIR = resolve(HERE, '..')
const RENDERER_SRC = resolve(HISTORY_DIR, '..', '..', '..')
const REPO_ROOT = resolve(RENDERER_SRC, '..', '..', '..')

// Production may import history only from the migration entrypoint, using
// direct exact-module specifiers (the general `migrations/history` barrel was
// deleted): `brandIds`, `systemModels`, `systemProviders`. Migration tests may
// import the same exact modules, but only in test scope (test files). Every
// other importer is a boundary violation.
const ALLOWED_PRODUCTION_HISTORY_IMPORTERS = new Set(['src/renderer/src/store/migrate.ts'])
const ALLOWED_TEST_HISTORY_IMPORTERS = new Set([
  'src/renderer/src/store/__tests__/migrate.test.ts',
  'src/renderer/src/store/migrations/history/__tests__/historyIsolation.test.ts'
])

const RETIRED_SUBSTRINGS = ['config/providers', 'config/models/default', 'config/models/logo'] as const

function toRepoRel(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join('/')
}

function isTestFile(repoRel: string): boolean {
  return (
    repoRel.includes('/__tests__/') ||
    repoRel.includes('/__test__/') ||
    /\.test\.[cm]?[jt]sx?$/.test(repoRel) ||
    /\.spec\.[cm]?[jt]sx?$/.test(repoRel)
  )
}

function isHistoryFile(repoRel: string): boolean {
  return (
    repoRel === 'src/renderer/src/store/migrations/history' ||
    repoRel.startsWith('src/renderer/src/store/migrations/history/')
  )
}

// Replace comment characters with blanks (newlines preserved) so import-like
// text inside comments can never count as an importer, while reported line
// numbers stay accurate. String-aware so `https://` and `//` inside string
// literals are not treated as comments.
function stripComments(source: string): string {
  const out = source.split('')
  const n = source.length
  let i = 0
  let quote: string | null = null
  let templateExprDepth = 0
  while (i < n) {
    const ch = source[i]
    const next = i + 1 < n ? source[i + 1] : ''
    if (quote !== null) {
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === quote) {
        quote = null
      } else if (quote === '`' && ch === '$' && next === '{') {
        templateExprDepth += 1
      }
      i += 1
      continue
    }
    if (templateExprDepth > 0 && ch === '}') {
      templateExprDepth -= 1
      i += 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') {
        out[i] = ' '
        i += 1
      }
      continue
    }
    if (ch === '/' && next === '*') {
      out[i] = ' '
      out[i + 1] = ' '
      i += 2
      while (i < n && !(source[i] === '*' && i + 1 < n && source[i + 1] === '/')) {
        if (out[i] !== '\n') out[i] = ' '
        i += 1
      }
      if (i < n) {
        out[i] = ' '
        out[i + 1] = ' '
        i += 2
      }
      continue
    }
    i += 1
  }
  return out.join('')
}

interface SpecifierHit {
  spec: string
  line: number
  kind: string
}

// Formatting-independent specifier extraction over the whole file text:
// static `import ... from` / `export ... from` (multiline), side-effect
// `import '...'`, dynamic `import('...')`, `require('...')`, and
// `vi.mock` / `vi.doMock` / `vi.importActual` (also `vi.unmock`).
function extractSpecifierHits(code: string): SpecifierHit[] {
  const hits: SpecifierHit[] = []
  const lineOf = (index: number): number => code.slice(0, index).split('\n').length
  const patterns: Array<{ kind: string; re: RegExp }> = [
    { kind: 'static-from', re: /(?:import|export)\s+[^'";]*?from\s*['"]([^'"]+)['"]/g },
    { kind: 'side-effect-import', re: /import\s*['"]([^'"]+)['"]/g },
    { kind: 'dynamic-import', re: /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g },
    { kind: 'require', re: /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g },
    { kind: 'vi-mock', re: /\bvi\s*\.\s*(?:mock|doMock|unmock|importActual|importMock)\s*\(\s*['"]([^'"]+)['"]/g }
  ]
  for (const { kind, re } of patterns) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(code)) !== null) {
      hits.push({ spec: m[1], line: lineOf(m.index), kind })
    }
  }
  return hits
}

function isHistorySpecifier(spec: string, importerAbs: string): boolean {
  if (spec.includes('migrations/history')) return true
  if (spec.startsWith('.')) {
    const resolved = resolve(dirname(importerAbs), spec)
    const rel = relative(HISTORY_DIR, resolved)
    if (rel === '' || (!rel.startsWith('..') && !relative(HISTORY_DIR, resolved).startsWith('..'))) {
      return true
    }
    // Bare `./systemModels`-style hits that resolve inside the history dir.
    if (resolved === HISTORY_DIR || resolved.startsWith(HISTORY_DIR + '/')) return true
  }
  return false
}

function isBarrelHistorySpecifier(spec: string, importerAbs: string): boolean {
  if (!isHistorySpecifier(spec, importerAbs)) return false
  if (spec.includes('migrations/history')) {
    return !spec.includes('systemModels') && !spec.includes('systemProviders') && !spec.includes('brandIds')
  }
  // Relative form: resolves to the history dir itself or its index, not to an
  // exact history module file.
  const resolved = resolve(dirname(importerAbs), spec)
  return resolved === HISTORY_DIR || resolved === join(HISTORY_DIR, 'index')
}

function isRetiredSpecifier(spec: string): boolean {
  return RETIRED_SUBSTRINGS.some((sub) => spec.includes(sub))
}

function collectSourceFiles(roots: string[]): string[] {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist' || entry === 'out' || entry === '.git') continue
        walk(full)
        continue
      }
      if (!/\.[cm]?[jt]sx?$/.test(entry)) continue
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry)) {
        files.push(full)
        continue
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue
      files.push(full)
    }
  }
  for (const root of roots) {
    if (existsSync(root)) walk(root)
  }
  return files
}

describe('history isolation', () => {
  it('keeps the frozen history brand identity intact (62 ids)', () => {
    expect(SystemProviderIdList).toHaveLength(62)
    expect(new Set(SystemProviderIdList).size).toBe(62)
    expect(Object.keys(SystemProviderIds)).toHaveLength(62)
    // Map keys and values mirror the frozen id list exactly.
    expect(new Set(Object.keys(SystemProviderIds))).toEqual(new Set(SystemProviderIdList))
    for (const id of SystemProviderIdList) {
      expect(SystemProviderIds[id]).toBe(id)
    }
    // Spot-check well-known replay ids used by migrate.ts.
    for (const id of ['openai', 'anthropic', 'groq', 'ollama', 'gateway', 'longcat', 'qiniu']) {
      expect(isSystemProviderId(id)).toBe(true)
    }
    expect(isSystemProviderId('brand-free')).toBe(false)
    expect(isSystemProviderId('')).toBe(false)
    expect(
      isSystemProvider({ id: 'openai', isSystem: true } as unknown as Parameters<typeof isSystemProvider>[0])
    ).toBe(true)
    expect(isSystemProvider({ id: 'openai' } as unknown as Parameters<typeof isSystemProvider>[0])).toBe(false)
    expect(
      isSystemProvider({ id: 'brand-free', isSystem: true } as unknown as Parameters<typeof isSystemProvider>[0])
    ).toBe(false)
  })

  it('keeps qwenModel/defaultModel history data intact', () => {
    expect(qwenModel).toEqual({ id: 'qwen', name: 'Qwen', provider: 'cherryai', group: 'Qwen' })
    expect(SYSTEM_MODELS.defaultModel).toHaveLength(4)
    for (const slot of SYSTEM_MODELS.defaultModel) {
      expect(slot).toEqual(qwenModel)
    }
  })

  it('keeps dead ids absent from history stock (replay no-op unchanged)', () => {
    const configIds = new Set<string>(Object.keys(SYSTEM_PROVIDERS_CONFIG))
    const listedIds = new Set<string>(SYSTEM_PROVIDERS.map((p) => p.id))
    const modelKeys = new Set<string>(Object.keys(SYSTEM_MODELS))
    for (const dead of DEAD_IDS) {
      expect(configIds.has(dead)).toBe(false)
      expect(listedIds.has(dead)).toBe(false)
      expect(modelKeys.has(dead)).toBe(false)
    }
    // Spot-check live stock entries still exist with expected hosts.
    expect(SYSTEM_PROVIDERS_CONFIG.openai.apiHost).toBe('https://api.openai.com')
    expect(SYSTEM_PROVIDERS_CONFIG.ollama.apiHost).toBe('http://localhost:11434')
  })

  it('preserves migration 221 deep-equality drop/preserve semantics from history stock', async () => {
    const untouched = { ...SYSTEM_PROVIDERS_CONFIG.deepseek }
    const customized = {
      ...SYSTEM_PROVIDERS_CONFIG.openai,
      apiKey: 'sk-live',
      enabled: true,
      models: [{ id: 'my-model', name: 'my-model', provider: 'openai', group: 'openai' }]
    }
    const state = {
      llm: { providers: [customized, untouched], settings: {} },
      assistants: { defaultAssistant: {}, assistants: [] },
      _persist: { version: 220, rehydrated: false }
    }
    const migrated: any = await migrate(state as any, 221)
    expect(migrated.llm.providers.map((p: { id: string }) => p.id)).toEqual(['openai'])
    expect(migrated.llm.providers[0].isSystem).toBe(false)
    expect(migrated.llm.providers[0].apiKey).toBe('sk-live')
  })

  it('no active source outside store/migrate* imports history or retired catalog paths', () => {
    // Robust anchoring: derive every root from this test module, not cwd.
    expect(existsSync(HISTORY_DIR)).toBe(true)
    expect(existsSync(RENDERER_SRC)).toBe(true)
    const extraRoots = [
      resolve(REPO_ROOT, 'src', 'main'),
      resolve(REPO_ROOT, 'src', 'preload'),
      resolve(REPO_ROOT, 'packages')
    ]
    const roots = [RENDERER_SRC, ...extraRoots.filter((r) => existsSync(r))]
    expect(roots.length).toBeGreaterThanOrEqual(1)

    const selfRel = toRepoRel(join(HERE, 'historyIsolation.test.ts'))
    const violations: string[] = []
    const historyImporters = new Set<string>()
    const retiredImporters = new Set<string>()

    for (const full of collectSourceFiles(roots)) {
      const repoRel = toRepoRel(full)
      // This boundary test references history by design; its own specifier
      // pattern strings must never count as violations.
      if (repoRel === selfRel) continue
      if (isHistoryFile(repoRel)) continue
      const raw = readFileSync(full, 'utf8')
      const code = stripComments(raw)
      for (const hit of extractSpecifierHits(code)) {
        if (isHistorySpecifier(hit.spec, full)) {
          historyImporters.add(repoRel)
          if (isBarrelHistorySpecifier(hit.spec, full)) {
            violations.push(
              `${repoRel}:${hit.line}: [${hit.kind}] barrel history import ${JSON.stringify(hit.spec)} (use exact brandIds/systemModels/systemProviders modules)`
            )
            continue
          }
          if (isTestFile(repoRel)) {
            if (!ALLOWED_TEST_HISTORY_IMPORTERS.has(repoRel)) {
              violations.push(
                `${repoRel}:${hit.line}: [${hit.kind}] unexpected test-scope history import ${JSON.stringify(hit.spec)}`
              )
            }
          } else if (!ALLOWED_PRODUCTION_HISTORY_IMPORTERS.has(repoRel)) {
            violations.push(
              `${repoRel}:${hit.line}: [${hit.kind}] unexpected production history import ${JSON.stringify(hit.spec)}`
            )
          }
        } else if (isRetiredSpecifier(hit.spec)) {
          retiredImporters.add(repoRel)
          violations.push(`${repoRel}:${hit.line}: [${hit.kind}] retired catalog import ${JSON.stringify(hit.spec)}`)
        }
      }
    }

    // Explicit allowed-importer set: production history may only come from
    // `store/migrate.ts`; test-scope history may only come from the migration
    // tests. Any drift (new importer, or the entrypoint losing its import and
    // silently breaking 1-224 replay) fails here.
    const allowedHistoryImporters = new Set([
      ...ALLOWED_PRODUCTION_HISTORY_IMPORTERS,
      ...ALLOWED_TEST_HISTORY_IMPORTERS
    ])
    for (const importer of historyImporters) {
      expect(allowedHistoryImporters.has(importer)).toBe(true)
    }
    expect(historyImporters.has('src/renderer/src/store/migrate.ts')).toBe(true)
    expect(retiredImporters.size).toBe(0)
    expect(violations).toEqual([])
  })
})
