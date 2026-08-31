import KeyvStorage from '@kangfenmao/keyv-storage'
import { loggerService } from '@logger'

import { applyMainWindowTitle } from './config/title'
import { scheduleScrollSnapshotStartupSweep } from './services/scrollSnapshotCache'
import storeSyncService from './services/StoreSyncService'
import { subscribeTopicDeletionEvents } from './services/topicDeletionSubscription'
import { webTraceService } from './services/WebTraceService'
import store from './store'

loggerService.initWindowSource('mainWindow')

// Start renderer-local retention enforcement (B-01..B-05) — bounded TTL timer, subscription, no content retention.
// ESM-safe dynamic import avoids renderer import cycle/mock-hoist cascade while retaining immediate correctness with bounded logging.
// No CommonJS require; startup failures are logged centrally via loggerService and not swallowed silently.
void import('./services/residentRetention')
  .then(({ startResidentRetention }) => {
    try {
      startResidentRetention(store as any)
    } catch (e) {
      loggerService
        .withContext('Store')
        .warn('[store] resident retention startup failed — retention inactive', e as Error)
    }
  })
  .catch((e) => {
    loggerService
      .withContext('Store')
      .warn('[store] resident retention startup failed — retention inactive', e as Error)
  })

// LOCK-RETIRE-001: Cherry Chat is the single application identity. Resolve the
// main-window title from the identity-derived constant at startup — the title
// seam always produces `Cherry Chat` and overrides the shared static HTML title.
applyMainWindowTitle()

function initKeyv() {
  window.keyv = new KeyvStorage()
  void window.keyv.init().catch((e) => {
    try {
      loggerService.withContext('Store').warn('[store] keyv init failed', e as Error)
    } catch {}
  })
  // B-07: startup global TTL/LRU sweep via 0ms bounded post-bootstrap task — Keyv creation + init() stay in synchronous bootstrap; sweep is deferred (best-effort, not authoritative, post-bootstrap)
  try {
    scheduleScrollSnapshotStartupSweep()
  } catch {
    // best-effort; renderer-local only
  }
}

function initAutoSync() {
  setTimeout(() => {
    const { webdavAutoSync, localBackupAutoSync, s3 } = store.getState().settings
    const { nutstoreAutoSync } = store.getState().nutstore
    const autoSyncLogger = loggerService.withContext('AutoSync')
    if (webdavAutoSync || (s3 && s3.autoSync) || localBackupAutoSync) {
      void import('./services/BackupService')
        .then(({ startAutoSync }) => {
          try {
            startAutoSync()
          } catch (e) {
            autoSyncLogger.warn('[AutoSync] backup auto-sync startup failed', e as Error)
          }
        })
        .catch((e) => {
          autoSyncLogger.warn('[AutoSync] backup auto-sync startup failed', e as Error)
        })
    }
    if (nutstoreAutoSync) {
      void import('./services/NutstoreService')
        .then(({ startNutstoreAutoSync }) => startNutstoreAutoSync())
        .catch((e) => {
          autoSyncLogger.warn('[AutoSync] nutstore auto-sync startup failed', e as Error)
        })
    }
  }, 8000)
}

function initStoreSync() {
  storeSyncService.subscribe()
}

function initTopicDeletionSubscription() {
  subscribeTopicDeletionEvents()
}

function initWebTrace() {
  webTraceService.init()
}

initKeyv()
initAutoSync()
initStoreSync()
initTopicDeletionSubscription()
initWebTrace()
