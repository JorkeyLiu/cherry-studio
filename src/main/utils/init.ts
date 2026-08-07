import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { isLinux, isPortable, isWin } from '@main/constant'
import { HOME_CHERRY_DIR } from '@shared/config/constant'
import { appIdentity } from '@shared/config/identity'
import { findExplicitUserDataDir, isCherryStudioDefaultUserData, resolveUserDataBase } from '@shared/config/userData'
import { app } from 'electron'

// Please don't import any other modules which is not node/electron built-in modules

function hasWritePermission(path: string) {
  try {
    fs.accessSync(path, fs.constants.W_OK)
    return true
  } catch (error) {
    return false
  }
}

function getConfigDir() {
  return path.join(os.homedir(), HOME_CHERRY_DIR, 'config')
}

/**
 * Initialize the runtime userData/profile directory. Runs from `./bootstrap`
 * BEFORE `@main/config` applies the dev suffix, so both dev and packaged
 * profiles are derived from the correct identity base.
 *
 * Precedence:
 *   0. explicit `--user-data-dir=<path>` CLI override — Electron applies it
 *      to `app.getPath('userData')` before JS runs; this function preserves
 *      the exact value instead of overwriting it,
 *   1. identity-specific configured `appDataPath` from
 *      `<homedir>/<homeDirName>/config/config.json` (packaged only),
 *   2. portable `data` directory (packaged only),
 *   3. identity default: Cherry Chat resolves to its own `Cherry Chat` profile
 *      (LOCK-RETIRE-001).
 *
 * LOCK-PROFILE-006: a userData that would resolve to the known Cherry Studio
 * default profile is refused at startup — the guard runs on the FINAL userData
 * value, so a CLI override pointing at `<appData>/Cherry Studio` also fails
 * closed.
 */
export function initAppDataDir() {
  const explicitUserDataDir = findExplicitUserDataDir(process.argv)
  const resolution = resolveUserDataBase({
    identity: appIdentity,
    appDataRoot: app.getPath('appData'),
    // The identity-specific config read (and its legacy-migration write) only
    // runs when packaged, preserving the historical bootstrap gate.
    configuredAppDataPath: app.isPackaged ? getAppDataPathFromConfig() : null,
    portableDataDir: isPortable ? path.join(process.env.PORTABLE_EXECUTABLE_DIR || app.getPath('exe'), 'data') : null,
    explicitUserDataDir,
    isPackaged: app.isPackaged,
    isPortable
  })

  if (resolution.source === 'cli-override') {
    // Electron applied `--user-data-dir` before JS; preserve the exact value
    // (defensive re-apply only when something mutated it before bootstrap).
    if (app.getPath('userData') !== resolution.path) {
      app.setPath('userData', resolution.path)
    }
  } else {
    app.setPath('userData', resolution.path)
  }

  if (isCherryStudioDefaultUserData(app.getPath('appData'), app.getPath('userData'))) {
    throw new Error(
      `[initAppDataDir] Refusing to start Cherry Chat with the Cherry Studio default userData ` +
        `"${app.getPath('userData')}" (LOCK-PROFILE-006). The Cherry Chat profile must be independent; configure a ` +
        `different appDataPath in the Cherry Chat config, use portable mode, or pass an explicit ` +
        `--user-data-dir=... override.`
    )
  }
}

function getAppDataPathFromConfig() {
  try {
    const configPath = path.join(getConfigDir(), 'config.json')
    if (!fs.existsSync(configPath)) {
      return null
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))

    if (!config.appDataPath) {
      return null
    }

    let executablePath = app.getPath('exe')
    if (isLinux && process.env.APPIMAGE) {
      // 如果是 AppImage 打包的应用，直接使用 APPIMAGE 环境变量
      // 这样可以确保获取到正确的可执行文件路径
      executablePath = path.join(path.dirname(process.env.APPIMAGE), 'cherry-chat.appimage')
    }

    if (isWin && isPortable) {
      executablePath = path.join(process.env.PORTABLE_EXECUTABLE_DIR || '', 'cherry-chat-portable.exe')
    }

    let appDataPath = null
    // 兼容旧版本
    if (config.appDataPath && typeof config.appDataPath === 'string') {
      appDataPath = config.appDataPath
      // 将旧版本数据迁移到新版本
      appDataPath && updateAppDataConfig(appDataPath)
    } else {
      appDataPath = config.appDataPath.find(
        (item: { executablePath: string }) => item.executablePath === executablePath
      )?.dataPath
    }

    if (appDataPath && fs.existsSync(appDataPath) && hasWritePermission(appDataPath)) {
      return appDataPath
    }

    return null
  } catch (error) {
    return null
  }
}

export function updateAppDataConfig(appDataPath: string) {
  const configDir = getConfigDir()
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true })
  }

  // config.json
  // appDataPath: [{ executablePath: string, dataPath: string }]
  const configPath = path.join(configDir, 'config.json')
  let executablePath = app.getPath('exe')
  if (isLinux && process.env.APPIMAGE) {
    executablePath = path.join(path.dirname(process.env.APPIMAGE), 'cherry-chat.appimage')
  }

  // 如果是 Windows 可移植版本，则使用 PORTABLE_EXECUTABLE_FILE 环境变量
  if (isWin && isPortable) {
    executablePath = path.join(process.env.PORTABLE_EXECUTABLE_DIR || '', 'cherry-chat-portable.exe')
  }

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({ appDataPath: [{ executablePath, dataPath: appDataPath }] }, null, 2))
    return
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  if (!config.appDataPath || (config.appDataPath && typeof config.appDataPath !== 'object')) {
    config.appDataPath = []
  }

  const existingPath = config.appDataPath.find(
    (item: { executablePath: string }) => item.executablePath === executablePath
  )

  if (existingPath) {
    existingPath.dataPath = appDataPath
  } else {
    config.appDataPath.push({ executablePath, dataPath: appDataPath })
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
}
