import { loggerService } from '@logger'

import { retryModelMetadataAfterProxyApplied } from './modelMetadata'

const logger = loggerService.withContext('ProxyMetadataRetry')

/**
 * Apply the configured proxy, then run one bounded metadata recovery.
 *
 * Fresh-cache boot fetches models.dev before the app-init proxy effect
 * applies the proxy, so a cold failure settles `unavailable` with a null
 * snapshot. Once the `App_Proxy` promise resolves, a cold failure gets
 * exactly one retry via `retryModelMetadataAfterProxyApplied` (which awaits
 * the prior init round and skips ready snapshots). Best-effort and never
 * throws: a `setProxy` rejection skips the retry, and startup stays
 * nonblocking. No polling, no alias heuristics, no UI strings.
 */
export async function applyProxyAndRetryModelMetadata(args: {
  proxyMode: string
  proxyUrl?: string
  proxyBypassRules?: string
}): Promise<void> {
  let applied = false
  try {
    if (args.proxyMode === 'system') {
      await window.api.setProxy('system', undefined)
      applied = true
    } else if (args.proxyMode === 'custom') {
      if (!args.proxyUrl) return
      await window.api.setProxy(args.proxyUrl, args.proxyBypassRules)
      applied = true
    } else {
      await window.api.setProxy('', undefined)
      applied = true
    }
  } catch (error) {
    logger.warn('proxy apply failed; skipping model metadata retry', error as Error)
    return
  }
  if (!applied) return
  try {
    await retryModelMetadataAfterProxyApplied()
  } catch (error) {
    logger.warn('model metadata post-proxy retry failed', error as Error)
  }
}
