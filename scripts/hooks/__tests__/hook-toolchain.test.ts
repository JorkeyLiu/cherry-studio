import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

/**
 * Focused hermetic regression coverage for the hook toolchain bootstrap
 * (scripts/hooks/ensure-toolchain.sh + run-pnpm.sh +
 * install-if-deps-changed.sh) behind .pre-commit-config.yaml:
 *
 * - a restricted noninteractive PATH (no node/pnpm) resolves the
 *   repo-pinned nvm fallback (v24.11.1 + packageManager-pinned pnpm);
 * - a conflicting wrong-version node on PATH is overridden by the fallback;
 * - an already-correct inherited pair is used untouched (no fallback);
 * - correct Node + wrong pnpm falls back to the valid pinned pair;
 * - no valid pnpm pair fails closed (127 + Node+pnpm diagnostic);
 * - a missing toolchain fails closed (127 + diagnostic, no hidden success);
 * - pnpm arguments forward verbatim, including filenames with spaces;
 * - no-dependency-change runs skip without a toolchain or pnpm install;
 * - dependency-change runs trigger install and preserve real failures.
 *
 * Fully hermetic: every spawn uses a restricted PATH plus fake fixtures and
 * a scratch HOME/HOOK_NVM_ROOT. Fixtures never install anything and never
 * use the user PATH/HOME. Real-HOME/nvm smokes are intentionally excluded
 * from this committed suite; run them manually as separate smoke evidence.
 */

const REPO_ROOT = process.cwd()
const RUN_PNPM = join(REPO_ROOT, 'scripts/hooks/run-pnpm.sh')
const INSTALL = join(REPO_ROOT, 'scripts/hooks/install-if-deps-changed.sh')
const ENSURE = join(REPO_ROOT, 'scripts/hooks/ensure-toolchain.sh')
const PINNED_NODE = '24.11.1'
const PINNED_PNPM: string = (() => {
  const pm = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).packageManager as string) ?? ''
  return pm.replace(/^pnpm@/, '').split('+')[0]
})()
const RESTRICTED_PATH = '/usr/bin:/bin'

const TMP_ROOT = mkdtempSync(join(tmpdir(), 'hook-toolchain-test-'))

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true })
})

function writeExe(path: string, content: string): void {
  writeFileSync(path, content)
  chmodSync(path, 0o755)
}

/**
 * Fake node: answers --version locally, delegates every other invocation
 * (including `node -e` JSON evaluation for packageManager parsing) to the
 * real test runtime so fixtures stay hermetic without reimplementing node.
 */
function fakeNodeBin(dir: string, version: string): void {
  mkdirSync(dir, { recursive: true })
  writeExe(
    join(dir, 'node'),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "v${version}"; exit 0; fi
exec "${process.execPath}" "$@"
`
  )
}

/** Fake pnpm: answers --version with the given pin, forwards other args verbatim. */
function fakePnpmBin(dir: string, marker: string, version: string = PINNED_PNPM): void {
  mkdirSync(dir, { recursive: true })
  writeExe(
    join(dir, 'pnpm'),
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  if [ -n "\${FAKE_PNPM_VERSION:-}" ]; then echo "$FAKE_PNPM_VERSION"; else echo "${version}"; fi
  exit 0
fi
echo "${marker} ARGS:$*"
for _a in "$@"; do printf 'ARG:%s\\n' "$_a"; done
if [ -n "\${FAKE_PNPM_SENTINEL:-}" ]; then printf 'ran\\n' >> "$FAKE_PNPM_SENTINEL"; fi
exit \${FAKE_PNPM_EXIT:-0}
`
  )
}

/** Fake nvm layout: <root>/v<pinned-node>/bin/{node,pnpm}. */
function fakeNvm(root: string, nodeVersion: string, pnpmMarker: string, pnpmVersion: string = PINNED_PNPM): string {
  const bin = join(root, `v${PINNED_NODE}`, 'bin')
  fakeNodeBin(bin, nodeVersion)
  fakePnpmBin(bin, pnpmMarker, pnpmVersion)
  return root
}

function fakeGitBin(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeExe(
    join(dir, 'git'),
    `#!/bin/sh
if [ -n "\${FAKE_GIT_LOG:-}" ]; then echo "git $*" >> "$FAKE_GIT_LOG"; fi
if [ "$1" = "rev-parse" ]; then printf '%s' "\${FAKE_GIT_REV_OUTPUT:-}"; exit 0; fi
if [ "$1" = "diff" ]; then printf '%s' "\${FAKE_GIT_DIFF_OUTPUT:-}"; exit 0; fi
echo "unexpected git call: $*" >&2
exit 99
`
  )
}

function run(
  script: string,
  args: string[],
  env: Record<string, string | undefined>,
  options?: { cwd?: string }
): SpawnSyncReturns<string> {
  const full: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) full[key] = value
  }
  return spawnSync(script, args, {
    env: full,
    encoding: 'utf8',
    cwd: options?.cwd ?? REPO_ROOT
  })
}

function scratch(name: string): string {
  const dir = join(TMP_ROOT, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('run-pnpm.sh toolchain bootstrap', () => {
  it('restricted PATH resolves the pinned nvm fallback', () => {
    const dir = scratch('fallback')
    const nvm = fakeNvm(join(dir, 'nvm'), PINNED_NODE, 'FALLBACK-pnpm')
    const result = run(RUN_PNPM, ['hello'], {
      PATH: RESTRICTED_PATH,
      HOME: join(dir, 'home'),
      HOOK_NVM_ROOT: nvm
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('FALLBACK-pnpm')
  })

  it('overrides a conflicting wrong-version node with the pinned fallback', () => {
    const dir = scratch('override')
    const wrongBin = join(dir, 'wrongbin')
    fakeNodeBin(wrongBin, '20.99.0')
    fakePnpmBin(wrongBin, 'WRONG-pnpm')
    const nvm = fakeNvm(join(dir, 'nvm'), PINNED_NODE, 'FALLBACK-pnpm')
    const result = run(RUN_PNPM, ['hello'], {
      PATH: `${wrongBin}:${RESTRICTED_PATH}`,
      HOME: join(dir, 'home'),
      HOOK_NVM_ROOT: nvm
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('FALLBACK-pnpm')
    expect(result.stdout).not.toContain('WRONG-pnpm')
  })

  it('uses an already-correct inherited pair without the fallback', () => {
    const dir = scratch('inherited')
    const goodBin = join(dir, 'goodbin')
    fakeNodeBin(goodBin, PINNED_NODE)
    fakePnpmBin(goodBin, 'GOOD-pnpm')
    const result = run(RUN_PNPM, ['hello'], {
      PATH: `${goodBin}:${RESTRICTED_PATH}`,
      HOME: join(dir, 'home'),
      HOOK_NVM_ROOT: join(dir, 'empty-nvm')
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('GOOD-pnpm')
  })

  it('correct Node with wrong pnpm selects the valid fallback pair', () => {
    const dir = scratch('node-ok-pnpm-wrong')
    const inheritedBin = join(dir, 'inherited')
    fakeNodeBin(inheritedBin, PINNED_NODE)
    fakePnpmBin(inheritedBin, 'WRONG-pnpm', '9.9.9')
    const nvm = fakeNvm(join(dir, 'nvm'), PINNED_NODE, 'FALLBACK-pnpm')
    const result = run(RUN_PNPM, ['hello'], {
      PATH: `${inheritedBin}:${RESTRICTED_PATH}`,
      HOME: join(dir, 'home'),
      HOOK_NVM_ROOT: nvm
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('FALLBACK-pnpm')
    expect(result.stdout).not.toContain('WRONG-pnpm')
  })

  it('no valid pnpm pair fails closed with the required Node+pnpm diagnostic', () => {
    const dir = scratch('pnpm-mismatch')
    const inheritedBin = join(dir, 'inherited')
    fakeNodeBin(inheritedBin, PINNED_NODE)
    fakePnpmBin(inheritedBin, 'WRONG-pnpm', '9.9.9')
    const result = run(RUN_PNPM, ['hello'], {
      PATH: `${inheritedBin}:${RESTRICTED_PATH}`,
      HOME: join(dir, 'home'),
      HOOK_NVM_ROOT: join(dir, 'empty-nvm')
    })
    expect(result.status).toBe(127)
    expect(result.stderr).toMatch(new RegExp(`node v${PINNED_NODE.replace(/\./g, '\\.')}`))
    expect(result.stderr).toContain(PINNED_PNPM)
    expect(result.stdout).not.toContain('ARGS:')
  })

  it('fails closed with 127 and a diagnostic when no toolchain exists', () => {
    const dir = scratch('missing')
    const result = run(RUN_PNPM, ['hello'], {
      PATH: RESTRICTED_PATH,
      HOME: join(dir, 'home'),
      HOOK_NVM_ROOT: join(dir, 'empty-nvm')
    })
    expect(result.status).toBe(127)
    expect(result.stderr).toMatch(new RegExp(`node v${PINNED_NODE.replace(/\./g, '\\.')}`))
    expect(result.stderr).toContain(PINNED_PNPM)
    expect(result.stdout).not.toContain('ARGS:')
  })

  it('forwards arguments verbatim, including filenames with spaces', () => {
    const dir = scratch('forwarding')
    const nvm = fakeNvm(join(dir, 'nvm'), PINNED_NODE, 'FALLBACK-pnpm')
    const result = run(RUN_PNPM, ['biome', 'format', '--write', 'a file with spaces.ts', '--flag=x y'], {
      PATH: RESTRICTED_PATH,
      HOME: join(dir, 'home'),
      HOOK_NVM_ROOT: nvm
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('ARG:a file with spaces.ts')
    expect(result.stdout).toContain('ARG:--flag=x y')
  })

  it('propagates a nonzero pnpm exit verbatim', () => {
    const dir = scratch('exit-code')
    const nvm = fakeNvm(join(dir, 'nvm'), PINNED_NODE, 'FALLBACK-pnpm')
    const result = run(RUN_PNPM, ['hello'], {
      PATH: RESTRICTED_PATH,
      HOME: join(dir, 'home'),
      HOOK_NVM_ROOT: nvm,
      FAKE_PNPM_EXIT: '7'
    })
    expect(result.status).toBe(7)
  })

  it('derives the required pnpm version from packageManager instead of a literal', () => {
    const source = readFileSync(ENSURE, 'utf8')
    expect(source).toMatch(/packageManager/)
    expect(source).not.toContain(`"${PINNED_PNPM}"`)
    expect(source).not.toContain(`'${PINNED_PNPM}'`)
    // Functional side: the suite pin itself is derived from package.json.
    expect(PINNED_PNPM).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('install-if-deps-changed.sh dependency gating', () => {
  it('checkout with equal refs skips without invoking pnpm', () => {
    const dir = scratch('checkout-skip')
    const toolBin = join(dir, 'tools')
    fakeNodeBin(toolBin, PINNED_NODE)
    const sentinel = join(dir, 'pnpm-ran')
    fakePnpmBin(toolBin, 'SENTINEL-pnpm')
    const result = run(INSTALL, ['checkout'], {
      PATH: `${toolBin}:${RESTRICTED_PATH}`,
      HOME: join(dir, 'home'),
      HOOK_NVM_ROOT: join(dir, 'empty-nvm'),
      PRE_COMMIT_FROM_REF: 'abc123',
      PRE_COMMIT_TO_REF: 'abc123',
      FAKE_PNPM_SENTINEL: sentinel
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('No dependency changes, skipping pnpm install.')
    expect(existsSync(sentinel)).toBe(false)
  })

  it('checkout with equal refs skips successfully with no toolchain available', () => {
    const dir = scratch('checkout-skip-no-toolchain')
    const result = run(INSTALL, ['checkout'], {
      PATH: RESTRICTED_PATH,
      HOME: join(dir, 'home'),
      HOOK_NVM_ROOT: join(dir, 'empty-nvm'),
      PRE_COMMIT_FROM_REF: 'abc123',
      PRE_COMMIT_TO_REF: 'abc123'
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('No dependency changes, skipping pnpm install.')
  })

  it('merge without changes skips successfully with no toolchain available', () => {
    const dir = scratch('merge-skip-no-toolchain')
    const gitBin = join(dir, 'gitbin')
    fakeGitBin(gitBin)
    const result = run(INSTALL, ['merge'], {
      PATH: `${gitBin}:${RESTRICTED_PATH}`,
      HOME: join(dir, 'home'),
      HOOK_NVM_ROOT: join(dir, 'empty-nvm'),
      FAKE_GIT_REV_OUTPUT: ''
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('No dependency changes, skipping pnpm install.')
  })

  it('checkout with a dependency change runs install and preserves failure', () => {
    const dir = scratch('checkout-fail')
    const toolBin = join(dir, 'tools')
    fakeNodeBin(toolBin, PINNED_NODE)
    fakePnpmBin(toolBin, 'INSTALL-pnpm')
    fakeGitBin(toolBin)
    const result = run(INSTALL, ['checkout'], {
      PATH: `${toolBin}:${RESTRICTED_PATH}`,
      HOME: join(dir, 'home'),
      HOOK_NVM_ROOT: join(dir, 'empty-nvm'),
      PRE_COMMIT_FROM_REF: 'aaa000',
      PRE_COMMIT_TO_REF: 'bbb111',
      FAKE_GIT_DIFF_OUTPUT: 'package.json\n',
      FAKE_PNPM_EXIT: '3'
    })
    expect(result.status).toBe(3)
    expect(result.stdout).toContain('Dependencies changed, running pnpm install...')
  })

  it('checkout with a dependency change succeeds when install succeeds', () => {
    const dir = scratch('checkout-ok')
    const toolBin = join(dir, 'tools')
    fakeNodeBin(toolBin, PINNED_NODE)
    fakePnpmBin(toolBin, 'INSTALL-pnpm')
    fakeGitBin(toolBin)
    const result = run(INSTALL, ['checkout'], {
      PATH: `${toolBin}:${RESTRICTED_PATH}`,
      HOME: join(dir, 'home'),
      HOOK_NVM_ROOT: join(dir, 'empty-nvm'),
      PRE_COMMIT_FROM_REF: 'aaa000',
      PRE_COMMIT_TO_REF: 'bbb111',
      FAKE_GIT_DIFF_OUTPUT: 'pnpm-lock.yaml\n'
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Dependencies changed, running pnpm install...')
  })

  it('merge without a previous HEAD skips without invoking pnpm', () => {
    const dir = scratch('merge-skip')
    const toolBin = join(dir, 'tools')
    fakeNodeBin(toolBin, PINNED_NODE)
    const sentinel = join(dir, 'pnpm-ran')
    fakePnpmBin(toolBin, 'SENTINEL-pnpm')
    fakeGitBin(toolBin)
    const result = run(INSTALL, ['merge'], {
      PATH: `${toolBin}:${RESTRICTED_PATH}`,
      HOME: join(dir, 'home'),
      HOOK_NVM_ROOT: join(dir, 'empty-nvm'),
      FAKE_GIT_REV_OUTPUT: '',
      FAKE_PNPM_SENTINEL: sentinel
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('No dependency changes, skipping pnpm install.')
    expect(existsSync(sentinel)).toBe(false)
  })

  it('merge with a dependency change runs install', () => {
    const dir = scratch('merge-ok')
    const toolBin = join(dir, 'tools')
    fakeNodeBin(toolBin, PINNED_NODE)
    fakePnpmBin(toolBin, 'INSTALL-pnpm')
    fakeGitBin(toolBin)
    const result = run(INSTALL, ['merge'], {
      PATH: `${toolBin}:${RESTRICTED_PATH}`,
      HOME: join(dir, 'home'),
      HOOK_NVM_ROOT: join(dir, 'empty-nvm'),
      FAKE_GIT_REV_OUTPUT: 'abc1234',
      FAKE_GIT_DIFF_OUTPUT: 'packages/foo/package.json\n'
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Dependencies changed, running pnpm install...')
  })
})
