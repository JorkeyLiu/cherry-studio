/**
 * Phase 4.0-A Spike — Narrow Preload
 *
 * TEST/FEASIBILITY-ONLY. Not used by any production build.
 * Excluded from normal builds by PHASE4_SPIKE gating in electron.vite.config.ts.
 * Retained through Phase 4.1 as reproducibility harness.
 *
 * Fixed IPC surface only. No generic channel dispatch, no normal window.api.
 * Designed for sandbox: true, contextIsolation: true, nodeIntegration: false.
 *
 * Channels (all fixed):
 *   spike:ready   — renderer → main  (signals renderer loaded, listener registered)
 *   spike:config  — main → renderer  (sends SpikeRequest envelope)
 *   spike:result  — renderer → main  (sends SpikeResult envelope)
 */
import type { SpikeRequest, SpikeResult } from '@shared/phase4SpikeContract'
import { SPIKE_CHANNELS } from '@shared/phase4SpikeContract'
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('spike', {
  /**
   * Signal to main that the renderer has loaded and set up its config listener.
   * No payload — identity is validated by main via webContents.id.
   */
  ready: (): void => {
    ipcRenderer.send(SPIKE_CHANNELS.READY)
  },

  /**
   * Register a persistent callback for spike:config messages from main.
   * Unlike `once`, this survives the single CONFIG message we expect.
   */
  onConfig: (callback: (config: SpikeRequest) => void): void => {
    ipcRenderer.on(SPIKE_CHANNELS.CONFIG, (_event, config) => {
      callback(config)
    })
  },

  /**
   * Send a SpikeResult envelope to the main process on the fixed RESULT channel.
   */
  reportResult: (data: SpikeResult): void => {
    ipcRenderer.send(SPIKE_CHANNELS.RESULT, data)
  }
})
