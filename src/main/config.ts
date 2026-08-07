import { isDev, isWin } from '@main/constant'
import { applyDevSuffix, findExplicitUserDataDir } from '@shared/config/userData'
import { app } from 'electron'

import { getDataPath } from './utils'

if (isDev && !findExplicitUserDataDir(process.argv)) {
  // Historical dev-profile suffix applied on top of the identity base that
  // ./bootstrap resolved (Cherry Chat keeps an independent dev profile). An
  // explicit `--user-data-dir` CLI override is the user's direct instruction
  // and is preserved verbatim — no `Dev` suffix is appended to it.
  app.setPath('userData', applyDevSuffix(app.getPath('userData'), isDev))
}

export const DATA_PATH = getDataPath()

export const titleBarOverlayDark = {
  height: 42,
  color: isWin ? 'rgba(0,0,0,0.02)' : 'rgba(255,255,255,0)',
  symbolColor: '#fff'
}

export const titleBarOverlayLight = {
  height: 42,
  color: 'rgba(255,255,255,0)',
  symbolColor: '#000'
}

global.CHERRYAI_CLIENT_SECRET = import.meta.env.MAIN_VITE_CHERRYAI_CLIENT_SECRET
