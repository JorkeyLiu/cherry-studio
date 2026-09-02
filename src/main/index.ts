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
import { join } from 'node:path'

import { DATA_PATH } from '@main/config'
import { appIdentity } from '@shared/config/identity'

import { registerIpc } from './ipc'
import { analyticsService } from './services/AnalyticsService'
import { markStartupStageSync, withStartupStage } from './services/startupStageDiagnostics'
import { apiServerService } from './services/ApiServerService'
import { appMenuService } from './services/AppMenuService'
import { configManager } from './services/ConfigManager'
import mcpService from './services/MCPService'
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
import { disposeActiveImport, recoverOrphanedImportArtifacts } from './services/chatDbImport'
import { disposeCherryImportControl } from './services/chatDbImport/importControlIpc'
import { runStartupRecoveryGate } from './services/chatDbImport/promotion/gate'
import { readPromotionJournal } from './services/chatDbImport/promotion/journalStore'
import type { PromotionJournalObservation } from './services/chatDbImport/promotion/recovery'
import { runAsyncFunction } from './utils'
import { extractRtkBinaries } from './utils/rtk'

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
      await withStartupStage('main.restore', () => BackupManager.handleStartupRestore())
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
      await withStartupStage('main.cleanupExtractions', () => BackupManager.cleanupOrphanedExtractions())
    } catch {
      // Non-fatal — orphan cleanup is best-effort
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
    // LOCK-F2: when the catalog recovery window exhausted its bounded retry
    // budget, it stays up showing the bounded terminal repair surface. The
    // app must NOT boot ordinary UI nor init chatDb — the whole ordinary
    // startup path below is skipped.
    let catalogRecoveryTerminal = false
    try {
      const gateResult = await withStartupStage('main.promotionGate', () => runStartupRecoveryGate(false))
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
      // LOCK-PROMO-7: v2 catalog-dependent recovery — boot the recovery-only
      // window surface, run the three-artifact recovery to convergence
      // (all-new or all-old), then continue normal startup. Ordinary UI is
      // blocked until the handoff completes or the old generation is
      // restored.
      if (gateResult.catalogRecoveryRequired) {
        logger.warn(
          `Promotion recovery gate: catalog recovery required (${String(gateResult.catalogRecoveryAction)}, ` +
            `phase ${String(gateResult.catalogRecoveryPhase)}) — booting the recovery-only surface; ` +
            'ordinary UI stays blocked (LOCK-PROMO-7)'
        )
        try {
          const { runCatalogStartupRecovery } = await import('./services/chatDbImport/catalogStartupRecovery')
          const { BrowserWindow } = await import('electron')
          const recoveryResult = await withStartupStage('main.catalogRecovery', () =>
            runCatalogStartupRecovery({
              dataRoot: DATA_PATH,
              createWindow: () =>
                new BrowserWindow({
                  width: 480,
                  height: 300,
                  // LOCK-CAT-8: the recovery window stays hidden — the renderer
                  // only needs to run the catalog handoff in the background; it
                  // is shown only when the bounded terminal repair surface is
                  // raised (LOCK-F2).
                  show: false,
                  autoHideMenuBar: true,
                  backgroundColor: '#181818',
                  webPreferences: {
                    preload: join(__dirname, '../preload/index.js'),
                    // Mirror the main window webPreferences (house style):
                    // sandbox/webSecurity follow the existing window bootstrap
                    // patterns; webviewTag stays disabled on the minimal surface.
                    sandbox: false,
                    webSecurity: false,
                    webviewTag: false,
                    contextIsolation: true
                  }
                }),
              liveDb: chatDbService
            })
          )
          if (!recoveryResult.ok) {
            // LOCK-F2: terminal recovery failure — fail closed (LOCK-4431):
            // chatDb init is blocked and, when the bounded repair surface is
            // shown, the ordinary app window is NOT created.
            promotionGateRepairRequired = true
            catalogRecoveryTerminal = recoveryResult.terminalSurface
            logger.error(
              `Catalog startup recovery failed (${recoveryResult.code}) — failing closed: ` +
                'chatDbService init will be skipped until repair is completed',
              recoveryResult.safeCode ? new Error(recoveryResult.safeCode) : undefined
            )
          } else if (recoveryResult.restartRequested) {
            // Packaged relaunch path: the process is exiting.
            logger.info('Catalog startup recovery: relaunch pending — process will exit')
            return
          }
          // Non-packaged: the recovery window is destroyed; normal startup
          // (chatDb init + main window) proceeds below.
        } catch (error) {
          promotionGateRepairRequired = true
          logger.error(
            'Catalog startup recovery failed unexpectedly — failing closed (LOCK-4431): ' +
              'chatDbService init will be skipped. Error:',
            error as Error
          )
        }
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

    // LOCK-F2: terminal catalog recovery — the recovery window is showing the
    // bounded repair surface (or no window could be shown at all). Ordinary
    // UI, chatDb init, and every downstream service stay off; the process
    // stays alive on the repair surface and the will-quit cleanup below still
    // runs.
    if (catalogRecoveryTerminal) {
      logger.warn('Catalog recovery terminal — ordinary startup skipped (bounded repair surface shown, LOCK-F2)')
      return
    }

    // Initialise chat database after restore and recovery gate, before normal
    // app availability. If init fails (e.g., integrity check after restore),
    // the app continues but chat DB is marked unavailable for normal operations.
    // If restore failed or repair is required, skip init entirely.
    if (restoreSucceeded && !promotionGateRepairRequired) {
      try {
        await withStartupStage('main.chatDbInit', () => chatDbService.init())
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
    await withStartupStage('main.orphanRecovery', () => recoverOrphanedImportArtifacts(journalObservation))

    const cwStart = performance.now()
    const mainWindow = windowService.createMainWindow()
    markStartupStageSync('main.createWindow', cwStart)

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

    await withStartupStage('main.registerIpc', () => registerIpc(mainWindow, app))

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
      // renderer/import projection can no longer force the disabled fallback
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

    // L2 control layer (poller, terminal ownership, webContents ref) must be
    // settled BEFORE the underlying import session is torn down. This stops
    // the state poller and releases any unclaimed terminal promotion ownership
    // (LOCK-6015/6018) so the session disposal below cannot race a stale poller
    // callback or leave terminal capability unreleased.
    try {
      disposeCherryImportControl()
    } catch (error) {
      logger.warn('Error disposing import control:', error as Error)
    }

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
