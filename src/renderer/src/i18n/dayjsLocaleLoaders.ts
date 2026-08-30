import type { LanguageVarious } from '@renderer/types'

export const dayjsLocaleMap: Record<LanguageVarious, string> = {
  'en-US': 'en',
  'zh-CN': 'zh-cn',
  'zh-TW': 'zh-tw',
  'de-DE': 'de',
  'el-GR': 'el',
  'es-ES': 'es',
  'fr-FR': 'fr',
  'ja-JP': 'ja',
  'pt-PT': 'pt',
  'ro-RO': 'ro',
  'ru-RU': 'ru',
  'vi-VN': 'vi'
}

export const dayjsLocaleLoaders: Record<LanguageVarious, () => Promise<unknown>> = {
  'en-US': () => Promise.resolve(),
  'zh-CN': () => import('dayjs/locale/zh-cn'),
  'zh-TW': () => import('dayjs/locale/zh-tw'),
  'de-DE': () => import('dayjs/locale/de'),
  'el-GR': () => import('dayjs/locale/el'),
  'es-ES': () => import('dayjs/locale/es'),
  'fr-FR': () => import('dayjs/locale/fr'),
  'ja-JP': () => import('dayjs/locale/ja'),
  'pt-PT': () => import('dayjs/locale/pt'),
  'ro-RO': () => import('dayjs/locale/ro'),
  'ru-RU': () => import('dayjs/locale/ru'),
  'vi-VN': () => import('dayjs/locale/vi')
}

export const SUPPORTED_DAYJS_LANGUAGES = Object.keys(dayjsLocaleLoaders) as LanguageVarious[]

export const dayjsLocaleCache = new Set<LanguageVarious>()

export function normalizeDayjsLanguage(language: string): LanguageVarious {
  if (Object.prototype.hasOwnProperty.call(dayjsLocaleLoaders, language)) {
    return language as LanguageVarious
  }
  return 'en-US'
}

export function getDayjsLocaleLoader(language: string): () => Promise<unknown> {
  const normalized = normalizeDayjsLanguage(language)
  return dayjsLocaleLoaders[normalized]
}

export function getDayjsLocaleCode(language: string): string {
  const normalized = normalizeDayjsLanguage(language)
  return dayjsLocaleMap[normalized] || 'en'
}

export async function loadDayjsLocale(language: string): Promise<string> {
  const normalized = normalizeDayjsLanguage(language)
  if (dayjsLocaleCache.has(normalized)) {
    return dayjsLocaleMap[normalized]
  }
  const loader = dayjsLocaleLoaders[normalized]
  await loader()
  dayjsLocaleCache.add(normalized)
  return dayjsLocaleMap[normalized]
}

export function clearDayjsLocaleCache(): void {
  dayjsLocaleCache.clear()
}
