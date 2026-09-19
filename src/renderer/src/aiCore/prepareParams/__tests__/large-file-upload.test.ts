/**
 * Large-file upload: Gemini FilePart/file URI and OpenAI root-cause retention.
 */
import type { Model, Provider } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { geminiRemoteFileToFilePart, handleGeminiFileUpload, handleOpenAILargeFileUpload } from '../fileProcessor'

vi.mock('@renderer/services/AssistantService', () => ({
  getProviderByModel: vi.fn(),
  getDefaultAssistant: vi.fn(() => ({ id: 'default', name: 'Default Assistant' }))
}))

import { getProviderByModel } from '@renderer/services/AssistantService'

const makeModel = (overrides: Partial<Model> = {}): Model =>
  ({ id: 'm', name: 'M', provider: 'p1', ...overrides }) as Model

const makeProvider = (type: Provider['type'], id = 'p1'): Provider =>
  ({ id, name: id, type, apiKey: 'k', apiHost: 'https://example.com' }) as unknown as Provider

const makeFile = () =>
  ({
    id: 'f-1',
    name: 'doc.pdf',
    origin_name: 'doc.pdf',
    path: '/tmp/doc.pdf',
    size: 30 * 1024 * 1024,
    ext: '.pdf',
    type: 'document',
    created_at: new Date().toISOString(),
    count: 1
  }) as any

function mockFileService(retrieve: unknown, upload: unknown) {
  const g = window as any
  g.api = g.api || {}
  g.api.fileService = {
    retrieve: vi.fn(async () => retrieve),
    upload: vi.fn(async () => upload)
  }
}

describe('large file upload root causes', () => {
  beforeEach(() => {
    vi.mocked(getProviderByModel).mockReset()
  })

  it('geminiRemoteFileToFilePart builds a URL-backed FilePart', () => {
    const part = geminiRemoteFileToFilePart(
      { uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc', mimeType: 'application/pdf' },
      'doc.pdf'
    )
    expect(part).toMatchObject({ type: 'file', mediaType: 'application/pdf', filename: 'doc.pdf' })
    expect((part as any).data).toBeInstanceOf(URL)
  })

  it('existing Gemini upload returns a URL FilePart', async () => {
    vi.mocked(getProviderByModel).mockReturnValue(makeProvider('gemini'))
    mockFileService(
      {
        status: 'success',
        originalFile: { type: 'gemini', file: { uri: 'https://example.com/files/1', mimeType: 'application/pdf' } }
      },
      null
    )
    const part = await handleGeminiFileUpload(makeFile(), makeModel())
    expect(part).toMatchObject({ type: 'file', filename: 'doc.pdf' })
    expect((part as any).data).toBeInstanceOf(URL)
  })

  it('new Gemini upload returns a URL FilePart', async () => {
    vi.mocked(getProviderByModel).mockReturnValue(makeProvider('gemini'))
    mockFileService(
      { status: 'failed' },
      {
        status: 'success',
        originalFile: { type: 'gemini', file: { uri: 'https://example.com/files/2', mimeType: 'application/pdf' } }
      }
    )
    const part = await handleGeminiFileUpload(makeFile(), makeModel())
    expect((part as any).data).toBeInstanceOf(URL)
  })

  it('Gemini upload failure throws with root cause (never silent null)', async () => {
    vi.mocked(getProviderByModel).mockReturnValue(makeProvider('gemini'))
    mockFileService({ status: 'failed' }, { status: 'failed' })
    await expect(handleGeminiFileUpload(makeFile(), makeModel())).rejects.toThrow(/doc\.pdf.*failed/)
  })

  it('OpenAI retrieve/upload failures retain the concrete cause', async () => {
    const provider = makeProvider('openai')
    provider.apiHost = 'https://proxy.example.com/v1'
    vi.mocked(getProviderByModel).mockReturnValue(provider)
    const g = window as any
    g.api = g.api || {}
    g.api.fileService = {
      retrieve: vi.fn(async () => {
        throw new Error('network down')
      }),
      upload: vi.fn(async () => ({}))
    }
    await expect(handleOpenAILargeFileUpload(makeFile(), makeModel())).rejects.toThrow(/network down/)
  })
})
