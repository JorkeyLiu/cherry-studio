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

import { forkMarkerLabel, groupForkChildrenByParent, resolveForkPlacement, takenChildAtAnchor } from './forkPlacement'
import MessageOutline from './MessageOutline'
import type { ReadingAnchorReport } from './Messages'
import { useBranchTree } from './useBranchTree'
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
  readingAnchor?: ReadingAnchorReport | null
  onNavigate: (messageId: string) => void
}

/**
 * Build the chronological USER-message navigation list from an explicit
 * caller-local whole-topic snapshot (effective active-branch route order).
 * Pure entry for focused tests; production passes the loaded snapshot.
 *
 * Display rules: a filtered nonempty body shows WITH its attachment kind
 * prefix (sequential labels in original block order, joined directly with
 * the body — no added space/dot/count); a no-body (or quote-only) message
 * with attachments keeps a navigable stable-ID row with a meaningful
 * attachment label; quote-only without attachments keeps the localized
 * fallback.
 */
export const buildConversationNavItems = (
  messages: Message[],
  blocksById: SnapshotBlockMap,
  fallback: string,
  attachment?: string | AttachmentLabelFormatters,
  options?: { maxLength?: number; linkLabel?: string }
): ConversationNavItem[] => {
  const items: ConversationNavItem[] = []
  for (const message of messages) {
    if (!message || message.role !== 'user') continue
    const preview = summarizeUserMessage(message, blocksById, options)
    const hasAttachment = hasNavigableAttachment(message, blocksById)
    if (preview) {
      if (hasAttachment && attachment && typeof attachment === 'object') {
        const prefix = buildAttachmentLabel(message, blocksById, attachment)
        if (prefix) {
          items.push({ id: message.id, preview: `${prefix}${preview}`, hasAttachment })
          continue
        }
      }
      items.push({ id: message.id, preview, hasAttachment })
      continue
    }
    if (hasAttachment) {
      if (attachment && typeof attachment === 'object') {
        const label = buildAttachmentLabel(message, blocksById, attachment)
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
/**
 * Resolve a message id to the outline row it belongs under. A user message is
 * its own row; any other message belongs under its nearest preceding user
 * message in route order (`precedingUserByMessageId`). Unresolved — the id is
 * not in this snapshot, or nothing user precedes it — has no row.
 *
 * This is the single mapping the reading-anchor highlight and the fork markers
 * share; keeping one implementation is what makes "which row does this message
 * belong under" a single fact instead of two agreeing guesses.
 */
const resolveOutlineRowId = (
  messageId: string,
  itemIds: ReadonlySet<string>,
  precedingUserByMessageId: ReadonlyMap<string, string>
): string | undefined => (itemIds.has(messageId) ? messageId : precedingUserByMessageId.get(messageId))

const ConversationNavigation: FC<ConversationNavigationProps> = ({ topicId, readingAnchor, onNavigate }) => {
  const { t } = useTranslation()
  const fallback = t('chat.navigation.user_message_fallback')
  // Localized link word for in-place external-link replacement in body
  // previews (the pure preview module interpolates nothing itself).
  const linkLabel = t('chat.navigation.user_message_link')
  // Attachment label builders bound to i18n plural semantics; the pure
  // preview module interpolates nothing itself.
  const attachmentFormatters = useMemo<AttachmentLabelFormatters>(
    () => ({
      genericFallback: t('chat.navigation.user_attachment_fallback'),
      typeImage: t('chat.navigation.user_attachment_type_image'),
      typeVideo: t('chat.navigation.user_attachment_type_video'),
      typeAudio: t('chat.navigation.user_attachment_type_audio'),
      typeText: t('chat.navigation.user_attachment_type_text'),
      typeDocument: t('chat.navigation.user_attachment_type_document'),
      typeCode: t('chat.navigation.user_attachment_type_code')
    }),
    [t]
  )
  const activeBranchId = useSelector((state: RootState) =>
    topicId ? (state.topicBranch?.activeBranchIdByTopic?.[topicId] ?? null) : null
  )
  // Branch catalog for the viewed route: the outline mirrors the message
  // stream's fork dividers, so it needs the same relation source (children of
  // the active level plus every ancestor level of this route, by anchor) and
  // the root-first `path` of the route itself, which is what tells a fork's
  // siblings apart — only the one this route travels names the marker.
  const { childrenByAnchor, path: branchPath } = useBranchTree(topicId, activeBranchId)
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
    () =>
      isSnapshotCurrent
        ? buildConversationNavItems(messages, blocksById, fallback, attachmentFormatters, { linkLabel })
        : [],
    [isSnapshotCurrent, messages, blocksById, fallback, attachmentFormatters, linkLabel]
  )

  // Caller-local chronological map: each non-user message id resolves to the
  // nearest preceding user message id in the current whole-topic snapshot
  // (route order). This is the ONE "nearest preceding user row" mapping in
  // this module: the reading-anchor highlight and the fork markers both
  // consume it, so the two surfaces can never disagree about which outline
  // row a message belongs under.
  const precedingUserByMessageId = useMemo(() => {
    const map = new Map<string, string>()
    let lastUserId: string | null = null
    if (isSnapshotCurrent) {
      for (const message of messages) {
        if (!message) continue
        if (message.role === 'user') lastUserId = message.id
        else if (lastUserId) map.set(message.id, lastUserId)
      }
    }
    return map
  }, [isSnapshotCurrent, messages])

  const itemIds = useMemo(() => new Set(items.map((item) => item.id)), [items])

  // Fork markers handed to the outline: `map.has(messageId)` means "draw one
  // marker line directly after that row", and the value is the text the marker
  // shows — the branch this route travels at that fork, or the fork's
  // children-here count when it took none. That text is produced by
  // `forkMarkerLabel`, the SAME two-state decision the message flow's divider
  // renders, so the two surfaces can never name one thing and show another. The
  // shared placement resolution decides the boundary id (never a second
  // ternary), so a marker cannot sit under a row whose divider the flow draws
  // somewhere else.
  // The outline is a directory of USER turns, so a boundary message is mapped
  // to the row it belongs under by `resolveOutlineRowId`: a user boundary marks
  // its own row, while an assistant boundary marks the nearest preceding user
  // row. Assistant boundaries are the normal case — the split action lives only
  // on assistant turns, and Main reports the anchor itself as the boundary
  // while it is still on its own parent route — and the preceding user row is
  // exactly the user-facing meaning of that fork: "you asked this, the
  // assistant answered, the split happened here".
  //
  // Two silent drops remain, both structural:
  // - `'head'` placements have no inherited message at all, so there is no row
  //   to sit under (the head position is a relation position, not a target).
  // - an unresolvable boundary (message absent from this route's snapshot, or
  //   no user row before it) has no row either.
  // Several forks may resolve to the same user row. The FIRST one in this
  // iteration order keeps the row (one marker per row, and a stable winner
  // because `childrenByAnchor` and the group order are both deterministic), so
  // a rebuild can never flip which branch the marker names.
  const forkAfter = useMemo<ReadonlyMap<string, string>>(() => {
    const marked = new Map<string, string>()
    if (!isSnapshotCurrent) return marked
    for (const [anchorMessageId, children] of childrenByAnchor) {
      for (const group of groupForkChildrenByParent(children)) {
        const { placement, boundaryMessageId } = resolveForkPlacement(group.children, anchorMessageId)
        if (placement !== 'message' || boundaryMessageId === null) continue
        const rowId = resolveOutlineRowId(boundaryMessageId, itemIds, precedingUserByMessageId)
        if (rowId === undefined) continue
        if (marked.has(rowId)) continue
        const taken = takenChildAtAnchor(branchPath, anchorMessageId, group.children)
        marked.set(rowId, forkMarkerLabel(taken, group.children, t))
      }
    }
    return marked
  }, [isSnapshotCurrent, itemIds, precedingUserByMessageId, childrenByAnchor, branchPath, t])

  // Active highlight: only when the report matches the current topic, the
  // current branch route and the loaded snapshot key. navigationTargetId
  // wins over messageId; the resolved row is the same row the fork markers use
  // (a user id is its own row, any other id maps to its preceding user id); an
  // unresolvable id never steals the highlight.
  const activeId = useMemo(() => {
    if (!readingAnchor || !isSnapshotCurrent) return undefined
    if (readingAnchor.topicId !== topicId) return undefined
    if ((readingAnchor.route ?? 'main') !== (activeBranchId ?? 'main')) return undefined
    const target = readingAnchor.navigationTargetId ?? readingAnchor.messageId
    if (!target) return undefined
    return resolveOutlineRowId(target, itemIds, precedingUserByMessageId)
  }, [readingAnchor, isSnapshotCurrent, topicId, activeBranchId, itemIds, precedingUserByMessageId])

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
  return <MessageOutline entries={entries} onNavigate={handleNavigate} activeId={activeId} forkAfter={forkAfter} />
}

export default ConversationNavigation
