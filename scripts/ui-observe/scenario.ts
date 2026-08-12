/**
 * Scenario API and resolution for the `pnpm ui:observe` observation harness.
 *
 * A scenario is a plain async function (or an object with a `run` function)
 * receiving an `ObservationContext`. Scenario files are TypeScript loaded by
 * the repository's `tsx` runtime via a plain dynamic `import()` — never eval
 * or generated source.
 *
 * The pure parts (module normalization, artifact-name sanitization, artifact
 * path resolution, scenario resolution) are deterministic and covered by the
 * `scripts` Vitest project.
 */
import { pathToFileURL } from 'node:url'

import type { ElectronApplication, Page } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'

/** Session metadata handed to every scenario (LOCK-OBS-003 disposable contract). */
export interface ObservationSessionMetadata {
  /** Unique disposable profile dir passed to Electron via --user-data-dir. */
  userDataDir: string
  /** Runtime appDataPath asserted to exactly equal `userDataDir`. */
  runtimeAppDataPath: string
  /** `<runtimeAppDataPath>/Data/chat.db` — the runtime path, never predicted. */
  chatDbPath: string
  /** Ownership-safe temp root for this run; every disposable artifact lives beneath it. */
  ownedTmpRoot: string
  /** Ephemeral in-process mock OpenAI-compatible endpoint port. */
  mockPort: number
  /** Unique output directory for this run's artifacts (survives cleanup). */
  outputDir: string
}

/** Context handed to a scenario body. */
export interface ObservationContext {
  /** The ready main `Cherry Chat` window (Playwright Electron Page). */
  page: Page
  /** The launched ElectronApplication (still running while the scenario executes). */
  electronApp: ElectronApplication
  /** Session metadata for this run. */
  session: ObservationSessionMetadata
  /**
   * Screenshot the main page into the run's output directory. The name is
   * sanitized and deduplicated; returns the absolute path of the written PNG.
   */
  capture(name: string): Promise<string>
  /**
   * Write a UTF-8 text artifact into the run's output directory. The name is
   * sanitized and deduplicated; returns the absolute path of the written file.
   */
  writeText(name: string, content: string): Promise<string>
}

/** A validated observation scenario. */
export interface ObservationScenario {
  /** Display name used for the output directory and stdout; defaults to the module name. */
  name?: string
  /** One-line description shown by `pnpm ui:observe --list`. */
  description?: string
  run(context: ObservationContext): Promise<void>
}

/** Accepted module export shapes: a default-exported object or function, or a named `scenario` export. */
export type ObservationScenarioExport = ObservationScenario | ((context: ObservationContext) => Promise<void>)

/**
 * Normalize an imported scenario module into a validated `ObservationScenario`.
 * Accepts a default export that is either an object with a `run` function or
 * a bare async function, a named `scenario` export as a fallback, and the
 * scenario object/function itself when the module is already that shape.
 * Throws a descriptive error for any other shape.
 */
export function normalizeScenarioExport(mod: unknown, fallbackName: string): ObservationScenario {
  const namespace = mod as { default?: unknown; scenario?: unknown } | null | undefined
  const candidate = namespace?.default ?? namespace?.scenario ?? mod

  if (typeof candidate === 'function') {
    return { name: fallbackName, run: candidate as (context: ObservationContext) => Promise<void> }
  }

  if (
    candidate !== null &&
    typeof candidate === 'object' &&
    typeof (candidate as { run?: unknown }).run === 'function'
  ) {
    const object = candidate as {
      name?: string
      description?: string
      run: (context: ObservationContext) => Promise<void>
    }
    return {
      ...(typeof object.name === 'string' && object.name.length > 0 ? { name: object.name } : { name: fallbackName }),
      ...(typeof object.description === 'string' && object.description.length > 0
        ? { description: object.description }
        : {}),
      run: object.run
    }
  }

  throw new Error(
    `invalid scenario module '${fallbackName}': expected a default-exported ` +
      `function (context) => Promise<void> or an object { name?, description?, run(context) }`
  )
}

/**
 * Sanitize an artifact name to the safe `[A-Za-z0-9._-]` set: invalid
 * characters become `-`, repeated dashes collapse, and leading/trailing
 * separators are trimmed. A name with no usable characters becomes `artifact`.
 */
export function sanitizeArtifactName(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
  return cleaned.length > 0 ? cleaned : 'artifact'
}

export type ArtifactKind = 'png' | 'txt'

/**
 * Build a deterministic artifact path resolver for one output directory.
 * The default extension (`png`/`txt`) is appended only when the sanitized
 * name carries no explicit dot, so `capture('home')` writes `home.png` and
 * `writeText('state.json')` writes `state.json` — never `home.png.png`.
 *
 * Allocation is collision-free within one run: no two captures/writes can
 * resolve to the same final path. Repeated logical names are deduplicated with
 * a `-2`, `-3`, ... suffix, and the suffix search skips any candidate whose
 * final path is already handed out. That covers extension aliases
 * (`capture('home')` then `capture('home.png')`), cross-kind aliases
 * (`writeText('state.json')` after `capture('state.json')`), dedupe-suffix
 * collisions (`home-2` colliding with the deduped second `home`), and
 * case-folded aliases on the common case-insensitive development filesystem
 * (`home` vs `Home`).
 */
export function createArtifactPathResolver(outputDir: string): (kind: ArtifactKind, name: string) => string {
  // Handed-out final paths (case-folded so a case-insensitive filesystem can
  // never alias two allocations onto one file).
  const used = new Set<string>()
  // Per-base-name dedupe counter, keyed case-folded like `used`.
  const baseCounts = new Map<string, number>()
  return (kind, name) => {
    const base = sanitizeArtifactName(name)
    const defaultExtension = kind === 'png' ? '.png' : '.txt'
    const extension = base.includes('.') ? '' : defaultExtension
    const candidate = (count: number) =>
      path.join(outputDir, count === 1 ? `${base}${extension}` : `${base}-${count}${extension}`)
    const fold = (filePath: string) => filePath.toLowerCase()
    const baseKey = base.toLowerCase()
    let count = (baseCounts.get(baseKey) ?? 0) + 1
    // Skip any candidate whose final path is already handed out. `count` only
    // grows and `used` is finite, so a free path is always found.
    while (used.has(fold(candidate(count)))) count += 1
    baseCounts.set(baseKey, count)
    const filePath = candidate(count)
    used.add(fold(filePath))
    return filePath
  }
}

/** A built-in scenario entry: selector name plus its module export. */
export interface BuiltinScenarioEntry {
  name: string
  module: ObservationScenarioExport
}

export interface ResolvedScenario {
  scenario: ObservationScenario
  /** Human-readable source: `builtin:<name>` or the absolute scenario file path. */
  source: string
}

/** Injectable scenario module loader (real wiring is `import()` via tsx). */
export type ScenarioModuleLoader = (absolutePath: string) => Promise<unknown>

const defaultScenarioLoader: ScenarioModuleLoader = (absolutePath) => import(pathToFileURL(absolutePath).href)

/**
 * Resolve a scenario selector: a built-in name wins first, otherwise the
 * selector is treated as a scenario file path (an extension-less path is
 * resolved with a `.ts` suffix appended). Throws a descriptive error when the
 * selector matches neither a built-in nor an existing file.
 */
export async function resolveScenario(
  selector: string,
  cwd: string,
  builtins: readonly BuiltinScenarioEntry[],
  loader: ScenarioModuleLoader = defaultScenarioLoader
): Promise<ResolvedScenario> {
  const builtin = builtins.find((entry) => entry.name === selector)
  if (builtin) {
    return {
      scenario: normalizeScenarioExport(builtin.module, builtin.name),
      source: `builtin:${builtin.name}`
    }
  }

  const direct = path.resolve(cwd, selector)
  let target = direct
  if (!fs.existsSync(target) && path.extname(target).length === 0) {
    const withTs = `${target}.ts`
    if (fs.existsSync(withTs)) target = withTs
  }
  if (!fs.existsSync(target)) {
    throw new Error(
      `scenario not found: '${selector}' (no built-in scenario named '${selector}' and no file at '${direct}')`
    )
  }

  const mod = await loader(target)
  const fallbackName = path.basename(target).replace(/\.(ts|tsx|js|mjs|mts)$/, '')
  return { scenario: normalizeScenarioExport(mod, fallbackName), source: target }
}
