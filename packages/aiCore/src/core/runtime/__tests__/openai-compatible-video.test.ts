/**
 * OpenAI-compatible video_url serialization — real patched SDK + fake HTTP.
 *
 * Proves the maintained `@ai-sdk/openai-compatible` patch maps user FilePart
 * `video/*` to `{ type: 'video_url', video_url: { url } }` on the wire for
 * both generate and stream, with MIME/base64 fidelity, model-id passthrough,
 * multipart order preserved, no frame-rate synthesis, and transparent
 * upstream-error propagation. This is the adapter half of the video fix; the
 * renderer encoder half lives in
 * `src/renderer/src/aiCore/prepareParams/__tests__/unit-b-media-matrix.test.ts`.
 *
 * Governance (model-metadata ADR MM-3/MM-4/MM-11): support is adjudicated
 * upstream — the tests below never consult canonical metadata and use
 * arbitrary/unknown model ids to prove the request is lazily sent as-is.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { describe, expect, it, vi } from 'vitest'

const VIDEO_B64 = 'QUJDRA==' // raw base64 payload (opaque bytes, never decoded here)
const VIDEO_MIME = 'video/mp4'

function successBody(model: string) {
  return {
    id: 'chatcmpl-test-video',
    object: 'chat.completion',
    created: 1700000000,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop'
      }
    ],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
  }
}

function streamBody(model: string) {
  const chunk = {
    id: 'chatcmpl-test-video-stream',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model,
    choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }]
  }
  const done = {
    id: 'chatcmpl-test-video-stream',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
  }
  return `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`
}

function captureFetch(handler: (url: string, body: any) => Response) {
  const seen: Array<{ url: string; body: any }> = []
  const fetch = vi.fn(async (url: any, init: any) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    seen.push({ url: String(url), body })
    return handler(String(url), body)
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, seen }
}

describe('openai-compatible video_url serialization (patched SDK)', () => {
  it('generate: FilePart video/mp4 becomes video_url data URL, model id untouched, order kept, no fps', async () => {
    const { fetch, seen } = captureFetch((_url, body) => {
      return new Response(JSON.stringify(successBody(body.model)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    })
    const provider = createOpenAICompatible({
      baseURL: 'http://127.0.0.1:1/v1',
      name: 'test-video-provider',
      apiKey: 'test',
      fetch
    })
    const model = provider.chatModel('my-renamed-unknown-1')

    const result = await model.doGenerate({
      prompt: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe this clip' },
            { type: 'file', mediaType: VIDEO_MIME, data: VIDEO_B64, filename: 'clip.mp4' },
            { type: 'text', text: 'be brief' }
          ]
        }
      ]
    } as any)

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(seen).toHaveLength(1)
    const body = seen[0].body
    // Selected connection model id is sent as-is (MM-1/MM-4 lazy send).
    expect(body.model).toBe('my-renamed-unknown-1')
    const content = body.messages[0].content
    expect(content).toHaveLength(3)
    expect(content[0]).toMatchObject({ type: 'text', text: 'describe this clip' })
    // MIME + base64 fidelity on the wire.
    expect(content[1]).toEqual({
      type: 'video_url',
      video_url: { url: `data:${VIDEO_MIME};base64,${VIDEO_B64}` }
    })
    expect(content[2]).toMatchObject({ type: 'text', text: 'be brief' })
    // No frame-rate synthesis, no dropped part.
    expect(JSON.stringify(body)).not.toContain('fps')
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
  })

  it('generate: Uint8Array bytes and URL data follow the image-branch encoding', async () => {
    const { fetch, seen } = captureFetch((_url, body) => {
      return new Response(JSON.stringify(successBody(body.model)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    })
    const provider = createOpenAICompatible({
      baseURL: 'http://127.0.0.1:1/v1',
      name: 'test-video-provider',
      apiKey: 'test',
      fetch
    })
    const model = provider.chatModel('custom-vl-model')
    const bytes = new Uint8Array([0x00, 0x01, 0x02])

    await model.doGenerate({
      prompt: [
        {
          role: 'user',
          content: [
            { type: 'file', mediaType: 'video/quicktime', data: bytes, filename: 'clip.mov' },
            {
              type: 'file',
              mediaType: 'video/webm',
              data: new URL('https://cdn.example/clip.webm'),
              filename: 'clip.webm'
            }
          ]
        }
      ]
    } as any)

    const content = seen[0].body.messages[0].content
    expect(content).toHaveLength(2)
    // Uint8Array -> base64 data URL with the part media type.
    expect(content[0].type).toBe('video_url')
    expect(content[0].video_url.url.startsWith('data:video/quicktime;base64,')).toBe(true)
    // URL data passes through untouched (same contract as image parts).
    expect(content[1]).toEqual({
      type: 'video_url',
      video_url: { url: 'https://cdn.example/clip.webm' }
    })
  })

  it('stream: video_url content is identical on the streaming wire', async () => {
    const { fetch, seen } = captureFetch((_url, body) => {
      return new Response(streamBody(body.model), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      })
    })
    const provider = createOpenAICompatible({
      baseURL: 'http://127.0.0.1:1/v1',
      name: 'test-video-provider',
      apiKey: 'test',
      fetch
    })
    const model = provider.chatModel('stream-vl-model')

    const { stream } = await model.doStream({
      prompt: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'watch:' },
            { type: 'file', mediaType: VIDEO_MIME, data: VIDEO_B64, filename: 'clip.mp4' }
          ]
        }
      ]
    } as any)

    // Drain the stream to completion.
    const reader = stream.getReader()
    for (;;) {
      const { done } = await reader.read()
      if (done) break
    }

    expect(fetch).toHaveBeenCalledTimes(1)
    const body = seen[0].body
    expect(body.model).toBe('stream-vl-model')
    expect(body.stream).toBe(true)
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'watch:' },
      { type: 'video_url', video_url: { url: `data:${VIDEO_MIME};base64,${VIDEO_B64}` } }
    ])
    expect(JSON.stringify(body)).not.toContain('fps')
  })

  it('upstream 400 for video is transparent (never masked locally)', async () => {
    const upstreamMessage = 'This model does not support video inputs'
    const { fetch } = captureFetch(() => {
      return new Response(JSON.stringify({ error: { message: upstreamMessage, type: 'invalid_request_error' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    })
    const provider = createOpenAICompatible({
      baseURL: 'http://127.0.0.1:1/v1',
      name: 'test-video-provider',
      apiKey: 'test',
      fetch
    })
    const model = provider.chatModel('upstream-adjudicated-model')

    await expect(
      model.doGenerate({
        prompt: [
          {
            role: 'user',
            content: [{ type: 'file', mediaType: VIDEO_MIME, data: VIDEO_B64, filename: 'clip.mp4' }]
          }
        ]
      } as any)
    ).rejects.toThrow(upstreamMessage)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('openai-compatible input_audio serialization (patched SDK)', () => {
  const AUDIO_CASES = [
    { mediaType: 'audio/wav', format: 'wav', filename: 'note.wav' },
    { mediaType: 'audio/mpeg', format: 'mp3', filename: 'note.mp3' },
    { mediaType: 'audio/ogg', format: 'ogg', filename: 'note.ogg' },
    { mediaType: 'audio/flac', format: 'flac', filename: 'note.flac' },
    { mediaType: 'audio/aac', format: 'aac', filename: 'note.aac' }
  ] as const
  const AUDIO_B64 = 'QUJDRA=='

  it('generate: ogg/flac/aac FileParts become input_audio with reliable format, model id untouched, no transcode', async () => {
    const { fetch, seen } = captureFetch((_url, body) => {
      return new Response(JSON.stringify(successBody(body.model)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    })
    const provider = createOpenAICompatible({
      baseURL: 'http://127.0.0.1:1/v1',
      name: 'test-audio-provider',
      apiKey: 'test',
      fetch
    })
    const model = provider.chatModel('my-renamed-unknown-audio-1')

    const promptContent = [
      { type: 'text', text: 'transcribe:' },
      ...AUDIO_CASES.filter((c) => ['audio/ogg', 'audio/flac', 'audio/aac'].includes(c.mediaType)).map((c) => ({
        type: 'file',
        mediaType: c.mediaType,
        data: AUDIO_B64,
        filename: c.filename
      })),
      { type: 'text', text: 'be brief' }
    ]

    const result = await model.doGenerate({
      prompt: [{ role: 'user', content: promptContent }]
    } as any)

    expect(fetch).toHaveBeenCalledTimes(1)
    const body = seen[0].body
    expect(body.model).toBe('my-renamed-unknown-audio-1')
    const content = body.messages[0].content
    expect(content).toHaveLength(5)
    expect(content[0]).toMatchObject({ type: 'text', text: 'transcribe:' })
    expect(content[1]).toEqual({ type: 'input_audio', input_audio: { data: AUDIO_B64, format: 'ogg' } })
    expect(content[2]).toEqual({ type: 'input_audio', input_audio: { data: AUDIO_B64, format: 'flac' } })
    expect(content[3]).toEqual({ type: 'input_audio', input_audio: { data: AUDIO_B64, format: 'aac' } })
    expect(content[4]).toMatchObject({ type: 'text', text: 'be brief' })
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
  })

  it('generate: wav/mp3 parity is unchanged', async () => {
    const { fetch, seen } = captureFetch((_url, body) => {
      return new Response(JSON.stringify(successBody(body.model)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    })
    const provider = createOpenAICompatible({
      baseURL: 'http://127.0.0.1:1/v1',
      name: 'test-audio-provider',
      apiKey: 'test',
      fetch
    })
    const model = provider.chatModel('audio-parity-model')

    await model.doGenerate({
      prompt: [
        {
          role: 'user',
          content: [
            { type: 'file', mediaType: 'audio/wav', data: AUDIO_B64, filename: 'note.wav' },
            { type: 'file', mediaType: 'audio/mpeg', data: AUDIO_B64, filename: 'note.mp3' }
          ]
        }
      ]
    } as any)

    const content = seen[0].body.messages[0].content
    expect(content).toEqual([
      { type: 'input_audio', input_audio: { data: AUDIO_B64, format: 'wav' } },
      { type: 'input_audio', input_audio: { data: AUDIO_B64, format: 'mp3' } }
    ])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('stream: input_audio content is identical on the streaming wire', async () => {
    const { fetch, seen } = captureFetch((_url, body) => {
      return new Response(streamBody(body.model), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      })
    })
    const provider = createOpenAICompatible({
      baseURL: 'http://127.0.0.1:1/v1',
      name: 'test-audio-provider',
      apiKey: 'test',
      fetch
    })
    const model = provider.chatModel('stream-audio-model')

    const { stream } = await model.doStream({
      prompt: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'listen:' },
            { type: 'file', mediaType: 'audio/ogg', data: AUDIO_B64, filename: 'note.ogg' }
          ]
        }
      ]
    } as any)

    const reader = stream.getReader()
    for (;;) {
      const { done } = await reader.read()
      if (done) break
    }

    expect(fetch).toHaveBeenCalledTimes(1)
    const body = seen[0].body
    expect(body.model).toBe('stream-audio-model')
    expect(body.stream).toBe(true)
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'listen:' },
      { type: 'input_audio', input_audio: { data: AUDIO_B64, format: 'ogg' } }
    ])
  })

  it('URL audio stays forbidden (never video_url-style passthrough) and unknown audio stays a local error', async () => {
    const { fetch } = captureFetch((_url, body) => {
      return new Response(JSON.stringify(successBody(body.model)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    })
    const provider = createOpenAICompatible({
      baseURL: 'http://127.0.0.1:1/v1',
      name: 'test-audio-provider',
      apiKey: 'test',
      fetch
    })
    const model = provider.chatModel('audio-forbidden-model')

    await expect(
      model.doGenerate({
        prompt: [
          {
            role: 'user',
            content: [
              {
                type: 'file',
                mediaType: 'audio/ogg',
                data: new URL('https://cdn.example/note.ogg'),
                filename: 'note.ogg'
              }
            ]
          }
        ]
      } as any)
    ).rejects.toThrow(/audio file parts with URLs/)
    await expect(
      model.doGenerate({
        prompt: [
          {
            role: 'user',
            content: [{ type: 'file', mediaType: 'audio/x-unknown', data: AUDIO_B64, filename: 'note.bin' }]
          }
        ]
      } as any)
    ).rejects.toThrow(/audio media type/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('upstream 400 for audio is transparent (never masked locally)', async () => {
    const upstreamMessage = 'This model does not support audio inputs'
    const { fetch } = captureFetch(() => {
      return new Response(JSON.stringify({ error: { message: upstreamMessage, type: 'invalid_request_error' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    })
    const provider = createOpenAICompatible({
      baseURL: 'http://127.0.0.1:1/v1',
      name: 'test-audio-provider',
      apiKey: 'test',
      fetch
    })
    const model = provider.chatModel('upstream-adjudicated-audio-model')

    await expect(
      model.doGenerate({
        prompt: [
          {
            role: 'user',
            content: [{ type: 'file', mediaType: 'audio/flac', data: AUDIO_B64, filename: 'note.flac' }]
          }
        ]
      } as any)
    ).rejects.toThrow(upstreamMessage)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
