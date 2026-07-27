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
import { IpcChannel } from '@shared/IpcChannel'
import { contextBridge, ipcRenderer } from 'electron'

const chatImport = {
  /** Renderer → Main: signal that the import renderer is ready. */
  ready: (sessionId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannel.ChatImport_Ready, sessionId),

  /** Renderer → Main: send discovery result after opening source IDB. */
  discoverResult: (envelope: ChatImportEnvelope<DiscoveryResult>): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannel.ChatImport_Discover, envelope),

  /** Renderer → Main: send a page of read data. */
  readPageResult: (envelope: ChatImportEnvelope<ReadPageResponse>): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannel.ChatImport_ReadPage, envelope),

  /** Renderer → Main: signal all data has been read (fire-and-forget). */
  complete: (envelope: ChatImportEnvelope<SourceReadStats>): void =>
    ipcRenderer.send(IpcChannel.ChatImport_Complete, envelope),

  /** Renderer → Main: report an error (fire-and-forget). */
  error: (envelope: ChatImportEnvelope<ImportErrorPayload>): void =>
    ipcRenderer.send(IpcChannel.ChatImport_Error, envelope),

  /** Main → Renderer: listen for discover trigger. */
  onDiscover: (callback: (sessionId: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { sessionId: string }) => {
      callback(data.sessionId)
    }
    ipcRenderer.on(IpcChannel.ChatImport_Discover, listener)
    return () => ipcRenderer.removeListener(IpcChannel.ChatImport_Discover, listener)
  },

  /** Main → Renderer: listen for read-page requests. */
  onReadPage: (callback: (request: ReadPageRequest & { sessionId: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: ReadPageRequest & { sessionId: string }) => {
      callback(data)
    }
    ipcRenderer.on(IpcChannel.ChatImport_ReadPage, listener)
    return () => ipcRenderer.removeListener(IpcChannel.ChatImport_ReadPage, listener)
  },

  /** Main → Renderer: listen for cancel signal. */
  onCancel: (callback: (sessionId: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { sessionId: string }) => {
      callback(data.sessionId)
    }
    ipcRenderer.on(IpcChannel.ChatImport_Cancel, listener)
    return () => ipcRenderer.removeListener(IpcChannel.ChatImport_Cancel, listener)
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
