import type { LanguageVarious } from '@renderer/types'

export const translationLoaders: Record<LanguageVarious, () => Promise<{ default: Record<string, unknown> }>> = {
  'en-US': () => import('./locales/en-us.json'),
  'zh-CN': () => import('./locales/zh-cn.json'),
  'zh-TW': () => import('./locales/zh-tw.json'),
  'de-DE': () => import('./translate/de-de.json'),
  'el-GR': () => import('./translate/el-gr.json'),
  'es-ES': () => import('./translate/es-es.json'),
  'fr-FR': () => import('./translate/fr-fr.json'),
  'ja-JP': () => import('./translate/ja-jp.json'),
  'pt-PT': () => import('./translate/pt-pt.json'),
  'ro-RO': () => import('./translate/ro-ro.json'),
  'ru-RU': () => import('./translate/ru-ru.json'),
  'vi-VN': () => import('./translate/vi-vn.json')
}

export const SUPPORTED_TRANSLATION_LANGUAGES = Object.keys(translationLoaders) as LanguageVarious[]

export const translationCache = new Map<LanguageVarious, Record<string, unknown>>()

export function normalizeTranslationLanguage(language: string): LanguageVarious {
  if (Object.prototype.hasOwnProperty.call(translationLoaders, language)) {
    return language as LanguageVarious
  }
  return 'en-US'
}

export function getTranslationLoader(language: string): () => Promise<{ default: Record<string, unknown> }> {
  const normalized = normalizeTranslationLanguage(language)
  return translationLoaders[normalized]
}

export async function loadTranslation(language: string): Promise<Record<string, unknown>> {
  const normalized = normalizeTranslationLanguage(language)
  const cached = translationCache.get(normalized)
  if (cached) return cached
  const loader = translationLoaders[normalized]
  const mod = await loader()
  const data = (mod as { default: Record<string, unknown> }).default ?? (mod as unknown as Record<string, unknown>)
  translationCache.set(normalized, data)
  return data
}

export function clearTranslationCache(): void {
  translationCache.clear()
}
