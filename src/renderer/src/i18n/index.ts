import { loggerService } from '@logger'
import { defaultLanguage } from '@shared/config/constant'
import dayjs from 'dayjs'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import {
  dayjsLocaleCache,
  dayjsLocaleLoaders,
  dayjsLocaleMap as dayjsMap,
  getDayjsLocaleCode,
  normalizeDayjsLanguage
} from './dayjsLocaleLoaders'
import { loadTranslation, normalizeTranslationLanguage, translationCache } from './translationLoaders'

const logger = loggerService.withContext('I18N')

export const getLanguage = () => {
  try {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('language') : null
    if (stored) return stored
  } catch {}
  try {
    if (typeof navigator !== 'undefined' && navigator.language) return navigator.language
  } catch {}
  return defaultLanguage
}

export const getLanguageCode = () => {
  return getLanguage().split('-')[0]
}

// Map i18n language codes to dayjs locale codes (re-exported for compatibility)
export const dayjsLocaleMap: Record<string, string> = { ...dayjsMap }

// --- Day.js locale state with stale-guard and failure retention ---

let dayjsRequestId = 0
let lastSuccessfulDayjsLanguage: string | null = null

export const setDayjsLocale = (language: string): void => {
  const normalized = normalizeDayjsLanguage(language)
  const requestId = ++dayjsRequestId
  const localeCode = dayjsLocaleMap[normalized] || 'en'

  if (dayjsLocaleCache.has(normalized as any)) {
    if (dayjsRequestId === requestId) {
      dayjs.locale(localeCode)
      lastSuccessfulDayjsLanguage = normalized
    }
    return
  }

  const loader = dayjsLocaleLoaders[normalized]
  if (!loader) {
    if (dayjsRequestId === requestId) {
      dayjs.locale('en')
      lastSuccessfulDayjsLanguage = 'en-US'
    }
    return
  }

  loader()
    .then(() => {
      dayjsLocaleCache.add(normalized as any)
      if (dayjsRequestId !== requestId) return
      dayjs.locale(localeCode)
      lastSuccessfulDayjsLanguage = normalized
    })
    .catch((error) => {
      if (dayjsRequestId !== requestId) return
      logger.error('Failed to load Day.js locale', error as Error, { language: normalized })
    })
}

// Initiate i18next with deterministic initImmediate:false so the internal
// fallback activation is native and synchronous before the wrapper is installed.
// This provably eliminates a competing wrapped request by construction.
const initPromise = i18n.use(initReactI18next).init({
  fallbackLng: defaultLanguage,
  initImmediate: false,
  interpolation: {
    escapeValue: false
  },
  react: {
    useSuspense: false
  },
  saveMissing: true,
  missingKeyHandler: (_1, _2, key) => {
    logger.error(`Missing key: ${key}`)
  }
})

// --- i18n translation state with stale-guard and failure retention ---

let translationRequestId = 0
let lastSuccessfulTranslationLanguage: string | null = null

const originalChangeLanguage =
  typeof (i18n as any).changeLanguage === 'function' ? (i18n as any).changeLanguage.bind(i18n) : null

// Wrap changeLanguage to load translation + dayjs atomically with stale guards
;(i18n as any).changeLanguage = async (lng: string, ...args: unknown[]): Promise<any> => {
  const callback =
    args.length > 0 && typeof args[args.length - 1] === 'function'
      ? (args[args.length - 1] as (err: unknown, t: unknown) => void)
      : undefined
  const resolveT = (): unknown => {
    const t = (i18n as any).t
    return typeof t === 'function' && typeof t.bind === 'function' ? t.bind(i18n) : t
  }
  const invokeCallback = (err: unknown): void => {
    if (typeof callback === 'function') {
      try {
        callback(err ?? null, resolveT())
      } catch {}
    }
  }
  if (!originalChangeLanguage) {
    invokeCallback(null)
    return resolveT()
  }
  const target = typeof lng === 'string' ? lng : getLanguage()
  const normalized = normalizeTranslationLanguage(target)
  const requestId = ++translationRequestId

  try {
    const data = await loadTranslation(normalized)
    if (translationRequestId !== requestId) {
      invokeCallback(null)
      return resolveT()
    }

    // Ensure dayjs locale for same language is loaded before committing language switch.
    // Day.js load failure is treated as combined failure: retain previous both.
    const dayjsNormalized = normalizeDayjsLanguage(target)
    const dayjsCode = getDayjsLocaleCode(target)
    let dayjsLoadSucceeded = dayjsLocaleCache.has(dayjsNormalized as any)
    let dayjsLoadError: unknown = null
    if (!dayjsLoadSucceeded) {
      const dayjsLoader = dayjsLocaleLoaders[dayjsNormalized]
      if (dayjsLoader) {
        try {
          await dayjsLoader()
          dayjsLocaleCache.add(dayjsNormalized as any)
          dayjsLoadSucceeded = true
        } catch (e) {
          dayjsLoadError = e
          if (translationRequestId !== requestId) {
            invokeCallback(null)
            return resolveT()
          }
          logger.error('Failed to load Day.js locale', e as Error, { language: dayjsNormalized })
          dayjsLoadSucceeded = false
        }
      } else {
        dayjsLoadSucceeded = true
      }
    }
    if (translationRequestId !== requestId) {
      invokeCallback(null)
      return resolveT()
    }
    if (!dayjsLoadSucceeded) {
      invokeCallback(dayjsLoadError)
      return resolveT()
    }

    const hasBundle =
      typeof (i18n as any).hasResourceBundle === 'function'
        ? (i18n as any).hasResourceBundle(normalized, 'translation')
        : !!i18n.getResourceBundle(normalized, 'translation')

    if (!hasBundle) {
      i18n.addResourceBundle(normalized, 'translation', data, true, true)
    } else {
      // ensure cache is hot; addResourceBundle with deep merge keeps existing keys
      i18n.addResourceBundle(normalized, 'translation', data, true, true)
    }

    // Apply dayjs locale only after confirming still current request and load succeeded
    dayjs.locale(dayjsCode)
    lastSuccessfulDayjsLanguage = dayjsNormalized

    if (i18n.language !== normalized) {
      const result = await originalChangeLanguage(normalized, ...args)
      lastSuccessfulTranslationLanguage = normalized
      return result
    }
    // Same language: bundle was just added for first time (initial load) — force reload to notify react-i18next
    if (!hasBundle) {
      const result = await originalChangeLanguage(normalized, ...args)
      lastSuccessfulTranslationLanguage = normalized
      return result
    }
    lastSuccessfulTranslationLanguage = normalized
    invokeCallback(null)
    return resolveT()
  } catch (error) {
    if (translationRequestId !== requestId) {
      invokeCallback(null)
      return resolveT()
    }
    logger.error('Failed to load i18n translation', error as Error, { language: normalized })
    invokeCallback(error)
    return resolveT()
  }
}

// Deterministic serialized initial activation: wait for native init to complete,
// then load configured language exclusively through the wrapped atomic path.
// No competing wrapped request exists by construction (initImmediate:false + wrapper after init).
// Pending preserves fallback while configured is pending; atomic commit only on combined success.
void (async () => {
  try {
    await initPromise
  } catch {}
  let initial: string
  try {
    initial = getLanguage()
  } catch {
    initial = defaultLanguage
  }
  const normalized = normalizeTranslationLanguage(initial)
  try {
    await (i18n as any).changeLanguage(initial)
    if (!translationCache.has(normalized as any)) {
      await loadTranslation(normalized)
    }
  } catch {
    // initial failure retains fallback default
  }
})()

// Expose for tests
export const __i18nTestUtils = {
  get translationRequestId() {
    return translationRequestId
  },
  get dayjsRequestId() {
    return dayjsRequestId
  },
  get lastSuccessfulTranslationLanguage() {
    return lastSuccessfulTranslationLanguage
  },
  get lastSuccessfulDayjsLanguage() {
    return lastSuccessfulDayjsLanguage
  },
  bumpTranslationRequestId() {
    translationRequestId++
  },
  bumpDayjsRequestId() {
    dayjsRequestId++
  }
}

export default i18n
