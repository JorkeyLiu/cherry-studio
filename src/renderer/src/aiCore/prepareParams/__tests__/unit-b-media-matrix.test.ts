/**
 * Unit B media matrix tests: endpoint/adapter decides audio-video encodability,
 * never model metadata. Covers supportsImageInput (protocol-based),
 * supportsAudioInput/supportsVideoInput matrix, and attachment atomicity in
 * convertFileBlockToFilePart.
 */
import type { Model, Provider } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { convertFileBlockToFilePart } from '../fileProcessor'
import {
  resolveAudioMime,
  resolveVideoMime,
  supportsAudioInput,
  supportsImageInput,
  supportsVideoInput
} from '../modelCapabilities'

vi.mock('@renderer/services/AssistantService', () => ({
  getProviderByModel: vi.fn(),
  getDefaultAssistant: vi.fn(() => ({
    id: 'default',
    name: 'Default Assistant',
    prompt: '',
    topics: [],
    type: 'assistant'
  })),
  getDefaultTopic: vi.fn(() => ({ id: 'default-topic', assistantId: 'default', name: 'Default Topic', messages: [] }))
}))

vi.mock('@renderer/store', () => ({
  default: { getState: () => ({}), dispatch: () => {} }
}))

import { getProviderByModel } from '@renderer/services/AssistantService'

const makeModel = (overrides: Partial<Model> = {}): Model =>
  ({
    id: 'plain-chat-model',
    name: 'Plain Chat',
    provider: 'p1',
    group: 'g',
    ...overrides
  }) as Model

const makeProvider = (type: Provider['type'], id = 'p1'): Provider =>
  ({ id, name: id, type, apiKey: 'k', apiHost: 'https://example.com' }) as unknown as Provider

const makeFileBlock = (file: Record<string, unknown>) =>
  ({
    id: 'block-1',
    messageId: 'm-1',
    type: 'file',
    file: {
      id: 'f-1',
      name: 'a.bin',
      origin_name: 'a.bin',
      path: '/tmp/a.bin',
      size: 1024,
      ext: '.bin',
      type: FILE_TYPE.OTHER,
      created_at: new Date().toISOString(),
      count: 1,
      ...file
    }
  }) as any

function mockWindowFile() {
  const g = window as any
  g.api = g.api || {}
  g.api.file = g.api.file || {}
  g.api.file.base64File = vi.fn(async () => ({ data: 'AAA', mime: 'application/octet-stream' }))
  g.api.file.base64Image = vi.fn(async () => ({ base64: 'BBB', mime: 'image/png', data: 'BBB' }))
}

describe('Unit B media matrix', () => {
  beforeEach(() => {
    vi.mocked(getProviderByModel).mockReset()
    mockWindowFile()
  })

  it('supportsImageInput follows the endpoint adapter, not vision metadata', () => {
    const cases: Array<{ type: Provider['type']; host: string }> = [
      { type: 'openai-response', host: 'https://example.com' },
      { type: 'openai', host: 'https://api.openai.com/v1' },
      { type: 'openai', host: 'https://proxy.example.com/v1' },
      { type: 'anthropic', host: 'https://example.com' },
      { type: 'gemini', host: 'https://example.com' }
    ]
    for (const c of cases) {
      const provider = makeProvider(c.type)
      provider.apiHost = c.host
      vi.mocked(getProviderByModel).mockReturnValue(provider)
      expect(supportsImageInput(makeModel())).toBe(true)
    }
  })

  it('audio matrix: chat/compatible WAV-MP3 only, Gemini audio, Responses-Anthropic none', () => {
    const wav = (type: Provider['type'], host = 'https://example.com') => {
      const p = makeProvider(type)
      p.apiHost = host
      return p
    }
    vi.mocked(getProviderByModel).mockReturnValue(wav('openai-response'))
    expect(supportsAudioInput(makeModel(), '.wav')).toBe(false)

    vi.mocked(getProviderByModel).mockReturnValue(wav('anthropic'))
    expect(supportsAudioInput(makeModel(), '.mp3')).toBe(false)

    vi.mocked(getProviderByModel).mockReturnValue(wav('openai', 'https://api.openai.com/v1'))
    expect(supportsAudioInput(makeModel(), '.mp3')).toBe(true)
    expect(supportsAudioInput(makeModel(), '.ogg')).toBe(false)

    vi.mocked(getProviderByModel).mockReturnValue(wav('openai', 'https://proxy.example.com/v1'))
    expect(supportsAudioInput(makeModel(), '.wav')).toBe(true)

    vi.mocked(getProviderByModel).mockReturnValue(wav('gemini'))
    expect(supportsAudioInput(makeModel(), '.wav')).toBe(true)
  })

  it('video matrix: only Gemini encodes video', () => {
    for (const [type, host, expected] of [
      ['openai-response', 'https://example.com', false],
      ['anthropic', 'https://example.com', false],
      ['openai', 'https://api.openai.com/v1', false],
      ['openai', 'https://proxy.example.com/v1', false],
      ['gemini', 'https://example.com', true]
    ] as const) {
      const p = makeProvider(type)
      p.apiHost = host
      vi.mocked(getProviderByModel).mockReturnValue(p)
      expect(supportsVideoInput(makeModel(), '.mp4')).toBe(expected)
    }
  })

  it('single truth source: OpenAI strictly WAV/MP3, Gemini reliable MIME only', () => {
    const chat = makeProvider('openai')
    chat.apiHost = 'https://api.openai.com/v1'
    vi.mocked(getProviderByModel).mockReturnValue(chat)
    // .mpeg/.mpga share audio/mpeg with .mp3 but are never admitted.
    expect(supportsAudioInput(makeModel(), '.mpeg')).toBe(false)
    expect(supportsAudioInput(makeModel(), '.mpga')).toBe(false)
    expect(resolveAudioMime('.mpeg', 'openai-chat')).toBeUndefined()
    expect(resolveAudioMime('.mp3', 'openai-chat')).toBe('audio/mpeg')

    const gemini = makeProvider('gemini')
    vi.mocked(getProviderByModel).mockReturnValue(gemini)
    // Gemini audio uses the same resolver as the encoder.
    expect(supportsAudioInput(makeModel(), '.ogg')).toBe(true)
    expect(resolveAudioMime('.ogg', 'google')).toBe('audio/ogg')
    expect(supportsAudioInput(makeModel(), '.mpeg')).toBe(false)
    // Video: only mp4/mov/webm are reliably encodable.
    expect(supportsVideoInput(makeModel(), '.mp4')).toBe(true)
    expect(supportsVideoInput(makeModel(), '.mov')).toBe(true)
    expect(supportsVideoInput(makeModel(), '.webm')).toBe(true)
    expect(supportsVideoInput(makeModel(), '.avi')).toBe(false)
    expect(supportsVideoInput(makeModel(), '.mkv')).toBe(false)
    expect(resolveVideoMime('.avi')).toBeUndefined()
  })

  it('WAV audio on OpenAI Chat encodes as FilePart with reliable MIME', async () => {
    const p = makeProvider('openai')
    p.apiHost = 'https://api.openai.com/v1'
    vi.mocked(getProviderByModel).mockReturnValue(p)
    const block = makeFileBlock({ origin_name: 'note.wav', ext: '.wav', type: FILE_TYPE.AUDIO })

    const part = await convertFileBlockToFilePart(block, makeModel())
    expect(part).toMatchObject({ type: 'file', mediaType: 'audio/wav', filename: 'note.wav' })
  })

  it('OGG audio on OpenAI Chat fails explicitly (only WAV-MP3)', async () => {
    const p = makeProvider('openai')
    p.apiHost = 'https://api.openai.com/v1'
    vi.mocked(getProviderByModel).mockReturnValue(p)
    const block = makeFileBlock({ origin_name: 'note.ogg', ext: '.ogg', type: FILE_TYPE.AUDIO })

    await expect(convertFileBlockToFilePart(block, makeModel())).rejects.toThrow(/note\.ogg.*only WAV\/MP3/)
  })

  it('video on Anthropic fails explicitly', async () => {
    vi.mocked(getProviderByModel).mockReturnValue(makeProvider('anthropic'))
    const block = makeFileBlock({ origin_name: 'clip.mp4', ext: '.mp4', type: FILE_TYPE.VIDEO })

    await expect(convertFileBlockToFilePart(block, makeModel())).rejects.toThrow(/clip\.mp4.*not supported/)
  })

  it('image read failure aborts with filename/type/reason (never silent null)', async () => {
    const p = makeProvider('openai')
    p.apiHost = 'https://proxy.example.com/v1'
    vi.mocked(getProviderByModel).mockReturnValue(p)
    ;(window as any).api.file.base64Image = vi.fn(async () => {
      throw new Error('ENOENT')
    })
    const block = makeFileBlock({ origin_name: 'pic.png', ext: '.png', type: FILE_TYPE.IMAGE })

    await expect(convertFileBlockToFilePart(block, makeModel())).rejects.toThrow(/pic\.png.*image.*ENOENT/)
  })
})
