/**
 * Mock chat-completions multimodal acceptance — real HTTP against the real
 * in-process mock server (no Electron launch).
 *
 * Proves the mock's allowlist is limited and explicit: string user content
 * and legal multimodal arrays (text / image_url / input_audio / file(pdf) /
 * video_url) return deterministic 200s, while unknown part types, malformed
 * payloads, and missing user messages keep the deterministic 400. This guards
 * the video E2E (which must observe a real `video_url` product request)
 * without weakening the mock into an echo-all.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createMockServer, stopMockServer } from '../fixtures/mock-openai-server'

let baseUrl = ''

async function postChat(body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    // SSE streams are asserted as text below.
  }
  return { status: res.status, json, text }
}

describe('mock chat-completions multimodal acceptance', () => {
  beforeAll(async () => {
    const { port } = await createMockServer()
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterAll(() => {
    stopMockServer()
  })

  it('keeps accepting plain string user content', async () => {
    const { status, json } = await postChat({
      model: 'mock-model',
      stream: false,
      messages: [{ role: 'user', content: 'hello probe' }]
    })
    expect(status).toBe(200)
    expect(json.choices[0].message.content).toContain('hello probe')
  })

  it('accepts a legal text + video_url array and echoes the text part', async () => {
    const { status, json } = await postChat({
      model: 'mock-model',
      stream: false,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'video echo probe' },
            { type: 'video_url', video_url: { url: 'data:video/mp4;base64,QUJD' } }
          ]
        }
      ]
    })
    expect(status).toBe(200)
    expect(json.choices[0].message.content).toContain('video echo probe')
  })

  it('accepts legal image_url + input_audio + file(pdf) parts', async () => {
    const { status } = await postChat({
      model: 'mock-model',
      stream: false,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'mixed probe' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBOR' } },
            { type: 'input_audio', input_audio: { data: 'QUJD', format: 'mp3' } },
            { type: 'file', file: { filename: 'doc.pdf', file_data: 'data:application/pdf;base64,QUJD' } }
          ]
        }
      ]
    })
    expect(status).toBe(200)
  })

  it('accepts the extended compatible audio formats (wav/ogg/flac/aac)', async () => {
    for (const format of ['wav', 'ogg', 'flac', 'aac']) {
      const { status } = await postChat({
        model: 'mock-model',
        stream: false,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: `audio ${format} probe` },
              { type: 'input_audio', input_audio: { data: 'QUJD', format } }
            ]
          }
        ]
      })
      expect(status).toBe(200)
    }
  })

  it('rejects an unknown input_audio format (per-part allowlist, no unconditional accept)', async () => {
    const { status, json } = await postChat({
      model: 'mock-model',
      stream: false,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'bad audio format probe' },
            { type: 'input_audio', input_audio: { data: 'QUJD', format: 'm4a' } }
          ]
        }
      ]
    })
    expect(status).toBe(400)
    expect(json.error.message).toMatch(/user message/)
  })

  it('streams a legal video array as SSE to completion', async () => {
    const { status, text } = await postChat({
      model: 'mock-model',
      stream: true,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'stream video probe' },
            { type: 'video_url', video_url: { url: 'data:video/mp4;base64,QUJD' } }
          ]
        }
      ]
    })
    expect(status).toBe(200)
    expect(text).toContain('data: [DONE]')
    // Word-grained SSE chunks never contain the full probe contiguously;
    // the echo is proven by its split tokens across chunks.
    expect(text).toContain('stream ')
    expect(text).toContain('probe\\"')
  })

  it('rejects an unknown part type (no unconditional pass-through)', async () => {
    const { status, json } = await postChat({
      model: 'mock-model',
      stream: false,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'bad part probe' },
            { type: 'video', url: 'https://cdn.example/clip.mp4' }
          ]
        }
      ]
    })
    expect(status).toBe(400)
    expect(json.error.message).toMatch(/user message/)
  })

  it('rejects a malformed video_url part missing its url', async () => {
    const { status } = await postChat({
      model: 'mock-model',
      stream: false,
      messages: [{ role: 'user', content: [{ type: 'video_url', video_url: {} }] }]
    })
    expect(status).toBe(400)
  })

  it('rejects requests with no user message', async () => {
    const { status } = await postChat({
      model: 'mock-model',
      stream: false,
      messages: [{ role: 'system', content: 'you are helpful' }]
    })
    expect(status).toBe(400)
  })
})
