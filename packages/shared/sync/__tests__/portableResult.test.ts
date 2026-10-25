/**
 * Portable persisted MESSAGE RESULT metadata — central helper unit contract.
 *
 * Guards the ONE declared sanitized container used by every sync route:
 * sanitizing extraction from persisted `extra`, strict wire validation
 * (numeric/unsafe-key rejection), atomic-container merge semantics (null
 * clears, unrelated local-only keys preserved) and the exclusion of
 * connection/credential/raw-blob fields.
 */
import { describe, expect, it } from 'vitest'

import {
  extractBlockResultMeta,
  extractMessageResultMeta,
  mergeResultMetaIntoExtra,
  RESULT_META_MAX_JSON_BYTES,
  validateBlockResultMeta,
  validateMessageResultMeta
} from '../portableResult'

describe('message result extraction', () => {
  it('extracts usage/metrics/mentions/useful and a sanitized model display snapshot', () => {
    const extra = JSON.stringify({
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        thoughts_tokens: 3,
        cost: 0.0012,
        completion_tokens_details: { reasoning_tokens: 3, audio_tokens: 0 }
      },
      metrics: { completion_tokens: 7, time_completion_millsec: 900, time_first_token_millsec: 120.5 },
      mentions: [{ id: 'openai/gpt-4o', name: 'GPT-4o', group: 'OpenAI', provider: 'local-conn', apiKey: 'sk-x' }],
      useful: true,
      model: {
        id: 'anthropic/claude-sonnet-4',
        name: 'Claude Sonnet 4',
        group: 'Anthropic',
        provider: 'device-local-provider',
        apiHost: 'https://internal.example',
        pricing: { input_per_million_tokens: 3 }
      }
    })
    const { meta, dropped } = extractMessageResultMeta(extra)
    expect(meta).toMatchObject({
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, thoughts_tokens: 3, cost: 0.0012 },
      metrics: { completion_tokens: 7, time_completion_millsec: 900, time_first_token_millsec: 120.5 },
      mentions: [{ id: 'openai/gpt-4o', name: 'GPT-4o', group: 'OpenAI' }],
      useful: true,
      model: { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', group: 'Anthropic' }
    })
    // Connection binding / credentials / pricing never become portable.
    const serialized = JSON.stringify(meta)
    expect(serialized).not.toContain('local-conn')
    expect(serialized).not.toContain('apiKey')
    expect(serialized).not.toContain('device-local-provider')
    expect(serialized).not.toContain('internal.example')
    expect(serialized).not.toContain('pricing')
    expect(dropped).toContain('model.provider')
    expect(dropped).toContain('mentions[].provider')
  })

  it('excludes non-portable message overflow keys (trace, provider metadata, removed domains, UI fold)', () => {
    const { meta, dropped } = extractMessageResultMeta({
      usage: { total_tokens: 5 },
      traceId: 'trace-1',
      providerMetadata: { anthropic: { cacheRead: 12 } },
      enabledMCPs: [{ name: 'server' }],
      type: 'clear',
      multiModelMessageStyle: 'horizontal',
      foldSelected: true
    })
    expect(meta).toEqual({ usage: { total_tokens: 5 } })
    for (const key of [
      'traceId',
      'providerMetadata',
      'enabledMCPs',
      'type',
      'multiModelMessageStyle',
      'foldSelected'
    ]) {
      expect(dropped).toContain(key)
    }
  })

  it('drops malformed values instead of failing capture, and returns null when nothing portable remains', () => {
    expect(extractMessageResultMeta({ usage: { prompt_tokens: '11' as unknown as number } }).meta).toBeNull()
    expect(extractMessageResultMeta({ useful: 'yes' as unknown as boolean }).meta).toBeNull()
    expect(extractMessageResultMeta(null).meta).toBeNull()
    expect(extractMessageResultMeta('not json').meta).toBeNull()
  })

  it('answers a null/malformed mention with a structured error instead of dereferencing it', () => {
    expect(() => validateMessageResultMeta({ mentions: [null] })).not.toThrow()
    expect(validateMessageResultMeta({ mentions: [null] })).toMatch(/mentions\[0\]/)
    expect(validateMessageResultMeta({ mentions: [{ id: 'ok' }, null] })).toMatch(/mentions\[1\]/)
    expect(validateMessageResultMeta({ mentions: [{ name: 'no-id' }] })).toMatch(/mentions\[0\].id/)
    expect(validateMessageResultMeta({ mentions: ['model-x'] })).toMatch(/mentions\[0\]/)
    // `model` keeps legitimate nullable semantics (unknown model is not a defect).
    expect(validateMessageResultMeta({ model: null })).toBeNull()
    // The same malformed shapes are capture-safe: best effort, never a throw.
    expect(() => extractMessageResultMeta({ mentions: [null, 'x', { id: 'ok' }] })).not.toThrow()
    expect(extractMessageResultMeta({ mentions: [null, 'x', { id: 'ok' }] }).meta).toEqual({
      mentions: [{ id: 'ok' }]
    })
    expect(() => extractBlockResultMeta({ error: null, translation: null })).not.toThrow()
    expect(extractBlockResultMeta({ error: null, translation: null }).meta).toBeNull()
  })
})

describe('block result extraction', () => {
  it('keeps thinking duration, sanitized error display, code language and translation identity', () => {
    const { meta, dropped } = extractBlockResultMeta({
      thinking_millsec: 4321.5,
      error: {
        name: 'AI_APICallError',
        code: 'E_PROVIDER_UNAVAILABLE',
        statusCode: 503,
        i18nKey: 'error.request.timeout',
        // Freeform text stays local: it can embed a URL/host/credential/path.
        message: 'Upstream unavailable at https://internal.example?key=sk-live',
        stack: 'Error: boom\n at secret.ts:1',
        url: 'https://internal.example/v1/chat?key=sk-live',
        requestBodyValues: { apiKey: 'sk-live' },
        responseHeaders: { authorization: 'Bearer sk-live' },
        responseBody: 'raw',
        providerId: 'local-conn'
      },
      language: 'typescript',
      sourceBlockId: 'b-main',
      sourceLanguage: 'en-US',
      targetLanguage: 'zh-CN',
      // Local-only / unsupported block payloads stay excluded.
      rawMcpToolResponse: { result: 'raw' },
      generateImageResponse: { images: [] },
      file: { path: '/Users/me/a.png' },
      url: 'file:///Users/me/a.png',
      l2AttachmentUnavailable: true,
      citationReferences: [{ citationBlockId: 'c-1' }],
      knowledgeBaseIds: ['kb-1']
    })
    expect(meta).toEqual({
      thinkingMs: 4321.5,
      error: {
        name: 'AI_APICallError',
        code: 'E_PROVIDER_UNAVAILABLE',
        statusCode: 503,
        i18nKey: 'error.request.timeout'
      },
      language: 'typescript',
      translation: { sourceBlockId: 'b-main', sourceLanguage: 'en-US', targetLanguage: 'zh-CN' }
    })
    const serialized = JSON.stringify(meta)
    expect(serialized).not.toContain('stack')
    expect(serialized).not.toContain('Upstream unavailable')
    expect(serialized).not.toContain('sk-live')
    expect(serialized).not.toContain('internal.example')
    expect(serialized).not.toContain('/Users/me')
    expect(dropped).toContain('error.message')
    expect(dropped).toContain('error.stack')
    expect(dropped).toContain('error.url')
    expect(dropped).toContain('error.providerId')
    expect(dropped).toContain('citationReferences')
    expect(dropped).toContain('knowledgeBaseIds')
  })

  it('rejects negative or non-finite thinking durations and never carries raw error blobs', () => {
    expect(extractBlockResultMeta({ thinking_millsec: -5 }).meta).toBeNull()
    expect(extractBlockResultMeta({ thinking_millsec: Number.POSITIVE_INFINITY }).meta).toBeNull()
    expect(extractBlockResultMeta({ error: { stack: 'only-stack' } }).meta).toBeNull()
  })

  it('never carries freeform error text or unsafe identifiers (URL/host/credential/path)', () => {
    const { meta, dropped } = extractBlockResultMeta({
      error: {
        name: 'https://internal.example/v1',
        code: 'sk-live-1234',
        i18nKey: '/Users/me/.ssh/id_rsa',
        status: 500,
        message: 'Bearer sk-live at https://internal.example'
      }
    })
    // Unsafe identifiers are dropped (never heuristic-redacted): a redacted
    // URL/credential is still unreliable content to transmit. Only the safe
    // numeric classification survives.
    expect(meta).toEqual({ error: { status: 500 } })
    expect(dropped).toEqual(expect.arrayContaining(['error.name', 'error.code', 'error.i18nKey', 'error.message']))
    const serialized = JSON.stringify(meta)
    expect(serialized).not.toContain('sk-live')
    expect(serialized).not.toContain('internal.example')
    expect(serialized).not.toContain('/Users/me')
    // A safe structured classification still crosses (token or numeric code).
    expect(
      extractBlockResultMeta({
        error: { name: 'AI_APICallError', code: 429, statusCode: 429, i18nKey: 'error.provider.rate_limit' }
      }).meta
    ).toEqual({
      error: { name: 'AI_APICallError', code: 429, statusCode: 429, i18nKey: 'error.provider.rate_limit' }
    })
  })
})

describe('strict wire validation', () => {
  it('accepts a sanitized container and explicit null', () => {
    expect(validateMessageResultMeta(null)).toBeNull()
    expect(validateMessageResultMeta({ usage: { prompt_tokens: 1, cost: 0.5 }, useful: false })).toBeNull()
    expect(
      validateBlockResultMeta({ thinkingMs: 0, language: 'ts', translation: { targetLanguage: 'zh-CN' } })
    ).toBeNull()
  })

  it('rejects numeric and unsafe-shape violations', () => {
    expect(validateMessageResultMeta({ usage: { prompt_tokens: '1' } })).toMatch(/prompt_tokens/)
    expect(validateMessageResultMeta({ usage: { prompt_tokens: -1 } })).toMatch(/prompt_tokens/)
    expect(validateMessageResultMeta({ usage: { total_tokens: 1.5 } })).toMatch(/total_tokens/)
    expect(validateMessageResultMeta({ metrics: { time_completion_millsec: -1 } })).toMatch(/time_completion_millsec/)
    expect(validateMessageResultMeta({ model: { id: 'm', provider: 'p' } })).toMatch(/unknown key "provider"/)
    expect(validateMessageResultMeta({ useful: 'true' })).toMatch(/useful/)
    expect(validateMessageResultMeta({ traceId: 't' })).toMatch(/unknown key "traceId"/)
    expect(validateBlockResultMeta({ thinkingMs: -1 })).toMatch(/thinkingMs/)
    expect(validateBlockResultMeta({ error: { stack: 'x' } })).toMatch(/unknown key "stack"/)
    expect(validateBlockResultMeta({ error: {} })).toMatch(/must not be empty/)
    expect(validateBlockResultMeta({ translation: {} })).toMatch(/must not be empty/)
    expect(validateBlockResultMeta({ knowledgeBaseIds: [] })).toMatch(/unknown key "knowledgeBaseIds"/)
  })

  it('rejects freeform error text and unsafe error identifiers on receive', () => {
    // Freeform `message` left the portable schema entirely.
    expect(validateBlockResultMeta({ error: { message: 'boom' } })).toMatch(/unknown key "message"/)
    expect(validateBlockResultMeta({ error: { name: 'AI_APICallError', message: 'boom' } })).toMatch(
      /unknown key "message"/
    )
    // name/code/i18nKey are bounded known-safe tokens: no URL, host, path,
    // credential, whitespace or raw payload can ride them.
    expect(validateBlockResultMeta({ error: { name: 'https://internal.example' } })).toMatch(/error.name/)
    expect(validateBlockResultMeta({ error: { code: '/Users/me/key' } })).toMatch(/error.code/)
    expect(validateBlockResultMeta({ error: { code: 'sk live token' } })).toMatch(/error.code/)
    expect(validateBlockResultMeta({ error: { i18nKey: 'error@host' } })).toMatch(/error.i18nKey/)
    expect(validateBlockResultMeta({ error: { name: 'x'.repeat(200) } })).toMatch(/error.name/)
    expect(validateBlockResultMeta({ error: { status: 503.5 } })).toMatch(/error.status/)
    // Safe structured classification is accepted (token + numeric code).
    expect(
      validateBlockResultMeta({
        error: { name: 'AI_APICallError', code: 'E_UPSTREAM', status: 500, statusCode: 503, i18nKey: 'error.x.y' }
      })
    ).toBeNull()
  })

  it('bounds container size and mention count', () => {
    const mentions = Array.from({ length: 65 }, (_, i) => ({ id: `model-${i}`, name: `M${i}` }))
    expect(validateMessageResultMeta({ mentions })).toMatch(/too many entries/)
    expect(validateBlockResultMeta({ error: { i18nKey: 'x'.repeat(200) } })).toMatch(/error.i18nKey/)
    expect(validateBlockResultMeta({ error: { message: 'x'.repeat(3000) } })).toMatch(/unknown key "message"/)
    const bigUsage = { prompt_tokens: 1 }
    expect(RESULT_META_MAX_JSON_BYTES).toBeGreaterThan(JSON.stringify(bigUsage).length)
  })
})

describe('atomic container merge into persisted extra', () => {
  it('replaces the portable subset and preserves unrelated local-only keys', () => {
    const localExtra = {
      usage: { total_tokens: 1 },
      metrics: { completion_tokens: 1 },
      traceId: 'local-trace',
      providerMetadata: { openai: { cached: 1 } },
      model: { id: 'm', provider: 'local-conn' }
    }
    const merged = mergeResultMetaIntoExtra('message', localExtra, { usage: { total_tokens: 9 }, useful: true })
    expect(merged).toEqual({
      usage: { total_tokens: 9 },
      useful: true,
      traceId: 'local-trace',
      providerMetadata: { openai: { cached: 1 } }
    })
  })

  it('null clears only the portable subset', () => {
    const merged = mergeResultMetaIntoExtra(
      'message',
      { usage: { total_tokens: 1 }, mentions: [{ id: 'm' }], traceId: 'keep-me' },
      null
    )
    expect(merged).toEqual({ traceId: 'keep-me' })
  })

  it('maps block keys onto their persisted extra names', () => {
    const merged = mergeResultMetaIntoExtra(
      'message_block',
      { thinking_millsec: 10, sourceBlockId: 'old', file: { path: '/tmp/x' } },
      { thinkingMs: 250, translation: { targetLanguage: 'ja-JP' } }
    )
    expect(merged).toEqual({
      thinking_millsec: 250,
      targetLanguage: 'ja-JP',
      file: { path: '/tmp/x' }
    })
    expect(mergeResultMetaIntoExtra('message_block', merged, null)).toEqual({ file: { path: '/tmp/x' } })
  })
})
