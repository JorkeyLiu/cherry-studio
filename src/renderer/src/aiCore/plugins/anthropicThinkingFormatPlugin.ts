/**
 * Generic Anthropic thinking-format middleware (enabled <-> adaptive).
 *
 * No model-name predicate participates: prepare-params keeps emitting its
 * legacy default shape and this middleware only reacts to an explicit
 * thinking-type HTTP400 rejection for the shape that was actually sent. It
 * retries the same logical request once with the alternate shape and, only
 * after that alternate request succeeds, records the learned dialect for the
 * exact connection endpoint + raw serving model id. Later requests send the
 * learned shape directly (recomputed per request from the current
 * reasoning_effort, so strength changes are never replayed stale).
 *
 * Topology: registered before simulateStreaming (outer after reversal), so
 * both generate and stream execution are protected and the inner Anthropic
 * caching middleware sees converted options. Retries resend through the
 * inner `model.doStream/doGenerate`, which reaches inner wrappers without
 * reapplying outer transforms. One retry budget per middleware instance is
 * shared across tool steps and generate/stream calls.
 */
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult
} from '@ai-sdk/provider'
import { definePlugin } from '@cherrystudio/ai-core'
import { loggerService } from '@logger'
import type { Assistant, Model, Provider } from '@renderer/types'
import type { JSONValue, LanguageModelMiddleware } from 'ai'

import {
  type AnthropicThinkingBucket,
  type AnthropicThinkingDialect,
  buildThinkingScopeKey,
  classifyThinkingRejection,
  evictLearnedDialect,
  hasExplicitThinkingCustomParams,
  isNegotiableReasoningEffort,
  readLearnedDialect,
  toAdaptiveBucket,
  toAdaptiveEffortPlan,
  toEnabledBucket,
  writeLearnedDialect
} from '../utils/anthropicThinkingDialect'
import { getFallbackBudgetTokens } from '../utils/reasoning'

const logger = loggerService.withContext('anthropicThinkingFormat')

/** SDK add-back default when an enabled request carries no explicit budget. */
const SDK_DEFAULT_BUDGET_TOKENS = 1024

export interface AnthropicThinkingFormatPluginOptions {
  provider: Provider
  model: Model
  assistant: Assistant
}

function readBucket(params: LanguageModelV3CallOptions): AnthropicThinkingBucket | null {
  const providerOptions = params.providerOptions as Record<string, unknown> | undefined
  const bucket = providerOptions?.['anthropic']
  if (typeof bucket !== 'object' || bucket === null) return null
  return bucket as AnthropicThinkingBucket
}

function readThinkingType(bucket: AnthropicThinkingBucket): 'enabled' | 'adaptive' | null {
  const type = bucket.thinking?.type
  return type === 'enabled' || type === 'adaptive' ? type : null
}

function readAbortSignal(params: LanguageModelV3CallOptions): AbortSignal | undefined {
  try {
    // Duck-typed (never instanceof): the signal may come from another realm.
    const signal = (params as { abortSignal?: unknown }).abortSignal as AbortSignal | undefined
    return signal && typeof signal.aborted === 'boolean' ? signal : undefined
  } catch {
    return undefined
  }
}

interface ConvertedSend {
  params: LanguageModelV3CallOptions
  dialect: AnthropicThinkingDialect
}

/**
 * enabled -> adaptive. The wire total must not change: the SDK sends
 * max_tokens = maxOutputTokens (+ SDK default) + budget for enabled but no
 * add-back for adaptive, so the recovered total becomes the adaptive
 * maxOutputTokens. An undefined maxOutputTokens keeps SDK-default semantics.
 */
function convertToAdaptive(
  params: LanguageModelV3CallOptions,
  bucket: AnthropicThinkingBucket,
  plan: { mode: 'level'; effort: 'low' | 'medium' | 'high' | 'xhigh' } | { mode: 'auto' }
): ConvertedSend {
  const nextBucket = toAdaptiveBucket(bucket, plan)
  const budget = bucket.thinking?.budgetTokens ?? SDK_DEFAULT_BUDGET_TOKENS
  const maxOutputTokens = params.maxOutputTokens === undefined ? undefined : params.maxOutputTokens + budget
  return {
    params: {
      ...params,
      maxOutputTokens,
      providerOptions: { ...params.providerOptions, anthropic: nextBucket as unknown as Record<string, JSONValue> }
    },
    dialect: 'adaptive'
  }
}

/**
 * adaptive -> enabled. Uses ONLY the generic fallback budget for the current
 * reasoning_effort (no model-id lookup, no token maps, no numeric inference
 * from budgets). When the wire total is defined, bounds the budget to
 * <= total-1 with >= 1024 and subtracts it so the SDK add-back restores the
 * same wire total. Returns null when no valid budget exists (the original
 * error is then preserved instead of emitting invalid budgets). An undefined
 * maxOutputTokens keeps SDK-default semantics with no invented hard cap.
 */
function convertToEnabled(
  params: LanguageModelV3CallOptions,
  bucket: AnthropicThinkingBucket,
  assistant: Assistant
): ConvertedSend | null {
  const effort = assistant?.settings?.reasoning_effort
  const candidate = getFallbackBudgetTokens(effort)
  const total = params.maxOutputTokens
  if (total === undefined) {
    const nextBucket = toEnabledBucket(bucket, candidate)
    if (!nextBucket) return null
    return {
      params: {
        ...params,
        providerOptions: { ...params.providerOptions, anthropic: nextBucket as unknown as Record<string, JSONValue> }
      },
      dialect: 'enabled'
    }
  }
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= SDK_DEFAULT_BUDGET_TOKENS) return null
  const bounded = Math.min(Math.floor(candidate), Math.floor(total) - 1)
  if (!(bounded >= SDK_DEFAULT_BUDGET_TOKENS)) return null
  const nextBucket = toEnabledBucket(bucket, bounded)
  if (!nextBucket) return null
  return {
    params: {
      ...params,
      maxOutputTokens: total - bounded,
      providerOptions: { ...params.providerOptions, anthropic: nextBucket as unknown as Record<string, JSONValue> }
    },
    dialect: 'enabled'
  }
}

/**
 * Single-pass stream observer. Passes every part through untouched (no tee,
 * no extra consumption) and reports success only after a valid terminal
 * finish part AND successful stream closure, with no error part, no read
 * rejection, no cancellation, and no aborted signal. A 200 alone, a stream
 * error/cancel, or a missing finish never commits.
 */
function observeThinkingStream(
  stream: ReadableStream<LanguageModelV3StreamPart>,
  onClose: (ok: boolean) => void,
  signal: AbortSignal | undefined
): ReadableStream<LanguageModelV3StreamPart> {
  let seenFinish = false
  let invalid = false
  const finish = (ok: boolean) => {
    try {
      onClose(ok && !signal?.aborted)
    } catch {
      // Commit is guarded internally; never break the stream here.
    }
  }
  return stream.pipeThrough(
    new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
      transform(chunk, controller) {
        try {
          if (chunk?.type === 'finish') {
            if (chunk.finishReason?.unified && chunk.finishReason.unified !== 'error') seenFinish = true
            else invalid = true
          } else if (chunk?.type === 'error') {
            invalid = true
          }
          controller.enqueue(chunk)
        } catch (error) {
          invalid = true
          throw error
        }
      },
      flush() {
        finish(seenFinish && !invalid)
      }
      // No cancel trap: a cancelled or errored pipe never reaches flush, so
      // no commit can happen on those paths by construction.
    })
  )
}

export const createAnthropicThinkingFormatPlugin = ({
  provider,
  model,
  assistant
}: AnthropicThinkingFormatPluginOptions) => {
  // One retry budget per logical completions request, shared across tool
  // steps and generate/stream calls.
  let retryUsed = false
  let scopeKeyPromise: Promise<string | null> | null = null

  const getScopeKey = (): Promise<string | null> => {
    if (!scopeKeyPromise) {
      scopeKeyPromise = buildThinkingScopeKey({ provider, modelId: model.id }).catch(() => null)
    }
    return scopeKeyPromise
  }

  const commitSuccess = (scopeKey: string | null, pendingLearn: AnthropicThinkingDialect | null): void => {
    if (!scopeKey || !pendingLearn) return
    try {
      if (readLearnedDialect(scopeKey) !== pendingLearn) {
        writeLearnedDialect(scopeKey, pendingLearn)
        logger.debug('Learned thinking dialect', { learned: true, dialect: pendingLearn })
      }
    } catch {
      // Fail open: the record must never break chat.
    }
  }

  interface ResolvedSend {
    /** Params to send (identical reference to input when unconverted). */
    send: LanguageModelV3CallOptions
    converted: boolean
    /** Thinking shape being sent; null = passthrough, never negotiated. */
    sentType: 'enabled' | 'adaptive' | null
    /** Dialect to commit on success (set only when the send was converted). */
    pendingLearn: AnthropicThinkingDialect | null
    scopeKey: string | null
  }

  const resolveSend = async (params: LanguageModelV3CallOptions): Promise<ResolvedSend> => {
    const idle: ResolvedSend = { send: params, converted: false, sentType: null, pendingLearn: null, scopeKey: null }
    const bucket = readBucket(params)
    const initialType = bucket ? readThinkingType(bucket) : null
    // default (absent) and none/disabled are never negotiated or reinterpreted.
    if (!bucket || !initialType) return idle
    // Explicit user-controlled thinking values always win: opt out entirely.
    if (hasExplicitThinkingCustomParams(assistant?.settings?.customParameters)) return idle
    const effort = assistant?.settings?.reasoning_effort
    if (!isNegotiableReasoningEffort(effort)) return idle

    const scopeKey = await getScopeKey()
    // New default comes from the builder as adaptive; a learned hint for a
    // cached contradiction (or an explicitly seeded valid mode in tests) may
    // still convert the first leg. Otherwise the builder shape sends as-is.
    const learned = scopeKey ? readLearnedDialect(scopeKey) : undefined
    const target = learned ?? initialType
    if (target === initialType) {
      return { ...idle, sentType: initialType, scopeKey }
    }
    const plan = toAdaptiveEffortPlan(effort)
    const converted =
      target === 'adaptive'
        ? plan.mode === 'off'
          ? null
          : convertToAdaptive(params, bucket, plan)
        : convertToEnabled(params, bucket, assistant)
    if (!converted) return { ...idle, sentType: initialType, scopeKey }
    return { send: converted.params, converted: true, sentType: target, pendingLearn: target, scopeKey }
  }

  const resolveRetry = (
    params: LanguageModelV3CallOptions,
    resolved: ResolvedSend,
    error: unknown
  ): ConvertedSend | null => {
    if (retryUsed || !resolved.sentType) return null
    const originalSignal = readAbortSignal(params)
    if (originalSignal?.aborted) return null
    const rejection = classifyThinkingRejection(error, resolved.sentType)
    if (!rejection) return null
    // Invert the shape that was actually sent. When a learned hint converted
    // the first leg, resolved.send carries the converted bucket/totals;
    // converting the original params would double-count or default the budget.
    const sent = resolved.send
    const bucket = readBucket(sent)
    if (!bucket) return null
    const effort = assistant?.settings?.reasoning_effort
    const preserveSignal = (converted: ConvertedSend | null): ConvertedSend | null => {
      if (converted && originalSignal && readAbortSignal(converted.params) !== originalSignal) {
        ;(converted.params as { abortSignal?: unknown }).abortSignal = originalSignal
      }
      return converted
    }
    if (resolved.sentType === 'enabled') {
      const plan = toAdaptiveEffortPlan(effort)
      if (plan.mode === 'off') return null
      return preserveSignal(convertToAdaptive(sent, bucket, plan))
    }
    if (!isNegotiableReasoningEffort(effort)) return null
    return preserveSignal(convertToEnabled(sent, bucket, assistant))
  }

  const middleware: LanguageModelMiddleware = {
    specificationVersion: 'v3',

    wrapGenerate: async ({ params, model: innerModel, doGenerate }) => {
      const resolved = await resolveSend(params)
      if (!resolved.sentType) return doGenerate()
      try {
        const result = resolved.converted ? await innerModel.doGenerate(resolved.send) : await doGenerate()
        if (result.finishReason?.unified !== 'error') {
          commitSuccess(resolved.scopeKey, resolved.pendingLearn)
        }
        return result
      } catch (error) {
        const alternate = resolveRetry(params, resolved, error)
        if (!alternate) throw error
        retryUsed = true
        // The rejected shape was the learned hint: evict the stale record,
        // then allow exactly one alternate. Only a success overwrites.
        if (resolved.pendingLearn && resolved.scopeKey) evictLearnedDialect(resolved.scopeKey)
        logger.debug('Retrying with alternate thinking dialect', { alternate: alternate.dialect })
        const result = await innerModel.doGenerate(alternate.params)
        if (result.finishReason?.unified !== 'error') {
          commitSuccess(resolved.scopeKey, alternate.dialect)
        }
        return result
      }
    },

    wrapStream: async ({ params, model: innerModel, doStream }) => {
      const resolved = await resolveSend(params)
      if (!resolved.sentType) return doStream()
      const observe = (
        result: LanguageModelV3StreamResult,
        pendingLearn: AnthropicThinkingDialect | null
      ): LanguageModelV3StreamResult => {
        if (!(result.stream instanceof ReadableStream) || typeof result.stream.pipeThrough !== 'function') {
          return result
        }
        return {
          ...result,
          stream: observeThinkingStream(
            result.stream,
            (ok) => {
              if (ok) commitSuccess(resolved.scopeKey, pendingLearn)
            },
            readAbortSignal(params)
          )
        }
      }
      try {
        const result = resolved.converted ? await innerModel.doStream(resolved.send) : await doStream()
        return observe(result, resolved.pendingLearn)
      } catch (error) {
        const alternate = resolveRetry(params, resolved, error)
        if (!alternate) throw error
        retryUsed = true
        if (resolved.pendingLearn && resolved.scopeKey) evictLearnedDialect(resolved.scopeKey)
        logger.debug('Retrying stream with alternate thinking dialect', { alternate: alternate.dialect })
        const result = await innerModel.doStream(alternate.params)
        return observe(result, alternate.dialect)
      }
    }
  }

  return definePlugin({
    name: 'anthropicThinkingFormat',
    enforce: 'pre',
    configureContext: (context) => {
      context.middlewares = context.middlewares || []
      context.middlewares.push(middleware)
    }
  })
}
