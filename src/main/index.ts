// don't reorder this file, it's used to initialize the app data dir and
// other which should be run before the main process is ready
// eslint-disable-next-line
import './bootstrap'

import '@main/config'

import { loggerService } from '@logger'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { replaceDevtoolsFont } from '@main/utils/windowUtil'
import { app, crashReporter } from 'electron'
import installExtension, { REACT_DEVELOPER_TOOLS, REDUX_DEVTOOLS } from 'electron-devtools-installer'
import { isDev, isLinux, isWin } from './constant'

import process from 'node:process'
import { appIdentity } from '@shared/config/identity'

import { registerIpc } from './ipc'
import { analyticsService } from './services/AnalyticsService'
import { apiServerService } from './services/ApiServerService'
import { saveDataHandshake } from './services/SaveDataHandshake'
import { appMenuService } from './services/AppMenuService'
import { configManager } from './services/ConfigManager'
import { nodeTraceService } from './services/NodeTraceService'
import powerMonitorService from './services/PowerMonitorService'
import {
  APP_PROTOCOL,
  handleProtocolUrl,
  registerProtocolClient,
  setupAppImageDeepLink
} from './services/ProtocolClient'
import { registerShortcuts } from './services/ShortcutService'
import { TrayService } from './services/TrayService'
import { versionService } from './services/VersionService'
import { windowService } from './services/WindowService'
import { initWebviewHotkeys } from './services/WebviewService'
import { chatDbService } from './services/chatDb'
import { syncService } from './services/sync/SyncService'
import { syncAutoService } from './services/sync/syncAuto'
import { runAsyncFunction } from './utils'
import { installStdioBrokenPipeGuard } from './utils/stdioErrorGuard'
import { extractRtkBinaries } from './utils/rtk'

// Dev-only broken-pipe guard: a retired Electron runner closes the stdio pipe
// under a still-running dev main. Only EPIPE is absorbed; any other stream
// error keeps propagating (production installs no guard at all).
if (isDev) {
  installStdioBrokenPipeGuard([process.stdout, process.stderr])
}

const logger = loggerService.withContext('MainEntry')

// enable local crash reports
crashReporter.start({
  companyName: 'CherryHQ',
  productName: appIdentity.crashReporterProductName,
  submitURL: '',
  uploadToServer: false
})

/**
 * Disable hardware acceleration if setting is enabled
 */
const disableHardwareAcceleration = configManager.getDisableHardwareAcceleration()
if (disableHardwareAcceleration) {
  app.disableHardwareAcceleration()
}

/**
 * Disable chromium's window animations
 * Know Issue: https://github.com/electron/electron/issues/12130#issuecomment-627198990
 */
if (isWin) {
  app.commandLine.appendSwitch('wm-window-animations-disabled')
}

/**
 * Enable GlobalShortcutsPortal for Linux Wayland Protocol
 * see: https://www.electronjs.org/docs/latest/api/global-shortcut
 */
if (isLinux && process.env.XDG_SESSION_TYPE === 'wayland') {
  app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal')
}

/**
 * Set window class and name for Linux
 * This ensures the window manager identifies the app correctly on both X11 and Wayland
 */
if (isLinux) {
  app.commandLine.appendSwitch('class', appIdentity.linuxClassAndName)
  app.commandLine.appendSwitch('name', appIdentity.linuxClassAndName)
}

// DocumentPolicyIncludeJSCallStacksInCrashReports: Enable features for unresponsive renderer js call stacks
// EarlyEstablishGpuChannel,EstablishGpuChannelAsync: Enable features for early establish gpu channel
// speed up the startup time
// https://github.com/microsoft/vscode/pull/241640/files
app.commandLine.appendSwitch(
  'enable-features',
  'DocumentPolicyIncludeJSCallStacksInCrashReports,EarlyEstablishGpuChannel,EstablishGpuChannelAsync'
)
app.on('web-contents-created', (_, webContents) => {
  webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Document-Policy': ['include-js-call-stacks-in-crash-reports']
      }
    })
  })

  webContents.on('unresponsive', async () => {
    // Interrupt execution and collect call stack from unresponsive renderer
    logger.error('Renderer unresponsive start')
    const callStack = await webContents.mainFrame.collectJavaScriptCallStack()
    logger.error(`Renderer unresponsive js call stack\n ${callStack}`)
  })
})

// in production mode, handle uncaught exception and unhandled rejection globally
if (!isDev) {
  // handle uncaught exception
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error)
  })

  // handle unhandled rejection
  process.on('unhandledRejection', (reason, promise) => {
    logger.error(`Unhandled Rejection at: ${promise} reason: ${reason}`)
  })
}

// Check for single instance lock
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
} else {
  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  // Some APIs can only be used after this event occurs.

  void app.whenReady().then(async () => {
    // Record current version for tracking
    // A preparation for v2 data refactoring
    versionService.recordCurrentVersion()

    initWebviewHotkeys()
    // Set app user model id for windows
    electronApp.setAppUserModelId(import.meta.env.VITE_MAIN_BUNDLE_ID || appIdentity.appId)

    // Mac: Hide dock icon before window creation when launch to tray is set
    const isLaunchToTray = configManager.getLaunchToTray()
    if (isLaunchToTray) {
      app.dock?.hide()
    }

    // Check for backup restore marker and complete restoration (highest priority, before window creation)
    const { BackupManager } = await import('./services/BackupManager')

    let restoreSucceeded = true
    try {
      await BackupManager.handleStartupRestore()
    } catch (error) {
      restoreSucceeded = false
      logger.error(
        'Startup restore failed — staged restore directories retained for retry on next startup. ' +
          'Chat DB will not be initialised this session to prevent unchecked use.',
        error as Error
      )
    }

    // LOCK-6013: Clean up orphaned extraction directories from crashed restores.
    // Must run AFTER handleStartupRestore (which may leave .restore dirs for retry)
    // and BEFORE chatDbService.init().
    try {
      await BackupManager.cleanupOrphanedExtractions()
    } catch {
      // Non-fatal — orphan cleanup is best-effort
    }

    // Initialise the chat database after startup restore, before normal app
    // availability. If init fails (e.g., integrity check after restore), the
    // app continues but chat DB is marked unavailable for normal operations.
    // A failed restore skips init entirely to prevent unchecked use.
    if (restoreSucceeded) {
      try {
        await chatDbService.init()
      } catch (error) {
        logger.error('ChatDbService initialisation failed (app continues, chat DB unavailable):', error as Error)
      }
    } else {
      logger.warn('ChatDbService init skipped due to restore failure — chat DB unavailable this session')
    }

    const mainWindow = windowService.createMainWindow()

    new TrayService()

    // Setup macOS application menu
    appMenuService?.setupApplicationMenu()

    nodeTraceService.init()
    powerMonitorService.init()
    analyticsService.init()

    // Extract bundled rtk binary to ~/.cherrychat/bin/ on first run
    extractRtkBinaries().catch((error) => {
      logger.warn('Failed to extract rtk binaries (non-fatal)', {
        error: error instanceof Error ? error.message : String(error)
      })
    })

    app.on('activate', function () {
      const mainWindow = windowService.getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed()) {
        windowService.createMainWindow()
      } else {
        windowService.showMainWindow()
      }
    })

    registerShortcuts(mainWindow)

    await registerIpc(mainWindow, app)

    // Sync realtime closure (Main-owned): start automation after chatDb init
    // and IPC registration so saved enabled endpoint config resumes SSE +
    // debounced auto sync. Failures are contained, never block startup.
    try {
      syncAutoService.start()
    } catch (error) {
      logger.warn('Failed to start sync automation (non-fatal)', error as Error)
    }

    replaceDevtoolsFont(mainWindow)

    // Setup deep link for AppImage on Linux
    await setupAppImageDeepLink()

    if (isDev) {
      installExtension([REDUX_DEVTOOLS, REACT_DEVELOPER_TOOLS])
        .then((name) => logger.info(`Added Extension:  ${name}`))
        .catch((err) => logger.error('An error occurred: ', err))
    }

    void runAsyncFunction(async () => {
      // Start API server if enabled. LOCK-005: auto-start first awaits Redux
      // readiness without a fixed timeout (the store is selectable right
      // after rehydration, LOCK-003), then loads the real config — a slow
      // renderer readiness can no longer force the disabled fallback
      // for the whole run. Fire-and-forget relative to global app startup;
      // failures are logged here, never propagated into startup.
      try {
        await apiServerService.startIfEnabled()
      } catch (error: any) {
        logger.error('Failed to check/start API server:', error)
      }
    })
  })

  registerProtocolClient(app)

  // macOS specific: handle protocol when app is already running

  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleProtocolUrl(url)
  })

  const handleOpenUrl = (args: string[]) => {
    const url = args.find((arg) => arg.startsWith(APP_PROTOCOL + '://'))
    if (url) handleProtocolUrl(url)
  }

  // for windows to start with url
  handleOpenUrl(process.argv)

  // Listen for second instance
  app.on('second-instance', (_event, argv) => {
    windowService.showMainWindow()

    // Protocol handler for Windows/Linux
    // The commandLine is an array of strings where the last item might be the URL
    handleOpenUrl(argv)
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  app.on('before-quit', () => {
    app.isQuitting = true
  })

  app.on('will-quit', async () => {
    // Clean up resources — each service in its own try/catch so one failure
    // cannot prevent cleanup of subsequent services.

    // Save-data handshake: remove the ack handler and settle any in-flight
    // request as `disposed` so a late renderer ack can never settle a
    // future session's request.
    try {
      saveDataHandshake.dispose()
    } catch (error) {
      logger.warn('Error disposing save-data handshake:', error as Error)
    }

    // Stop sync synchronously (abort SSE/timers + invalidate in-flight
    // SyncService.sync network/database loops) BEFORE chatDb close so no sync
    // continuation races teardown with post-close DB access. Synchronous calls
    // only — no await is permitted on this path before chatDbService.close().
    // stopSync() already invalidates SyncService.sync; the direct
    // beginShutdown() covers manual sync when automation never started.
    try {
      syncAutoService.stopSync()
    } catch (error) {
      logger.warn('Error stopping sync automation:', error as Error)
    }
    try {
      syncService.beginShutdown()
    } catch (error) {
      logger.warn('Error invalidating in-flight sync:', error as Error)
    }

    // CRITICAL (Finding 6): close() MUST execute synchronously and BEFORE
    // any await. Electron does not guarantee it will await async will-quit
    // listeners. If the process exits during an await above this call,
    // chatDbService.close() would never run, leaking a WAL DB handle.
    // close() is synchronous and safe to call even if init failed or already
    // closed.
    try {
      chatDbService.close()
    } catch (error) {
      logger.warn('Error closing chatDbService:', error as Error)
    }

    try {
      await analyticsService.destroy()
    } catch (error) {
      logger.warn('Error cleaning up analyticsService:', error as Error)
    }

    try {
      await apiServerService.stop()
    } catch (error) {
      logger.warn('Error cleaning up apiServerService:', error as Error)
    }

    // finish the logger
    logger.finish()
  })

  // In this file you can include the rest of your app"s specific main process
  // code. You can also put them in separate files and require them here.
}
