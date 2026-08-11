/**
 * Focused regression tests for the canonical Dexie schema module
 * (`./dbSchema`) and its barrel (`./index`).
 *
 * Proves the isolation contract after the schema/upgrades refactor:
 * - One canonical `CherryStudio` Dexie singleton (default + named exports from
 *   both `./dbSchema` and `./index` are the same instance).
 * - Exact schema versioning v1-v11 is preserved, including `quick_phrases`
 *   remaining present in v6-v11 (LOCK-001) and the per-version table
 *   availability boundaries.
 * - Module evaluation is isolated: constructing the schema (and lazily loading
 *   `./upgrades` / `./migrationHelpers`) never requires `window.api` /
 *   `window.electron`, and never runtime-evaluates the `@renderer/types`
 *   barrel (all type imports are erased).
 *
 * Schema inspection uses Dexie's per-version `_versions[]._cfg.dbschema`
 * (cumulative schema snapshot per declared version) — stable in Dexie 4.x and
 * available without opening an IndexedDB connection.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Dexie } from 'dexie'
import { describe, expect, it, vi } from 'vitest'

import dbSchemaDefault, { db } from '../dbSchema'
import indexDefault, { db as barrelDb } from '../index'

/**
 * The four database modules must only ever `import type` from
 * `@renderer/types` (erased at transform time). A runtime value import would
 * evaluate the whole renderer types barrel (and its i18n/LoggerService chain)
 * inside the isolated chatImport renderer — the exact regression this file
 * guards against. The throwing factory is file-wide; it fires if any module in
 * this file's graph (dbSchema/upgrades/migrationHelpers/index) runtime-imports
 * the barrel.
 */
vi.mock('@renderer/types', () => {
  throw new Error('@renderer/types must not be runtime-evaluated by databases modules')
})

/** Table names declared cumulatively at a given Dexie schema version. */
function tablesAtVersion(versionNumber: number): string[] {
  const version = (db as any)._versions.find((v: any) => v._cfg.version === versionNumber)
  if (!version) throw new Error(`Dexie version ${versionNumber} is not declared by dbSchema`)
  return Object.keys(version._cfg.dbschema)
}

describe('canonical Dexie schema singleton', () => {
  it('exposes a single CherryStudio Dexie instance declared at v11', () => {
    expect(db).toBeInstanceOf(Dexie)
    expect(db.name).toBe('CherryStudio')
    expect(db.verno).toBe(11)
    // One canonical singleton: both export forms of both modules point to it.
    expect(dbSchemaDefault).toBe(db)
    expect(barrelDb).toBe(db)
    expect(indexDefault).toBe(db)
  })

  it('keeps quick_phrases available across v6-v11 only (LOCK-001)', () => {
    for (let version = 1; version <= 5; version += 1) {
      expect(tablesAtVersion(version)).not.toContain('quick_phrases')
    }
    for (let version = 6; version <= 11; version += 1) {
      expect(tablesAtVersion(version)).toContain('quick_phrases')
    }
  })

  it('keeps the exact v1-v11 table availability boundaries', () => {
    // topics/settings arrive at v2, knowledge_notes at v3, translate_history at v4.
    expect(tablesAtVersion(1)).toEqual(['files'])
    expect(tablesAtVersion(2)).toEqual(expect.arrayContaining(['files', 'topics', 'settings']))
    expect(tablesAtVersion(3)).toContain('knowledge_notes')
    expect(tablesAtVersion(4)).toContain('translate_history')

    // message_blocks arrives at v7 and stays through v11.
    for (let version = 1; version <= 6; version += 1) {
      expect(tablesAtVersion(version)).not.toContain('message_blocks')
    }
    for (let version = 7; version <= 11; version += 1) {
      expect(tablesAtVersion(version)).toContain('message_blocks')
    }

    // translate_languages arrives at v9, topic_segments at v11.
    for (let version = 7; version <= 8; version += 1) {
      expect(tablesAtVersion(version)).not.toContain('translate_languages')
    }
    expect(tablesAtVersion(9)).toContain('translate_languages')
    for (let version = 9; version <= 10; version += 1) {
      expect(tablesAtVersion(version)).not.toContain('topic_segments')
    }
    expect(tablesAtVersion(11)).toContain('topic_segments')

    // Final v11 schema holds every canonical table exactly once.
    expect(tablesAtVersion(11)).toEqual([
      'files',
      'topics',
      'settings',
      'knowledge_notes',
      'translate_history',
      'quick_phrases',
      'message_blocks',
      'translate_languages',
      'topic_segments'
    ])
  })
})

describe('isolated module evaluation', () => {
  it('imports dbSchema/index/upgrades/migrationHelpers without window.api or window.electron', async () => {
    vi.resetModules()
    const originalApi = (window as any).api
    const originalElectron = (window as any).electron
    try {
      delete (window as any).api
      delete (window as any).electron
      delete (globalThis as any).api
      delete (globalThis as any).electron

      const schema = await import('../dbSchema')
      const barrel = await import('../index')
      const upgrades = await import('../upgrades')
      const helpers = await import('../migrationHelpers')

      // Construction succeeded without the window bridge.
      expect(schema.db.name).toBe('CherryStudio')
      expect(schema.db.verno).toBe(11)
      // The freshly evaluated schema is the same canonical instance through the barrel.
      expect(barrel.db).toBe(schema.db)
      // Lazy-upgrade exports are present but never evaluated by construction.
      expect(typeof upgrades.upgradeToV5).toBe('function')
      expect(typeof upgrades.upgradeToV7).toBe('function')
      expect(typeof upgrades.upgradeToV8).toBe('function')
      expect(typeof helpers.generateId).toBe('function')
    } finally {
      ;(window as any).api = originalApi
      ;(window as any).electron = originalElectron
      ;(globalThis as any).api = originalApi
      ;(globalThis as any).electron = originalElectron
    }
  })

  it('never runtime-evaluates the @renderer/types barrel (type-only imports are erased)', async () => {
    vi.resetModules()
    // If any database module had a runtime `import ... from '@renderer/types'`,
    // this throwing mock factory would fire during evaluation and fail the test.
    const schema = await import('../dbSchema')
    const upgrades = await import('../upgrades')
    const helpers = await import('../migrationHelpers')

    expect(schema.db.name).toBe('CherryStudio')
    expect(typeof upgrades.upgradeToV7).toBe('function')
    expect(typeof helpers.generateId).toBe('function')
  })
})

describe('static import isolation (source contract)', () => {
  const databasesDir = dirname(fileURLToPath(import.meta.url))
  const readSource = (name: string): string => readFileSync(resolve(databasesDir, '..', name), 'utf8')

  /** Removes block comments and line comments (keeps `//` inside URLs). */
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  /** Removes `import type` statements (single-line and multi-line) from source. */
  const stripTypeImports = (source: string): string =>
    source
      .replace(/import\s+type\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"]/g, '')
      .replace(/import\s+type\s*\w+\s*from\s*['"][^'"]+['"]/g, '')

  it('keeps every @renderer import type-only in the database modules', () => {
    // The isolated chatImport renderer loads dbSchema/upgrades/migrationHelpers
    // outside the main bundle, so ANY non-type `@renderer/*` import would pull
    // main-renderer runtime code into the lazy historical-upgrades chunk. This
    // static check fails the moment a runtime import is reintroduced, even
    // before the build-time chunk scan.
    for (const file of ['dbSchema.ts', 'index.ts', 'upgrades.ts', 'migrationHelpers.ts']) {
      const remaining = stripTypeImports(stripComments(readSource(file)))
      const runtimeRendererImport = remaining.match(/import\s*[\s\S]*?from\s*['"]@renderer\/(?:[^'"]*)['"]/)
      expect(runtimeRendererImport, `${file} must have no runtime @renderer import`).toBeNull()
    }
  })
})
