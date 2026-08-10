import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

/**
 * Focused builder-identity tests for the single Cherry Chat identity
 * (LOCK-RETIRE-001/002, LOCK-UPDATER-004).
 *
 * These tests load the BASE electron-builder config through the INSTALLED
 * electron-builder 26.8.1 config loader (`app-builder-lib` `getConfig`), so
 * they verify the actual effective config the ordinary packaging commands
 * consume — not a text-only snapshot. Locks covered: LOCK-RETIRE-001 (Cherry
 * Chat identity only), LOCK-UPDATER-004 (no Cherry Studio feed / release
 * notes; explicit `publish: null` suppresses git-remote repository inference),
 * LOCK-PLATFORM-005 (default macOS arm64 command, no flavor selection).
 *
 * Migration-portability (REPO-MIGRATION-001): these package-contract
 * assertions describe the CURRENT package.json — they never read Git history,
 * so they keep passing after the current state becomes a new Cherry Chat
 * repository.
 */

const REPO_ROOT = process.cwd()

// `app-builder-lib` is not hoisted to the repo root under pnpm; resolve it
// through the installed `electron-builder` peer.
const requireRoot = createRequire(import.meta.url)
const requireFromElectronBuilder = createRequire(requireRoot.resolve('electron-builder'))
const { getConfig, validateConfiguration } = requireFromElectronBuilder('app-builder-lib/out/util/config/config')

const LOCKED_APP_ID = 'com.jorkeyliu.CherryChat'
const LOCKED_PRODUCT_NAME = 'Cherry Chat'
const CHERRY_STUDIO_FEED_URL = 'https://releases.cherry-ai.com'
// VERSION-003: the per-build Build ID is injected via env macro by the
// build-identity wrapper; the product version stays `${version}` (0.1.0).
const ARTIFACT_NAME_TEMPLATE = '${productName}-${version}-${env.CHERRY_CHAT_BUILD_ID}-${arch}.${ext}'
const BUILD_ID_ENV_NAME = 'CHERRY_CHAT_BUILD_ID'

const IDENTITY_WRAPPER = 'dotenv -- tsx scripts/build-identity.ts --spawn'
const WRAPPED_PACKAGING_SCRIPTS = new Set([
  'build:unpack',
  'build:win',
  'build:win:x64',
  'build:win:arm64',
  'build:mac',
  'build:mac:arm64',
  'build:mac:x64',
  'build:linux',
  'build:linux:arm64',
  'build:linux:x64'
])

interface LockedProtocol {
  name: string
  schemes: string[]
}

interface EffectiveBuilderConfig {
  appId: string
  productName: string
  protocols?: LockedProtocol | LockedProtocol[]
  publish?: unknown
  releaseInfo?: { releaseNotes?: string | null } | null
  buildVersion?: string
  mac?: { artifactName?: string }
  beforePack?: string
  afterSign?: string
  artifactBuildCompleted?: string
}

function loadEffectiveConfig(configPath: string): Promise<EffectiveBuilderConfig> {
  return getConfig(REPO_ROOT, configPath) as Promise<EffectiveBuilderConfig>
}

function asProtocolArray(protocols: EffectiveBuilderConfig['protocols']): LockedProtocol[] {
  if (protocols == null) {
    return []
  }
  return Array.isArray(protocols) ? protocols : [protocols]
}

/** Minimal debug logger accepted by the installed schema validator. */
const silentDebugLogger = {
  isEnabled: false,
  add: () => {}
}

describe('electron-builder base config — single Cherry Chat identity (LOCK-RETIRE-001)', () => {
  let config: EffectiveBuilderConfig

  beforeAll(async () => {
    config = await loadEffectiveConfig('electron-builder.yml')
  })

  it('carries the locked Cherry Chat appId and productName', () => {
    expect(config.appId).toBe(LOCKED_APP_ID)
    expect(config.productName).toBe(LOCKED_PRODUCT_NAME)
  })

  it('carries exactly the cherrychat protocol — no cherrystudio scheme', () => {
    expect(asProtocolArray(config.protocols)).toEqual([{ name: 'Cherry Chat', schemes: ['cherrychat'] }])
    const allSchemes = asProtocolArray(config.protocols).flatMap((p) => p.schemes)
    expect(allSchemes).toContain('cherrychat')
    expect(allSchemes).not.toContain('cherrystudio')
  })

  it('suppresses publish with an explicit null — no git-remote inference (LOCK-UPDATER-004)', () => {
    // Under installed electron-builder 26.8.1 an undefined/absent `publish`
    // (or `[]`) makes the builder fall back to repository-info inference and
    // emit app-update.yml / latest-mac.yml metadata. Explicit null suppresses
    // that. The value must be exactly null — never a configured endpoint.
    expect(config.publish).toBeNull()
    expect(JSON.stringify(config)).not.toContain(CHERRY_STUDIO_FEED_URL)
  })

  it('writes the suppression explicitly as `publish: null` in the config text', () => {
    // Text-level lock: the base config must spell out `null` so the
    // suppression is a deliberate, reviewable statement — not an absent key.
    const text = readFileSync(join(REPO_ROOT, 'electron-builder.yml'), 'utf8')
    expect(text).toMatch(/^publish: null\s*$/m)
  })

  it('has no release notes and no Cherry Studio identity anywhere (LOCK-UPDATER-004)', () => {
    // The actual no-releaseInfo guard: releaseInfo is absent, so no release
    // notes metadata can be emitted into generated artifacts.
    expect(config.releaseInfo?.releaseNotes).toBeUndefined()
    // Broad no-Cherry-Studio guard: the whole serialized effective config must
    // not reference the retired identity anywhere — not productName, appId,
    // protocol names, artifact templates, or any other field.
    expect(JSON.stringify(config)).not.toContain('Cherry Studio')
  })

  it('keeps the packaging hooks and the Build ID artifact-name template (VERSION-003)', () => {
    expect(config.beforePack).toBe('scripts/before-pack.js')
    expect(config.afterSign).toBe('scripts/notarize.js')
    expect(config.artifactBuildCompleted).toBe('scripts/artifact-build-completed.js')
    expect(config.mac?.artifactName).toBe(ARTIFACT_NAME_TEMPLATE)
    expect(config.mac?.artifactName).toContain(`\${env.${BUILD_ID_ENV_NAME}}`)
    // Product version macro is preserved: app.getVersion() stays 0.1.0.
    expect(config.mac?.artifactName).toContain('${version}')
  })

  it('derives the numeric macOS build version via the beforePack hook, not a static macro (VERSION-003)', () => {
    // electron-builder does not macro-expand `buildVersion` (AppInfo reads the
    // config value raw), so the config must NOT carry a `${env.…}` template.
    // The build-identity wrapper sets CHERRY_CHAT_BUILD_VERSION and
    // scripts/apply-build-version.js (invoked by beforePack) applies it to
    // AppInfo so it lands in CFBundleVersion.
    expect(config.buildVersion).toBeUndefined()
    expect(config.beforePack).toBe('scripts/before-pack.js')
  })

  it('passes the installed electron-builder schema validation', () => {
    expect(() => validateConfiguration(config, silentDebugLogger)).not.toThrow()
  })
})

describe('package scripts — ordinary default macOS arm64 packaging (LOCK-RETIRE-002 / LOCK-PLATFORM-005)', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    name?: string
    desktopName?: string
    scripts: Record<string, string>
  }

  it('keeps the default macOS arm64 build command producing the single identity', () => {
    // The ordinary/default macOS arm64 packaging command exists and selects no
    // flavor — it now produces Cherry Chat via the base config. It runs under
    // the Electron ABI lane and is wrapped by the build-identity wrapper so one
    // build invocation reuses one Build ID across the electron-vite compile and
    // the electron-builder packaging (the compile+package chain lives in the
    // internal `:run` helper the wrapper spawns).
    expect(pkg.scripts['build:mac:arm64']).toBe(
      'pnpm native:run electron -- dotenv -- tsx scripts/build-identity.ts --spawn "pnpm build:mac:arm64:run"'
    )
    expect(pkg.scripts['build:mac:arm64:run']).toBe('npm run build && electron-builder --mac --arm64')
  })

  it('keeps the fast unpacked .app / packaged-E2E build command (COMMAND-002)', () => {
    // `pnpm build:unpack` is the fast unpacked `.app` helper used as the
    // packaged-E2E prerequisite (tests/e2e/README.md). It carries the same one
    // build-identity wrapper as the full macOS build, but targets `--dir`
    // instead of a distributable DMG/ZIP.
    expect(pkg.scripts['build:unpack']).toBe(
      'pnpm native:run electron -- dotenv -- tsx scripts/build-identity.ts --spawn "pnpm build:unpack:run"'
    )
    expect(pkg.scripts['build:unpack:run']).toBe('npm run build && electron-builder --dir')
  })

  it('has no dedicated flavor-selection build command (LOCK-RETIRE-002)', () => {
    const flavorScripts = Object.keys(pkg.scripts).filter((s) => s.startsWith('build:chat'))
    expect(flavorScripts).toEqual([])
  })
})

describe('package metadata — active package and desktop identity are Cherry Chat (LOCK-RETIRE-001)', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    name?: string
    desktopName?: string
  }

  it('carries the Cherry Chat active package name (no CherryStudio package identity)', () => {
    expect(pkg.name).toBe('CherryChat')
    expect(pkg.name).not.toContain('Studio')
  })

  it('carries the Cherry Chat desktop entry name', () => {
    expect(pkg.desktopName).toBe('CherryChat.desktop')
    expect(pkg.desktopName).not.toContain('Studio')
  })
})

describe('package contract — migration-portable stable assertions (REPO-MIGRATION-001)', () => {
  // These assertions describe the CURRENT package.json only. They intentionally
  // avoid Git history (REPO-MIGRATION-001): after the current state becomes a
  // new Cherry Chat repository, they must still pass unchanged.
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    version: string
    scripts: Record<string, string>
    devDependencies: Record<string, string>
  }

  const REQUIRED_SCRIPTS = [
    'dev',
    'build',
    'build:check',
    'build:mac:arm64',
    'build:unpack',
    'test',
    'test:scripts',
    'typecheck',
    'lint',
    'format'
  ]

  const REQUIRED_BUILD_DEPS = ['tsx', 'dotenv-cli', 'electron-builder', 'electron-vite', 'vitest']

  it('keeps the product version at the approved 0.1.0 (VERSION-002)', () => {
    expect(pkg.version).toBe('0.1.0')
  })

  it('keeps every required build/test/dev script present', () => {
    for (const script of REQUIRED_SCRIPTS) {
      expect(pkg.scripts[script], `${script} must exist`).toBeDefined()
      expect(pkg.scripts[script].trim(), `${script} must be non-empty`).not.toBe('')
    }
  })

  it('wraps every packaging command exactly once and never nests wrappers', () => {
    for (const name of WRAPPED_PACKAGING_SCRIPTS) {
      const value = pkg.scripts[name]
      expect(value, name).toContain('scripts/build-identity.ts --spawn')
      expect(value.match(/scripts\/build-identity\.ts/g)?.length, `${name} has exactly one wrapper`).toBe(1)
      expect(value, name).not.toContain('build-identity.ts --spawn "dotenv')
      // One wrapper per packaging script: the identity wrapper is the leading
      // command exactly once, followed by the inner compile+package invocation.
      expect(value, name).toContain(IDENTITY_WRAPPER)
      expect(value.match(new RegExp(IDENTITY_WRAPPER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length).toBe(1)
      // The electron-builder invocation lives in the internal `:run` helper the
      // wrapper spawns, so the lane runner always executes one explicit command
      // (never a raw shell chain string).
      const runHelper = pkg.scripts[`${name}:run`]
      expect(runHelper, `${name}:run must exist`).toBeDefined()
      expect(runHelper, `${name}:run must invoke electron-builder`).toContain('electron-builder ')
      expect(value, name).toContain(`pnpm ${name}:run`)
    }
  })

  it('keeps the fast unpacked command and the full macOS command distinct (COMMAND-001/002)', () => {
    expect(pkg.scripts['build:unpack']).not.toBe(pkg.scripts['build:mac:arm64'])
    expect(pkg.scripts['build:unpack:run']).toContain('electron-builder --dir')
    expect(pkg.scripts['build:mac:arm64:run']).toContain('electron-builder --mac --arm64')
  })

  it('keeps the retired flavor build command absent (LOCK-RETIRE-001/002)', () => {
    expect(pkg.scripts['build:chat:mac:arm64']).toBeUndefined()
    expect(Object.keys(pkg.scripts).filter((s) => s.startsWith('build:chat'))).toEqual([])
  })

  it('keeps the required build devDependencies present', () => {
    for (const dep of REQUIRED_BUILD_DEPS) {
      expect(pkg.devDependencies[dep], `${dep} must be present`).toBeDefined()
    }
    // TypeScript compiler tooling: `typescript` (tsserver/tsc) plus the
    // `@typescript/native-preview` package that provides the `tsgo` binary
    // used by `typecheck:node` / `typecheck:web`.
    expect(pkg.devDependencies['typescript']).toBeDefined()
    expect(pkg.devDependencies['@typescript/native-preview']).toBeDefined()
  })
})
