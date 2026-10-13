import { loggerService } from '@logger'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import type { RootState } from '@renderer/store'
import type { Message } from '@renderer/types/newMessage'
import type { SnapshotBlockMap } from '@renderer/utils/messageUtils/snapshotBlocks'
import { loadWholeTopicSnapshot } from '@renderer/utils/topicSnapshot'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSelector } from 'react-redux'

import MessageOutline from './MessageOutline'
import {
  type AttachmentLabelFormatters,
  buildAttachmentLabel,
  hasNavigableAttachment,
  summarizeUserMessage
} from './userMessagePreview'

const logger = loggerService.withContext('ConversationNavigation')

/** Coalescing window shared with the former history drawer pattern. */
export const CONVERSATION_NAV_REFRESH_DEBOUNCE_MS = 250

export interface ConversationNavItem {
  id: string
  preview: string
  hasAttachment: boolean
}

interface ConversationNavigationProps {
  topicId: string
  onNavigate: (messageId: string) => void
}

/**
 * Build the chronological USER-message navigation list from an explicit
 * caller-local whole-topic snapshot (effective active-branch route order).
 * Pure entry for focused tests; production passes the loaded snapshot.
 *
 * Display rules: a filtered nonempty body always wins with no attachment
 * clutter; a no-body (or quote-only) message with attachments keeps a
 * navigable stable-ID row with a meaningful attachment label; quote-only
 * without attachments keeps the localized fallback.
 */
export const buildConversationNavItems = (
  messages: Message[],
  blocksById: SnapshotBlockMap,
  fallback: string,
  attachment?: string | AttachmentLabelFormatters,
  options?: { maxLength?: number }
): ConversationNavItem[] => {
  const items: ConversationNavItem[] = []
  for (const message of messages) {
    if (!message || message.role !== 'user') continue
    const preview = summarizeUserMessage(message, blocksById, options)
    const hasAttachment = hasNavigableAttachment(message, blocksById)
    if (preview) {
      items.push({ id: message.id, preview, hasAttachment })
      continue
    }
    if (hasAttachment) {
      if (attachment && typeof attachment === 'object') {
        const label = buildAttachmentLabel(message, blocksById, attachment, options)
        items.push({ id: message.id, preview: label || attachment.genericFallback, hasAttachment })
      } else {
        items.push({ id: message.id, preview: attachment ?? fallback, hasAttachment })
      }
      continue
    }
    items.push({ id: message.id, preview: fallback, hasAttachment })
  }
  return items
}

const ConversationNavigation: FC<ConversationNavigationProps> = ({ topicId, onNavigate }) => {
  const { t } = useTranslation()
  const fallback = t('chat.navigation.user_message_fallback')
  // Attachment label builders bound to i18n plural semantics; the pure
  // preview module interpolates nothing itself.
  const attachmentFormatters = useMemo<AttachmentLabelFormatters>(
    () => ({
      genericFallback: t('chat.navigation.user_attachment_fallback'),
      formatSingleNamed: (name: string) => t('chat.navigation.user_attachment_file', { name }),
      formatNamedWithMore: (name: string, count: number) =>
        t('chat.navigation.user_attachment_file_more', { name, count }),
      formatImageCount: (count: number) => t('chat.navigation.user_attachment_image', { count }),
      formatAttachmentCount: (count: number) => t('chat.navigation.user_attachment_count', { count }),
      pastedImageLabel: t('message.attachments.pasted_image')
    }),
    [t]
  )
  const activeBranchId = useSelector((state: RootState) =>
    topicId ? (state.topicBranch?.activeBranchIdByTopic?.[topicId] ?? null) : null
  )
  // Loaded-route provenance: the active route key (`topic::branch`) is derived
  // synchronously every render; the loaded snapshot carries the key it was
  // fetched for. While a new route's snapshot is pending, the keys mismatch
  // and the list derives empty — no post-effect flash of old IDs under the
  // new route. Same-route refetches keep the key, so the list stays coherent.
  const activeRouteKey = `${topicId}::${activeBranchId ?? 'main'}`
  const [messages, setMessages] = useState<Message[]>([])
  const [blocksById, setBlocksById] = useState<SnapshotBlockMap>(new Map())
  const [snapshotKey, setSnapshotKey] = useState<string>('')

  const generationRef = useRef(0)
  const routeRef = useRef<string>('')
  const topicRef = useRef<string>(topicId)
  const branchRef = useRef<string | null>(activeBranchId)
  const mountedRef = useRef(true)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lastUpdatedAtRef = useRef<string | undefined>(undefined)
  topicRef.current = topicId
  branchRef.current = activeBranchId

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      generationRef.current += 1
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = undefined
      }
    }
  }, [])

  const fetchSnapshot = useCallback(
    async (targetTopicId: string, targetBranchId: string | null, targetRouteKey: string, gen: number) => {
      try {
        const snap = await loadWholeTopicSnapshot(targetTopicId, targetBranchId)
        if (!mountedRef.current || gen !== generationRef.current) return
        if (targetTopicId !== topicRef.current || targetBranchId !== branchRef.current) return
        // Guarded store: only the still-current route's snapshot is kept, with
        // its key. Stale async completions (superseded topic/branch) are
        // discarded — they never overwrite the new route's pending state.
        setMessages(snap.messages)
        setBlocksById(snap.blocksById)
        setSnapshotKey(targetRouteKey)
      } catch (error) {
        // Fail-closed: stale list is cleared on route change below; a
        // background refetch failure retains the last good list.
        if (!mountedRef.current || gen !== generationRef.current) return
        if (targetTopicId !== topicRef.current || targetBranchId !== branchRef.current) return
        logger.warn('Conversation navigation snapshot refetch failed', error as Error)
      }
    },
    []
  )

  const scheduleDebouncedRefetch = useCallback(() => {
    const targetTopic = topicRef.current
    const targetBranch = branchRef.current
    const targetRouteKey = `${targetTopic}::${targetBranch ?? 'main'}`
    if (!targetTopic) return
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = undefined
      if (!mountedRef.current) return
      if (topicRef.current !== targetTopic || branchRef.current !== targetBranch) return
      const gen = generationRef.current + 1
      generationRef.current = gen
      void fetchSnapshot(targetTopic, targetBranch, targetRouteKey, gen)
    }, CONVERSATION_NAV_REFRESH_DEBOUNCE_MS)
  }, [fetchSnapshot])

  // 1) mount / topic or branch switch: immediate load; drop the previous
  // route's list at once so a stale list never renders under the new route.
  // The synchronous `snapshotKey !== activeRouteKey` derivation below already
  // hides the old list on the very first render under the new key — this
  // effect only starts the fetch and clears the retained buffers.
  useEffect(() => {
    const targetRouteKey = `${topicId}::${activeBranchId ?? 'main'}`
    routeRef.current = targetRouteKey
    lastUpdatedAtRef.current = undefined
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = undefined
    }
    if (!topicId) {
      generationRef.current += 1
      setMessages([])
      setBlocksById(new Map())
      setSnapshotKey(targetRouteKey)
      return
    }
    const gen = generationRef.current + 1
    generationRef.current = gen
    setMessages([])
    setBlocksById(new Map())
    void fetchSnapshot(topicId, activeBranchId, targetRouteKey, gen)
  }, [topicId, activeBranchId, fetchSnapshot])

  const topicUpdatedAt = useSelector((state: RootState) =>
    topicId
      ? state.assistants.assistants.flatMap((a) => a.topics ?? []).find((topic) => topic.id === topicId)?.updatedAt
      : undefined
  )

  // 2) authority mutation metadata: refetch when the current topic's
  // updatedAt changes (baseline established on route load above).
  useEffect(() => {
    if (!topicId) return
    if (lastUpdatedAtRef.current === undefined) {
      lastUpdatedAtRef.current = topicUpdatedAt
      return
    }
    if (topicUpdatedAt === lastUpdatedAtRef.current) return
    lastUpdatedAtRef.current = topicUpdatedAt
    scheduleDebouncedRefetch()
  }, [topicId, topicUpdatedAt, scheduleDebouncedRefetch])

  // 3) terminal streaming: MESSAGE_COMPLETE (filtered by topicId) schedules
  // the same coalesced refetch for user-message changes from streaming.
  useEffect(() => {
    if (!topicId) return
    const handler = (payload: { topicId?: string } | undefined) => {
      if (!payload || payload.topicId !== topicId) return
      scheduleDebouncedRefetch()
    }
    const unsubscribe = EventEmitter.on(EVENT_NAMES.MESSAGE_COMPLETE, handler)
    return () => {
      unsubscribe()
    }
  }, [topicId, scheduleDebouncedRefetch])

  // Caller-local only: derived per snapshot, never a per-token full scan.
  // Route-boundary provenance: whenever the loaded snapshot key differs from
  // the active route key (topic/branch switch with the new fetch still
  // pending), derive an empty list synchronously — the previous route's IDs
  // never render under the new route, even for the intermediate render before
  // the clearing effect runs.
  const isSnapshotCurrent = snapshotKey === activeRouteKey
  const items = useMemo(
    () => (isSnapshotCurrent ? buildConversationNavItems(messages, blocksById, fallback, attachmentFormatters) : []),
    [isSnapshotCurrent, messages, blocksById, fallback, attachmentFormatters]
  )

  // Stable-ID clicks are honored only within the matching route. A click
  // landing after a route switch (stale closure or queued event) is dropped
  // instead of navigating the new route to an old-route ID.
  const handleNavigate = useCallback(
    (messageId: string) => {
      if (snapshotKey !== activeRouteKey) return
      if (topicRef.current !== topicId || branchRef.current !== activeBranchId) return
      onNavigate(messageId)
    },
    [snapshotKey, activeRouteKey, topicId, activeBranchId, onNavigate]
  )

  if (items.length === 0) return null

  // Presentation is the restored original MessageOutline (verbatim styles);
  // this module stays a caller-local data controller only.
  const entries = items.map((item) => ({ id: item.id, text: item.preview }))
  return <MessageOutline entries={entries} onNavigate={handleNavigate} />
}

export default ConversationNavigation
