import {
  buildVitestChangedArgs,
  buildVitestRelatedArgs,
  classifyChangedSet,
  classifyPath,
  type Deps,
  discoverFiles,
  getLintableRendererFiles,
  mainWithDeps,
  parseArgs,
  parseNameStatusZero,
  parseUntrackedZero,
  runFileScopedLint,
  runRendererVitest,
  spawnInherit,
  validateBase
} from '../verify-changed'

// ---------------------------------------------------------------------------
// Existing coverage retained
// ---------------------------------------------------------------------------

describe('classifyPath', () => {
  test('renderer source/test paths', () => {
    expect(classifyPath('src/renderer/src/components/Button.tsx')).toBe('renderer')
    expect(classifyPath('src/renderer/src/foo.test.ts')).toBe('renderer')
    expect(classifyPath('src/renderer/index.html')).toBe('renderer')
  })

  test('main paths', () => {
    expect(classifyPath('src/main/services/foo.ts')).toBe('main')
    expect(classifyPath('src/main/index.ts')).toBe('main')
  })

  test('preload paths', () => {
    expect(classifyPath('src/preload/index.ts')).toBe('preload')
  })

  test('scripts paths', () => {
    expect(classifyPath('scripts/check-i18n.ts')).toBe('scripts')
    expect(classifyPath('scripts/native-abi/run.ts')).toBe('scripts')
  })

  test('shared paths', () => {
    expect(classifyPath('packages/shared/config/identity.ts')).toBe('shared')
    expect(classifyPath('packages/aiCore/src/foo.ts')).toBe('shared')
    expect(classifyPath('tests/e2e/utils/foo.ts')).toBe('shared')
  })

  test('package/config paths', () => {
    expect(classifyPath('package.json')).toBe('config')
    expect(classifyPath('pnpm-lock.yaml')).toBe('config')
    expect(classifyPath('tsconfig.node.json')).toBe('config')
    expect(classifyPath('electron.vite.config.ts')).toBe('config')
    expect(classifyPath('vitest.config.ts')).toBe('config')
    expect(classifyPath('patches/antd-npm-5.27.0-aa91c36546.patch')).toBe('config')
  })

  test('docs paths', () => {
    expect(classifyPath('docs/architecture.md')).toBe('docs')
    expect(classifyPath('README.md')).toBe('docs')
    expect(classifyPath('.agents/skills/foo/SKILL.md')).toBe('docs')
  })

  test('unknown paths', () => {
    expect(classifyPath('unknown/file.txt')).toBe('unknown')
    expect(classifyPath('build/output.js')).toBe('unknown')
    expect(classifyPath('resources/icon.png')).toBe('unknown')
  })
})

describe('classifyPath hardening — whitespace/absolute/traversal/NUL', () => {
  test('leading space is unknown not renderer', () => {
    expect(classifyPath(' src/renderer/src/foo.ts')).toBe('unknown')
  })
  test('trailing space is unknown', () => {
    expect(classifyPath('src/renderer/src/foo.ts ')).toBe('unknown')
  })
  test('both spaces is unknown', () => {
    expect(classifyPath(' src/renderer/src/foo.ts ')).toBe('unknown')
  })
  test('absolute path is unknown', () => {
    expect(classifyPath('/src/renderer/src/foo.ts')).toBe('unknown')
    expect(classifyPath('/etc/passwd')).toBe('unknown')
  })
  test('traversal is unknown', () => {
    expect(classifyPath('src/renderer/../main/foo.ts')).toBe('unknown')
    expect(classifyPath('../src/renderer/foo.ts')).toBe('unknown')
    expect(classifyPath('src/../src/renderer/foo.ts')).toBe('unknown')
  })
  test('NUL is unknown', () => {
    expect(classifyPath('src/renderer/foo\0.ts')).toBe('unknown')
    expect(classifyPath('\0src/renderer/foo.ts')).toBe('unknown')
  })
  test('double slash is unknown', () => {
    expect(classifyPath('src/renderer//foo.ts')).toBe('unknown')
  })
  test('trailing slash is unknown', () => {
    expect(classifyPath('src/renderer/src/foo.ts/')).toBe('unknown')
  })
  test('dot-slash is unknown', () => {
    expect(classifyPath('./src/renderer/foo.ts')).toBe('unknown')
  })
  test('windows absolute is unknown', () => {
    expect(classifyPath('C:/src/renderer/foo.ts')).toBe('unknown')
    expect(classifyPath('C:\\windows\\foo.ts')).toBe('unknown')
  })
  test('exact renderer still passes, whitespace variant does not get rewritten', () => {
    const a = classifyPath('src/renderer/foo.ts')
    const b = classifyPath(' src/renderer/foo.ts')
    expect(a).toBe('renderer')
    expect(b).toBe('unknown')
  })
})

describe('classifyChangedSet', () => {
  test('renderer-only', () => {
    const r = classifyChangedSet(['src/renderer/src/components/Button.tsx'], [])
    expect(r.verdict).toBe('renderer-only')
    expect(r.rendererPaths).toEqual(['src/renderer/src/components/Button.tsx'])
  })

  test('renderer+docs is still renderer-only', () => {
    const r = classifyChangedSet(['src/renderer/src/foo.ts', 'docs/architecture.md'], [])
    expect(r.verdict).toBe('renderer-only')
    expect(r.rendererPaths).toEqual(['src/renderer/src/foo.ts'])
    expect(r.docsPaths).toEqual(['docs/architecture.md'])
  })

  test('shared => unsafe', () => {
    const r = classifyChangedSet(['packages/shared/src/foo.ts'], [])
    expect(r.verdict).toBe('unsafe')
    expect(r.unsafePaths).toContain('packages/shared/src/foo.ts')
  })

  test('main/preload => unsafe', () => {
    const r1 = classifyChangedSet(['src/main/services/foo.ts'], [])
    expect(r1.verdict).toBe('unsafe')
    const r2 = classifyChangedSet(['src/preload/index.ts'], [])
    expect(r2.verdict).toBe('unsafe')
  })

  test('package/config => unsafe', () => {
    const r = classifyChangedSet(['package.json'], [])
    expect(r.verdict).toBe('unsafe')
    const r2 = classifyChangedSet(['tsconfig.node.json'], [])
    expect(r2.verdict).toBe('unsafe')
    const r3 = classifyChangedSet(['electron.vite.config.ts'], [])
    expect(r3.verdict).toBe('unsafe')
  })

  test('scripts => unsafe', () => {
    const r = classifyChangedSet(['scripts/check-i18n.ts'], [])
    expect(r.verdict).toBe('unsafe')
  })

  test('unknown => unsafe', () => {
    const r = classifyChangedSet(['some/random/file.txt'], [])
    expect(r.verdict).toBe('unsafe')
  })

  test('docs-only', () => {
    const r = classifyChangedSet(['docs/architecture.md', 'README.md'], [])
    expect(r.verdict).toBe('docs-only')
  })

  test('empty => docs-only no-op', () => {
    const r = classifyChangedSet([], [])
    expect(r.verdict).toBe('docs-only')
  })

  test('untracked renderer test handling: untracked renderer file is included and yields renderer-only', () => {
    const r = classifyChangedSet([], ['src/renderer/src/foo.test.ts'])
    expect(r.verdict).toBe('renderer-only')
    expect(r.rendererPaths).toEqual(['src/renderer/src/foo.test.ts'])
  })

  test('untracked renderer source is included', () => {
    const r = classifyChangedSet([], ['src/renderer/src/utils/helper.ts'])
    expect(r.verdict).toBe('renderer-only')
  })

  test('mixed tracked renderer + untracked renderer stays renderer-only', () => {
    const r = classifyChangedSet(['src/renderer/src/a.ts'], ['src/renderer/src/b.test.ts'])
    expect(r.verdict).toBe('renderer-only')
    expect(r.rendererPaths).toHaveLength(2)
  })

  test('untracked unsafe fails closed', () => {
    const r = classifyChangedSet(['src/renderer/src/a.ts'], ['src/main/foo.ts'])
    expect(r.verdict).toBe('unsafe')
  })

  test('renderer + shared fails closed', () => {
    const r = classifyChangedSet(['src/renderer/src/a.ts', 'packages/shared/foo.ts'], [])
    expect(r.verdict).toBe('unsafe')
  })

  test('whitespace path is unsafe not trimmed to renderer', () => {
    const r = classifyChangedSet([' src/renderer/src/foo.ts'], [])
    expect(r.verdict).toBe('unsafe')
    expect(r.unsafePaths).toContain(' src/renderer/src/foo.ts')
    expect(r.rendererPaths).toHaveLength(0)
  })

  test('preserves exact whitespace identity without trim', () => {
    const input = ' src/renderer/src/a.ts '
    const r = classifyChangedSet([input], [])
    expect(r.unsafePaths[0]).toBe(input)
  })

  test('NUL path is unsafe', () => {
    const r = classifyChangedSet(['src/renderer/foo\0.ts'], [])
    expect(r.verdict).toBe('unsafe')
  })

  test('absolute path is unsafe', () => {
    const r = classifyChangedSet(['/src/renderer/foo.ts'], [])
    expect(r.verdict).toBe('unsafe')
  })
})

describe('parseArgs', () => {
  test('default base is HEAD', () => {
    expect(parseArgs([]).base).toBe('HEAD')
  })

  test('parses --base=HEAD~1', () => {
    expect(parseArgs(['--base=HEAD~1']).base).toBe('HEAD~1')
  })

  test('parses --base HEAD', () => {
    expect(parseArgs(['--base', 'HEAD~2']).base).toBe('HEAD~2')
  })

  test('empty --base= is preserved as empty for validation to reject', () => {
    expect(parseArgs(['--base=']).base).toBe('')
  })

  test('empty --base value via separate arg is preserved', () => {
    expect(parseArgs(['--base', '']).base).toBe('')
  })

  test('missing --base value is empty not fallback', () => {
    expect(parseArgs(['--base']).base).toBe('')
  })

  test('whitespace --base= is preserved', () => {
    expect(parseArgs(['--base=   ']).base).toBe('   ')
  })

  test('hostile base is preserved as single value not shell split', () => {
    const hostile = 'HEAD; echo pwned'
    expect(parseArgs([`--base=${hostile}`]).base).toBe(hostile)
  })
})

describe('NUL parsing preserves identity', () => {
  test('parseNameStatusZero — single M', () => {
    const out = 'M\0src/renderer/src/foo.ts\0'
    const r = parseNameStatusZero(out)
    expect(r.allPaths).toEqual(['src/renderer/src/foo.ts'])
    expect(r.existingPaths).toEqual(['src/renderer/src/foo.ts'])
    expect(r.deleted.size).toBe(0)
  })

  test('parseNameStatusZero — D is deleted not existing', () => {
    const out = 'D\0src/renderer/src/deleted.ts\0'
    const r = parseNameStatusZero(out)
    expect(r.allPaths).toEqual(['src/renderer/src/deleted.ts'])
    expect(r.existingPaths).toEqual([])
    expect(r.deleted.has('src/renderer/src/deleted.ts')).toBe(true)
  })

  test('parseNameStatusZero — R rename yields both but only dst existing', () => {
    const out = 'R100\0src/renderer/old.ts\0src/renderer/new.ts\0'
    const r = parseNameStatusZero(out)
    expect(r.allPaths).toEqual(['src/renderer/old.ts', 'src/renderer/new.ts'])
    expect(r.existingPaths).toEqual(['src/renderer/new.ts'])
    expect(r.deleted.size).toBe(0)
  })

  test('parseNameStatusZero — C copy', () => {
    const out = 'C100\0src/renderer/a.ts\0src/renderer/b.ts\0'
    const r = parseNameStatusZero(out)
    expect(r.allPaths).toEqual(['src/renderer/a.ts', 'src/renderer/b.ts'])
    expect(r.existingPaths).toEqual(['src/renderer/b.ts'])
  })

  test('parseNameStatusZero — mixed M D R', () => {
    const out = [
      'M',
      'src/renderer/a.ts',
      'D',
      'src/renderer/b.ts',
      'R100',
      'src/renderer/c.ts',
      'src/renderer/d.ts'
    ].join('\0')
    const joined = out + '\0'
    const r = parseNameStatusZero(joined)
    expect(r.allPaths).toEqual(['src/renderer/a.ts', 'src/renderer/b.ts', 'src/renderer/c.ts', 'src/renderer/d.ts'])
    expect(r.existingPaths).toEqual(['src/renderer/a.ts', 'src/renderer/d.ts'])
    expect(r.deleted.has('src/renderer/b.ts')).toBe(true)
  })

  test('parseNameStatusZero — preserves whitespace filename without trim', () => {
    const out = 'M\0 src/renderer/space.ts\0'
    const r = parseNameStatusZero(out)
    expect(r.allPaths[0]).toBe(' src/renderer/space.ts')
    expect(classifyPath(r.allPaths[0])).toBe('unknown')
  })

  test('parseNameStatusZero — empty output', () => {
    expect(parseNameStatusZero('').allPaths).toEqual([])
  })

  test('parseUntrackedZero — simple', () => {
    const out = 'src/renderer/a.ts\0src/renderer/b.ts\0'
    expect(parseUntrackedZero(out)).toEqual(['src/renderer/a.ts', 'src/renderer/b.ts'])
  })

  test('parseUntrackedZero — preserves leading space', () => {
    const out = ' src/renderer/a.ts\0'
    expect(parseUntrackedZero(out)[0]).toBe(' src/renderer/a.ts')
  })

  test('parseUntrackedZero — empty', () => {
    expect(parseUntrackedZero('')).toEqual([])
  })
})

describe('validateBase — argv no-shell construction', () => {
  test('valid base calls rev-parse with exact argv', () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = []
    const deps: Deps = {
      execFileSyncFn: (cmd, args) => {
        calls.push({ cmd, args })
        return ''
      },
      spawnSyncFn: () => ({ status: 0 })
    }
    const res = validateBase('HEAD', deps)
    expect(res.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].cmd).toBe('git')
    expect(calls[0].args).toEqual(['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'])
  })

  test('hostile base is single argv element, not shell split', () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = []
    const deps: Deps = {
      execFileSyncFn: (cmd, args) => {
        calls.push({ cmd, args })
        return ''
      },
      spawnSyncFn: () => ({ status: 0 })
    }
    const hostile = 'HEAD; rm -rf /'
    const res = validateBase(hostile, deps)
    expect(res.ok).toBe(true)
    expect(calls[0].args[3]).toBe(`${hostile}^{commit}`)
    expect(calls[0].args).toHaveLength(4)
    expect(calls[0].args[2]).toBe('--end-of-options')
  })

  test('invalid base — empty string fails without git call', () => {
    let called = false
    const deps: Deps = {
      execFileSyncFn: () => {
        called = true
        return ''
      },
      spawnSyncFn: () => ({ status: 0 })
    }
    const res = validateBase('', deps)
    expect(res.ok).toBe(false)
    expect(called).toBe(false)
  })

  test('invalid base — whitespace fails without git call', () => {
    const deps: Deps = {
      execFileSyncFn: () => {
        throw new Error('should not be called')
      },
      spawnSyncFn: () => ({ status: 0 })
    }
    expect(validateBase('   ', deps).ok).toBe(false)
  })

  test('NUL in base fails without git call', () => {
    const deps: Deps = {
      execFileSyncFn: () => {
        throw new Error('should not be called')
      },
      spawnSyncFn: () => ({ status: 0 })
    }
    expect(validateBase('HEAD\0', deps).ok).toBe(false)
  })

  test('git rev-parse throws -> invalid', () => {
    const deps: Deps = {
      execFileSyncFn: () => {
        throw new Error('fatal: not a valid object name')
      },
      spawnSyncFn: () => ({ status: 0 })
    }
    expect(validateBase('NOTEXIST', deps).ok).toBe(false)
  })
})

describe('discoverFiles — success vs failure structure', () => {
  test('success parses changed and untracked via -z argv', () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = []
    const deps: Deps = {
      execFileSyncFn: (cmd, args) => {
        calls.push({ cmd, args })
        if (args.includes('--name-status')) {
          return 'M\0src/renderer/a.ts\0D\0src/renderer/b.ts\0'
        }
        if (args.includes('--others')) {
          return 'src/renderer/c.ts\0'
        }
        return ''
      },
      spawnSyncFn: () => ({ status: 0 })
    }
    const r = discoverFiles('HEAD', deps)
    expect(r.ok).toBe(true)
    expect(r.changedAll).toEqual(['src/renderer/a.ts', 'src/renderer/b.ts'])
    expect(r.changedExisting).toEqual(['src/renderer/a.ts'])
    expect(r.deleted.has('src/renderer/b.ts')).toBe(true)
    expect(r.untracked).toEqual(['src/renderer/c.ts'])
    expect(calls[0].args).toEqual(['diff', '--name-status', '-z', '--end-of-options', 'HEAD', '--'])
    expect(calls[1].args).toEqual(['ls-files', '--others', '--exclude-standard', '-z', '--'])
  })

  test('git diff failure yields ok false not empty docs-only', () => {
    const deps: Deps = {
      execFileSyncFn: () => {
        throw new Error('git diff failed')
      },
      spawnSyncFn: () => ({ status: 0 })
    }
    const r = discoverFiles('HEAD', deps)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/git diff failed/)
    expect(r.changedAll).toEqual([])
  })

  test('untracked failure also yields ok false', () => {
    const deps: Deps = {
      execFileSyncFn: (_cmd, args) => {
        if ((args as string[]).includes('--name-status')) return 'M\0src/renderer/a.ts\0'
        throw new Error('ls-files failed')
      },
      spawnSyncFn: () => ({ status: 0 })
    }
    const r = discoverFiles('HEAD', deps)
    expect(r.ok).toBe(false)
  })

  test('uses argv array, never shell string', () => {
    const calls: Array<{ args: readonly string[] }> = []
    const deps: Deps = {
      execFileSyncFn: (_cmd, args) => {
        calls.push({ args })
        if ((args as string[]).includes('--name-status')) return ''
        return ''
      },
      spawnSyncFn: () => ({ status: 0 })
    }
    discoverFiles('HEAD', deps)
    for (const c of calls) {
      expect(Array.isArray(c.args)).toBe(true)
      expect(c.args.join(' ')).not.toContain('&&')
    }
  })

  test('rename handling — src not in existing', () => {
    const deps: Deps = {
      execFileSyncFn: (_cmd, args) => {
        if ((args as string[]).includes('--name-status')) return 'R100\0src/renderer/old.ts\0src/renderer/new.ts\0'
        return ''
      },
      spawnSyncFn: () => ({ status: 0 })
    }
    const r = discoverFiles('HEAD', deps)
    expect(r.ok).toBe(true)
    expect(r.changedAll).toEqual(['src/renderer/old.ts', 'src/renderer/new.ts'])
    expect(r.changedExisting).toEqual(['src/renderer/new.ts'])
  })
})

describe('canonical lane argv and spawn propagation', () => {
  test('buildVitestChangedArgs is exact canonical', () => {
    expect(buildVitestChangedArgs('HEAD')).toEqual([
      'native:run',
      'node',
      '--',
      'vitest',
      'run',
      '--project',
      'renderer',
      '--changed=HEAD'
    ])
  })

  test('buildVitestChangedArgs with hostile base preserved as single arg value', () => {
    const hostile = 'HEAD; rm -rf /'
    const args = buildVitestChangedArgs(hostile)
    expect(args[args.length - 1]).toBe(`--changed=${hostile}`)
  })

  test('buildVitestRelatedArgs canonical', () => {
    expect(buildVitestRelatedArgs(['src/renderer/a.ts', 'src/renderer/b.ts'])).toEqual([
      'native:run',
      'node',
      '--',
      'vitest',
      'related',
      '--run',
      '--project',
      'renderer',
      'src/renderer/a.ts',
      'src/renderer/b.ts'
    ])
  })

  test('spawnInherit propagates status and spawn error as 1', () => {
    let deps: Deps = {
      execFileSyncFn: () => '',
      spawnSyncFn: () => ({ status: 2 })
    }
    expect(spawnInherit('pnpm', ['arg'], deps)).toBe(2)
    deps = {
      execFileSyncFn: () => '',
      spawnSyncFn: () => ({ status: null, error: new Error('spawn ENOENT') })
    }
    expect(spawnInherit('pnpm', ['arg'], deps)).toBe(1)
    deps = {
      execFileSyncFn: () => '',
      spawnSyncFn: () => ({ status: null, signal: 'SIGTERM' })
    }
    expect(spawnInherit('pnpm', ['arg'], deps)).toBe(1)
  })

  test('spawnInherit uses argv array via pnpm native:run node', () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = []
    const deps: Deps = {
      execFileSyncFn: () => '',
      spawnSyncFn: (cmd, args) => {
        calls.push({ cmd, args })
        return { status: 0 }
      }
    }
    spawnInherit('pnpm', buildVitestChangedArgs('HEAD'), deps)
    expect(calls[0].cmd).toBe('pnpm')
    expect(calls[0].args[0]).toBe('native:run')
    expect(calls[0].args[1]).toBe('node')
  })
})

describe('lint filtering excludes deleted/non-existing', () => {
  test('deleted renderer file excluded', () => {
    const rendererFiles = ['src/renderer/a.ts', 'src/renderer/b.ts']
    const existing = new Set(['src/renderer/a.ts'])
    expect(getLintableRendererFiles(rendererFiles, existing)).toEqual(['src/renderer/a.ts'])
  })

  test('non-ts files excluded', () => {
    const files = ['src/renderer/a.ts', 'src/renderer/b.css', 'src/renderer/c.json']
    const existing = new Set(files)
    expect(getLintableRendererFiles(files, existing)).toEqual(['src/renderer/a.ts'])
  })

  test('renamed old file not lintable if not in existing', () => {
    const rendererFiles = ['src/renderer/old.ts', 'src/renderer/new.ts']
    const existing = new Set(['src/renderer/new.ts'])
    expect(getLintableRendererFiles(rendererFiles, existing)).toEqual(['src/renderer/new.ts'])
  })

  test('untracked renderer files are lintable when in existing set', () => {
    const files = ['src/renderer/newfile.ts']
    const existing = new Set(['src/renderer/newfile.ts'])
    expect(getLintableRendererFiles(files, existing)).toEqual(['src/renderer/newfile.ts'])
  })

  test('integration: discover + classify + lint filtering end-to-end', () => {
    const deps: Deps = {
      execFileSyncFn: (_cmd, args) => {
        if ((args as string[]).includes('--name-status')) return 'D\0src/renderer/deleted.ts\0M\0src/renderer/kept.ts\0'
        if ((args as string[]).includes('--others')) return ''
        return ''
      },
      spawnSyncFn: () => ({ status: 0 })
    }
    const disc = discoverFiles('HEAD', deps)
    expect(disc.ok).toBe(true)
    const cls = classifyChangedSet(disc.changedAll, disc.untracked)
    expect(cls.verdict).toBe('renderer-only')
    const existing = new Set([...disc.changedExisting, ...disc.untracked])
    const lintable = getLintableRendererFiles(cls.rendererPaths, existing)
    expect(lintable).toEqual(['src/renderer/kept.ts'])
    expect(lintable).not.toContain('src/renderer/deleted.ts')
  })
})

describe('no shell invocation', () => {
  test('verify-changed source contains no execSync with shell string', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync('scripts/verify-changed.ts', 'utf-8')
    expect(src).not.toMatch(/execSync\(.*`git diff/)
    expect(src).not.toMatch(/execSync\(.*\$\{base\}/)
    expect(src).toContain('execFileSync')
    expect(src).not.toContain("execSync('git")
  })
})

describe('validateBase option-like rejection and --end-of-options', () => {
  test('rejects --help before git invocation', () => {
    let gitCalled = false
    const deps: Deps = {
      execFileSyncFn: () => {
        gitCalled = true
        return ''
      },
      spawnSyncFn: () => ({ status: 0 })
    }
    const res = validateBase('--help', deps)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/option-like/)
    expect(gitCalled).toBe(false)
  })

  test('rejects -p before git', () => {
    let called = false
    const deps: Deps = {
      execFileSyncFn: () => {
        called = true
        return ''
      },
      spawnSyncFn: () => ({ status: 0 })
    }
    expect(validateBase('-p', deps).ok).toBe(false)
    expect(called).toBe(false)
  })

  test('rejects -- with leading dash and whitespace-prefixed dash', () => {
    const deps: Deps = {
      execFileSyncFn: () => {
        throw new Error('should not be called')
      },
      spawnSyncFn: () => ({ status: 0 })
    }
    expect(validateBase('--', deps).ok).toBe(false)
    expect(validateBase(' -p', deps).ok).toBe(false)
    expect(validateBase('\t--help', deps).ok).toBe(false)
  })

  test('valid base uses --end-of-options delimiter', () => {
    const calls: Array<{ args: readonly string[] }> = []
    const deps: Deps = {
      execFileSyncFn: (_cmd, args) => {
        calls.push({ args })
        return ''
      },
      spawnSyncFn: () => ({ status: 0 })
    }
    const res = validateBase('HEAD', deps)
    expect(res.ok).toBe(true)
    expect(calls[0].args).toEqual(['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'])
  })

  test('hostile option-like base never reaches git even with --end-of-options logic', () => {
    const calls: Array<readonly string[]> = []
    const deps: Deps = {
      execFileSyncFn: (_cmd, args) => {
        calls.push(args)
        return ''
      },
      spawnSyncFn: () => ({ status: 0 })
    }
    const res = validateBase('--evil', deps)
    expect(res.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

describe('discoverFiles uses --end-of-options delimiter', () => {
  test('diff argv contains --end-of-options before base and trailing --', () => {
    const calls: Array<{ args: readonly string[] }> = []
    const deps: Deps = {
      execFileSyncFn: (_cmd, args) => {
        calls.push({ args } as { args: readonly string[] })
        if ((args as string[]).includes('--name-status')) return 'M\0src/renderer/a.ts\0'
        return ''
      },
      spawnSyncFn: () => ({ status: 0 })
    }
    const r = discoverFiles('HEAD', deps)
    expect(r.ok).toBe(true)
    expect(calls[0].args).toEqual(['diff', '--name-status', '-z', '--end-of-options', 'HEAD', '--'])
  })
})

describe('runRendererVitest orchestration — injected', () => {
  test('changed failure propagates non-zero and still invokes related but returns changed exit', () => {
    const calls: Array<{ args: readonly string[] }> = []
    const deps: Deps = {
      execFileSyncFn: () => '',
      spawnSyncFn: (_cmd, args) => {
        calls.push({ args })
        const argStr = args.join(' ')
        if (argStr.includes('--changed=')) return { status: 2 }
        if (argStr.includes('related')) return { status: 0 }
        return { status: 0 }
      }
    }
    const exit = runRendererVitest('HEAD', ['src/renderer/b.ts'], deps)
    expect(exit).toBe(2)
    // both changed and related were invoked
    expect(calls).toHaveLength(2)
    expect(calls[0].args).toContain('--changed=HEAD')
    expect(calls[1].args).toContain('related')
  })

  test('untracked related failure propagates when changed succeeds', () => {
    const deps: Deps = {
      execFileSyncFn: () => '',
      spawnSyncFn: (_cmd, args) => {
        const s = args.join(' ')
        if (s.includes('--changed=')) return { status: 0 }
        if (s.includes('related')) return { status: 3 }
        return { status: 0 }
      }
    }
    expect(runRendererVitest('HEAD', ['src/renderer/b.ts'], deps)).toBe(3)
  })

  test('happy path returns 0 and invokes canonical lane args', () => {
    const calls: Array<{ args: readonly string[] }> = []
    const deps: Deps = {
      execFileSyncFn: () => '',
      spawnSyncFn: (_cmd, args) => {
        calls.push({ args })
        return { status: 0 }
      }
    }
    const exit = runRendererVitest('HEAD', ['src/renderer/b.ts'], deps)
    expect(exit).toBe(0)
    expect(calls[0].args[0]).toBe('native:run')
    expect(calls[0].args[1]).toBe('node')
    expect(calls[1].args).toContain('related')
  })

  test('no untracked files only runs changed', () => {
    const calls: Array<readonly string[]> = []
    const deps: Deps = {
      execFileSyncFn: () => '',
      spawnSyncFn: (_cmd, args) => {
        calls.push(args)
        return { status: 0 }
      }
    }
    expect(runRendererVitest('HEAD', [], deps)).toBe(0)
    expect(calls).toHaveLength(1)
  })

  test('signal and error and null status propagate as 1', () => {
    let deps: Deps = {
      execFileSyncFn: () => '',
      spawnSyncFn: () => ({ status: null, signal: 'SIGTERM' })
    }
    expect(runRendererVitest('HEAD', [], deps)).toBe(1)
    deps = {
      execFileSyncFn: () => '',
      spawnSyncFn: () => ({ status: null, error: new Error('spawn') })
    }
    expect(runRendererVitest('HEAD', [], deps)).toBe(1)
    deps = {
      execFileSyncFn: () => '',
      spawnSyncFn: () => ({ status: null })
    }
    expect(runRendererVitest('HEAD', [], deps)).toBe(1)
  })
})

describe('runFileScopedLint strict failure propagation — injected', () => {
  const rendererFiles = ['src/renderer/a.ts', 'src/renderer/b.tsx']
  const existing = new Set(rendererFiles)

  test('happy path all linters 0 returns 0', () => {
    const deps: Deps = {
      execFileSyncFn: () => '',
      spawnSyncFn: () => ({ status: 0 })
    }
    expect(runFileScopedLint(rendererFiles, existing, deps)).toBe(0)
  })

  test('biome non-zero returns non-zero', () => {
    let idx = 0
    const deps: Deps = {
      execFileSyncFn: () => '',
      spawnSyncFn: () => {
        idx++
        if (idx === 1) return { status: 2 }
        return { status: 0 }
      }
    }
    expect(runFileScopedLint(rendererFiles, existing, deps)).toBe(2)
  })

  test('oxlint non-zero returns non-zero', () => {
    let idx = 0
    const deps: Deps = {
      execFileSyncFn: () => '',
      spawnSyncFn: () => {
        idx++
        if (idx === 2) return { status: 5 }
        return { status: 0 }
      }
    }
    expect(runFileScopedLint(rendererFiles, existing, deps)).toBe(5)
  })

  test('eslint non-zero returns non-zero', () => {
    let idx = 0
    const deps: Deps = {
      execFileSyncFn: () => '',
      spawnSyncFn: () => {
        idx++
        if (idx === 3) return { status: 7 }
        return { status: 0 }
      }
    }
    expect(runFileScopedLint(rendererFiles, existing, deps)).toBe(7)
  })

  test('biome signal propagates as 1', () => {
    let idx = 0
    const deps: Deps = {
      execFileSyncFn: () => '',
      spawnSyncFn: () => {
        idx++
        if (idx === 1) return { status: null, signal: 'SIGKILL' }
        return { status: 0 }
      }
    }
    expect(runFileScopedLint(rendererFiles, existing, deps)).toBe(1)
  })

  test('oxlint signal propagates', () => {
    let idx = 0
    const deps: Deps = {
      execFileSyncFn: () => '',
      spawnSyncFn: () => {
        idx++
        if (idx === 2) return { status: null, signal: 'SIGTERM' }
        return { status: 0 }
      }
    }
    expect(runFileScopedLint(rendererFiles, existing, deps)).toBe(1)
  })

  test('eslint signal propagates', () => {
    let idx = 0
    const deps: Deps = {
      execFileSyncFn: () => '',
      spawnSyncFn: () => {
        idx++
        if (idx === 3) return { status: null, signal: 'SIGABRT' }
        return { status: 0 }
      }
    }
    expect(runFileScopedLint(rendererFiles, existing, deps)).toBe(1)
  })

  test('biome spawn error propagates as 1', () => {
    let idx = 0
    const deps: Deps = {
      execFileSyncFn: () => '',
      spawnSyncFn: () => {
        idx++
        if (idx === 1) return { status: null, error: new Error('ENOENT') }
        return { status: 0 }
      }
    }
    expect(runFileScopedLint(rendererFiles, existing, deps)).toBe(1)
  })

  test('oxlint spawn error propagates', () => {
    let idx = 0
    const deps: Deps = {
      execFileSyncFn: () => '',
      spawnSyncFn: () => {
        idx++
        if (idx === 2) return { status: null, error: new Error('spawn') }
        return { status: 0 }
      }
    }
    expect(runFileScopedLint(rendererFiles, existing, deps)).toBe(1)
  })

  test('eslint spawn error propagates', () => {
    let idx = 0
    const deps: Deps = {
      execFileSyncFn: () => '',
      spawnSyncFn: () => {
        idx++
        if (idx === 3) return { status: null, error: new Error('fail') }
        return { status: 0 }
      }
    }
    expect(runFileScopedLint(rendererFiles, existing, deps)).toBe(1)
  })

  test('status-null without signal/error propagates as 1', () => {
    let idx = 0
    const deps: Deps = {
      execFileSyncFn: () => '',
      spawnSyncFn: () => {
        idx++
        if (idx === 1) return { status: null }
        return { status: 0 }
      }
    }
    expect(runFileScopedLint(rendererFiles, existing, deps)).toBe(1)
  })

  test('thrown exception from spawnSync propagates as 1 for each linter', () => {
    let idx = 0
    const deps: Deps = {
      execFileSyncFn: () => '',
      spawnSyncFn: () => {
        idx++
        if (idx === 1) throw new Error('thrown biome')
        if (idx === 2) throw new Error('thrown ox')
        if (idx === 3) throw new Error('thrown eslint')
        return { status: 0 }
      }
    }
    // first throw => exit 1, but subsequent also throw and stay 1
    expect(runFileScopedLint(rendererFiles, existing, deps)).toBe(1)
  })

  test('thrown on oxlint alone propagates', () => {
    let idx = 0
    const deps: Deps = {
      execFileSyncFn: () => '',
      spawnSyncFn: () => {
        idx++
        if (idx === 2) throw new Error('throw ox')
        return { status: 0 }
      }
    }
    expect(runFileScopedLint(rendererFiles, existing, deps)).toBe(1)
  })

  test('thrown on eslint alone propagates', () => {
    let idx = 0
    const deps: Deps = {
      execFileSyncFn: () => '',
      spawnSyncFn: () => {
        idx++
        if (idx === 3) throw new Error('throw eslint')
        return { status: 0 }
      }
    }
    expect(runFileScopedLint(rendererFiles, existing, deps)).toBe(1)
  })

  test('uses safe argv with -- delimiter before files', () => {
    const calls: Array<{ args: readonly string[] }> = []
    const deps: Deps = {
      execFileSyncFn: () => '',
      spawnSyncFn: (_cmd, args) => {
        calls.push({ args })
        return { status: 0 }
      }
    }
    runFileScopedLint(rendererFiles, existing, deps)
    expect(calls[0].args).toContain('--')
    expect(calls[1].args).toContain('--')
    expect(calls[2].args).toContain('--')
    // ensure lintable files appear after --
    for (const c of calls) {
      const dashIdx = (c.args as string[]).indexOf('--')
      expect(dashIdx).toBeGreaterThan(-1)
      const after = (c.args as string[]).slice(dashIdx + 1)
      expect(after).toEqual(expect.arrayContaining(rendererFiles))
    }
  })

  test('earlier failure not overwritten by later success', () => {
    let idx = 0
    const deps: Deps = {
      execFileSyncFn: () => '',
      spawnSyncFn: () => {
        idx++
        if (idx === 1) return { status: 2 }
        return { status: 0 }
      }
    }
    expect(runFileScopedLint(rendererFiles, existing, deps)).toBe(2)
  })
})

describe('mainWithDeps does not announce pass after failed subprocess — injected', () => {
  function captureMain(deps: Deps, argv: string[]): { exitCode: number | null; logs: string[]; errors: string[] } {
    const logs: string[] = []
    const errors: string[] = []
    const origLog = console.log
    const origError = console.error
    const origExit = process.exit
    const origArgv = process.argv
    let exitCode: number | null = null
    const captureLog: typeof console.log = (...args: Parameters<typeof console.log>) => {
      logs.push(args.join(' '))
    }
    const captureError: typeof console.error = (...args: Parameters<typeof console.error>) => {
      errors.push(args.join(' '))
    }
    const mockExit: typeof process.exit = (code?: number | string | null): never => {
      if (code === undefined || code === null) {
        exitCode = 0
      } else if (typeof code === 'number') {
        exitCode = code
      } else {
        const numeric = Number(code)
        exitCode = Number.isNaN(numeric) ? 1 : numeric
      }
      throw new Error(`__EXIT_${String(code)}`)
    }
    console.log = captureLog
    console.error = captureError
    process.exit = mockExit
    process.argv = ['node', 'verify-changed.ts', ...argv]
    try {
      mainWithDeps(deps)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.startsWith('__EXIT_')) throw e
    } finally {
      console.log = origLog
      console.error = origError
      process.exit = origExit
      process.argv = origArgv
    }
    return { exitCode, logs, errors }
  }

  test('renderer vitest failure does not print pass', () => {
    const deps: Deps = {
      execFileSyncFn: (_cmd, args) => {
        if ((args as string[]).includes('--verify')) return ''
        if ((args as string[]).includes('--name-status')) return 'M\0src/renderer/a.ts\0'
        if ((args as string[]).includes('--others')) return ''
        return ''
      },
      spawnSyncFn: (_cmd, args) => {
        const s = args.join(' ')
        if (s.includes('--changed=')) return { status: 4 }
        return { status: 0 }
      }
    }
    const { exitCode, logs } = captureMain(deps, ['--base=HEAD'])
    expect(exitCode).toBe(4)
    expect(logs.join('\n')).not.toContain('fast-feedback passed')
  })

  test('untracked related failure does not print pass', () => {
    const deps: Deps = {
      execFileSyncFn: (_cmd, args) => {
        if ((args as string[]).includes('--verify')) return ''
        if ((args as string[]).includes('--name-status')) return 'M\0src/renderer/a.ts\0'
        if ((args as string[]).includes('--others')) return 'src/renderer/b.ts\0'
        return ''
      },
      spawnSyncFn: (_cmd, args) => {
        const s = args.join(' ')
        if (s.includes('--changed=')) return { status: 0 }
        if (s.includes('related')) return { status: 5 }
        return { status: 0 }
      }
    }
    const { exitCode, logs } = captureMain(deps, ['--base=HEAD'])
    expect(exitCode).toBe(5)
    expect(logs.join('\n')).not.toContain('fast-feedback passed')
  })

  test('linter failure does not print pass', () => {
    const deps: Deps = {
      execFileSyncFn: (_cmd, args) => {
        if ((args as string[]).includes('--verify')) return ''
        if ((args as string[]).includes('--name-status')) return 'M\0src/renderer/a.ts\0'
        if ((args as string[]).includes('--others')) return ''
        return ''
      },
      spawnSyncFn: (_cmd, args) => {
        const s = args.join(' ')
        if (s.includes('--changed=')) return { status: 0 }
        if (s.includes('related')) return { status: 0 }
        if (s.includes('biome')) return { status: 2 }
        return { status: 0 }
      }
    }
    const { exitCode, logs } = captureMain(deps, ['--base=HEAD'])
    expect(exitCode).toBe(2)
    expect(logs.join('\n')).not.toContain('fast-feedback passed')
  })

  test('linter signal does not print pass', () => {
    const deps: Deps = {
      execFileSyncFn: (_cmd, args) => {
        if ((args as string[]).includes('--verify')) return ''
        if ((args as string[]).includes('--name-status')) return 'M\0src/renderer/a.ts\0'
        if ((args as string[]).includes('--others')) return ''
        return ''
      },
      spawnSyncFn: (_cmd, args) => {
        const s = args.join(' ')
        if (s.includes('--changed=')) return { status: 0 }
        if (s.includes('biome')) return { status: null, signal: 'SIGTERM' }
        return { status: 0 }
      }
    }
    const { exitCode, logs } = captureMain(deps, ['--base=HEAD'])
    expect(exitCode).toBe(1)
    expect(logs.join('\n')).not.toContain('fast-feedback passed')
  })

  test('linter thrown does not print pass', () => {
    const deps: Deps = {
      execFileSyncFn: (_cmd, args) => {
        if ((args as string[]).includes('--verify')) return ''
        if ((args as string[]).includes('--name-status')) return 'M\0src/renderer/a.ts\0'
        if ((args as string[]).includes('--others')) return ''
        return ''
      },
      spawnSyncFn: (_cmd, args) => {
        const s = args.join(' ')
        if (s.includes('--changed=')) return { status: 0 }
        if (s.includes('biome')) throw new Error('spawn throw')
        return { status: 0 }
      }
    }
    const { exitCode, logs } = captureMain(deps, ['--base=HEAD'])
    expect(exitCode).toBe(1)
    expect(logs.join('\n')).not.toContain('fast-feedback passed')
  })

  test('option-like base rejected before any git diff and does not print pass', () => {
    let diffCalled = false
    const deps: Deps = {
      execFileSyncFn: (_cmd, args) => {
        if ((args as string[]).includes('--name-status')) diffCalled = true
        if ((args as string[]).includes('--verify')) throw new Error('should not reach git verify for option-like')
        return ''
      },
      spawnSyncFn: () => ({ status: 0 })
    }
    // validateBase will be called inside mainWithDeps with base --help, should fail closed
    const { exitCode, logs } = captureMain(deps, ['--base=--help'])
    expect(exitCode).toBe(1)
    expect(diffCalled).toBe(false)
    expect(logs.join('\n')).not.toContain('fast-feedback passed')
  })

  test('happy path prints pass', () => {
    const deps: Deps = {
      execFileSyncFn: (_cmd, args) => {
        if ((args as string[]).includes('--verify')) return ''
        if ((args as string[]).includes('--name-status')) return 'M\0src/renderer/a.ts\0'
        if ((args as string[]).includes('--others')) return ''
        return ''
      },
      spawnSyncFn: () => ({ status: 0 })
    }
    const { exitCode, logs } = captureMain(deps, ['--base=HEAD'])
    expect(exitCode).toBe(0)
    expect(logs.join('\n')).toContain('fast-feedback passed')
  })
})
