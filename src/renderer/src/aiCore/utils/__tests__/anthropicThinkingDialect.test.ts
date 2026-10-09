/**
 * Unit tests for the generic Anthropic thinking-dialect helpers.
 *
 * All model ids are opaque and arbitrary: no brand/family/version meaning is
 * attached to any name, and none of the assertions depend on one.
 */
import { APICallError } from 'ai'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  buildThinkingScopeKey,
  classifyThinkingRejection,
  evictLearnedDialect,
  hasExplicitThinkingCustomParams,
  isNegotiableReasoningEffort,
  normalizeHostUrl,
  readLearnedDialect,
  sha256Hex,
  THINKING_DIALECT_STORAGE_KEY,
  toAdaptiveBucket,
  toAdaptiveEffortPlan,
  toEnabledBucket,
  writeLearnedDialect
} from '../anthropicThinkingDialect'

function scopeInput(overrides: Record<string, any> = {}) {
  return {
    provider: {
      id: 'conn-opaque-1',
      type: 'anthropic',
      apiHost: 'https://api.example.com/',
      apiKey: 'sk-secret-1',
      apiVersion: undefined,
      extra_headers: undefined,
      ...overrides.provider
    },
    modelId: 'router-opaque-7f2a',
    ...overrides
  }
}

function apiError(statusCode: number, body: unknown, messageSuffix = ''): unknown {
  const responseBody = typeof body === 'string' ? body : JSON.stringify(body)
  return new APICallError({
    message: `API call failed${messageSuffix}`,
    url: 'https://api.example.com/v1/messages',
    requestBodyValues: {},
    statusCode,
    responseHeaders: {},
    responseBody,
    data: typeof body === 'string' ? undefined : (body as Record<string, unknown>),
    isRetryable: false
  })
}

const ENABLED_REJECTED_MESSAGE =
  "thinking.type 'enabled' is not supported for this model. Use thinking.type 'adaptive' with output_config.effort instead."
const GATEWAY_ENABLED_REJECTED_MESSAGE =
  'Upstream request failed: [invalid_request_error] thinking.type "enabled" is not supported for this model; use adaptive thinking with output_config.effort.'
const ADAPTIVE_REJECTED_MESSAGE =
  "adaptive thinking is not supported for model 'router-opaque-7f2a'. Use thinking.type 'enabled' with budget_tokens instead."

function invalidRequestError(message: string) {
  return { type: 'error', error: { type: 'invalid_request_error', message } }
}

describe('anthropicThinkingDialect', () => {
  beforeEach(() => {
    localStorage.removeItem(THINKING_DIALECT_STORAGE_KEY)
  })

  describe('toAdaptiveEffortPlan', () => {
    it.each([
      { effort: 'low', expected: { mode: 'level', effort: 'low' } },
      { effort: 'medium', expected: { mode: 'level', effort: 'medium' } },
      { effort: 'high', expected: { mode: 'level', effort: 'high' } },
      { effort: 'xhigh', expected: { mode: 'level', effort: 'xhigh' } },
      { effort: 'auto', expected: { mode: 'auto' } }
    ])('maps $effort', ({ effort, expected }) => {
      expect(toAdaptiveEffortPlan(effort as never)).toEqual(expected)
    })

    it.each([{ effort: undefined }, { effort: 'default' }, { effort: 'none' }, { effort: 'minimal' }])(
      'stays off for $effort (never negotiated)',
      ({ effort }) => {
        expect(toAdaptiveEffortPlan(effort as never)).toEqual({ mode: 'off' })
      }
    )
  })

  describe('isNegotiableReasoningEffort', () => {
    it.each([{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'auto' }])(
      'negotiates $effort',
      ({ effort }) => {
        expect(isNegotiableReasoningEffort(effort as never)).toBe(true)
      }
    )

    it.each([{ effort: undefined }, { effort: 'default' }, { effort: 'none' }, { effort: 'minimal' }])(
      'does not negotiate $effort',
      ({ effort }) => {
        expect(isNegotiableReasoningEffort(effort as never)).toBe(false)
      }
    )
  })

  describe('learned-dialect record', () => {
    it('round-trips a learned dialect for an opaque scope key', async () => {
      const key = await buildThinkingScopeKey(scopeInput())
      expect(readLearnedDialect(key)).toBeUndefined()
      writeLearnedDialect(key, 'adaptive')
      expect(readLearnedDialect(key)).toBe('adaptive')
      evictLearnedDialect(key)
      expect(readLearnedDialect(key)).toBeUndefined()
    })

    it('persists across reads and holds no raw connection values', async () => {
      const key = await buildThinkingScopeKey(scopeInput())
      writeLearnedDialect(key, 'adaptive')
      const raw = localStorage.getItem(THINKING_DIALECT_STORAGE_KEY)
      expect(raw).toBeTruthy()
      expect(raw).toContain('adaptive')
      for (const secret of ['router-opaque-7f2a', 'sk-secret-1', 'api.example.com', 'conn-opaque-1']) {
        expect(raw).not.toContain(secret)
      }
      // Opaque digest keys only.
      const parsed = JSON.parse(raw as string)
      expect(Object.keys(parsed.entries)).toEqual([key])
      expect(key).toMatch(/^[0-9a-f]{64}$/)
    })

    it('isolates endpoint, model, auth, and header scopes', async () => {
      const base = scopeInput()
      const variants = [
        scopeInput({ provider: { ...base.provider, apiHost: 'https://other.example.net' } }),
        scopeInput({ modelId: 'router-opaque-bb91' }),
        scopeInput({ provider: { ...base.provider, apiKey: 'sk-secret-2' } }),
        scopeInput({ provider: { ...base.provider, extra_headers: { 'x-route': 'a' } } })
      ]
      const baseKey = await buildThinkingScopeKey(base)
      const keys = new Set([baseKey])
      for (const variant of variants) {
        keys.add(await buildThinkingScopeKey(variant))
      }
      expect(keys.size).toBe(1 + variants.length)
    })

    it('ignores surrounding slashes/case when normalizing hosts', () => {
      expect(normalizeHostUrl('https://api.example.com/')).toBe('https://api.example.com')
      expect(normalizeHostUrl('HTTPS://API.EXAMPLE.COM/v1/')).toBe('https://api.example.com/v1')
    })

    it('fails open on corrupt storage', async () => {
      localStorage.setItem(THINKING_DIALECT_STORAGE_KEY, 'not-json{{{')
      const key = await buildThinkingScopeKey(scopeInput())
      expect(readLearnedDialect(key)).toBeUndefined()
      writeLearnedDialect(key, 'enabled')
      expect(readLearnedDialect(key)).toBe('enabled')
    })

    it('clears schema mismatches instead of misreading them', () => {
      localStorage.setItem(THINKING_DIALECT_STORAGE_KEY, JSON.stringify({ version: 999, entries: { x: 'adaptive' } }))
      expect(readLearnedDialect('x')).toBeUndefined()
      expect(localStorage.getItem(THINKING_DIALECT_STORAGE_KEY)).toBeNull()
    })
  })

  describe('sha256Hex', () => {
    it('hashes deterministically', async () => {
      expect(await sha256Hex('abc')).toBe(await sha256Hex('abc'))
      expect(await sha256Hex('abc')).toMatch(/^[0-9a-f]{64}$/)
      expect(await sha256Hex('abc')).not.toBe(await sha256Hex('abd'))
    })
  })

  describe('hasExplicitThinkingCustomParams', () => {
    it('opts out for explicit thinking/effort/output_config/budget keys', () => {
      for (const name of ['thinking', 'effort', 'output_config', 'budget_tokens', 'taskBudget']) {
        expect(hasExplicitThinkingCustomParams([{ name, value: 'x', type: 'string' }])).toBe(true)
      }
    })

    it('opts out for the same keys nested under the anthropic bucket', () => {
      expect(hasExplicitThinkingCustomParams([{ name: 'anthropic', value: { effort: 'high' }, type: 'json' }])).toBe(
        true
      )
      expect(
        hasExplicitThinkingCustomParams([
          { name: 'anthropic', value: JSON.stringify({ thinking: { type: 'adaptive' } }), type: 'json' }
        ])
      ).toBe(true)
    })

    it('does not opt out for unrelated fields', () => {
      expect(
        hasExplicitThinkingCustomParams([
          { name: 'temperature', value: 0.5, type: 'number' },
          { name: 'anthropic', value: { cacheControl: { type: 'ephemeral' } }, type: 'json' },
          { name: 'gateway', value: { order: ['a'] }, type: 'json' },
          { name: '  ', value: 'x', type: 'string' }
        ])
      ).toBe(false)
      expect(hasExplicitThinkingCustomParams(undefined)).toBe(false)
    })
  })

  describe('classifyThinkingRejection', () => {
    it('matches an explicit enabled rejection for the sent enabled shape', () => {
      const error = apiError(400, invalidRequestError(ENABLED_REJECTED_MESSAGE))
      expect(classifyThinkingRejection(error, 'enabled')).toBe('enabled-rejected')
    })

    it('matches the gateway-prefixed enabled rejection', () => {
      const error = apiError(400, invalidRequestError(GATEWAY_ENABLED_REJECTED_MESSAGE))
      expect(classifyThinkingRejection(error, 'enabled')).toBe('enabled-rejected')
    })

    it('matches an adaptive rejection for the sent adaptive shape', () => {
      const error = apiError(400, invalidRequestError(ADAPTIVE_REJECTED_MESSAGE))
      expect(classifyThinkingRejection(error, 'adaptive')).toBe('adaptive-rejected')
    })

    it('matches the documented bare standard adaptive rejection without a recommendation', () => {
      const bare = 'adaptive thinking is not supported on this model'
      const error = apiError(400, invalidRequestError(bare))
      expect(classifyThinkingRejection(error, 'adaptive')).toBe('adaptive-rejected')
      expect(classifyThinkingRejection(error, 'enabled')).toBeNull()
    })

    it('matches an explicit quoted thinking.type adaptive subject with an enabled recommendation', () => {
      const quoted =
        "thinking.type 'adaptive' is not supported for this model. Use thinking.type 'enabled' with budget_tokens instead."
      const error = apiError(400, invalidRequestError(quoted))
      expect(classifyThinkingRejection(error, 'adaptive')).toBe('adaptive-rejected')
      expect(classifyThinkingRejection(error, 'enabled')).toBeNull()
    })

    it('matches a gateway-prefixed adaptive rejection wrapping the precise clause', () => {
      const wrapped =
        "Upstream request failed: [invalid_request_error] adaptive thinking is not supported for model 'router-opaque-7f2a'. Use thinking.type 'enabled' with budget_tokens instead."
      const error = apiError(400, invalidRequestError(wrapped))
      expect(classifyThinkingRejection(error, 'adaptive')).toBe('adaptive-rejected')
    })

    it('stays transparent for misleading adaptive/budget/tool and non-thinking unsupported messages', () => {
      const misleading = [
        'thinking.budget_tokens (50000) must be less than max_tokens (4096) for adaptive mode.',
        'adaptive tool use is not supported for this model.',
        'adaptive mode is unsupported for this model.',
        'thinking is not supported for this model.',
        'A maximum of 4 thinking blocks is allowed for adaptive requests.'
      ]
      for (const message of misleading) {
        expect(classifyThinkingRejection(apiError(400, invalidRequestError(message)), 'adaptive')).toBeNull()
        expect(classifyThinkingRejection(apiError(400, invalidRequestError(message)), 'enabled')).toBeNull()
      }
    })

    it('requires agreement between the rejected and sent shapes', () => {
      const enabledError = apiError(400, invalidRequestError(ENABLED_REJECTED_MESSAGE))
      expect(classifyThinkingRejection(enabledError, 'adaptive')).toBeNull()
      const adaptiveError = apiError(400, invalidRequestError(ADAPTIVE_REJECTED_MESSAGE))
      expect(classifyThinkingRejection(adaptiveError, 'enabled')).toBeNull()
    })

    it('stays transparent for budget/validation messages without the recommendation clause', () => {
      const budgetError = apiError(
        400,
        invalidRequestError('thinking.budget_tokens (50000) must be less than max_tokens (4096).')
      )
      expect(classifyThinkingRejection(budgetError, 'enabled')).toBeNull()
      const contentError = apiError(400, invalidRequestError('A maximum of 4 thinking blocks is allowed.'))
      expect(classifyThinkingRejection(contentError, 'adaptive')).toBeNull()
    })

    it('stays transparent for non-400, wrong-type, malformed, and non-API errors', () => {
      expect(
        classifyThinkingRejection(apiError(401, invalidRequestError(ENABLED_REJECTED_MESSAGE)), 'enabled')
      ).toBeNull()
      expect(
        classifyThinkingRejection(apiError(429, invalidRequestError(ENABLED_REJECTED_MESSAGE)), 'enabled')
      ).toBeNull()
      expect(
        classifyThinkingRejection(apiError(500, invalidRequestError(ENABLED_REJECTED_MESSAGE)), 'enabled')
      ).toBeNull()
      expect(
        classifyThinkingRejection(
          apiError(400, { type: 'error', error: { type: 'authentication_error', message: ENABLED_REJECTED_MESSAGE } }),
          'enabled'
        )
      ).toBeNull()
      expect(classifyThinkingRejection(apiError(400, 'not json{{{', ' plain'), 'enabled')).toBeNull()
      expect(classifyThinkingRejection(new TypeError('fetch failed'), 'enabled')).toBeNull()
      const bare = { statusCode: 400, data: invalidRequestError(ENABLED_REJECTED_MESSAGE) }
      expect(classifyThinkingRejection(bare, 'enabled')).toBeNull()
    })
  })

  describe('bucket conversions', () => {
    it('converts enabled to adaptive, dropping budget/sendReasoning and keeping the rest', () => {
      const next = toAdaptiveBucket(
        {
          thinking: { type: 'enabled', budgetTokens: 2000 },
          sendReasoning: true,
          cacheControl: { type: 'ephemeral' }
        },
        { mode: 'level', effort: 'high' }
      )
      expect(next).toEqual({
        thinking: { type: 'adaptive' },
        effort: 'high',
        cacheControl: { type: 'ephemeral' }
      })
    })

    it('omits effort for auto', () => {
      const next = toAdaptiveBucket({ thinking: { type: 'enabled', budgetTokens: 2000 } }, { mode: 'auto' })
      expect(next).toEqual({ thinking: { type: 'adaptive' } })
    })

    it('converts adaptive to enabled, dropping display/effort and keeping the rest', () => {
      const next = toEnabledBucket(
        {
          thinking: { type: 'adaptive', display: 'summarized' },
          effort: 'high',
          metadata: { userId: 'u' }
        },
        2000
      )
      expect(next).toEqual({
        thinking: { type: 'enabled', budgetTokens: 2000 },
        metadata: { userId: 'u' }
      })
    })

    it('refuses invalid budgets instead of emitting them', () => {
      expect(toEnabledBucket({ thinking: { type: 'adaptive' } }, undefined)).toBeNull()
      expect(toEnabledBucket({ thinking: { type: 'adaptive' } }, 512)).toBeNull()
    })
  })
})
