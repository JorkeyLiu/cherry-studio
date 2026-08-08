import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { appIdentity } from '@shared/config/identity'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Force the Linux autostart path (main.setup.ts mocks electron / fs / os / path).
vi.mock('@main/constant', () => ({
  isWin: false,
  isMac: false,
  isLinux: true,
  isDev: false
}))

describe('AppService Linux autostart desktop entry (USER-SCOPE-013)', () => {
  let setAppLaunchOnBoot: (isLaunchOnBoot: boolean) => Promise<void>

  beforeEach(async () => {
    vi.clearAllMocks()
    const { default: appService } = await import('../AppService')
    setAppLaunchOnBoot = appService.setAppLaunchOnBoot.bind(appService)
  })

  it('writes a Cherry Chat-consistent desktop entry with the packaged icon identifier', async () => {
    await setAppLaunchOnBoot(true)

    const autostartDir = path.join(os.homedir(), '.config', 'autostart')
    const desktopFile = path.join(autostartDir, `${appIdentity.tempDirName}.desktop`)

    expect(vi.mocked(fs.promises.writeFile)).toHaveBeenCalledTimes(1)
    const [writtenFile, content] = vi.mocked(fs.promises.writeFile).mock.calls[0] as [string, string]

    // Filename and Name come from the Cherry Chat identity, not the retired one.
    expect(writtenFile).toBe(desktopFile)
    expect(desktopFile).toContain('cherry-chat.desktop')
    expect(content).toContain('[Desktop Entry]')
    expect(content).toContain(`Name=${appIdentity.productName}`)
    expect(content).toContain('Name=Cherry Chat')

    // Icon references the identifier the current Linux packaging installs
    // (linux.executableName === appIdentity.linuxClassAndName === CherryChat).
    expect(content).toContain(`Icon=${appIdentity.linuxClassAndName}`)
    expect(content).toContain('Icon=CherryChat')

    // No retired Cherry Studio icon identity anywhere in the entry.
    expect(content).not.toContain('cherrystudio')
  })

  it('removes the same autostart desktop file when launch-on-boot is disabled', async () => {
    await setAppLaunchOnBoot(false)

    const desktopFile = path.join(os.homedir(), '.config', 'autostart', `${appIdentity.tempDirName}.desktop`)
    expect(vi.mocked(fs.promises.unlink)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fs.promises.unlink)).toHaveBeenCalledWith(desktopFile)
    expect(vi.mocked(fs.promises.writeFile)).not.toHaveBeenCalled()
  })
})
