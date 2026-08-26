/**
 * verify:changed — strict renderer-only fast-feedback command.
 *
 * Locked decisions (LOCK-VG-001..006):
 * - build:check remains sole authoritative aggregate pre-commit gate.
 * - verify:changed is local feedback only, never CI proof, never a substitute.
 * - Fast path is renderer-only; any Main/preload/shared/package/config/scripts/unknown
 *   path must fail closed with instruction to run `pnpm build:check`.
 * - Fast renderer test execution must enter canonical Node ABI lane via
 *   `pnpm native:run node -- ...` and preserve real exit codes.
 * - CI workflows remain unchanged; no pool caps changed here.
 *
 * Hardened per audit:
 * - No shell construction; all git via execFileSync argv.
 * - Base validated via `git rev-parse --verify <base>^{commit}` before discovery.
 * - Git paths retrieved with NUL delimiters (-z) and preserved without trim.
 * - Status-aware diff (--name-status -z) so deletions are not passed to linters.
 * - Discovery errors are fail-closed, never empty/docs-only.
 * - Path classification is exact; whitespace/absolute/traversal/NUL are unsafe.
 */

import { execFileSync, spawnSync } from 'node:child_process'

// ---------------------------------------------------------------------------
// Pure classifier — no I/O, fully unit-testable
// ---------------------------------------------------------------------------

export type PathCategory = 'renderer' | 'docs' | 'main' | 'preload' | 'shared' | 'scripts' | 'config' | 'unknown'

export type Verdict = 'renderer-only' | 'docs-only' | 'unsafe'

export interface ClassifyResult {
  verdict: Verdict
  categories: Set<PathCategory>
  rendererPaths: string[]
  docsPaths: string[]
  unsafePaths: string[]
  reason?: string
}

function isDocsPath(filePath: string): boolean {
  if (filePath.startsWith('docs/')) return true
  if (filePath.startsWith('.agents/')) return true
  if (filePath.startsWith('.claude/')) return true
  if (filePath.endsWith('.md')) return true
  if (filePath === 'AGENTS.md' || filePath === 'CLAUDE.md') return true
  return false
}

function isConfigPath(filePath: string): boolean {
  if (filePath === 'package.json') return true
  if (filePath === 'pnpm-lock.yaml') return true
  if (filePath === 'pnpm-workspace.yaml') return true
  if (filePath === 'electron.vite.config.ts') return true
  if (filePath === 'vitest.config.ts') return true
  if (filePath === 'electron-builder.yml') return true
  if (filePath === 'playwright.config.ts') return true
  if (filePath === 'eslint.config.mjs') return true
  if (filePath === '.oxlintrc.json') return true
  if (filePath === 'biome.jsonc') return true
  if (filePath === '.node-version') return true
  if (filePath === '.nvmrc') return true
  if (filePath === 'app-upgrade-config.json') return true
  if (filePath.startsWith('tsconfig')) return true
  if (filePath.startsWith('patches/')) return true
  if (filePath.startsWith('config/')) return true
  return false
}

export function classifyPath(filePath: string): PathCategory {
  if (filePath.length === 0) return 'unknown'
  if (filePath.includes('\0')) return 'unknown'
  if (filePath !== filePath.trim()) return 'unknown'
  if (filePath.startsWith('/')) return 'unknown'
  if (filePath.startsWith('\\')) return 'unknown'
  if (/^[a-zA-Z]:[\\/]/.test(filePath)) return 'unknown'
  if (filePath.includes('//')) return 'unknown'
  if (filePath.startsWith('./')) return 'unknown'
  const segs = filePath.split('/')
  if (segs.includes('..')) return 'unknown'
  if (segs.includes('')) {
    // empty segment from trailing slash or double slash already handled, but treat as unknown for safety except single slash?
    // repository-relative paths should not contain empty segments
    // already returned for '//', trailing slash like 'src/renderer/' has empty last seg -> unknown
    // Do strict check: if any seg is '' then unknown (covers trailing slash)
    // However allow not to break normal files; normal files have no empty segs, so this is safe.
    return 'unknown'
  }
  if (filePath.startsWith('src/renderer/')) return 'renderer'
  if (filePath.startsWith('src/main/')) return 'main'
  if (filePath.startsWith('src/preload/')) return 'preload'
  if (filePath.startsWith('scripts/')) return 'scripts'
  if (filePath.startsWith('packages/')) return 'shared'
  if (filePath.startsWith('tests/')) return 'shared'
  if (isConfigPath(filePath)) return 'config'
  if (isDocsPath(filePath)) return 'docs'
  return 'unknown'
}

export function classifyChangedSet(changed: string[], untracked: string[]): ClassifyResult {
  const all = [...changed, ...untracked].filter((p) => p.length > 0)
  const categories = new Set<PathCategory>()
  const rendererPaths: string[] = []
  const docsPaths: string[] = []
  const unsafePaths: string[] = []

  for (const file of all) {
    const cat = classifyPath(file)
    categories.add(cat)
    if (cat === 'renderer') rendererPaths.push(file)
    else if (cat === 'docs') docsPaths.push(file)
    else unsafePaths.push(file)
  }

  if (all.length === 0) {
    return {
      verdict: 'docs-only',
      categories,
      rendererPaths,
      docsPaths,
      unsafePaths,
      reason: 'no changed files'
    }
  }

  const hasUnsafe = unsafePaths.length > 0
  const hasRenderer = rendererPaths.length > 0
  const hasDocsOnly = docsPaths.length > 0 && !hasRenderer && !hasUnsafe

  if (hasUnsafe) {
    return {
      verdict: 'unsafe',
      categories,
      rendererPaths,
      docsPaths,
      unsafePaths,
      reason: `unsafe paths detected: ${unsafePaths.slice(0, 5).join(', ')}${unsafePaths.length > 5 ? ` +${unsafePaths.length - 5} more` : ''}`
    }
  }

  if (hasRenderer) {
    return {
      verdict: 'renderer-only',
      categories,
      rendererPaths,
      docsPaths,
      unsafePaths
    }
  }

  if (hasDocsOnly) {
    return {
      verdict: 'docs-only',
      categories,
      rendererPaths,
      docsPaths,
      unsafePaths
    }
  }

  return {
    verdict: 'docs-only',
    categories,
    rendererPaths,
    docsPaths,
    unsafePaths
  }
}

// ---------------------------------------------------------------------------
// Arg parsing (pure, no fallback on explicit empty)
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  base: string
  help: boolean
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let base = 'HEAD'
  let help = false
  let baseSet = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      help = true
    } else if (arg.startsWith('--base=')) {
      base = arg.slice('--base='.length)
      baseSet = true
    } else if (arg === '--base') {
      if (i + 1 < argv.length) {
        base = argv[i + 1] ?? ''
        baseSet = true
        i++
      } else {
        base = ''
        baseSet = true
      }
    }
  }
  if (!baseSet) {
    base = 'HEAD'
  }
  return { base, help }
}

function usage(): string {
  return [
    'usage: pnpm verify:changed [--base=<ref>]',
    '',
    '  --base <ref>   git base ref for changed-file detection (default: HEAD)',
    '  --help, -h     show this help',
    '',
    'Strict renderer-only fast-feedback. Any Main/preload/shared/package/config/scripts/unknown',
    'path fails closed and instructs to run `pnpm build:check`. Renderer-only changes enter',
    'the canonical Node ABI lane via `pnpm native:run node -- vitest --changed=<base>` and',
    'include untracked renderer files via explicit related invocation. Docs-only exits 0 with',
    'a no-op message and no validation claim. Never a substitute for `pnpm build:check` or CI proof.'
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Dependency injection types
// ---------------------------------------------------------------------------

export type ExecFileSyncFn = (cmd: string, args: readonly string[], opts: unknown) => string
export type SpawnSyncFn = (
  cmd: string,
  args: readonly string[],
  opts: unknown
) => { status: number | null; error?: Error; signal?: NodeJS.Signals | null }

export interface Deps {
  execFileSyncFn: ExecFileSyncFn
  spawnSyncFn: SpawnSyncFn
}

export const defaultDeps: Deps = {
  execFileSyncFn: execFileSync as unknown as ExecFileSyncFn,
  spawnSyncFn: spawnSync as unknown as SpawnSyncFn
}

// ---------------------------------------------------------------------------
// NUL-delimited parsing (pure)
// ---------------------------------------------------------------------------

export interface NameStatusParseResult {
  allPaths: string[]
  existingPaths: string[]
  deleted: Set<string>
}

export function parseNameStatusZero(output: string): NameStatusParseResult {
  if (output.length === 0) return { allPaths: [], existingPaths: [], deleted: new Set() }
  const rawParts = output.split('\0')
  if (rawParts.length > 0 && rawParts[rawParts.length - 1] === '') rawParts.pop()
  if (rawParts.length === 1 && rawParts[0] === '') return { allPaths: [], existingPaths: [], deleted: new Set() }
  const allPaths: string[] = []
  const existingPaths: string[] = []
  const deleted = new Set<string>()
  let i = 0
  while (i < rawParts.length) {
    const status = rawParts[i++]
    if (status === undefined) break
    if (status.length === 0) continue
    const first = status[0]
    if (first === 'R' || first === 'C') {
      const src = rawParts[i++]
      const dst = rawParts[i++]
      if (src !== undefined && src.length > 0) {
        allPaths.push(src)
      }
      if (dst !== undefined && dst.length > 0) {
        allPaths.push(dst)
        existingPaths.push(dst)
      }
    } else if (first === 'D') {
      const p = rawParts[i++]
      if (p !== undefined && p.length > 0) {
        allPaths.push(p)
        deleted.add(p)
      }
    } else {
      const p = rawParts[i++]
      if (p !== undefined && p.length > 0) {
        allPaths.push(p)
        existingPaths.push(p)
      }
    }
  }
  return { allPaths, existingPaths, deleted }
}

export function parseUntrackedZero(output: string): string[] {
  if (output.length === 0) return []
  const parts = output.split('\0')
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts.filter((p) => p.length > 0)
}

// ---------------------------------------------------------------------------
// Git I/O (impure, uses Deps, fail-closed)
// ---------------------------------------------------------------------------

export interface DiscoveryResult {
  ok: boolean
  error?: string
  changedAll: string[]
  changedExisting: string[]
  deleted: Set<string>
  untracked: string[]
}

export function validateBase(base: string, deps: Deps = defaultDeps): { ok: boolean; error?: string } {
  if (base.length === 0 || base.trim().length === 0 || base.includes('\0')) {
    return { ok: false, error: 'empty or whitespace base' }
  }
  if (base.trimStart().startsWith('-')) {
    return { ok: false, error: 'option-like base rejected' }
  }
  try {
    deps.execFileSyncFn('git', ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`], {
      encoding: 'utf-8',
      stdio: 'pipe'
    } as unknown as object)
    return { ok: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg }
  }
}

export function discoverFiles(base: string, deps: Deps = defaultDeps): DiscoveryResult {
  try {
    const diffOut = deps.execFileSyncFn('git', ['diff', '--name-status', '-z', '--end-of-options', base, '--'], {
      encoding: 'utf-8'
    } as unknown as object)
    const parsed = parseNameStatusZero(diffOut)
    const untrackedOut = deps.execFileSyncFn('git', ['ls-files', '--others', '--exclude-standard', '-z', '--'], {
      encoding: 'utf-8'
    } as unknown as object)
    const untracked = parseUntrackedZero(untrackedOut)
    return {
      ok: true,
      changedAll: parsed.allPaths,
      changedExisting: parsed.existingPaths,
      deleted: parsed.deleted,
      untracked
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg, changedAll: [], changedExisting: [], deleted: new Set(), untracked: [] }
  }
}

// ---------------------------------------------------------------------------
// Spawning (safe, preserves exit codes, never uses *:run helpers)
// ---------------------------------------------------------------------------

export function spawnInherit(cmd: string, args: readonly string[], deps: Deps = defaultDeps): number {
  const result = deps.spawnSyncFn(cmd, args, { stdio: 'inherit' } as unknown as object)
  if (result.error) {
    return 1
  }
  if (typeof result.status === 'number') return result.status
  return 1
}

export function buildVitestChangedArgs(base: string): readonly string[] {
  return ['native:run', 'node', '--', 'vitest', 'run', '--project', 'renderer', `--changed=${base}`]
}

export function buildVitestRelatedArgs(untrackedRendererFiles: readonly string[]): readonly string[] {
  return ['native:run', 'node', '--', 'vitest', 'related', '--run', '--project', 'renderer', ...untrackedRendererFiles]
}

export function getLintableRendererFiles(rendererFiles: readonly string[], existingSet: ReadonlySet<string>): string[] {
  return rendererFiles.filter((f) => existingSet.has(f) && /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f))
}

export function runRendererVitest(
  base: string,
  untrackedRendererFiles: readonly string[],
  deps: Deps = defaultDeps
): number {
  const changedArgs = buildVitestChangedArgs(base)
  const changedExit = spawnInherit('pnpm', changedArgs, deps)

  if (untrackedRendererFiles.length === 0) {
    return changedExit
  }

  const relatedArgs = buildVitestRelatedArgs(untrackedRendererFiles)
  const relatedExit = spawnInherit('pnpm', relatedArgs, deps)

  if (changedExit !== 0) return changedExit
  return relatedExit
}

export function runFileScopedLint(
  rendererFiles: readonly string[],
  existingSet: ReadonlySet<string>,
  deps: Deps = defaultDeps
): number {
  const lintable = getLintableRendererFiles(rendererFiles, existingSet)
  if (lintable.length === 0) return 0

  let exit = 0

  const handle = (res: { status: number | null; error?: Error; signal?: NodeJS.Signals | null }): void => {
    if (res.error) {
      exit = 1
      return
    }
    if (res.signal != null) {
      exit = 1
      return
    }
    if (typeof res.status !== 'number') {
      exit = 1
      return
    }
    if (res.status !== 0) {
      exit = res.status
    }
  }

  try {
    const biome = deps.spawnSyncFn('pnpm', ['exec', 'biome', 'lint', '--', ...lintable], {
      stdio: 'inherit'
    } as unknown as object)
    handle(biome)
  } catch {
    exit = 1
  }

  try {
    const ox = deps.spawnSyncFn('pnpm', ['exec', 'oxlint', '--', ...lintable], {
      stdio: 'inherit'
    } as unknown as object)
    handle(ox)
  } catch {
    exit = 1
  }

  try {
    const es = deps.spawnSyncFn(
      'pnpm',
      ['exec', 'eslint', '--ext', '.js,.jsx,.cjs,.mjs,.ts,.tsx,.cts,.mts', '--', ...lintable],
      {
        stdio: 'inherit'
      } as unknown as object
    )
    handle(es)
  } catch {
    exit = 1
  }

  return exit
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function failClosed(message: string, base: string, extra?: string): never {
  console.error(message)
  console.error(`  base: ${base}`)
  if (extra) console.error(`  ${extra}`)
  console.error('')
  console.error('This command is local feedback only and cannot validate cross-process, package, or config changes.')
  console.error('Run `pnpm build:check` for the authoritative aggregate gate (lint + openapi:check + full test).')
  console.error(
    'Do not run `pnpm format`, `pnpm lint`, and `pnpm test` separately before `pnpm build:check`; `build:check` already proves those.'
  )
  process.exit(1)
}

export function mainWithDeps(deps: Deps = defaultDeps): void {
  const { base, help } = parseArgs(process.argv.slice(2))
  if (help) {
    console.log(usage())
    process.exit(0)
  }

  const baseValidation = validateBase(base, deps)
  if (!baseValidation.ok) {
    console.error('verify:changed: invalid --base ref')
    failClosed(
      'verify:changed: invalid base ref — fail closed.',
      base,
      `reason: ${baseValidation.error ?? 'invalid base'}`
    )
  }

  const discovery = discoverFiles(base, deps)
  if (!discovery.ok) {
    console.error('verify:changed: git discovery failed — fail closed.')
    failClosed('verify:changed: git discovery failed — fail closed.', base, `error: ${discovery.error ?? 'unknown'}`)
  }

  const result = classifyChangedSet(discovery.changedAll, discovery.untracked)

  if (result.verdict === 'unsafe') {
    console.error('verify:changed: unsafe scope detected — fast path is renderer-only.')
    console.error(`  base: ${base}`)
    console.error(`  reason: ${result.reason ?? 'non-renderer paths present'}`)
    if (result.unsafePaths.length > 0) {
      console.error(
        `  unsafe files: ${result.unsafePaths.slice(0, 10).join(', ')}${result.unsafePaths.length > 10 ? ' ...' : ''}`
      )
    }
    console.error('')
    console.error('This command is local feedback only and cannot validate cross-process, package, or config changes.')
    console.error('Run `pnpm build:check` for the authoritative aggregate gate (lint + openapi:check + full test).')
    console.error(
      'Do not run `pnpm format`, `pnpm lint`, and `pnpm test` separately before `pnpm build:check`; `build:check` already proves those.'
    )
    process.exit(1)
  }

  if (result.verdict === 'docs-only') {
    console.log('verify:changed: no renderer code changes detected (docs-only or no changes).')
    console.log('No validation performed — this is local no-op feedback, not proof of full validation.')
    console.log('For code-surface changes, run `pnpm build:check` (sole authoritative pre-commit gate).')
    process.exit(0)
  }

  const allRendererFiles = [...result.rendererPaths]
  const uniqueRendererFiles = [...new Set(allRendererFiles)]

  console.log(`verify:changed: renderer-only fast path (base=${base})`)
  if (result.docsPaths.length > 0) {
    console.log(`  + ${result.docsPaths.length} docs file(s) ignored (no validation needed)`)
  }
  console.log(
    `  renderer files: ${uniqueRendererFiles.slice(0, 10).join(', ')}${uniqueRendererFiles.length > 10 ? ' ...' : ''}`
  )

  const untrackedRendererFiles = discovery.untracked.filter((f) => classifyPath(f) === 'renderer')

  const existingSet = new Set<string>([...discovery.changedExisting, ...discovery.untracked])

  const vitestExit = runRendererVitest(base, untrackedRendererFiles, deps)
  if (vitestExit !== 0) {
    process.exit(vitestExit)
  }

  const lintExit = runFileScopedLint(uniqueRendererFiles, existingSet, deps)
  if (lintExit !== 0) {
    process.exit(lintExit)
  }

  console.log('')
  console.log('verify:changed: renderer fast-feedback passed (local only).')
  console.log('This is NOT proof of full validation and NOT a substitute for `pnpm build:check` or CI.')
  process.exit(0)
}

function main(): void {
  mainWithDeps(defaultDeps)
}

// Only run main when executed as script (not when imported for tests)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('verify-changed.ts')) {
  main()
}
