/**
 * Focused unit coverage for the default-hidden E2E launch policy.
 *
 * Only pure functions are exercised here; no Electron process is launched.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  HIDDEN_LAUNCH_SHOW_ENV,
  isHiddenLaunchRequested,
  LAUNCH_TO_TRAY_CONFIG_KEY,
  OWNED_PROFILE_PREFIX,
  seedHiddenLaunchProfile
} from './hidden-launch'

const created: string[] = []

function makeProfile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), OWNED_PROFILE_PREFIX))
  created.push(dir)
  return dir
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop()!
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('isHiddenLaunchRequested', () => {
  it('defaults to hidden when the opt-out is absent', () => {
    expect(isHiddenLaunchRequested({})).toBe(true)
  })

  it('opts out only for the exact documented value', () => {
    expect(isHiddenLaunchRequested({ [HIDDEN_LAUNCH_SHOW_ENV]: '1' })).toBe(false)
    expect(isHiddenLaunchRequested({ [HIDDEN_LAUNCH_SHOW_ENV]: '0' })).toBe(true)
    expect(isHiddenLaunchRequested({ [HIDDEN_LAUNCH_SHOW_ENV]: 'true' })).toBe(true)
  })
})

describe('seedHiddenLaunchProfile', () => {
  it('writes the product launch-to-tray key into an owned disposable profile', () => {
    const dir = makeProfile()
    const result = seedHiddenLaunchProfile(dir, {})

    expect(result.written).toBe(true)
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
    expect(written).toEqual({ [LAUNCH_TO_TRAY_CONFIG_KEY]: true })
  })

  it('merges with preseeded config keys instead of overwriting them', () => {
    const dir = makeProfile()
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ theme: 'dark', zoomFactor: 1.25 }), 'utf8')

    seedHiddenLaunchProfile(dir, {})

    const written = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
    expect(written).toEqual({ theme: 'dark', zoomFactor: 1.25, [LAUNCH_TO_TRAY_CONFIG_KEY]: true })
  })

  it('does not write anything when the run opts back into a visible window', () => {
    const dir = makeProfile()
    const result = seedHiddenLaunchProfile(dir, { [HIDDEN_LAUNCH_SHOW_ENV]: '1' })

    expect(result.written).toBe(false)
    expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(false)
  })

  it('refuses a profile that is not an owned disposable profile', () => {
    const dir = path.join(makeProfile(), 'live-profile')
    fs.mkdirSync(dir, { recursive: true })

    expect(() => seedHiddenLaunchProfile(dir, {})).toThrow(/not an owned disposable profile/)
    expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(false)
  })

  it('refuses an unreadable preseeded config instead of clobbering it', () => {
    const dir = makeProfile()
    fs.writeFileSync(path.join(dir, 'config.json'), '{ not json', 'utf8')

    expect(() => seedHiddenLaunchProfile(dir, {})).toThrow(/unreadable/)
    expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe('{ not json')
  })
})
