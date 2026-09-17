/**
 * Active rerank capability config.
 * Relocated from the retired `config/providers.ts` catalog so migration
 * history stays isolated. Values unchanged: local Ollama/LM Studio entries
 * do not offer rerank models in RAG compression settings.
 */
import type { SystemProviderId } from '@renderer/types'

export const NOT_SUPPORTED_RERANK_PROVIDERS = ['ollama', 'lmstudio'] as const satisfies SystemProviderId[]
