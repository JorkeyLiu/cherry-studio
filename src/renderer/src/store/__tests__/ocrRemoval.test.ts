import fs from 'node:fs'
import path from 'node:path'

import preprocessReducer, { defaultPreprocessProviders } from '@renderer/store/preprocess'
import { IpcChannel } from '@shared/IpcChannel'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf-8')
const exists = (rel: string): boolean => fs.existsSync(path.join(root, rel))

describe('OCR full removal: DocProcessSettings keeps preprocess/MinerU, no OCR surface', () => {
  it('preprocess store retains MinerU default plus independent doc providers', () => {
    const ids = defaultPreprocessProviders.map((p) => p.id)
    expect(ids).toEqual(expect.arrayContaining(['mineru', 'doc2x', 'mistral', 'open-mineru', 'paddleocr']))
    const state = preprocessReducer(undefined, { type: '@@INIT' } as never)
    expect(state.defaultProvider).toBe('mineru')
    expect(state.providers.find((p) => p.id === 'mineru')?.name).toBe('MinerU')
  })

  it('DocProcessSettings renders PreprocessSettings only (no OcrSettings)', () => {
    const source = read('src/renderer/src/pages/settings/DocProcessSettings/index.tsx')
    expect(source).toMatch(/PreprocessSettings/)
    expect(source).not.toMatch(/OcrSettings/)
  })

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
      'src/renderer/src/pages/settings/DocProcessSettings/OcrSettings.tsx',
      'src/renderer/src/components/Icons/OcrIcon.tsx'
    ]) {
      expect(exists(rel), rel).toBe(false)
    }
  })

  it('preprocess-shared OCR images stay, OCR-only provider logos are gone', () => {
    expect(exists('src/renderer/src/assets/images/ocr/mineru.jpg')).toBe(true)
    expect(exists('src/renderer/src/assets/images/ocr/doc2x.png')).toBe(true)
    expect(exists('src/renderer/src/assets/images/providers/Tesseract.js.png')).toBe(false)
    expect(exists('src/renderer/src/assets/images/providers/intel.png')).toBe(false)
    expect(exists('src/renderer/src/assets/images/providers/paddleocr.png')).toBe(true)
  })

  it('shared IPC exposes no OCR channel and preload exposes no ocr surface', () => {
    const values = Object.values(IpcChannel) as string[]
    expect(values.filter((v) => v.startsWith('ocr:'))).toEqual([])
    expect((IpcChannel as Record<string, string>).OCR_ocr).toBeUndefined()
    const preload = read('src/preload/index.ts')
    expect(preload).not.toMatch(/OCR_ocr|OCR_ListProviders/)
    expect(preload).not.toMatch(/window\.api\.ocr|api\.ocr\.ocr/)
  })

  it('independent PaddleOCR/Mistral document preprocessing stays intact', () => {
    expect(exists('src/main/knowledge/preprocess/PaddleocrPreprocessProvider.ts')).toBe(true)
    expect(exists('src/main/knowledge/preprocess/MistralPreprocessProvider.ts')).toBe(true)
    const factory = read('src/main/knowledge/preprocess/PreprocessProviderFactory.ts')
    expect(factory).toMatch(/paddleocr/)
  })
})
