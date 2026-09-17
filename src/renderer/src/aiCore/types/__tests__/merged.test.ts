/**
 * Type Tests for Merged Provider Types
 *
 * Active execution retains ONLY the approved core adapters: official OpenAI
 * (chat + responses variants), generic OpenAI-compatible, Anthropic, and
 * Google/Gemini. Retired brand adapters must stay absent — brand ids never
 * select an SDK and must not be reintroduced for type compatibility.
 */

import { describe, expect, expectTypeOf, it } from 'vitest'

import type { AppProviderId, AppProviderSettingsMap } from '../merged'
import { appProviderIds, getAllProviderIds, isRegisteredProviderId } from '../merged'

const APPROVED_IDS = [
  'openai',
  'openai-chat',
  'openai-compatible',
  'openai-response',
  'anthropic',
  'claude',
  'google',
  'gemini',
  'google-ai',
  'google-gemini'
] as const

const RETIRED_IDS = [
  'azure',
  'azure-openai',
  'azure-responses',
  'azure-anthropic',
  'deepseek',
  'xai',
  'grok',
  'xai-responses',
  'openrouter',
  'tokenflux',
  'google-vertex',
  'vertexai',
  'google-vertex-anthropic',
  'vertexai-anthropic',
  'github-copilot-openai-compatible',
  'copilot',
  'github-copilot',
  'bedrock',
  'aws-bedrock',
  'perplexity',
  'mistral',
  'huggingface',
  'hf',
  'hugging-face',
  'gateway',
  'ai-gateway',
  'cerebras',
  'groq',
  'ollama',
  'aihubmix',
  'newapi',
  'new-api',
  'togetherai',
  'voyage',
  'voyageai'
] as const

describe('Unified Provider Types', () => {
  describe('appProviderIds literal access', () => {
    it('should resolve approved aliases and variants', () => {
      // 别名 → 基础名
      expectTypeOf(appProviderIds.claude).toEqualTypeOf<'anthropic'>()
      // 变体 → 自身（自反映射）
      expectTypeOf(appProviderIds['openai-chat']).toEqualTypeOf<'openai-chat'>()
    })
  })

  describe('AppProviderId - Approved adapters', () => {
    it('should include all approved core extension names', () => {
      type Check1 = 'openai' extends AppProviderId ? true : false
      type Check2 = 'anthropic' extends AppProviderId ? true : false
      type Check3 = 'google' extends AppProviderId ? true : false
      type Check4 = 'openai-compatible' extends AppProviderId ? true : false

      expectTypeOf<Check1>().toEqualTypeOf<true>()
      expectTypeOf<Check2>().toEqualTypeOf<true>()
      expectTypeOf<Check3>().toEqualTypeOf<true>()
      expectTypeOf<Check4>().toEqualTypeOf<true>()
    })

    it('should include approved aliases', () => {
      type Check1 = 'claude' extends AppProviderId ? true : false
      type Check2 = 'gemini' extends AppProviderId ? true : false
      type Check3 = 'openai-response' extends AppProviderId ? true : false

      expectTypeOf<Check1>().toEqualTypeOf<true>()
      expectTypeOf<Check2>().toEqualTypeOf<true>()
      expectTypeOf<Check3>().toEqualTypeOf<true>()
    })

    // NOTE: AppProviderId is intentionally open (`KnownId | (string & {})`) so
    // that brand gateways and manually added entries stay requestable through
    // generic OpenAI-compatible. Retired-adapter absence is therefore asserted
    // at runtime below (isRegisteredProviderId / getAllProviderIds), not at
    // the type level.
  })

  describe('Registered registry (runtime)', () => {
    it('should register approved IDs', () => {
      for (const id of APPROVED_IDS) {
        expect(isRegisteredProviderId(id)).toBe(true)
      }
      const all = getAllProviderIds()
      for (const id of APPROVED_IDS) {
        expect(all).toContain(id)
      }
    })

    it('should not register retired adapters', () => {
      for (const id of RETIRED_IDS) {
        expect(isRegisteredProviderId(id)).toBe(false)
      }
      const all = getAllProviderIds()
      for (const id of RETIRED_IDS) {
        expect(all).not.toContain(id)
      }
    })
  })

  describe('AppProviderId', () => {
    it('should accept string for dynamic providers', () => {
      type Check = string extends AppProviderId ? true : false
      expectTypeOf<Check>().toEqualTypeOf<true>()
    })
  })

  describe('AppProviderSettingsMap', () => {
    it('should map approved provider IDs to their settings', () => {
      // OpenAI settings should have OpenAI-specific fields
      type OpenAISettings = AppProviderSettingsMap['openai']
      type HasBaseURL = 'baseURL' extends keyof OpenAISettings ? true : false
      type HasApiKey = 'apiKey' extends keyof OpenAISettings ? true : false

      expectTypeOf<HasBaseURL>().toEqualTypeOf<true>()
      expectTypeOf<HasApiKey>().toEqualTypeOf<true>()
    })

    it('should map aliases to same settings as main ID', () => {
      // Anthropic alias should share settings
      type AnthropicByName = AppProviderSettingsMap['anthropic']
      type AnthropicByAlias = AppProviderSettingsMap['claude']

      expectTypeOf<AnthropicByName>().toEqualTypeOf<AnthropicByAlias>()

      // Google aliases should share settings
      type GoogleByName = AppProviderSettingsMap['google']
      type GoogleByAlias = AppProviderSettingsMap['gemini']

      expectTypeOf<GoogleByName>().toEqualTypeOf<GoogleByAlias>()
    })
  })
})
