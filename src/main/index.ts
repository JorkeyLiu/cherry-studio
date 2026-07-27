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

import { registerIpc } from './ipc'
import { analyticsService } from './services/AnalyticsService'
import { apiServerService } from './services/ApiServerService'
import { appMenuService } from './services/AppMenuService'
import { configManager } from './services/ConfigManager'
import mcpService from './services/MCPService'
import { nodeTraceService } from './services/NodeTraceService'
import powerMonitorService from './services/PowerMonitorService'
import {
  CHERRY_STUDIO_PROTOCOL,
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
import { disposeActiveImport, recoverOrphanedImportArtifacts } from './services/chatDbImport'
import { runStartupRecoveryGate } from './services/chatDbImport/promotion/gate'
import { readPromotionJournal } from './services/chatDbImport/promotion/journalStore'
import type { PromotionJournalObservation } from './services/chatDbImport/promotion/recovery'
import { runAsyncFunction } from './utils'
import { extractRtkBinaries } from './utils/rtk'

const logger = loggerService.withContext('MainEntry')

// enable local crash reports
crashReporter.start({
  companyName: 'CherryHQ',
  productName: 'CherryStudio',
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
  app.commandLine.appendSwitch('class', 'CherryStudio')
  app.commandLine.appendSwitch('name', 'CherryStudio')
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
    electronApp.setAppUserModelId(import.meta.env.VITE_MAIN_BUNDLE_ID || 'com.kangfenmao.CherryStudio')

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

    // Phase 4.4.3 (LOCK-4431): promotion recovery gate runs AFTER restore
    // and BEFORE chatDbService.init(). Disk journal/artifacts decide the
    // action for both in-process continuation and restart after crash.
    //
    // Startup ordering:
    //   1. BackupManager.handleStartupRestore() [completed above]
    //   2. Promotion recovery gate (this block)
    //   3. chatDbService.init()
    //   4. Ordinary orphan cleanup / window startup
    let promotionGateRepairRequired = false
    try {
      const gateResult = await runStartupRecoveryGate(false)
      if (gateResult.repairRequired) {
        promotionGateRepairRequired = true
        logger.warn(
          `Promotion recovery gate: repair required (${gateResult.decision.reason}) — ` +
            'chatDbService init will be skipped until repair is completed'
        )
      }
      if (gateResult.relaunchPending) {
        // Relaunch was triggered — the process is exiting.
        // Return early; no further init should proceed.
        logger.info('Promotion recovery gate: relaunch pending — process will exit')
        return
      }
    } catch (error) {
      // LOCK-4431: unexpected gate failures must fail closed — no unverified
      // DB init. Set repair-required so chatDbService.init() is skipped.
      promotionGateRepairRequired = true
      logger.error(
        'Promotion recovery gate failed unexpectedly — failing closed (LOCK-4431): ' +
          'chatDbService init will be skipped. Error:',
        error as Error
      )
    }

    // Initialise chat database after restore and recovery gate, before normal
    // app availability. If init fails (e.g., integrity check after restore),
    // the app continues but chat DB is marked unavailable for normal operations.
    // If restore failed or repair is required, skip init entirely.
    if (restoreSucceeded && !promotionGateRepairRequired) {
      try {
        await chatDbService.init()
      } catch (error) {
        logger.error('ChatDbService initialisation failed (app continues, chat DB unavailable):', error as Error)
      }
    } else if (promotionGateRepairRequired) {
      logger.warn('ChatDbService init skipped due to promotion repair requirement — chat DB unavailable this session')
    } else {
      logger.warn('ChatDbService init skipped due to restore failure — chat DB unavailable this session')
    }

    // Recover orphaned import artifacts from prior crashes: temp workspaces
    // (R-2) then owned candidate directories (Phase 4.2). Failures are
    // contained/logged inside the helper and never block startup (LOCK-L3).
    //
    // Phase 4.4.1 (LOCK-4413/4414): read the promotion journal to determine
    // whether a promoting candidate must be protected from age-based cleanup.
    // Invalid/I/O-failed journal reads are classified as repair/block per
    // existing app repair conventions — they do NOT silently continue.
    let journalObservation: PromotionJournalObservation = { status: 'absent' }
    try {
      const journalResult = await readPromotionJournal()
      if (journalResult.status === 'absent') {
        journalObservation = { status: 'absent' }
      } else if (journalResult.status === 'invalid') {
        journalObservation = { status: 'invalid' }
        logger.warn(`Promotion journal is invalid (${journalResult.code}): candidate cleanup blocked until repair`)
      } else {
        journalObservation = journalResult
      }
    } catch (error) {
      // I/O failure reading the journal: treat as invalid (repair-block path).
      // LOCK-4414: an unreadable journal is NOT absent — promotion may have
      // begun and its progress is unknowable.
      journalObservation = { status: 'invalid' }
      logger.warn(
        'Failed to read promotion journal (I/O failure): candidate cleanup blocked until repair',
        error as Error
      )
    }
    await recoverOrphanedImportArtifacts(journalObservation)

    const mainWindow = windowService.createMainWindow()

    new TrayService()

    // Setup macOS application menu
    appMenuService?.setupApplicationMenu()

    nodeTraceService.init()
    powerMonitorService.init()
    analyticsService.init()

    // Extract bundled rtk binary to ~/.cherrystudio/bin/ on first run
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

    replaceDevtoolsFont(mainWindow)

    // Setup deep link for AppImage on Linux
    await setupAppImageDeepLink()

    if (isDev) {
      installExtension([REDUX_DEVTOOLS, REACT_DEVELOPER_TOOLS])
        .then((name) => logger.info(`Added Extension:  ${name}`))
        .catch((err) => logger.error('An error occurred: ', err))
    }

    void runAsyncFunction(async () => {
      // Start API server if enabled
      try {
        const config = await apiServerService.getCurrentConfig()
        logger.info('API server config:', config)

        if (config.enabled) {
          await apiServerService.start()
        }
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
    const url = args.find((arg) => arg.startsWith(CHERRY_STUDIO_PROTOCOL + '://'))
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

    // Dispose any active import session (non-fatal) — must run BEFORE
    // chatDbService.close() so the isolated session is torn down first.
    try {
      disposeActiveImport()
    } catch (error) {
      logger.warn('Error disposing active import session:', error as Error)
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
      await mcpService.cleanup()
    } catch (error) {
      logger.warn('Error cleaning up mcpService:', error as Error)
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
