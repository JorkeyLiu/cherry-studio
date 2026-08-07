import KeyvStorage from '@kangfenmao/keyv-storage'
import { loggerService } from '@logger'

import { applyMainWindowTitle } from './config/title'
import { startAutoSync } from './services/BackupService'
import { startNutstoreAutoSync } from './services/NutstoreService'
import storeSyncService from './services/StoreSyncService'
import { webTraceService } from './services/WebTraceService'
import store from './store'

loggerService.initWindowSource('mainWindow')

// LOCK-RETIRE-001: Cherry Chat is the single application identity. Resolve the
// main-window title from the identity-derived constant at startup — the title
// seam always produces `Cherry Chat` and overrides the shared static HTML title.
applyMainWindowTitle()

function initKeyv() {
  window.keyv = new KeyvStorage()
  void window.keyv.init()
}

function initAutoSync() {
  setTimeout(() => {
    const { webdavAutoSync, localBackupAutoSync, s3 } = store.getState().settings
    const { nutstoreAutoSync } = store.getState().nutstore
    if (webdavAutoSync || (s3 && s3.autoSync) || localBackupAutoSync) {
      startAutoSync()
    }
    if (nutstoreAutoSync) {
      void startNutstoreAutoSync()
    }
  }, 8000)
}

function initStoreSync() {
  storeSyncService.subscribe()
}

function initWebTrace() {
  webTraceService.init()
}

initKeyv()
initAutoSync()
initStoreSync()
initWebTrace()
