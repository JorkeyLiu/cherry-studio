import fs from 'node:fs'
import path from 'node:path'

import { IpcChannel } from '@shared/IpcChannel'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf-8')
const exists = (rel: string): boolean => fs.existsSync(path.join(root, rel))
const readJson = (rel: string): any => JSON.parse(read(rel))

/**
 * Unit-level guard for user-authorized capability removals.
 *
 * OCR removal (historical) and document-preprocess removal (current) both
 * deleted a whole capability: settings surface, Redux slice, hooks, main-process
 * providers, assets and the exclusive dependency. Not covered here (proven
 * elsewhere): the persistence scrub migration and the ordinary knowledge flow.
 */
describe('removed capabilities stay removed: OCR surface, document preprocessing', () => {
  describe('OCR removal (historical)', () => {
    it('OCR exclusive modules are deleted from the tree', () => {
      for (const rel of [
        'src/main/services/ocr/OcrService.ts',
        'src/main/utils/ocr.ts',
        'src/renderer/src/types/ocr.ts',
        'src/renderer/src/config/ocr.ts',
        'src/renderer/src/store/ocr.ts',
        'src/renderer/src/hooks/useOcr.ts',
        'src/renderer/src/hooks/useOcrProvider.tsx',
        'src/renderer/src/services/ocr/OcrService.ts',
        'src/renderer/src/components/Icons/OcrIcon.tsx'
      ]) {
        expect(exists(rel), rel).toBe(false)
      }
    })

    it('OCR-only provider logos are gone', () => {
      expect(exists('src/renderer/src/assets/images/providers/Tesseract.js.png')).toBe(false)
      expect(exists('src/renderer/src/assets/images/providers/intel.png')).toBe(false)
    })

    it('shared IPC exposes no OCR channel and preload exposes no ocr surface', () => {
      const values = Object.values(IpcChannel) as string[]
      expect(values.filter((v) => v.startsWith('ocr:'))).toEqual([])
      expect((IpcChannel as Record<string, string>).OCR_ocr).toBeUndefined()
      const preload = read('src/preload/index.ts')
      expect(preload).not.toMatch(/OCR_ocr|OCR_ListProviders/)
      expect(preload).not.toMatch(/window\.api\.ocr|api\.ocr\.ocr/)
    })
  })

  describe('document-preprocess removal', () => {
    it('main-process preprocess providers and renderer slice/hook/config are deleted', () => {
      for (const rel of [
        'src/main/knowledge/preprocess/BasePreprocessProvider.ts',
        'src/main/knowledge/preprocess/DefaultPreprocessProvider.ts',
        'src/main/knowledge/preprocess/Doc2xPreprocessProvider.ts',
        'src/main/knowledge/preprocess/MineruPreprocessProvider.ts',
        'src/main/knowledge/preprocess/MistralPreprocessProvider.ts',
        'src/main/knowledge/preprocess/OpenMineruPreprocessProvider.ts',
        'src/main/knowledge/preprocess/PaddleocrPreprocessProvider.ts',
        'src/main/knowledge/preprocess/PreprocessProvider.ts',
        'src/main/knowledge/preprocess/PreprocessProviderFactory.ts',
        'src/main/knowledge/preprocess/PreprocessingService.ts',
        'src/renderer/src/store/preprocess.ts',
        'src/renderer/src/hooks/usePreprocess.ts',
        'src/renderer/src/config/preprocessProviders.ts'
      ]) {
        expect(exists(rel), rel).toBe(false)
      }
    })

    it('settings menu/route surface is deleted and the route is unreachable', () => {
      for (const rel of [
        'src/renderer/src/pages/settings/DocProcessSettings/index.tsx',
        'src/renderer/src/pages/settings/DocProcessSettings/PreprocessSettings.tsx',
        'src/renderer/src/pages/settings/DocProcessSettings/PreprocessProviderSettings.tsx'
      ]) {
        expect(exists(rel), rel).toBe(false)
      }
      const settingsPage = read('src/renderer/src/pages/settings/SettingsPage.tsx')
      expect(settingsPage).not.toMatch(/DocProcessSettings/)
      expect(settingsPage).not.toMatch(/\/settings\/docprocess/)
    })

    it('preprocess-only assets are deleted', () => {
      for (const rel of [
        'src/renderer/src/assets/images/ocr/doc2x.png',
        'src/renderer/src/assets/images/ocr/mineru.jpg',
        'src/renderer/src/assets/images/providers/mistral.png',
        'src/renderer/src/assets/images/providers/paddleocr.png'
      ]) {
        expect(exists(rel), rel).toBe(false)
      }
    })

    it('Redux store registers no preprocess slice', () => {
      const storeIndex = read('src/renderer/src/store/index.ts')
      expect(storeIndex).not.toMatch(/from '\.\/preprocess'/)
      expect(storeIndex).not.toMatch(/\n  preprocess,\n/)
    })

    it('renderer/shared knowledge contracts carry no preprocess fields or provider ids', () => {
      const knowledgeTypes = read('src/renderer/src/types/knowledge.ts')
      expect(knowledgeTypes).not.toMatch(/PreprocessProvider|preprocessProvider|isPreprocessed|PreprocessReadPdfResult/)
      const rendererKnowledgeService = read('src/renderer/src/services/KnowledgeService.ts')
      expect(rendererKnowledgeService).not.toMatch(/preprocessProvider|preprocess\.providers/)
      const query = read('src/renderer/src/queue/KnowledgeQueue.ts')
      expect(query).not.toMatch(/isPreprocessed|preprocessProvider/)
      const sharedLoaderReturn = read('packages/shared/config/types.ts')
      expect(sharedLoaderReturn).not.toMatch(/'preprocess'/)
      const mainKnowledgeService = read('src/main/services/KnowledgeService.ts')
      expect(mainKnowledgeService).not.toMatch(/preprocess/i)
    })

    it('file-preprocess IPC events are gone from main and renderer', () => {
      const mainSources = [
        'src/main/services/KnowledgeService.ts',
        'src/renderer/src/pages/knowledge/KnowledgeContent.tsx'
      ]
      for (const rel of mainSources) {
        expect(read(rel), rel).not.toMatch(/file-preprocess-(finished|progress)/)
      }
      expect(Object.values(IpcChannel) as string[]).not.toContain('file-preprocess-progress')
    })

    it('preprocess i18n keys are gone from every shipped locale', () => {
      for (const locale of ['en-us', 'zh-cn', 'zh-tw']) {
        const json = readJson(`src/renderer/src/i18n/locales/${locale}.json`)
        expect(json.knowledge.settings.preprocessing, locale).toBeUndefined()
        expect(json.knowledge.settings.preprocessing_tooltip, locale).toBeUndefined()
        expect(json.knowledge.status_preprocess_completed, locale).toBeUndefined()
        expect(json.knowledge.status_preprocess_failed, locale).toBeUndefined()
        expect(json.settings.tool.preprocess, locale).toBeUndefined()
      }
    })

    it('only the exclusively-owned dependency is removed; shared ones stay', () => {
      const pkg = readJson('package.json')
      const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>
      // form-data was used only by the removed Open MinerU provider.
      expect(deps['form-data']).toBeUndefined()
      // adm-zip is shared by ZIP import/E2E fixture tooling, pdf-lib by FileStorage.
      expect(deps['adm-zip']).toBeDefined()
      expect(deps['@types/adm-zip']).toBeDefined()
      expect(deps['pdf-lib']).toBeDefined()
    })

    it('ordinary knowledge ingestion/search surface is retained', () => {
      for (const rel of [
        'src/renderer/src/store/knowledge.ts',
        'src/renderer/src/pages/knowledge/components/KnowledgeSettings/AdvancedSettingsPanel.tsx',
        'src/main/knowledge/embedjs/loader/index.ts',
        'src/main/knowledge/reranker/Reranker.ts'
      ]) {
        expect(exists(rel), rel).toBe(true)
      }
      const panel = read('src/renderer/src/pages/knowledge/components/KnowledgeSettings/AdvancedSettingsPanel.tsx')
      expect(panel).toMatch(/knowledge\.chunk_size/)
      expect(panel).toMatch(/knowledge\.threshold/)
      const content = read('src/renderer/src/pages/knowledge/KnowledgeContent.tsx')
      expect(content).toMatch(/directory-processing-percent/)
    })

    it('remote-file Mistral upload code is retained', () => {
      expect(exists('src/main/services/remotefile/MistralService.ts')).toBe(true)
      expect(exists('src/main/services/MistralClientManager.ts')).toBe(true)
    })
  })
})
