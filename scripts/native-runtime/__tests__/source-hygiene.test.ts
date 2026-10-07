import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * Source-hygiene regression: the new runtime tool must not reintroduce the
 * removed machinery.
 *
 *  - no `scripts/native-runtime` non-test source references rebuild, lock,
 *    lease, node-gyp, forge markers, or the removed packages;
 *  - `package.json` exposes the fixed public contract (`native:run`,
 *    `native:check:node`, `native:check:electron`) and no `native:rebuild:*`;
 *  - `@electron/rebuild` is gone from dependencies.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const SOURCE_DIR = path.resolve(here, '..')
const REPO_ROOT = path.resolve(here, '..', '..', '..')

/** Machinery identifiers that must not appear in non-test runtime sources. */
const FORBIDDEN = [
  'native:rebuild',
  '@electron/rebuild',
  'node-gyp',
  'forge-meta',
  'native-abi-lock',
  'releaseLock',
  'leaseEnv',
  'LaneId',
  'LaneEnsure'
]

function nonTestSources(): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(SOURCE_DIR)) {
    const full = path.join(SOURCE_DIR, entry)
    if (entry === '__tests__') continue
    if (fs.statSync(full).isFile() && (entry.endsWith('.ts') || entry.endsWith('.cjs'))) {
      out.push(full)
    }
  }
  return out
}

describe('native-runtime source hygiene', () => {
  it('non-test sources contain no removed-machinery identifiers', () => {
    const sources = nonTestSources()
    expect(sources.length).toBeGreaterThan(0)
    for (const file of sources) {
      const content = fs.readFileSync(file, 'utf8')
      for (const token of FORBIDDEN) {
        expect(content, `${path.basename(file)} must not contain '${token}'`).not.toContain(token)
      }
    }
  })

  it('package.json exposes the fixed public contract without rebuild scripts', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(pkg.scripts['native:run']).toBe('tsx scripts/native-runtime/run-cli.ts')
    expect(pkg.scripts['native:check:node']).toBe('tsx scripts/native-runtime/cli.ts check node')
    expect(pkg.scripts['native:check:electron']).toBe('tsx scripts/native-runtime/cli.ts check electron')
    expect(pkg.scripts['native:rebuild:node']).toBeUndefined()
    expect(pkg.scripts['native:rebuild:electron']).toBeUndefined()
    expect(pkg.devDependencies['@electron/rebuild']).toBeUndefined()
    expect(pkg.dependencies['@electron/rebuild']).toBeUndefined()
    expect(pkg.dependencies['better-sqlite3']).toBe('13.0.3')
  })
})
