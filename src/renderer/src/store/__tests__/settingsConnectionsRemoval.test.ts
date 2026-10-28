/**
 * Settings-slice regression for the retired note-app connection integrations
 * (Notion / Yuque / Joplin / Obsidian / Siyuan) and the retired export-menu
 * surface.
 *
 * The slice now carries one shared export default directory plus one Markdown
 * reasoning default; the per-format export-menu toggles and the four retired
 * Markdown switches are gone because the export menu is always available.
 */
import { describe, expect, it } from 'vitest'

import * as settingsModule from '../settings'
import settingsReducer, { initialState } from '../settings'

const removedSettingsKeys = [
  'notionDatabaseID',
  'notionApiKey',
  'notionPageNameKey',
  'notionExportReasoning',
  'yuqueToken',
  'yuqueUrl',
  'yuqueRepoId',
  'joplinToken',
  'joplinUrl',
  'joplinExportReasoning',
  'defaultObsidianVault',
  'siyuanApiUrl',
  'siyuanToken',
  'siyuanBoxId',
  'siyuanRootPath'
]

const retiredExportKeys = [
  'exportMenuOptions',
  'markdownExportPath',
  'forceDollarMathInMarkdown',
  'useTopicNamingForMessageTitle',
  'showModelNameInMarkdown',
  'showModelProviderInMarkdown'
]

const removedSetters = [
  'setNotionDatabaseID',
  'setNotionApiKey',
  'setNotionPageNameKey',
  'setNotionExportReasoning',
  'setYuqueToken',
  'setYuqueUrl',
  'setYuqueRepoId',
  'setJoplinToken',
  'setJoplinUrl',
  'setJoplinExportReasoning',
  'setDefaultObsidianVault',
  'setSiyuanApiUrl',
  'setSiyuanToken',
  'setSiyuanBoxId',
  'setSiyuanRootPath',
  'setExportMenuOptions',
  'setmarkdownExportPath',
  'setForceDollarMathInMarkdown',
  'setUseTopicNamingForMessageTitle',
  'setShowModelNameInMarkdown',
  'setShowModelProviderInMarkdown'
]

const freshState = () => settingsReducer(undefined, { type: '@@INIT' } as never)

describe('note-app connection + export-menu removal: settings slice', () => {
  it('initial state carries none of the integration-exclusive settings keys', () => {
    const state = freshState() as unknown as Record<string, unknown>
    for (const key of removedSettingsKeys) {
      expect(state[key], key).toBeUndefined()
    }
  })

  it('initial state carries none of the retired export-menu keys', () => {
    const state = freshState() as unknown as Record<string, unknown>
    for (const key of retiredExportKeys) {
      expect(state[key], key).toBeUndefined()
    }
  })

  it('defaults the shared export directory to the dialog behavior and reasoning to off', () => {
    const state = freshState()
    expect(state.exportPath).toBeNull()
    expect(state.exportIncludeThinking).toBe(false)
  })

  it('the slice exposes no retired setter and keeps the export/citation setters', () => {
    const actions = settingsModule as unknown as Record<string, unknown>
    for (const setter of removedSetters) {
      expect(actions[setter], setter).toBeUndefined()
    }
    for (const setter of [
      'setExportPath',
      'setExportIncludeThinking',
      'setExcludeCitationsInExport',
      'setStandardizeCitationsInExport'
    ]) {
      expect(typeof actions[setter], setter).toBe('function')
    }
  })

  it('stores the shared export directory, including clearing it back to null', () => {
    const set = settingsReducer(initialState, {
      type: 'settings/setExportPath',
      payload: '/tmp/exports'
    })
    expect(set.exportPath).toBe('/tmp/exports')

    const cleared = settingsReducer(set, { type: 'settings/setExportPath', payload: null })
    expect(cleared.exportPath).toBeNull()
  })

  it('stores the Markdown reasoning default', () => {
    const next = settingsReducer(initialState, {
      type: 'settings/setExportIncludeThinking',
      payload: true
    })
    expect(next.exportIncludeThinking).toBe(true)
  })

  it('keeps both citation switches as ordinary settings', () => {
    const excluded = settingsReducer(initialState, {
      type: 'settings/setExcludeCitationsInExport',
      payload: true
    })
    expect(excluded.excludeCitationsInExport).toBe(true)

    const standardized = settingsReducer(initialState, {
      type: 'settings/setStandardizeCitationsInExport',
      payload: true
    })
    expect(standardized.standardizeCitationsInExport).toBe(true)
  })
})
