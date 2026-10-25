/**
 * Chat projection invalidation broadcast — Main → all renderer windows.
 *
 * Post-commit HINT only (never data authority): carries stable assistant /
 * topic / branch IDs resolved from the committed authority, never contents
 * or optimistic metadata. Renderers consume the FULL directory via the
 * read-only `chatdb:list-live-assistant-topics` API (PROJ-10) and reload
 * only the currently selected resident route via the existing windowed read.
 * Empty topicIds is a legal coarse per-assistant refresh (directory only,
 * never message history). Failures and empty scopes never broadcast.
 */

import { loggerService } from '@logger'
import type { ChatProjectionInvalidationEvent } from '@shared/chatDb'
import type { HistoryReferenceInvalidationEvent } from '@shared/chatDb'
import { validateChatProjectionInvalidationEvent } from '@shared/chatDb'
import { IpcChannel } from '@shared/IpcChannel'
import { BrowserWindow } from 'electron'

const logger = loggerService.withContext('ChatProjectionBroadcast')

function dedup(ids: unknown): string[] {
  if (!Array.isArray(ids)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * Best-effort broadcast to every live renderer window. Never throws.
 * Invalid or empty-assistant payloads are discarded (fail-closed, no send).
 * Local-commit callers pass the originating `excludeWebContentsId` so the
 * origin — which already observes its own write via the Redux projection —
 * never receives a redundant forced-reload hint; every other window still
 * receives the hint. Failed/empty scopes never broadcast.
 */
export function broadcastChatProjectionInvalidation(
  event: ChatProjectionInvalidationEvent,
  opts?: { excludeWebContentsId?: number }
): void {
  let payload: ChatProjectionInvalidationEvent
  try {
    payload = {
      assistantIds: dedup(event.assistantIds),
      topicIds: dedup(event.topicIds),
      branchIds: dedup(event.branchIds),
      reason: event.reason
    }
  } catch {
    return
  }
  if (payload.assistantIds.length === 0) return
  try {
    validateChatProjectionInvalidationEvent(payload)
  } catch {
    logger.warn('[broadcastChatProjection] invalid payload, skipping broadcast')
    return
  }
  let wins: Array<{
    isDestroyed: () => boolean
    webContents?: { id?: number; isDestroyed: () => boolean; send: (...a: unknown[]) => void }
  }>
  try {
    wins = BrowserWindow.getAllWindows() as unknown as typeof wins
  } catch {
    return
  }
  if (!Array.isArray(wins)) return
  const excluded = typeof opts?.excludeWebContentsId === 'number' ? opts.excludeWebContentsId : null
  for (const win of wins) {
    try {
      if (!win || win.isDestroyed()) continue
      const wc = win.webContents
      if (!wc || wc.isDestroyed()) continue
      if (excluded !== null && typeof wc.id === 'number' && wc.id === excluded) continue
      wc.send(IpcChannel.ChatDb_ChatProjectionInvalidated, payload)
    } catch {
      // best-effort, never throw
    }
  }
}

/**
 * History-reference invalidation broadcast — Main → all renderer windows.
 *
 * Post-commit HINT only (never data authority): a SOURCE topic that a target
 * references changed (rename / content / order / segment / restore / delete),
 * so every open target must re-read its window and re-derive the live foreign
 * prefix + divider title. Carries stable source/target topic IDs only. Empty
 * or malformed payloads never broadcast; failures never throw.
 *
 * Single writer for both mutation origins (renderer IPC commits and remote
 * sync application), so a target open on any window is invalidated no matter
 * which side produced the source change.
 */
export function broadcastHistoryReferenceInvalidation(
  sourceTopicId: string,
  targetTopicIds: string[],
  opts?: { excludeWebContentsId?: number }
): void {
  let payload: HistoryReferenceInvalidationEvent
  try {
    if (typeof sourceTopicId !== 'string' || sourceTopicId.length === 0) return
    const targets = dedup(targetTopicIds)
    if (targets.length === 0) return
    payload = { sourceTopicId, targetTopicIds: targets }
  } catch {
    return
  }
  let wins: Array<{
    isDestroyed: () => boolean
    webContents?: { id?: number; isDestroyed: () => boolean; send: (...a: unknown[]) => void }
  }>
  try {
    wins = BrowserWindow.getAllWindows() as unknown as typeof wins
  } catch {
    return
  }
  if (!Array.isArray(wins)) return
  const excluded = typeof opts?.excludeWebContentsId === 'number' ? opts.excludeWebContentsId : null
  for (const win of wins) {
    try {
      if (!win || win.isDestroyed()) continue
      const wc = win.webContents
      if (!wc || wc.isDestroyed()) continue
      if (excluded !== null && typeof wc.id === 'number' && wc.id === excluded) continue
      wc.send(IpcChannel.ChatDb_HistoryReferenceInvalidated, payload)
    } catch {
      // best-effort, never throw
    }
  }
}
