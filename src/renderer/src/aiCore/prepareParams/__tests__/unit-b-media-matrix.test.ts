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

  it('audio matrix: official WAV-MP3 only, compatible +ogg/flac/aac, Gemini audio, Responses-Anthropic none', () => {
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
    expect(supportsAudioInput(makeModel(), '.flac')).toBe(false)
    expect(supportsAudioInput(makeModel(), '.aac')).toBe(false)

    vi.mocked(getProviderByModel).mockReturnValue(wav('openai', 'https://proxy.example.com/v1'))
    expect(supportsAudioInput(makeModel(), '.wav')).toBe(true)
    expect(supportsAudioInput(makeModel(), '.mp3')).toBe(true)
    expect(supportsAudioInput(makeModel(), '.ogg')).toBe(true)
    expect(supportsAudioInput(makeModel(), '.flac')).toBe(true)
    expect(supportsAudioInput(makeModel(), '.aac')).toBe(true)
    expect(supportsAudioInput(makeModel(), '.m4a')).toBe(false)
    expect(supportsAudioInput(makeModel(), '.opus')).toBe(false)

    vi.mocked(getProviderByModel).mockReturnValue(wav('gemini'))
    expect(supportsAudioInput(makeModel(), '.wav')).toBe(true)
  })

  it('video matrix: Gemini + generic compatible encode video, official/Responses/Anthropic do not', () => {
    for (const [type, host, expected] of [
      ['openai-response', 'https://example.com', false],
      ['anthropic', 'https://example.com', false],
      ['openai', 'https://api.openai.com/v1', false],
      ['openai', 'https://proxy.example.com/v1', true],
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

  it('OGG audio on official OpenAI Chat fails explicitly (only WAV-MP3)', async () => {
    const p = makeProvider('openai')
    p.apiHost = 'https://api.openai.com/v1'
    vi.mocked(getProviderByModel).mockReturnValue(p)
    const block = makeFileBlock({ origin_name: 'note.ogg', ext: '.ogg', type: FILE_TYPE.AUDIO })

    await expect(convertFileBlockToFilePart(block, makeModel())).rejects.toThrow(/note\.ogg.*only WAV\/MP3/)
  })

  it('compatible audio encodes ogg/flac/aac with reliable MIME regardless of model id (never metadata-gated)', async () => {
    const p = makeProvider('openai')
    p.apiHost = 'https://proxy.example.com/v1'
    vi.mocked(getProviderByModel).mockReturnValue(p)
    for (const [fileName, ext, mime] of [
      ['note.wav', '.wav', 'audio/wav'],
      ['note.mp3', '.mp3', 'audio/mpeg'],
      ['note.ogg', '.ogg', 'audio/ogg'],
      ['note.flac', '.flac', 'audio/flac'],
      ['note.aac', '.aac', 'audio/aac']
    ] as const) {
      for (const modelId of ['plain-chat-model', 'my-renamed-unknown-1']) {
        const block = makeFileBlock({ origin_name: fileName, ext, type: FILE_TYPE.AUDIO })
        const part = await convertFileBlockToFilePart(block, makeModel({ id: modelId, name: modelId }))
        expect(part).toMatchObject({ type: 'file', mediaType: mime, filename: fileName })
        expect(supportsAudioInput(makeModel({ id: modelId, name: modelId }), ext)).toBe(true)
      }
    }
  })

  it('compatible audio rejects unknown/m4a explicitly without the official WAV-MP3 wording', async () => {
    const p = makeProvider('openai')
    p.apiHost = 'https://proxy.example.com/v1'
    vi.mocked(getProviderByModel).mockReturnValue(p)
    for (const [fileName, ext] of [
      ['note.m4a', '.m4a'],
      ['note.opus', '.opus'],
      ['note.bin', '.bin']
    ] as const) {
      const block = makeFileBlock({ origin_name: fileName, ext, type: FILE_TYPE.AUDIO })
      await expect(convertFileBlockToFilePart(block, makeModel())).rejects.toThrow(/cannot be reliably encoded/)
      expect(supportsAudioInput(makeModel(), ext)).toBe(false)
    }
    expect(resolveAudioMime('.ogg', 'openai-compatible')).toBe('audio/ogg')
    expect(resolveAudioMime('.flac', 'openai-compatible')).toBe('audio/flac')
    expect(resolveAudioMime('.aac', 'openai-compatible')).toBe('audio/aac')
    expect(resolveAudioMime('.m4a', 'openai-compatible')).toBeUndefined()
    expect(resolveAudioMime('.ogg', 'openai-chat')).toBeUndefined()
    expect(resolveAudioMime('.ogg', 'openai')).toBeUndefined()
    expect(resolveAudioMime('.ogg', 'anthropic')).toBeUndefined()
  })

  it('video on Anthropic fails explicitly', async () => {
    vi.mocked(getProviderByModel).mockReturnValue(makeProvider('anthropic'))
    const block = makeFileBlock({ origin_name: 'clip.mp4', ext: '.mp4', type: FILE_TYPE.VIDEO })

    await expect(convertFileBlockToFilePart(block, makeModel())).rejects.toThrow(/clip\.mp4.*not supported/)
  })

  it('video on official OpenAI Chat fails explicitly (unchanged)', async () => {
    const p = makeProvider('openai')
    p.apiHost = 'https://api.openai.com/v1'
    vi.mocked(getProviderByModel).mockReturnValue(p)
    const block = makeFileBlock({ origin_name: 'clip.mp4', ext: '.mp4', type: FILE_TYPE.VIDEO })

    await expect(convertFileBlockToFilePart(block, makeModel())).rejects.toThrow(/clip\.mp4.*cannot be encoded/)
  })

  it('video on generic OpenAI-compatible encodes as FilePart regardless of model id (never metadata-gated)', async () => {
    const p = makeProvider('openai')
    p.apiHost = 'https://proxy.example.com/v1'
    vi.mocked(getProviderByModel).mockReturnValue(p)
    // Model ids (canonical or unknown) never gate encodability (MM-3/MM-4).
    for (const modelId of ['plain-chat-model', 'my-renamed-unknown-1', 'qwen3-vl-8b', 'OPENAI-COMPAT-MODEL']) {
      const block = makeFileBlock({ origin_name: 'clip.mp4', ext: '.mp4', type: FILE_TYPE.VIDEO })
      const part = await convertFileBlockToFilePart(block, makeModel({ id: modelId, name: modelId }))
      expect(part).toMatchObject({ type: 'file', mediaType: 'video/mp4', filename: 'clip.mp4' })
      expect(supportsVideoInput(makeModel({ id: modelId, name: modelId }), '.mp4')).toBe(true)
    }
  })

  it('compatible video keeps known-ext MIME rules, rejects unknown ext explicitly', async () => {
    const p = makeProvider('openai')
    p.apiHost = 'https://proxy.example.com/v1'
    vi.mocked(getProviderByModel).mockReturnValue(p)
    for (const [fileName, ext, mime] of [
      ['clip.mp4', '.mp4', 'video/mp4'],
      ['clip.MP4', '.MP4', 'video/mp4'],
      ['clip.mov', '.mov', 'video/quicktime'],
      ['clip.webm', '.webm', 'video/webm']
    ] as const) {
      const block = makeFileBlock({ origin_name: fileName, ext, type: FILE_TYPE.VIDEO })
      const part = await convertFileBlockToFilePart(block, makeModel())
      expect(part).toMatchObject({ type: 'file', mediaType: mime, filename: fileName })
    }
    for (const [fileName, ext] of [
      ['clip.avi', '.avi'],
      ['clip.mkv', '.mkv']
    ] as const) {
      const block = makeFileBlock({ origin_name: fileName, ext, type: FILE_TYPE.VIDEO })
      await expect(convertFileBlockToFilePart(block, makeModel())).rejects.toThrow(/cannot be reliably encoded/)
      expect(supportsVideoInput(makeModel(), ext)).toBe(false)
    }
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
