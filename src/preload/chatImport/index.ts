/**
 * ChatImport preload — narrow import-only bridge.
 *
 * Protocol (Phase 4.1 fix):
 * - discoverResult / readPageResult: renderer→main via ipcRenderer.invoke
 *   (Main uses ipcMain.handle; returns Promise).
 * - complete / error: renderer→main via ipcRenderer.send
 *   (Main uses ipcMain.on; fire-and-forget).
 * - onDiscover / onReadPage / onCancel: main→renderer via ipcRenderer.on
 *   (Main uses webContents.send).
 *
 * Same channel names reused for both directions (invoke/handle for
 * request-response, send/on for fire-and-forget) — Electron dispatches
 * through separate internal maps, so no conflict.
 *
 * NO generic SQL/repository API. Context-isolated bridge.
 * Same pattern as src/preload/index.ts chatDb bridge.
 */

import type {
  ChatImportEnvelope,
  DiscoveryResult,
  ImportErrorPayload,
  ReadPageRequest,
  ReadPageResponse,
  SourceReadStats
} from '@shared/chatImport/types'
import type { LogLevel, LogSourceWithContext } from '@shared/config/logger'
import { contextBridge, ipcRenderer } from 'electron'

/**
 * Fixed log source for the import renderer (LOCK-601): every log entry routed
 * through this narrow bridge is attributed to the chatImport window/module.
 */
const CHAT_IMPORT_LOG_SOURCE: LogSourceWithContext = {
  process: 'renderer',
  window: 'chatImport',
  module: 'chatImport'
}

/**
 * Narrow immutable channel map for this preload ONLY.
 *
 * The chatImport window is loaded with sandbox:true, so this preload runs in a
 * sandboxed context where the ONLY require()able module is Electron itself.
 * Importing the shared IpcChannel enum at runtime made the bundler emit a
 * separate helper chunk (out/preload/IpcChannel-*.js) that this preload then
 * required relatively — which fails in the sandbox and prevents window.chatImport
 * from being exposed. Keeping the exact literals local guarantees the emitted
 * artifact is self-contained (single file, electron-only require) while the
 * values below must stay in sync with the matching IpcChannel members in
 * packages/shared/IpcChannel.ts.
 */
const CHAT_IMPORT_CHANNELS = {
  appLogToMain: 'app:log-to-main',
  ready: 'chat-import:ready',
  discover: 'chat-import:discover',
  readPage: 'chat-import:read-page',
  cancel: 'chat-import:cancel',
  complete: 'chat-import:complete',
  error: 'chat-import:error'
} as const

const chatImport = {
  /** Renderer → Main: signal that the import renderer is ready. */
  ready: (sessionId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(CHAT_IMPORT_CHANNELS.ready, sessionId),

  /**
   * Renderer → Main: route a log entry through the app logger (LOCK-601).
   * Fire-and-forget; the fixed source above attributes every entry to the
   * chatImport window/module.
   */
  log: (level: LogLevel, message: string, data?: unknown[]): void => {
    void ipcRenderer.invoke(CHAT_IMPORT_CHANNELS.appLogToMain, CHAT_IMPORT_LOG_SOURCE, level, message, data)
  },

  /** Renderer → Main: send discovery result after opening source IDB. */
  discoverResult: (envelope: ChatImportEnvelope<DiscoveryResult>): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(CHAT_IMPORT_CHANNELS.discover, envelope),

  /** Renderer → Main: send a page of read data. */
  readPageResult: (envelope: ChatImportEnvelope<ReadPageResponse>): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(CHAT_IMPORT_CHANNELS.readPage, envelope),

  /** Renderer → Main: signal all data has been read (fire-and-forget). */
  complete: (envelope: ChatImportEnvelope<SourceReadStats>): void =>
    ipcRenderer.send(CHAT_IMPORT_CHANNELS.complete, envelope),

  /** Renderer → Main: report an error (fire-and-forget). */
  error: (envelope: ChatImportEnvelope<ImportErrorPayload>): void =>
    ipcRenderer.send(CHAT_IMPORT_CHANNELS.error, envelope),

  /** Main → Renderer: listen for discover trigger. */
  onDiscover: (callback: (sessionId: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { sessionId: string }) => {
      callback(data.sessionId)
    }
    ipcRenderer.on(CHAT_IMPORT_CHANNELS.discover, listener)
    return () => ipcRenderer.removeListener(CHAT_IMPORT_CHANNELS.discover, listener)
  },

  /** Main → Renderer: listen for read-page requests. */
  onReadPage: (callback: (request: ReadPageRequest & { sessionId: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: ReadPageRequest & { sessionId: string }) => {
      callback(data)
    }
    ipcRenderer.on(CHAT_IMPORT_CHANNELS.readPage, listener)
    return () => ipcRenderer.removeListener(CHAT_IMPORT_CHANNELS.readPage, listener)
  },

  /** Main → Renderer: listen for cancel signal. */
  onCancel: (callback: (sessionId: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { sessionId: string }) => {
      callback(data.sessionId)
    }
    ipcRenderer.on(CHAT_IMPORT_CHANNELS.cancel, listener)
    return () => ipcRenderer.removeListener(CHAT_IMPORT_CHANNELS.cancel, listener)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('chatImport', chatImport)
  } catch (error) {
    console.error('[ChatImport Preload] Failed to expose API:', error as Error)
  }
} else {
  ;(window as any).chatImport = chatImport
}

export type ChatImportApiType = typeof chatImport
