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
 * notes), LOCK-PLATFORM-005 (default macOS arm64 command, no flavor selection).
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
const ARTIFACT_NAME_TEMPLATE = '${productName}-${version}-${arch}.${ext}'

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

  it('has no publish feed configured (LOCK-UPDATER-004)', () => {
    expect(config.publish).toBeUndefined()
    expect(JSON.stringify(config)).not.toContain(CHERRY_STUDIO_FEED_URL)
  })

  it('has no release notes (LOCK-UPDATER-004)', () => {
    expect(config.releaseInfo?.releaseNotes).toBeUndefined()
    expect(JSON.stringify(config)).not.toContain('Cherry Studio 1.9.11')
  })

  it('keeps the packaging hooks and artifact-name template', () => {
    expect(config.beforePack).toBe('scripts/before-pack.js')
    expect(config.afterSign).toBe('scripts/notarize.js')
    expect(config.artifactBuildCompleted).toBe('scripts/artifact-build-completed.js')
    expect(config.mac?.artifactName).toBe(ARTIFACT_NAME_TEMPLATE)
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
    // flavor — it now produces Cherry Chat via the base config.
    expect(pkg.scripts['build:mac:arm64']).toBe('dotenv npm run build && electron-builder --mac --arm64')
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
