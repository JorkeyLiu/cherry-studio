import type { LanguageVarious } from '@renderer/types'
import type { Locale } from 'antd/es/locale'

export type AntdLocale = Locale

export const antdLocaleLoaders: Record<LanguageVarious, () => Promise<{ default: AntdLocale }>> = {
  'zh-CN': () => import('antd/locale/zh_CN'),
  'zh-TW': () => import('antd/locale/zh_TW'),
  'en-US': () => import('antd/locale/en_US'),
  'de-DE': () => import('antd/locale/de_DE'),
  'ru-RU': () => import('antd/locale/ru_RU'),
  'ja-JP': () => import('antd/locale/ja_JP'),
  'el-GR': () => import('antd/locale/el_GR'),
  'es-ES': () => import('antd/locale/es_ES'),
  'fr-FR': () => import('antd/locale/fr_FR'),
  'pt-PT': () => import('antd/locale/pt_PT'),
  'ro-RO': () => import('antd/locale/ro_RO'),
  'vi-VN': () => import('antd/locale/vi_VN')
}

export const SUPPORTED_LANGUAGES = Object.keys(antdLocaleLoaders) as LanguageVarious[]

export const antdLocaleCache = new Map<LanguageVarious, AntdLocale>()

export function normalizeAntdLanguage(language: string): LanguageVarious {
  if (Object.prototype.hasOwnProperty.call(antdLocaleLoaders, language)) {
    return language as LanguageVarious
  }
  return 'zh-CN'
}

export function getAntdLocaleLoader(language: string): () => Promise<{ default: AntdLocale }> {
  const normalized = normalizeAntdLanguage(language)
  return antdLocaleLoaders[normalized]
}

export async function loadAntdLocale(language: string): Promise<AntdLocale> {
  const normalized = normalizeAntdLanguage(language)
  const cached = antdLocaleCache.get(normalized)
  if (cached) return cached
  const loader = antdLocaleLoaders[normalized]
  const mod = await loader()
  const locale = (mod as { default: AntdLocale }).default ?? (mod as unknown as AntdLocale)
  antdLocaleCache.set(normalized, locale)
  return locale
}

export function clearAntdLocaleCache(): void {
  antdLocaleCache.clear()
}
