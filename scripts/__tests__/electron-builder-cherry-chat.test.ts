import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { BUILD_STEPS, buildStepEnv } from '../build-chat-mac-arm64'

/**
 * Focused builder-identity tests for Phase B (P-B) packaging.
 *
 * These tests load the BASE electron-builder config and the Cherry Chat overlay
 * (`electron-builder.cherry-chat.yml`) through the INSTALLED electron-builder
 * 26.8.1 config loader (`app-builder-lib` `getConfig`), so they verify the
 * actual effective merge semantics (extends + deepAssign) rather than assuming
 * them. Locks covered: IDENTITY-001 (default unchanged), IDENTITY-002 (Cherry
 * Chat identity), IDENTITY-004 (no Cherry Studio feed), IDENTITY-005 (macOS
 * arm64 only command).
 */

const REPO_ROOT = process.cwd()

// `app-builder-lib` is not hoisted to the repo root under pnpm; resolve it
// through the installed `electron-builder` peer.
const requireRoot = createRequire(import.meta.url)
const requireFromElectronBuilder = createRequire(requireRoot.resolve('electron-builder'))
const { getConfig, validateConfiguration } = requireFromElectronBuilder('app-builder-lib/out/util/config/config')

const DEFAULT_APP_ID = 'com.kangfenmao.CherryStudio'
const CHERRY_CHAT_APP_ID = 'com.jorkeyliu.CherryChat'
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

describe('electron-builder base config — default Cherry Studio identity unchanged (IDENTITY-001/003)', () => {
  let config: EffectiveBuilderConfig

  beforeAll(async () => {
    config = await loadEffectiveConfig('electron-builder.yml')
  })

  it('keeps the locked default appId and productName', () => {
    expect(config.appId).toBe(DEFAULT_APP_ID)
    expect(config.productName).toBe('Cherry Studio')
  })

  it('keeps the locked default protocol (exactly one cherrystudio scheme)', () => {
    expect(asProtocolArray(config.protocols)).toEqual([{ name: 'Cherry Studio', schemes: ['cherrystudio'] }])
  })

  it('keeps the Cherry Studio publish feed for the default build', () => {
    expect(JSON.stringify(config.publish)).toContain(CHERRY_STUDIO_FEED_URL)
  })

  it('keeps the inherited Cherry Studio release notes for the default build', () => {
    expect(config.releaseInfo?.releaseNotes).toContain('Cherry Studio 1.9.11')
  })

  it('keeps the inherited packaging hooks and artifact-name template', () => {
    expect(config.beforePack).toBe('scripts/before-pack.js')
    expect(config.afterSign).toBe('scripts/notarize.js')
    expect(config.artifactBuildCompleted).toBe('scripts/artifact-build-completed.js')
    expect(config.mac?.artifactName).toBe(ARTIFACT_NAME_TEMPLATE)
  })

  it('passes the installed electron-builder schema validation', () => {
    expect(() => validateConfiguration(config, silentDebugLogger)).not.toThrow()
  })
})

describe('electron-builder Cherry Chat overlay — locked identity (IDENTITY-002/004)', () => {
  let config: EffectiveBuilderConfig

  beforeAll(async () => {
    config = await loadEffectiveConfig('electron-builder.cherry-chat.yml')
  })

  it('resolves the locked Cherry Chat appId and productName', () => {
    expect(config.appId).toBe(CHERRY_CHAT_APP_ID)
    expect(config.productName).toBe('Cherry Chat')
  })

  it('resolves exactly the cherrychat protocol — no inherited cherrystudio scheme', () => {
    expect(asProtocolArray(config.protocols)).toEqual([{ name: 'Cherry Chat', schemes: ['cherrychat'] }])
    const allSchemes = asProtocolArray(config.protocols).flatMap((p) => p.schemes)
    expect(allSchemes).toContain('cherrychat')
    expect(allSchemes).not.toContain('cherrystudio')
  })

  it('removes the Cherry Studio publish feed (publish resolves to null)', () => {
    expect(config.publish).toBeNull()
    expect(JSON.stringify(config)).not.toContain(CHERRY_STUDIO_FEED_URL)
  })

  it('drops the inherited Cherry Studio release notes (releaseInfo releaseNotes resolves to null)', () => {
    // The effective Chat config must carry no Cherry Studio release notes.
    // `releaseInfo: null` is not schema-valid (ReleaseInfo is type object), so
    // the overlay nulls the inherited releaseNotes key — verified against the
    // installed electron-builder loader below.
    expect(config.releaseInfo).toEqual({ releaseNotes: null })
    expect(JSON.stringify(config)).not.toContain('Cherry Studio 1.9.11')
  })

  it('derives an independent artifact name from the overridden productName', async () => {
    const base = await loadEffectiveConfig('electron-builder.yml')
    // Artifact naming source stays the base template; productName substitution
    // yields the independent Cherry Chat artifact name.
    expect(config.mac?.artifactName).toBe(base.mac?.artifactName)
    const expand = (tpl: string, productName: string) =>
      tpl
        .replace('${productName}', productName)
        .replace('${version}', '1.9.11')
        .replace('${arch}', 'arm64')
        .replace('${ext}', 'dmg')
    const chatArtifact = expand(config.mac?.artifactName ?? '', config.productName)
    const studioArtifact = expand(base.mac?.artifactName ?? '', base.productName)
    expect(chatArtifact).toBe('Cherry Chat-1.9.11-arm64.dmg')
    expect(chatArtifact).not.toBe(studioArtifact)
  })

  it('keeps the inherited packaging hooks and mac targets', () => {
    expect(config.beforePack).toBe('scripts/before-pack.js')
    expect(config.afterSign).toBe('scripts/notarize.js')
    expect(config.artifactBuildCompleted).toBe('scripts/artifact-build-completed.js')
    expect(config.mac?.artifactName).toBe(ARTIFACT_NAME_TEMPLATE)
  })

  it('passes the installed electron-builder schema validation (overlay + extends merge)', () => {
    expect(() => validateConfiguration(config, silentDebugLogger)).not.toThrow()
  })
})

describe('package scripts — default unchanged, Cherry Chat macOS arm64 only (IDENTITY-001/005)', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }

  it('keeps the default macOS arm64 build script byte-for-byte unchanged', () => {
    expect(pkg.scripts['build:mac:arm64']).toBe('dotenv npm run build && electron-builder --mac --arm64')
  })

  it('adds exactly one explicit Cherry Chat macOS arm64 script delegating to the restoring wrapper', () => {
    const chatScripts = Object.keys(pkg.scripts).filter((s) => s.startsWith('build:chat'))
    expect(chatScripts).toEqual(['build:chat:mac:arm64']) // IDENTITY-005: no Windows/Linux Cherry Chat commands

    // Finding F1: the command delegates to the Node wrapper, which snapshots
    // and restores the tracked OpenAPI spec around the build+packaging chain
    // instead of shell `VAR=x cmd1 && cmd2`.
    expect(pkg.scripts['build:chat:mac:arm64']).toBe('tsx scripts/build-chat-mac-arm64.ts')

    // Both chain halves must still receive the locked flavor (IDENTITY-002);
    // the wrapper injects it into every step's environment.
    expect(BUILD_STEPS.map((step) => step.command)).toEqual(['dotenv', 'electron-builder'])
    for (const step of BUILD_STEPS) {
      expect(buildStepEnv({}).VITE_APP_FLAVOR).toBe('cherry-chat')
      expect(step.args).toBeDefined()
    }
    // The packaging phase targets the Cherry Chat overlay and macOS arm64 only.
    expect(BUILD_STEPS[1].args).toEqual(['--config', 'electron-builder.cherry-chat.yml', '--mac', '--arm64'])
  })
})
