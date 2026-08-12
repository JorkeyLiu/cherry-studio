import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createArtifactPathResolver, normalizeScenarioExport, resolveScenario, sanitizeArtifactName } from './scenario'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-observe-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('normalizeScenarioExport', () => {
  it('accepts a default-exported function', () => {
    const run = vi.fn()
    const scenario = normalizeScenarioExport({ default: run }, 'file-name')
    expect(scenario.name).toBe('file-name')
    expect(scenario.run).toBe(run)
  })

  it('accepts a default-exported object with a run function', () => {
    const run = vi.fn()
    const scenario = normalizeScenarioExport({ default: { name: 'named', description: 'desc', run } }, 'fallback')
    expect(scenario.name).toBe('named')
    expect(scenario.description).toBe('desc')
    expect(scenario.run).toBe(run)
  })

  it('uses the fallback name when the object has no name', () => {
    const scenario = normalizeScenarioExport({ default: { run: vi.fn() } }, 'fallback-name')
    expect(scenario.name).toBe('fallback-name')
    expect(scenario.description).toBeUndefined()
  })

  it('accepts a named scenario export when the default is missing', () => {
    const run = vi.fn()
    const scenario = normalizeScenarioExport({ scenario: { name: 'named-export', run } }, 'fallback')
    expect(scenario.name).toBe('named-export')
    expect(scenario.run).toBe(run)
  })

  it('rejects an invalid module shape with a descriptive error', () => {
    expect(() => normalizeScenarioExport({ default: { notARun: true } }, 'bad')).toThrow(
      /invalid scenario module 'bad'/
    )
    expect(() => normalizeScenarioExport(undefined, 'missing')).toThrow(/invalid scenario module 'missing'/)
    expect(() => normalizeScenarioExport({}, 'empty')).toThrow(/invalid scenario module 'empty'/)
  })
})

describe('sanitizeArtifactName', () => {
  it('keeps safe characters and replaces everything else', () => {
    expect(sanitizeArtifactName('home-screen')).toBe('home-screen')
    expect(sanitizeArtifactName('a/b:c d')).toBe('a-b-c-d')
    expect(sanitizeArtifactName('状态-ok')).toBe('ok')
  })

  it('falls back to artifact for a name with no usable characters', () => {
    expect(sanitizeArtifactName('')).toBe('artifact')
    expect(sanitizeArtifactName('///')).toBe('artifact')
    expect(sanitizeArtifactName('状态')).toBe('artifact')
  })
})

describe('createArtifactPathResolver', () => {
  it('appends the extension per kind', () => {
    const resolver = createArtifactPathResolver('/out')
    expect(resolver('png', 'home')).toBe(path.join('/out', 'home.png'))
    expect(resolver('txt', 'notes')).toBe(path.join('/out', 'notes.txt'))
  })

  it('does not double-append an extension already present in the name', () => {
    const resolver = createArtifactPathResolver('/out')
    expect(resolver('png', 'home.png')).toBe(path.join('/out', 'home.png'))
    expect(resolver('txt', 'state.json')).toBe(path.join('/out', 'state.json'))
  })

  it('deduplicates repeated names with a numeric suffix', () => {
    const resolver = createArtifactPathResolver('/out')
    expect(resolver('png', 'home')).toBe(path.join('/out', 'home.png'))
    expect(resolver('png', 'home')).toBe(path.join('/out', 'home-2.png'))
    expect(resolver('png', 'home')).toBe(path.join('/out', 'home-3.png'))
  })

  it('never lets two allocations resolve to the same final path', () => {
    const resolver = createArtifactPathResolver('/out')
    const names = ['a', 'a.png', 'a', 'a-2', 'A', 'state.json', 'state.json']
    const paths = names.map((name) => resolver('png', name))
    expect(new Set(paths).size).toBe(paths.length)
    expect(paths[0]).toBe(path.join('/out', 'a.png'))
    // `a.png` aliases the first `a` (extension alias) -> deduped suffix.
    expect(paths[1]).toBe(path.join('/out', 'a.png-2'))
    // Repeated `a` is deduped past the taken `a.png`.
    expect(paths[2]).toBe(path.join('/out', 'a-2.png'))
    // `a-2` collides with the deduped second `a` -> deduped again.
    expect(paths[3]).toBe(path.join('/out', 'a-2-2.png'))
    // Case-folded alias is never handed the same file twice.
    expect(paths[4]).toBe(path.join('/out', 'A-3.png'))
    expect(paths[5]).toBe(path.join('/out', 'state.json'))
    expect(paths[6]).toBe(path.join('/out', 'state.json-2'))
  })

  it('case-folds collision detection for case-insensitive filesystems', () => {
    const resolver = createArtifactPathResolver('/out')
    expect(resolver('png', 'home')).toBe(path.join('/out', 'home.png'))
    expect(resolver('png', 'Home')).toBe(path.join('/out', 'Home-2.png'))
    expect(resolver('png', 'HOME')).toBe(path.join('/out', 'HOME-3.png'))
  })

  it('deduplicates cross-kind aliases with a numeric suffix', () => {
    const resolver = createArtifactPathResolver('/out')
    expect(resolver('png', 'home')).toBe(path.join('/out', 'home.png'))
    expect(resolver('txt', 'home')).toBe(path.join('/out', 'home-2.txt'))
    expect(resolver('txt', 'home')).toBe(path.join('/out', 'home-3.txt'))
    // A `home-2` txt write must not collide with the deduped `home` write.
    expect(resolver('txt', 'home-2')).toBe(path.join('/out', 'home-2-2.txt'))
  })

  it('keeps extension-less and explicit-extension writes distinct within one run', () => {
    const resolver = createArtifactPathResolver('/out')
    expect(resolver('txt', 'state')).toBe(path.join('/out', 'state.txt'))
    expect(resolver('txt', 'state.txt')).toBe(path.join('/out', 'state.txt-2'))
    expect(resolver('txt', 'state')).toBe(path.join('/out', 'state-2.txt'))
  })
})

describe('resolveScenario', () => {
  const builtins = [{ name: 'app-ready', module: { name: 'app-ready', run: vi.fn() } }]

  it('resolves a built-in selector by name', async () => {
    const loader = vi.fn()
    const resolved = await resolveScenario('app-ready', process.cwd(), builtins, loader)
    expect(resolved.scenario.name).toBe('app-ready')
    expect(resolved.source).toBe('builtin:app-ready')
    expect(loader).not.toHaveBeenCalled()
  })

  it('resolves a scenario file with an absolute path passed to the loader', async () => {
    const dir = tempDir()
    const scenarioPath = path.join(dir, 'my-scenario.ts')
    fs.writeFileSync(scenarioPath, 'export default async () => {}')
    const loader = vi.fn().mockResolvedValue({ default: { run: vi.fn() } })

    const resolved = await resolveScenario(scenarioPath, dir, builtins, loader)
    expect(resolved.source).toBe(scenarioPath)
    expect(resolved.scenario.name).toBe('my-scenario')
    expect(loader).toHaveBeenCalledWith(scenarioPath)
  })

  it('resolves a relative path against the cwd', async () => {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'rel.ts'), 'export default async () => {}')
    const loader = vi.fn().mockResolvedValue({ default: { run: vi.fn() } })

    const resolved = await resolveScenario('./rel.ts', dir, builtins, loader)
    expect(resolved.source).toBe(path.join(dir, 'rel.ts'))
    expect(resolved.scenario.name).toBe('rel')
  })

  it('appends a .ts extension for an extension-less existing path', async () => {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'bare.ts'), 'export default async () => {}')
    const loader = vi.fn().mockResolvedValue({ default: { run: vi.fn() } })

    const resolved = await resolveScenario('bare', dir, builtins, loader)
    expect(resolved.source).toBe(path.join(dir, 'bare.ts'))
  })

  it('throws a descriptive error when the selector matches neither a built-in nor a file', async () => {
    const dir = tempDir()
    await expect(resolveScenario('nope', dir, builtins)).rejects.toThrow(/scenario not found: 'nope'/)
  })

  it('propagates a loader failure as-is', async () => {
    const dir = tempDir()
    const scenarioPath = path.join(dir, 'broken.ts')
    fs.writeFileSync(scenarioPath, 'this is not typescript')
    const loader = vi.fn().mockRejectedValue(new Error('import failed'))

    await expect(resolveScenario(scenarioPath, dir, builtins, loader)).rejects.toThrow('import failed')
  })
})
