/**
 * Main-window boot import graph: neither `init.ts` nor `entryPoint.tsx`
 * (loaded in that order by `src/renderer/index.html`) may STATICALLY reach
 * the store or fresh-assistant factories. Those modules call `i18n.t` at
 * module evaluation, so every static path to them would reintroduce the
 * fresh-profile missing-key race that `initialI18nReady` gating eliminates.
 *
 * Both entries gate their store-reaching work on the same exported readiness
 * promise and use dynamic import afterwards. This test walks the source-level
 * static import graph (relative + `@renderer/` alias) from both entries and
 * fails on any static path into `store/` or the fresh-default factories.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const REPO_ROOT = process.cwd()
const RENDERER_SRC = join(REPO_ROOT, 'src/renderer/src')

const ENTRIES = [join(RENDERER_SRC, 'init.ts'), join(RENDERER_SRC, 'entryPoint.tsx')]

/** Source files that must never be statically reachable from a main-window entry. */
function isForbidden(resolvedRepoPath: string): boolean {
  const rel = normalize(resolvedRepoPath)
  return (
    rel.startsWith(join('src/renderer/src/store') + '/') ||
    rel === normalize('src/renderer/src/services/assistantDefaults.ts') ||
    rel === normalize('src/renderer/src/services/importProjection.ts') ||
    rel === normalize('src/renderer/src/services/db/topicTrashLifecycle.ts')
  )
}

/** Extract STATIC import specifiers (dynamic `import(` and `import type` excluded). */
function staticImportSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  for (const line of source.split('\n')) {
    if (/\bimport\s*\(/.test(line)) continue
    if (/^\s*import\s+type\b/.test(line)) continue
    const match = line.match(/^\s*import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/)
    if (match) specifiers.push(match[1])
  }
  return specifiers
}

function resolveToFile(specifier: string, fromDir: string): string | null {
  let base: string | null = null
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    base = resolve(fromDir, specifier)
  } else if (specifier === '@renderer/databases') {
    base = join(RENDERER_SRC, 'databases')
  } else if (specifier.startsWith('@renderer/')) {
    base = join(RENDERER_SRC, specifier.slice('@renderer/'.length))
  } else {
    return null
  }
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

/** Walk the static import graph from `entry`, returning repo-relative forbidden hits. */
function findForbiddenStaticReachables(entry: string): string[] {
  const hits: string[] = []
  const visited = new Set<string>()
  const stack: string[] = [entry]
  while (stack.length > 0) {
    const file = stack.pop() as string
    if (visited.has(file)) continue
    visited.add(file)
    let source: string
    try {
      source = readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    for (const specifier of staticImportSpecifiers(source)) {
      const resolved = resolveToFile(specifier, dirname(file))
      if (!resolved) continue
      const rel = normalize(resolved).replace(`${normalize(REPO_ROOT)}/`, '')
      if (isForbidden(rel)) {
        hits.push(`${normalize(entry).replace(`${normalize(REPO_ROOT)}/`, '')} -> ${rel} (via '${specifier}')`)
        continue
      }
      stack.push(resolved)
    }
  }
  return hits
}

describe('main-window boot import graph', () => {
  it.each(ENTRIES)('entry %s has no static path to store/fresh-assistant factories', (entry) => {
    expect(existsSync(entry)).toBe(true)
    expect(findForbiddenStaticReachables(entry)).toEqual([])
  })

  it('both entries gate on initialI18nReady with a dynamic import afterwards', () => {
    const initSource = readFileSync(join(RENDERER_SRC, 'init.ts'), 'utf-8')
    expect(initSource).toMatch(/await\s+initialI18nReady/)
    expect(initSource).toMatch(/await\s+import\(['"]\.\/store['"]\)/)
    // No static VALUE import of the store (a type-only import is erased at
    // runtime and evaluates nothing); same for the transitive store-reaching
    // subscription module.
    expect(initSource).not.toMatch(/^\s*import\s+(?!type\b)[^'\n]*\sfrom\s+['"]\.\/store['"]/m)
    expect(initSource).not.toMatch(
      /^\s*import\s+(?!type\b)[^'\n]*\sfrom\s+['"]\.\/services\/topicDeletionSubscription['"]/m
    )

    const entrySource = readFileSync(join(RENDERER_SRC, 'entryPoint.tsx'), 'utf-8')
    expect(entrySource).toMatch(/await\s+initialI18nReady/)
    expect(entrySource).toMatch(/await\s+import\(['"]\.\/App['"]\)/)
    expect(entrySource).not.toMatch(/^import\s+App\s+from\s+['"]\.\/App['"]/m)
  })

  it('index.html still loads init before entryPoint', () => {
    const html = readFileSync(join(REPO_ROOT, 'src/renderer/index.html'), 'utf-8')
    const initPos = html.indexOf('/src/init.ts')
    const entryPos = html.indexOf('/src/entryPoint.tsx')
    expect(initPos).toBeGreaterThan(-1)
    expect(entryPos).toBeGreaterThan(-1)
    expect(initPos).toBeLessThan(entryPos)
  })
})
