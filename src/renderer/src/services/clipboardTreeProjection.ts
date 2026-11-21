import { loggerService } from '@logger'
import { handleScrollSnapshotCleared } from '@renderer/services/scrollSnapshotCache'
import type { AppDispatch, RootState } from '@renderer/store'
import { withClosureTopics } from '@renderer/store/closureOwnership'
import { upsertManyBlocks } from '@renderer/store/messageBlock'
import type { InsertMessageGroupsGroupApply } from '@renderer/store/newMessage'
import { newMessagesActions } from '@renderer/store/newMessage'
import { retentionEvict, selectGeneration } from '@renderer/store/residentRegistry'
import { fetchTopicBranchesThunk, loadRouteMessagesThunk } from '@renderer/store/thunk/messageThunk'
import {
  activeBranchReset,
  activeBranchSet,
  selectActiveBranchId,
  selectBranchPath,
  selectRouteGeneration,
  selectTopicBranches
} from '@renderer/store/topicBranch'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { convergeTopicSegmentCatalog } from '@renderer/utils/topicSegmentCatalog'
import type { ClipboardTreeRouteProjection } from '@shared/chatDb'

const logger = loggerService.withContext('ClipboardTreeProjection')

/**
 * Projection convergence after ONE tree clipboard authority command (paste,
 * cut-paste, or replay) already committed in Main.
 *
 * A tree command publishes THREE different projections per affected topic, and
 * each one has its own authority source:
 *
 * 1. The branch catalog (fork rows + inherited heads) and the segment catalog
 *    are topology/chrome facts that a per-route row delta cannot describe, so
 *    both are re-read from Main.
 * 2. The message window of the route the command wrote into is published from
 *    the command's OWN committed route-scoped delta (`projections`): Main
 *    produced it inside the same transaction that wrote the rows, so it carries
 *    canonical rows, stable neighbours, route-qualified mutability, and the rows
 *    that route lost. It is merged IN PLACE — untouched loaded rows (including
 *    every older page) keep their resident slots, so window completeness,
 *    pagination anchors and scroll restoration all stay valid and no re-read
 *    replaces the projection underneath an in-flight page request.
 *
 * Failure discipline: only the step whose failure would leave a fabricated
 * projection throws. The branch catalog refresh and the fallback route load are
 * projection-only re-reads of an already-committed write, so they warn instead
 * of turning a committed command into a failed one. The segment catalog step
 * keeps its typed committed marker (`SegmentCatalogConvergenceError`), which the
 * history layer already understands as "authority stands, advance the cursor".
 */
export async function convergeAfterClipboardTreeWrite(
  dispatch: AppDispatch,
  getState: () => RootState,
  affectedTopicIds: ReadonlyArray<string | null>,
  reason: string,
  projections: readonly ClipboardTreeRouteProjection[] = []
): Promise<void> {
  const deltasByTopic = groupDeltasByTopic(projections)
  const topicIds = [
    ...new Set([
      ...affectedTopicIds.filter((id): id is string => typeof id === 'string' && id.length > 0),
      ...deltasByTopic.keys()
    ])
  ]

  for (const topicId of topicIds) {
    const deltas = deltasByTopic.get(topicId) ?? []
    // The rows Main actually removed from this topic (owner-scoped, already
    // canonical): only these can invalidate a saved viewport anchor.
    const removedIds = collectRemovedIds(deltas)

    // Captured BEFORE the catalog re-read: a vanished route is resolved through
    // the parent chain Main just published, so the fallback targets the nearest
    // surviving ancestor rather than whatever the parent map says afterwards.
    // The generations capture which projection this delta belongs to — a switch
    // or an eviction during the await means someone else already re-imaged it.
    const before = getState()
    const activeBefore = readActiveRoute(before, topicId)
    const routeGenerationBefore = readRouteGeneration(before, topicId)
    const residentGenerationBefore = readResidentGeneration(before, topicId)
    const beforeById = new Map(readBranches(before, topicId).map((branch) => [branch.id, branch]))

    // 1. Branch catalog: fork rows, names, and inherited heads of this topic.
    try {
      await dispatch(fetchTopicBranchesThunk(topicId))
    } catch (error) {
      logger.warn(
        `[${reason}] Authority committed but branch catalog refresh failed for topic ${topicId}`,
        error as Error
      )
    }

    // 2. A route the command removed falls back to its nearest surviving
    // ancestor (parent first, else main — main holds every anchor).
    let route = activeBefore
    const surviving = new Set(readBranches(getState(), topicId).map((branch) => branch.id))
    if (activeBefore !== null && !surviving.has(activeBefore)) {
      let candidate = beforeById.get(activeBefore)?.parentBranchId ?? null
      while (candidate !== null && !surviving.has(candidate)) {
        candidate = beforeById.get(candidate)?.parentBranchId ?? null
      }
      route = candidate
      try {
        if (candidate === null) {
          dispatch(activeBranchReset({ topicId }))
        } else {
          dispatch(activeBranchSet({ topicId, branchId: candidate }))
        }
      } catch (error) {
        logger.warn(`[${reason}] Authority committed but route fallback failed for topic ${topicId}`, error as Error)
      }
    }

    // 3. A row this command removed can be the anchor of a saved viewport
    // position of one of this topic's routes. Main no longer has it, so that
    // position is unplaceable — the same reason the branch-deletion path drops
    // the saved position of a route whose rows it removed. Renderer-local,
    // best-effort, and only for positions whose anchor really was removed.
    dropVanishedViewportPositions(topicId, removedIds, [...new Set([...beforeById.keys(), ...surviving])])

    // 4. Message projection of the route this command wrote into / removed rows
    // from.
    //
    // Displayed topic on the SAME route: merge the command's own delta in place.
    // Nothing is re-read, so the displayed window is never rebased out from
    // under the user (no lost older pages, no viewport reset) and an in-flight
    // older/newer page request keeps a valid resident anchor.
    //
    // Displayed topic whose route the command removed: the fallback target is a
    // different route, so this really is a route switch and takes the ordinary
    // authority read.
    //
    // Topic the user is NOT looking at: Main just wrote or removed rows there,
    // so its loaded window is no longer a fact. Its projection is dropped
    // through the existing renderer-local eviction path (messages, blocks,
    // window completeness, residency marker, mutability) — authority is never
    // touched and scroll snapshots survive — so the next activation is a real
    // authority read instead of the resident cache hit that would keep
    // rendering the pre-command rows.
    const displayedState = getState()
    if (!isDisplayedTopic(displayedState, topicId)) {
      try {
        dispatch(retentionEvict(topicId))
      } catch (error) {
        logger.warn(
          `[${reason}] Authority committed but projection eviction failed for topic ${topicId}`,
          error as Error
        )
      }
    } else if (route !== activeBefore) {
      try {
        await dispatch(loadRouteMessagesThunk(topicId, route, { kind: 'latest' }))
      } catch (error) {
        logger.warn(
          `[${reason}] Authority committed but fallback route load failed for topic ${topicId}`,
          error as Error
        )
      }
    } else {
      const publishState = getState()
      const activeNow = readActiveRoute(publishState, topicId)
      if (
        activeNow !== route ||
        readRouteGeneration(publishState, topicId) !== routeGenerationBefore ||
        readResidentGeneration(publishState, topicId) !== residentGenerationBefore
      ) {
        // Someone else switched the route or re-imaged the projection while the
        // catalogs were refreshing; there is no resident window this delta was
        // produced for, and publishing it would place rows of one route into
        // another. Their own authority read owns the projection.
        logger.warn(
          `[${reason}] Projection changed during convergence for topic ${topicId}; no in-place publish (authority stands)`
        )
      } else {
        publishRouteDeltaInPlace(dispatch, publishState, topicId, route, deltas)
      }
    }

    // 5. Complete segment catalog of this topic (Main authority, applicability
    // checked). Runs LAST so the window it qualifies is the committed window.
    // The only step allowed to throw: its typed marker carries the committed
    // fact up to the caller.
    await convergeTopicSegmentCatalog(dispatch, topicId, getState)
  }
}

/**
 * One committed command delta → ONE resident projection commit for the route
 * the user is displaying.
 *
 * Placement scope: only the displayed route's own runs are spliced freely. A
 * run owned by an ancestor route is part of the displayed route's inherited
 * PREFIX only when the rows that follow it in the ancestor's order are also part
 * of that prefix, so it is anchored from its successor side alone (no
 * predecessor fallback, no tail append): a run whose successor is not resident
 * injects nothing instead of guessing a position past the fork.
 *
 * Mutability scope: `mutableMessageIds` is taken ONLY from the delta whose owner
 * is the displayed route. A row inherited from an ancestor stays read-only in
 * this route no matter which delta carried it — a delta is a row description,
 * never a permission.
 *
 * Removals are intersected by ID inside the reducer, so a delta of any owner
 * only ever drops rows this projection actually holds.
 *
 * A topic with no resident window yet is left alone: committing a delta into an
 * absent projection would synthesize a window whose head/tail completeness was
 * never established. Its own route load will read the committed rows instead.
 */
function publishRouteDeltaInPlace(
  dispatch: AppDispatch,
  state: RootState,
  topicId: string,
  route: string | null,
  deltas: readonly ClipboardTreeRouteProjection[]
): void {
  if (!Array.isArray(readResidentOrder(state, topicId))) return
  const ancestorIds = readAncestorBranchIds(state, topicId, route)
  const runs: InsertMessageGroupsGroupApply[] = []
  const mutableMessageIds: string[] = []
  const removedMessageIds: string[] = []
  const wireIds = new Set<string>()

  for (const delta of deltas) {
    for (const id of delta.removedMessageIds ?? []) {
      if (typeof id === 'string' && id.length > 0) removedMessageIds.push(id)
    }
    const owner = delta.branchId ?? null
    const own = owner === route
    const inheritedPrefix = !own && (owner === null || ancestorIds.has(owner))
    if (!own && !inheritedPrefix) continue

    for (const run of delta.insertedRuns ?? []) {
      const ids = (run.messageIds ?? []).filter((id) => typeof id === 'string' && id.length > 0)
      if (ids.length === 0) continue
      const nextMessageId =
        typeof run.nextMessageId === 'string' && run.nextMessageId.length > 0 ? run.nextMessageId : null
      const beforeMessageId =
        typeof run.beforeMessageId === 'string' && run.beforeMessageId.length > 0 ? run.beforeMessageId : null
      if (!own && nextMessageId === null) continue
      runs.push({
        insertedMessageIds: ids,
        // Inherited-prefix runs are successor-anchored only (see above).
        beforeMessageId: own ? beforeMessageId : null,
        nextMessageId,
        visibleMessageIds: ids
      })
      for (const id of ids) wireIds.add(id)
    }

    if (own) {
      for (const id of delta.mutableMessageIds ?? []) {
        if (typeof id === 'string' && id.length > 0) mutableMessageIds.push(id)
      }
    }
  }

  if (runs.length === 0 && removedMessageIds.length === 0) return

  const messages: Message[] = []
  const blocks: MessageBlock[] = []
  for (const delta of deltas) {
    for (const wire of delta.messages ?? []) {
      const id = (wire as { id?: unknown }).id
      if (typeof id === 'string' && wireIds.has(id)) messages.push(wire as unknown as Message)
    }
    for (const wire of delta.blocks ?? []) {
      const messageId = (wire as { messageId?: unknown }).messageId
      if (typeof messageId === 'string' && wireIds.has(messageId)) blocks.push(wire as unknown as MessageBlock)
    }
  }
  // Blocks for the installed rows first (existing block-slice convention), then
  // ONE messages+capability commit: no frame ever holds a row without its
  // route-scoped capability.
  if (blocks.length > 0) {
    try {
      dispatch(withClosureTopics(upsertManyBlocks(blocks), topicId))
    } catch (error) {
      logger.warn(
        `[ClipboardTreeProjection] Authority committed but block publication failed for topic ${topicId}`,
        error as Error
      )
    }
  }
  dispatch(
    newMessagesActions.applyClipboardTreeProjection({
      topicId,
      route,
      messages,
      removedMessageIds,
      runs,
      mutableMessageIds
    })
  )
}

function groupDeltasByTopic(
  projections: readonly ClipboardTreeRouteProjection[] | undefined
): Map<string, ClipboardTreeRouteProjection[]> {
  const byTopic = new Map<string, ClipboardTreeRouteProjection[]>()
  for (const delta of Array.isArray(projections) ? projections : []) {
    if (!delta || typeof delta !== 'object') continue
    const topicId = typeof delta.topicId === 'string' ? delta.topicId : ''
    if (topicId.length === 0) continue
    const list = byTopic.get(topicId)
    if (list) list.push(delta)
    else byTopic.set(topicId, [delta])
  }
  return byTopic
}

function collectRemovedIds(deltas: readonly ClipboardTreeRouteProjection[]): string[] {
  const removed = new Set<string>()
  for (const delta of deltas) {
    for (const id of delta.removedMessageIds ?? []) {
      if (typeof id === 'string' && id.length > 0) removed.add(id)
    }
  }
  return [...removed]
}

/**
 * Drop the saved viewport position of every route of `topicId` whose stored
 * anchor is one of the rows this command removed.
 *
 * A position whose anchor no longer exists cannot be restored, and the restore
 * attempt is what the product treats as a vanished anchor (explicit terminal
 * default). Removing it up front keeps that default reachable without asking a
 * viewport pipeline to resolve an anchor Main has already deleted. The route's
 * remaining positions are untouched, and nothing here changes how a position is
 * saved, restored or scrolled.
 */
function dropVanishedViewportPositions(
  topicId: string,
  removedMessageIds: readonly string[] | undefined,
  branchIds: readonly string[]
): void {
  if (!Array.isArray(removedMessageIds) || removedMessageIds.length === 0) return
  const removed = new Set(removedMessageIds.filter((id): id is string => typeof id === 'string' && id.length > 0))
  if (removed.size === 0) return
  const keyv = readScrollKeyv()
  if (!keyv) return
  for (const key of savedViewportKeys(topicId, branchIds)) {
    let anchor: unknown
    try {
      const saved = keyv.get?.(key) as Record<string, unknown> | null | undefined
      anchor = saved && typeof saved === 'object' ? (saved.messageId ?? saved.anchorId) : null
    } catch {
      continue
    }
    if (typeof anchor !== 'string' || !removed.has(anchor)) continue
    try {
      keyv.remove?.(key)
    } catch {
      // best-effort
    }
    try {
      handleScrollSnapshotCleared(key)
    } catch {
      // best-effort
    }
  }
}

/** Storage keys a topic can hold a saved viewport position under (main + branches). */
function savedViewportKeys(topicId: string, branchIds: readonly string[]): string[] {
  const keys = [`scroll:topic-${topicId}`, `scroll:topic-${topicId}::main`]
  for (const branchId of branchIds) {
    if (typeof branchId === 'string' && branchId.length > 0) keys.push(`scroll:topic-${topicId}::${branchId}`)
  }
  return keys
}

function readScrollKeyv(): { get?: (key: string) => unknown; remove?: (key: string) => unknown } | undefined {
  try {
    if (typeof window === 'undefined') return undefined
    return (window as unknown as { keyv?: { get?: (key: string) => unknown; remove?: (key: string) => unknown } }).keyv
  } catch {
    return undefined
  }
}

/**
 * Ancestor branch IDs of `route` (never the route itself). Main is the implicit
 * root ancestor and is therefore handled by the caller, not listed here.
 */
function readAncestorBranchIds(state: RootState, topicId: string, route: string | null): Set<string> {
  const ids = new Set<string>()
  if (route === null) return ids
  try {
    for (const node of selectBranchPath(state, topicId, route)) {
      if (typeof node?.id === 'string' && node.id.length > 0 && node.id !== route) ids.add(node.id)
    }
  } catch {
    // best-effort: an unresolvable path just means no inherited runs this commit
  }
  return ids
}

/** Loaded resident order of one topic, or `undefined` when it has no window. */
function readResidentOrder(state: RootState, topicId: string): string[] | undefined {
  try {
    const order = (state as unknown as { messages?: { messageIdsByTopic?: Record<string, string[]> } }).messages
      ?.messageIdsByTopic?.[topicId]
    return Array.isArray(order) ? order : undefined
  } catch {
    return undefined
  }
}

function readActiveRoute(state: RootState, topicId: string): string | null {
  try {
    return selectActiveBranchId(state, topicId)
  } catch {
    return null
  }
}

function readBranches(state: RootState, topicId: string) {
  try {
    return selectTopicBranches(state, topicId)
  } catch {
    return []
  }
}

function readRouteGeneration(state: RootState, topicId: string): number {
  try {
    return selectRouteGeneration(state, topicId)
  } catch {
    return 0
  }
}

function readResidentGeneration(state: RootState, topicId: string): number {
  try {
    return selectGeneration(state, topicId)
  } catch {
    return 0
  }
}

/** True when this topic is the chat route currently rendered. */
function isDisplayedTopic(state: RootState, topicId: string): boolean {
  try {
    const active = (state as unknown as { runtime?: { chat?: { activeTopic?: { id?: string } | null } } }).runtime?.chat
      ?.activeTopic
    return typeof active?.id === 'string' && active.id === topicId
  } catch {
    return false
  }
}
