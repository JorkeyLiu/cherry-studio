/**
 * Fresh-profile i18n readiness contract: the exported `initialI18nReady`
 * resolves after initial resource bundle activation, and the renderer entry
 * defers App/store/fresh-assistant evaluation until then.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('initial i18n readiness contract', () => {
  it('resolves only after the configured resource bundle is activated', async () => {
    const i18nModule = await import('../index')
    await expect(i18nModule.initialI18nReady).resolves.toBeUndefined()

    const i18n = i18nModule.default
    const { normalizeTranslationLanguage } = await import('../translationLoaders')
    const normalized = normalizeTranslationLanguage(i18nModule.getLanguage())

    // Non-tautological activation proof: the configured bundle is registered
    // AND the fresh-default keys resolve through the resource lookup (not the
    // raw key fallback). `i18n.exists` is false for unactivated resources.
    expect((i18n as any).hasResourceBundle(normalized, 'translation')).toBe(true)
    expect(i18n.exists('chat.default.name')).toBe(true)
    expect(i18n.exists('chat.default.topic.name')).toBe(true)
    const bundle = (i18n as any).getResourceBundle(normalized, 'translation') as Record<string, any>
    const expectedAssistantName = bundle?.chat?.default?.name
    const expectedTopicName = bundle?.chat?.default?.topic?.name
    expect(typeof expectedAssistantName).toBe('string')
    expect(typeof expectedTopicName).toBe('string')
    expect(i18n.t('chat.default.name')).toBe(expectedAssistantName)
    expect(i18n.t('chat.default.topic.name')).toBe(expectedTopicName)

    // Fresh factory construction after readiness takes the activated path.
    const { createAssistantDefaults, getDefaultTopic } = await import('../../services/assistantDefaults')
    expect(createAssistantDefaults().name).toBe(expectedAssistantName)
    expect(getDefaultTopic('default').name).toBe(expectedTopicName)
  })

  it('entry defers App/store evaluation until readiness (no static App import)', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/entryPoint.tsx'), 'utf-8')
    expect(source).toMatch(/initialI18nReady/)
    expect(source).toMatch(/await\s+initialI18nReady/)
    expect(source).toMatch(/await\s+import\(['"]\.\/App['"]\)/)
    expect(source).not.toMatch(/^import\s+App\s+from\s+['"]\.\/App['"]/m)
    expect(source).not.toMatch(/from\s+['"]@renderer\/store['"]/)
    // Failure fallback: renderer still starts when language loading fails.
    expect(source).toMatch(/catch/)
  })
})
