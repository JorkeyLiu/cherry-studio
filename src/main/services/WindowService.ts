// just import the themeService to ensure the theme is initialized
import './ThemeService'

import { is } from '@electron-toolkit/utils'
import { loggerService } from '@logger'
import { isDev, isLinux, isMac, isWin } from '@main/constant'
import { getFilesDir } from '@main/utils/file'
import { getWindowsBackgroundMaterial } from '@main/utils/windowUtil'
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH } from '@shared/config/constant'
import { IpcChannel } from '@shared/IpcChannel'
import { app, BrowserWindow, nativeImage, nativeTheme, shell } from 'electron'
import windowStateKeeper from 'electron-window-state'
import path, { join } from 'path'

import iconPath from '../../../build/icon.png?asset'
import { titleBarOverlayDark, titleBarOverlayLight } from '../config'
import { configManager } from './ConfigManager'
import { contextMenu } from './ContextMenu'
import { isSafeExternalUrl } from './security'
import { initSessionUserAgent } from './WebviewService'

// const logger = loggerService.withContext('WindowService')
const logger = loggerService.withContext('WindowService')

// S7.13: windowReady stage uses stored creation perfMs to compute blocking duration
let windowCreatePerfMs: number | null = null

// Create nativeImage for Linux window icon (required for Wayland)
const linuxIcon = isLinux ? nativeImage.createFromPath(iconPath) : undefined

export class WindowService {
  private static instance: WindowService | null = null
  private mainWindow: BrowserWindow | null = null
  private lastRendererProcessCrashTime: number = 0

  public static getInstance(): WindowService {
    if (!WindowService.instance) {
      WindowService.instance = new WindowService()
    }
    return WindowService.instance
  }

  public createMainWindow(): BrowserWindow {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.show()
      this.mainWindow.focus()
      return this.mainWindow
    }

    // S7.13: capture creation perf anchor for windowReady duration without changing window lifecycle
    windowCreatePerfMs = performance.now()

    const mainWindowState = windowStateKeeper({
      defaultWidth: MIN_WINDOW_WIDTH,
      defaultHeight: MIN_WINDOW_HEIGHT,
      fullScreen: false,
      maximize: false
    })
    const windowsBackgroundMaterial = getWindowsBackgroundMaterial()
    let mainWindowBackgroundColor: string | undefined

    if (!isMac && !windowsBackgroundMaterial) {
      mainWindowBackgroundColor = nativeTheme.shouldUseDarkColors ? '#181818' : '#FFFFFF'
    }

    this.mainWindow = new BrowserWindow({
      x: mainWindowState.x,
      y: mainWindowState.y,
      width: mainWindowState.width,
      height: mainWindowState.height,
      minWidth: MIN_WINDOW_WIDTH,
      minHeight: MIN_WINDOW_HEIGHT,
      show: false,
      autoHideMenuBar: true,
      transparent: false,
      vibrancy: 'sidebar',
      visualEffectState: 'active',
      // For Windows and Linux, we use frameless window with custom controls
      // For Mac, we keep the native title bar style
      ...(isMac
        ? {
            titleBarStyle: 'hidden',
            titleBarOverlay: nativeTheme.shouldUseDarkColors ? titleBarOverlayDark : titleBarOverlayLight,
            trafficLightPosition: { x: 13, y: 13 }
          }
        : {
            // On Linux, allow using system title bar if setting is enabled
            frame: isLinux && configManager.getUseSystemTitleBar() ? true : false
          }),
      ...(windowsBackgroundMaterial ? { backgroundMaterial: windowsBackgroundMaterial } : {}),
      ...(mainWindowBackgroundColor ? { backgroundColor: mainWindowBackgroundColor } : {}),
      darkTheme: nativeTheme.shouldUseDarkColors,
      ...(isLinux ? { icon: linuxIcon } : {}),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        webSecurity: false,
        webviewTag: true,
        allowRunningInsecureContent: true,
        zoomFactor: configManager.getZoomFactor(),
        backgroundThrottling: false
      }
    })

    this.setupMainWindow(this.mainWindow, mainWindowState)

    //init the MinApp webviews' useragent
    initSessionUserAgent()

    return this.mainWindow
  }

  private setupMainWindow(mainWindow: BrowserWindow, mainWindowState: any) {
    mainWindowState.manage(mainWindow)

    this.setupMaximize(mainWindow, mainWindowState.isMaximized)
    this.setupContextMenu(mainWindow)
    this.setupSpellCheck(mainWindow)
    this.setupWindowEvents(mainWindow)
    this.setupWebContentsHandlers(mainWindow)
    this.setupWindowLifecycleEvents(mainWindow)
    this.setupMainWindowMonitor(mainWindow)
    this.loadMainWindowContent(mainWindow)
  }

  private setupSpellCheck(mainWindow: BrowserWindow) {
    const enableSpellCheck = configManager.get('enableSpellCheck', false)
    if (enableSpellCheck) {
      try {
        const spellCheckLanguages = configManager.get('spellCheckLanguages', []) as string[]
        spellCheckLanguages.length > 0 && mainWindow.webContents.session.setSpellCheckerLanguages(spellCheckLanguages)
      } catch (error) {
        logger.error('Failed to set spell check languages:', error as Error)
      }
    }
  }

  private setupMainWindowMonitor(mainWindow: BrowserWindow) {
    mainWindow.webContents.on('render-process-gone', (_, details) => {
      logger.error(`Renderer process crashed with: ${JSON.stringify(details)}`)
      const currentTime = Date.now()
      const lastCrashTime = this.lastRendererProcessCrashTime
      this.lastRendererProcessCrashTime = currentTime
      if (currentTime - lastCrashTime > 60 * 1000) {
        // 如果大于1分钟，则重启渲染进程
        mainWindow.webContents.reload()
      } else {
        // 如果小于1分钟，则退出应用, 可能是连续crash，需要退出应用
        app.exit(1)
      }
    })
  }

  private setupMaximize(mainWindow: BrowserWindow, isMaximized: boolean) {
    if (isMaximized) {
      // 如果是从托盘启动，则需要延迟最大化，否则显示的就不是重启前的最大化窗口了
      configManager.getLaunchToTray()
        ? mainWindow.once('show', () => {
            mainWindow.maximize()
          })
        : mainWindow.maximize()
    }
  }

  private setupContextMenu(mainWindow: BrowserWindow) {
    contextMenu.contextMenu(mainWindow.webContents)
    // setup context menu for all webviews like miniapp
    app.on('web-contents-created', (_, webContents) => {
      contextMenu.contextMenu(webContents)
    })

    // Dangerous API
    if (isDev) {
      mainWindow.webContents.on('will-attach-webview', (_, webPreferences) => {
        webPreferences.preload = join(__dirname, '../preload/index.js')
      })
    }
  }

  private setupWindowEvents(mainWindow: BrowserWindow) {
    mainWindow.once('ready-to-show', () => {
      // S7.13: record windowReady stage without changing lifecycle/ordering.
      // Uses fail-closed synthetic-only gate; does not add IPC or file writes.
      try {
        const { isStartupStageEnabled, readStartupState, recordStartupStage } = require('./startupStageDiagnostics')
        if (isStartupStageEnabled() && windowCreatePerfMs !== null) {
          const duration = performance.now() - windowCreatePerfMs
          // Guard dedup via shared primitive; bounded scalar status only.
          if (!readStartupState().records.some((r) => r.stage === 'main.windowReady')) {
            recordStartupStage('main.windowReady', duration, 'ok')
          }
        }
      } catch {}
      // Clear anchor for next window creation without leaking perf timing
      windowCreatePerfMs = null

      mainWindow.webContents.setZoomFactor(configManager.getZoomFactor())

      // show window only when laucn to tray not set
      const isLaunchToTray = configManager.getLaunchToTray()
      if (!isLaunchToTray) {
        void app.dock?.show()
        mainWindow.show()
      }
    })

    // 处理全屏相关事件
    mainWindow.on('enter-full-screen', () => {
      mainWindow.webContents.send(IpcChannel.FullscreenStatusChanged, true)
    })

    mainWindow.on('leave-full-screen', () => {
      mainWindow.webContents.send(IpcChannel.FullscreenStatusChanged, false)
    })

    // set the zoom factor again when the window is going to resize
    //
    // this is a workaround for the known bug that
    // the zoom factor is reset to cached value when window is resized after routing to other page
    // see: https://github.com/electron/electron/issues/10572
    //
    // and resize ipc
    //
    mainWindow.on('will-resize', () => {
      mainWindow.webContents.setZoomFactor(configManager.getZoomFactor())
      mainWindow.webContents.send(IpcChannel.Windows_Resize, mainWindow.getSize())
    })

    // set the zoom factor again when the window is going to restore
    // minimize and restore will cause zoom reset
    mainWindow.on('restore', () => {
      mainWindow.webContents.setZoomFactor(configManager.getZoomFactor())
    })

    // ARCH: as `will-resize` is only for Win & Mac,
    // linux has the same problem, use `resize` listener instead
    // but `resize` will fliker the ui
    if (isLinux) {
      mainWindow.on('resize', () => {
        mainWindow.webContents.setZoomFactor(configManager.getZoomFactor())
        mainWindow.webContents.send(IpcChannel.Windows_Resize, mainWindow.getSize())
      })
    }

    mainWindow.on('unmaximize', () => {
      mainWindow.webContents.send(IpcChannel.Windows_Resize, mainWindow.getSize())
    })

    mainWindow.on('maximize', () => {
      mainWindow.webContents.send(IpcChannel.Windows_Resize, mainWindow.getSize())
    })

    // 添加Escape键退出全屏的支持
    // mainWindow.webContents.on('before-input-event', (event, input) => {
    //   // 当按下Escape键且窗口处于全屏状态时退出全屏
    //   if (input.key === 'Escape' && !input.alt && !input.control && !input.meta && !input.shift) {
    //     if (mainWindow.isFullScreen()) {
    //       // 获取 shortcuts 配置
    //       const shortcuts = configManager.getShortcuts()
    //       const exitFullscreenShortcut = shortcuts.find((s) => s.key === 'exit_fullscreen')
    //       if (exitFullscreenShortcut == undefined) {
    //         mainWindow.setFullScreen(false)
    //         return
    //       }
    //       if (exitFullscreenShortcut?.enabled) {
    //         event.preventDefault()
    //         mainWindow.setFullScreen(false)
    //         return
    //       }
    //     }
    //   }
    //   return
    // })
  }

  private setupWebContentsHandlers(mainWindow: BrowserWindow) {
    // Fix for Electron bug where zoom resets during in-page navigation (route changes)
    // This complements the resize-based workaround by catching navigation events
    mainWindow.webContents.on('did-navigate-in-page', () => {
      mainWindow.webContents.setZoomFactor(configManager.getZoomFactor())
    })

    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (url.includes('localhost:517')) {
        return
      }

      event.preventDefault()
      if (isSafeExternalUrl(url)) {
        void shell.openExternal(url)
      } else {
        logger.warn(`Blocked navigation to untrusted URL scheme: ${url}`)
      }
    })

    mainWindow.webContents.setWindowOpenHandler((details) => {
      const { url } = details

      const oauthProviderUrls = [
        'https://account.siliconflow.cn/oauth',
        'https://cloud.siliconflow.cn/bills',
        'https://cloud.siliconflow.cn/expensebill',
        'https://console.aihubmix.com/token',
        'https://console.aihubmix.com/topup',
        'https://console.aihubmix.com/statistics',
        'https://dash.302.ai/sso/login',
        'https://dash.302.ai/charge',
        'https://maas.aiionly.com/login'
      ]

      if (oauthProviderUrls.some((link) => url.startsWith(link))) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            webPreferences: {
              partition: 'persist:webview'
            }
          }
        }
      }

      if (url.includes('http://file/')) {
        const fileName = url.replace('http://file/', '')
        if (!fileName) {
          logger.warn('Blocked empty file name in http://file/ URL')
          return { action: 'deny' }
        }
        const storageDir = getFilesDir()
        const filePath = path.resolve(storageDir, fileName)
        // Prevent path traversal: ensure resolved path is within storageDir
        if (!filePath.startsWith(path.resolve(storageDir) + path.sep)) {
          logger.warn(`Blocked path traversal attempt: ${fileName}`)
        } else {
          shell.openPath(filePath).catch((err) => logger.error('Failed to open file:', err))
        }
      } else if (isSafeExternalUrl(details.url)) {
        void shell.openExternal(details.url)
      } else {
        logger.warn(`Blocked shell.openExternal for untrusted URL scheme: ${details.url}`)
      }

      return { action: 'deny' }
    })

    this.setupWebRequestHeaders(mainWindow)
  }

  private setupWebRequestHeaders(mainWindow: BrowserWindow) {
    mainWindow.webContents.session.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, callback) => {
      if (details.responseHeaders?.['X-Frame-Options']) {
        delete details.responseHeaders['X-Frame-Options']
      }
      if (details.responseHeaders?.['x-frame-options']) {
        delete details.responseHeaders['x-frame-options']
      }
      if (details.responseHeaders?.['Content-Security-Policy']) {
        delete details.responseHeaders['Content-Security-Policy']
      }
      if (details.responseHeaders?.['content-security-policy']) {
        delete details.responseHeaders['content-security-policy']
      }
      callback({ cancel: false, responseHeaders: details.responseHeaders })
    })
  }

  private loadMainWindowContent(mainWindow: BrowserWindow) {
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
      // mainWindow.webContents.openDevTools()
    } else {
      void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }
  }

  public getMainWindow(): BrowserWindow | null {
    return this.mainWindow
  }

  private setupWindowLifecycleEvents(mainWindow: BrowserWindow) {
    mainWindow.on('close', (event) => {
      // save data before when close window
      try {
        mainWindow.webContents.send(IpcChannel.App_SaveData)
      } catch (error) {
        logger.error('Failed to save data:', error as Error)
      }

      // 如果已经触发退出，直接退出
      if (app.isQuitting) {
        return app.quit()
      }

      // 托盘及关闭行为设置
      const isShowTray = configManager.getTray()
      const isTrayOnClose = configManager.getTrayOnClose()

      // 没有开启托盘，或者开启了托盘，但设置了直接关闭，应执行直接退出
      if (!isShowTray || (isShowTray && !isTrayOnClose)) {
        // 如果是Windows或Linux，直接退出
        // mac按照系统默认行为，不退出
        if (isWin || isLinux) {
          return app.quit()
        }
      }

      /**
       * 上述逻辑以下:
       * win/linux: 是"开启托盘+设置关闭时最小化到托盘"的情况
       * mac: 任何情况都会到这里，因此需要单独处理mac
       */

      if (!mainWindow.isFullScreen()) {
        event.preventDefault()
      }

      mainWindow.hide()

      //for mac users, should hide dock icon if close to tray
      if (isMac && isTrayOnClose) {
        app.dock?.hide()

        mainWindow.once('show', () => {
          //restore the window can hide by cmd+h when the window is shown again
          // https://github.com/electron/electron/pull/47970
          void app.dock?.show()
        })
      }
    })

    mainWindow.on('closed', () => {
      this.mainWindow = null
    })

    // LOCK-006: the Quick Assistant mini window is removed.
  }

  public showMainWindow() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      if (this.mainWindow.isMinimized()) {
        this.mainWindow.restore()
        return
      }

      /**
       * [Linux] Special handling for window activation
       * When the window is visible but covered by other windows, simply calling show() and focus()
       * is not enough to bring it to the front. We need to hide it first, then show it again.
       * This mimics the "close to tray and reopen" behavior which works correctly.
       */
      if (isLinux && this.mainWindow.isVisible() && !this.mainWindow.isFocused()) {
        this.mainWindow.hide()
        setImmediate(() => {
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.show()
            this.mainWindow.focus()
          }
        })
        return
      }

      /**
       * About setVisibleOnAllWorkspaces
       *
       * [macOS] Known Issue
       *  setVisibleOnAllWorkspaces true/false will NOT bring window to current desktop in Mac (works fine with Windows)
       *  AppleScript may be a solution, but it's not worth
       *
       * [Linux] Known Issue
       *  setVisibleOnAllWorkspaces 在 Linux 环境下（特别是 KDE Wayland）会导致窗口进入"假弹出"状态
       *  因此在 Linux 环境下不执行这两行代码
       */
      if (!isLinux) {
        this.mainWindow.setVisibleOnAllWorkspaces(true)
      }

      /**
       * [macOS] After being closed in fullscreen, the fullscreen behavior will become strange when window shows again
       * So we need to set it to FALSE explicitly.
       * althougle other platforms don't have the issue, but it's a good practice to do so
       *
       *  Check if window is visible to prevent interrupting fullscreen state when clicking dock icon
       */
      if (this.mainWindow.isFullScreen() && !this.mainWindow.isVisible()) {
        this.mainWindow.setFullScreen(false)
      }

      this.mainWindow.show()
      this.mainWindow.focus()
      if (!isLinux) {
        this.mainWindow.setVisibleOnAllWorkspaces(false)
      }
    } else {
      this.mainWindow = this.createMainWindow()
    }
  }

  public toggleMainWindow() {
    // should not toggle main window when in full screen
    // but if the main window is close to tray when it's in full screen, we can show it again
    // (it's a bug in macos, because we can close the window when it's in full screen, and the state will be remained)
    if (this.mainWindow?.isFullScreen() && this.mainWindow?.isVisible()) {
      return
    }

    if (this.mainWindow && !this.mainWindow.isDestroyed() && this.mainWindow.isVisible()) {
      if (this.mainWindow.isFocused()) {
        // if tray is enabled, hide the main window, else do nothing
        if (configManager.getTray()) {
          this.mainWindow.hide()
          app.dock?.hide()
        }
      } else {
        this.mainWindow.focus()
      }
      return
    }

    this.showMainWindow()
  }

  /**
   * 引用文本到主窗口
   * @param text 原始文本（未格式化）
   */
  public quoteToMainWindow(text: string): void {
    try {
      this.showMainWindow()

      const mainWindow = this.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        setTimeout(() => {
          mainWindow.webContents.send(IpcChannel.App_QuoteToMain, text)
        }, 100)
      }
    } catch (error) {
      logger.error('Failed to quote to main window:', error as Error)
    }
  }
}

export const windowService = WindowService.getInstance()
