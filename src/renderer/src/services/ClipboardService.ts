import { loggerService } from '@logger'
import { convergeAfterClipboardTreeWrite } from '@renderer/services/clipboardTreeProjection'
import { dbService } from '@renderer/services/db'
import { consumeFileCleanupResult } from '@renderer/services/db/topicTrashLifecycle'
import { publishInsertMessageGroupsAck } from '@renderer/services/insertGroupsAck'
import type { AppDispatch, RootState } from '@renderer/store'
import { clearClipboard, setClipboard } from '@renderer/store/clipboard'
import { withClosureTopics } from '@renderer/store/closureOwnership'
import { removeManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions, selectLoadedMessagesForTopic } from '@renderer/store/newMessage'
import { requireActiveRouteOf } from '@renderer/store/routeAnswerGroup'
import {
  deleteMessagesFromDB,
  executeDeleteMessagesWithDependents,
  executeStagedCutSourceDelete,
  isDeletePostCommitConvergenceError
} from '@renderer/store/thunk/messageThunk'
import { deleteSegmentsBySnapshots, syncSegmentsAfterMessageDeletion } from '@renderer/store/thunk/topicSegmentThunk'
import { selectActiveBranchId } from '@renderer/store/topicBranch'
import { recordUndoAction } from '@renderer/store/undoStack'
import type {
  ClipboardItem,
  ClipboardSegmentSnapshot,
  ClipboardTreeCapture,
  ClipboardTreeUndoAction,
  CutPasteUndoAction,
  DeleteUndoAction,
  GroupAnchor,
  PasteUndoAction,
  SegmentSnapshot,
  StagedCutSourceProjection
} from '@renderer/types/editMode'
import type { FileMessageBlock, ImageMessageBlock, Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'
import type { TopicSegment } from '@renderer/types/topicSegment'
import { convergeTopicSegmentCatalog, mapSegmentWireToTopicSegment } from '@renderer/utils/topicSegmentCatalog'
import { getSegmentColor } from '@renderer/utils/topicSegmentColor'
import type {
  ClipboardTreeMode,
  InheritanceBoundarySnapshot,
  InsertMessageGroupIntent,
  MessageBlockEntry
} from '@shared/chatDb'
import { t } from 'i18next'
import { v4 as uuidv4 } from 'uuid'

const logger = loggerService.withContext('ClipboardService')

/**
 * Find the first message after `positionIndex` whose ID is not in `excludedIds`.
 * Returns the message ID, or null if no such message exists.
 */
function findAnchorAfterPosition(messages: Message[], positionIndex: number, excludedIds: Set<string>): string | null {
  for (let i = positionIndex; i < messages.length; i++) {
    if (!excludedIds.has(messages[i].id)) {
      return messages[i].id
    }
  }
  return null
}

/**
 * Authority-complete clipboard payload for copy/cut under windowed loading.
 *
 * Resolves the selected stable group IDs (`selectedGroupIds`, the same values
 * the edit-mode UI passes as group `askId`s) in one Main group-scoped
 * authority read (`chatdb:fetch-clipboard-groups`, never published to Redux)
 * with the canonical grouping semantics (user keys own ID, assistants join by
 * askId with an orphan-askId fallback group, system keys own ID; any other
 * role forms no selectable group). Ordering and `positionIndex` come from
 * Main authority order (first-message `sort_order`), blocks come from the
 * response-local block set (so outside-loaded members are complete), and
 * segment inclusion comes from the authority-enriched segment catalog (a
 * segment is included only when ALL its authority message IDs are selected —
 * completeness is never inferred from loaded positions).
 *
 * Returns null when no selected group resolves or any authority read fails —
 * callers publish nothing on null (no partial clipboard).
 */
async function buildAuthorityClipboardPayload(
  topicId: string,
  selectedGroupIds: string[],
  branchId?: string | null
): Promise<{ items: ClipboardItem[]; segmentSnapshots: ClipboardSegmentSnapshot[] } | null> {
  // Stable group IDs only (dedupe defense-in-depth; same contract as the
  // semantic delete path).
  const rootIds = [...new Set(selectedGroupIds.filter((id) => typeof id === 'string' && id.length > 0))]
  if (rootIds.length === 0) {
    return null
  }

  // Group-scoped authority read in the addressed route (null = main route);
  // never relies on or mutates Redux, never fetches the whole topic. A
  // selected ID absent from authority (deletion race, unknown id,
  // non-clipboard role, cross-topic id) is filtered by Main and resolves to
  // nothing here.
  let clipboard: Awaited<ReturnType<typeof dbService.fetchClipboardGroups>>
  try {
    clipboard = await dbService.fetchClipboardGroups({
      topicId,
      branchId: typeof branchId === 'string' && branchId.length > 0 ? branchId : null,
      groupIds: rootIds
    })
  } catch (error) {
    logger.error('[buildAuthorityClipboardPayload] Failed to fetch clipboard groups', error as Error)
    return null
  }

  if (clipboard.groups.length === 0 || clipboard.messages.length === 0) {
    for (const gid of rootIds) {
      if (!clipboard.groups.some((g) => g.groupId === gid)) {
        logger.warn(`[buildAuthorityClipboardPayload] Selected group ${gid} absent from authority; skipping`)
      }
    }
    return null
  }

  const messageById = new Map((clipboard.messages as unknown as Message[]).map((m) => [m.id, m]))
  const blocksByMessageId = new Map<string, MessageBlock[]>()
  for (const block of clipboard.blocks as unknown as MessageBlock[]) {
    const arr = blocksByMessageId.get(block.messageId)
    if (arr) {
      arr.push(block)
    } else {
      blocksByMessageId.set(block.messageId, [block])
    }
  }

  const items: ClipboardItem[] = []
  const allSelectedMessageIds: string[] = []

  // Main already returns groups in authority order; keep that order (paste
  // sorts by positionIndex, so document order is preserved regardless).
  for (const group of clipboard.groups) {
    const groupMessages: Message[] = []
    for (const mid of group.messageIds) {
      const msg = messageById.get(mid)
      if (msg) {
        groupMessages.push(msg)
      } else {
        logger.warn(`[buildAuthorityClipboardPayload] Message ${mid} of group ${group.groupId} absent; skipping`)
      }
    }
    if (groupMessages.length === 0) {
      continue
    }
    const clonedMessages: Message[] = structuredClone(groupMessages)
    const clonedBlocks: MessageBlock[] = []
    for (const msg of groupMessages) {
      allSelectedMessageIds.push(msg.id)
      for (const block of blocksByMessageId.get(msg.id) ?? []) {
        clonedBlocks.push(structuredClone(block))
      }
    }

    // Authority order/group position; the persisted wire shape is unchanged
    // (no clipboard format migration).
    items.push({
      originalAskId: group.groupId,
      messages: clonedMessages,
      blocks: clonedBlocks,
      positionIndex: group.positionIndex
    })
  }

  if (items.length === 0) {
    return null
  }

  // Authority-enriched segment catalog membership (caller-local read, never
  // published). A segment snapshot is captured only when every authority
  // member message is in the complete selected set.
  const segmentSnapshots: ClipboardSegmentSnapshot[] = []
  try {
    const wires = await dbService.listSegments(topicId)
    const selectedSet = new Set(allSelectedMessageIds)
    for (const wire of wires) {
      const memberIds = wire.messageIds ?? []
      if (memberIds.length > 0 && memberIds.every((id) => selectedSet.has(id))) {
        segmentSnapshots.push({
          originalSegmentId: wire.id,
          name: wire.name ?? '',
          color: wire.color || getSegmentColor(wire.id),
          folded: wire.folded === true ? true : undefined,
          originalMessageIds: [...memberIds]
        })
      }
    }
  } catch (error) {
    logger.error(
      '[buildAuthorityClipboardPayload] Failed to list authority segments; publishing nothing',
      error as Error
    )
    return null
  }

  return { items, segmentSnapshots }
}

/** Opt-in tree clipboard: capture the selected roots plus their child-branch subtrees. */
export interface ClipboardTreeOptions {
  /**
   * Capture the whole descendant closure instead of the selected roots alone.
   * Explicit opt-in only: the ordinary copy/cut buttons and their keyboard
   * shortcuts keep the ordinary semantics.
   */
  includeChildBranches?: boolean
}

/** Same null/empty encoding the authority route contracts use (null = main route). */
function normalizeRouteId(branchId?: string | null): string | null {
  return typeof branchId === 'string' && branchId.length > 0 ? branchId : null
}

/**
 * Capture ONE Main authority clipboard closure for the selected stable group
 * IDs: the selected complete groups of the captured route (the roots) plus, for
 * every direct child branch anchored at a selected root, that branch's subtree
 * and only the rows those branches OWN.
 *
 * The closure is read whole from SQLite by Main (`chatdb:fetch-clipboard-tree`)
 * — never synthesized from the loaded projection, never widened by a renderer
 * selector, and an unresolvable group fails closed in Main instead of silently
 * dropping a selected branch. The payload also carries Main's own topology
 * (branch rows, segment membership) and the read facts that say which roots a
 * `cut` may delete.
 *
 * Returns null when nothing resolves or the read fails — callers publish
 * nothing, so the clipboard keeps its previous content.
 */
async function captureAuthorityClipboardTree(
  topicId: string,
  selectedGroupIds: string[],
  branchId?: string | null
): Promise<ClipboardTreeCapture | null> {
  const rootIds = [...new Set(selectedGroupIds.filter((id) => typeof id === 'string' && id.length > 0))]
  if (rootIds.length === 0) {
    return null
  }

  let response: Awaited<ReturnType<typeof dbService.fetchClipboardTree>>
  try {
    response = await dbService.fetchClipboardTree({
      topicId,
      branchId: normalizeRouteId(branchId),
      groupIds: rootIds
    })
  } catch (error) {
    logger.error(
      '[captureAuthorityClipboardTree] Failed to read the authority closure; publishing nothing',
      error as Error
    )
    return null
  }

  if (response.tree.roots.length === 0 || response.tree.messages.length === 0) {
    logger.warn('[captureAuthorityClipboardTree] Authority resolved no captured rows; publishing nothing')
    return null
  }

  return { payload: response.tree, meta: response.clipboard }
}

/**
 * Publish the opt-in tree capture for copy/cut.
 *
 * Shared by both modes: one authority read, one clipboard publication, and the
 * cut-only permission checks in front of the read (the addressed route must
 * still be the active loaded route, and Main's owned-root fact must cover the
 * whole selection — an inherited, copy-only root makes the cut unavailable
 * because Main never deletes rows it does not own).
 *
 * Returns the captured message count (roots + descendant rows), or 0 when
 * nothing was published (fail-closed: clipboard untouched).
 */
async function publishAuthorityClipboardTree(
  dispatch: AppDispatch,
  topicId: string,
  selectedGroupIds: string[],
  branchId: string | null | undefined,
  mode: ClipboardTreeMode,
  getState?: () => RootState
): Promise<number> {
  const stagedBranchId = normalizeRouteId(branchId)

  if (mode === 'cut') {
    if (typeof getState !== 'function') {
      logger.warn('[publishAuthorityClipboardTree] Cut capture without store access; cut refused')
      return 0
    }
    let activeSourceRoute: string | null = null
    try {
      activeSourceRoute = selectActiveBranchId(getState(), topicId)
    } catch {
      activeSourceRoute = null
    }
    if (stagedBranchId !== activeSourceRoute) {
      logger.warn(
        '[publishAuthorityClipboardTree] Staged source route differs from the active loaded route; cut refused'
      )
      return 0
    }
  }

  const capture = await captureAuthorityClipboardTree(topicId, selectedGroupIds, stagedBranchId)
  if (!capture) {
    return 0
  }

  if (mode === 'cut' && capture.meta.inheritedRootMessageIds.length > 0) {
    logger.warn(
      `[publishAuthorityClipboardTree] Selection includes ${capture.meta.inheritedRootMessageIds.length} inherited (copy-only) root(s); cut refused`
    )
    return 0
  }

  dispatch(
    setClipboard({
      mode,
      // Explicit content kind: the tree closure is never flattened into
      // ordinary per-route groups, so a later paste cannot degrade into an
      // ordinary single-route paste.
      items: [],
      sourceTopicId: topicId,
      sourceBranchId: stagedBranchId,
      segmentSnapshots: [],
      tree: capture
    })
  )

  logger.info(
    `[publishAuthorityClipboardTree] ${mode}: ${capture.meta.returnedMessageCount} messages from ${capture.meta.returnedCount} roots, ${capture.meta.returnedBranchCount} branches, ${capture.meta.returnedSegmentCount} segments`
  )
  return capture.meta.returnedMessageCount
}

/**
 * Copy ONE branch's own trunk plus every descendant branch's own rows.
 *
 * The branch is addressed explicitly by the clicked row (it may be inactive —
 * the source route is the row the user pressed, never the active route), so no
 * edit-mode selection is needed and no loaded/resident projection is involved:
 * Main reads the complete OWNED subtree in one read-only transaction
 * (`chatdb:fetch-clipboard-tree` with `capture: 'branch-owned'`) and returns the
 * same payload/meta shape the opt-in tree copy publishes.
 *
 * Copy only: this entry never publishes a `cut` intent, so a branch-row press can
 * never start a source removal. The captured payload pastes through the existing
 * tree command; the source branch's own node is not re-created (only descendant
 * branch names/parents/anchors are), and nothing is reparented.
 *
 * Returns the captured message count (trunk + descendant rows), or 0 when
 * nothing was published — fail-closed: the clipboard keeps its previous content.
 */
export async function copyBranchTree(dispatch: AppDispatch, topicId: string, branchId: string): Promise<number> {
  const sourceBranchId = normalizeRouteId(branchId)
  if (sourceBranchId === null) {
    logger.warn('[copyBranchTree] Branch capture requires an explicit branch; publishing nothing')
    return 0
  }

  let response: Awaited<ReturnType<typeof dbService.fetchClipboardTree>>
  try {
    response = await dbService.fetchClipboardTree({ topicId, branchId: sourceBranchId, capture: 'branch-owned' })
  } catch (error) {
    logger.error('[copyBranchTree] Failed to read the branch-owned closure; publishing nothing', error as Error)
    return 0
  }

  if (response.tree.roots.length === 0 || response.tree.messages.length === 0) {
    logger.warn('[copyBranchTree] Branch owns no capturable rows; publishing nothing')
    return 0
  }

  dispatch(
    setClipboard({
      mode: 'copy',
      // Explicit content kind: a tree closure is never flattened into ordinary
      // per-route groups, so a later paste cannot degrade into a plain paste.
      items: [],
      sourceTopicId: topicId,
      sourceBranchId,
      segmentSnapshots: [],
      tree: { payload: response.tree, meta: response.clipboard }
    })
  )

  logger.info(
    `[copyBranchTree] copy: ${response.clipboard.returnedMessageCount} messages from ${response.clipboard.returnedCount} trunk groups, ${response.clipboard.returnedBranchCount} branches, ${response.clipboard.returnedSegmentCount} segments`
  )
  return response.clipboard.returnedMessageCount
}

/**
 * Copy selected message groups to clipboard.
 *
 * Authority-complete under windowed loading: a selected group straddling the
 * loaded projection is copied with its complete ordered messages and blocks.
 * Read-only apart from the clipboard publication itself — Redux message and
 * block projections are never mutated. Returns the number of messages copied.
 *
 * With `options.includeChildBranches` the same selection is captured as ONE
 * tree closure instead (selected roots plus the child-branch subtrees anchored
 * at them); the ordinary path below is untouched.
 */
export async function copyMessages(
  dispatch: AppDispatch,
  topicId: string,
  selectedGroupIds: string[],
  branchId?: string | null,
  options?: ClipboardTreeOptions
): Promise<number> {
  if (options?.includeChildBranches === true) {
    return publishAuthorityClipboardTree(dispatch, topicId, selectedGroupIds, branchId, 'copy')
  }

  const payload = await buildAuthorityClipboardPayload(topicId, selectedGroupIds, branchId)

  if (!payload || payload.items.length === 0) {
    return 0
  }

  const stagedBranchId = typeof branchId === 'string' && branchId.length > 0 ? branchId : null
  dispatch(
    setClipboard({
      mode: 'copy',
      items: payload.items,
      sourceTopicId: topicId,
      sourceBranchId: stagedBranchId,
      segmentSnapshots: payload.segmentSnapshots
    })
  )

  const totalCount = payload.items.reduce((sum, item) => sum + item.messages.length, 0)
  logger.info(
    `[copyMessages] Copied ${totalCount} messages from ${payload.items.length} groups, ${payload.segmentSnapshots.length} segment snapshots`
  )
  return totalCount
}

/**
 * Cut selected message groups to clipboard.
 *
 * Same authority-complete clipboard publication as copy (mode `cut`); the
 * source deletion itself happens at paste time through the single semantic
 * delete transaction there. Read-only apart from the clipboard publication —
 * Redux message and block projections are never mutated. Returns the number
 * of messages cut.
 *
 * Service-level depth gate (BRANCH-12): the cut entry itself requires the
 * selection writable through the active route before any authority clipboard
 * read or `cut` publication — direct callers outside `useEditMode` fail
 * closed the same way. Copy stays ungated (read-only authority read).
 * Gate failure publishes nothing and issues no Main mutation (existing
 * warn-and-zero semantics, no new copy).
 *
 * With `options.includeChildBranches` the same selection is captured as ONE
 * tree closure (mode `cut`): the whole descendant closure is evaluated by
 * Main, and an inherited copy-only root makes the cut unavailable. The
 * ordinary path below is untouched.
 */
export async function cutMessages(
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  selectedGroupIds: string[],
  branchId?: string | null,
  options?: ClipboardTreeOptions
): Promise<number> {
  // Opt-in tree cut: same selection, same permission gate order — the
  // edit-selection mutability gate below runs first for both modes.
  const includeChildBranches = options?.includeChildBranches === true
  // Stable group IDs only (same contract as the authority payload builder).
  const rootIds = [...new Set(selectedGroupIds.filter((id) => typeof id === 'string' && id.length > 0))]
  if (rootIds.length === 0) {
    return 0
  }

  // Depth gate binds to the exact requested set (never a stale store copy).
  try {
    const { requireEditSelectionMutable } = await import('@renderer/store/editSelection')
    requireEditSelectionMutable(getState(), topicId, rootIds)
  } catch (error) {
    logger.warn('[cutMessages] Selection is immutable through this route; cut refused', error as Error)
    return 0
  }
  if (includeChildBranches) {
    return publishAuthorityClipboardTree(dispatch, topicId, rootIds, branchId, 'cut', getState)
  }

  const payload = await buildAuthorityClipboardPayload(topicId, rootIds, branchId)

  if (!payload || payload.items.length === 0) {
    return 0
  }

  // Staged-cut authority provenance: the addressed source route plus the
  // cut-time SOURCE projection eligibility are captured only after the cut
  // selection precheck above. The gate proves the selection writable through
  // the active loaded route, so the staged route must equal that active route
  // and the loaded ID list is the source eligibility snapshot. Paste addresses
  // the Main source delete with this staged route + eligibility without
  // rerequiring projection capability and without reading the (possibly
  // retargeted) live projection.
  const stagedBranchId = typeof branchId === 'string' && branchId.length > 0 ? branchId : null
  let activeSourceRoute: string | null = null
  try {
    activeSourceRoute = selectActiveBranchId(getState(), topicId)
  } catch {
    activeSourceRoute = null
  }
  if (stagedBranchId !== activeSourceRoute) {
    logger.warn('[cutMessages] Staged source route differs from the active loaded route; cut refused')
    return 0
  }
  const sourceLoadedIds = [...(getState().messages.messageIdsByTopic?.[topicId] ?? [])]
  dispatch(
    setClipboard({
      mode: 'cut',
      items: payload.items,
      sourceTopicId: topicId,
      sourceBranchId: stagedBranchId,
      segmentSnapshots: payload.segmentSnapshots,
      sourceProjection: { sourceTopicId: topicId, sourceBranchId: stagedBranchId, loadedMessageIds: sourceLoadedIds }
    })
  )

  const totalCount = payload.items.reduce((sum, item) => sum + item.messages.length, 0)
  logger.info(
    `[cutMessages] Cut ${totalCount} messages from ${payload.items.length} groups, ${payload.segmentSnapshots.length} segment snapshots`
  )
  return totalCount
}

/**
 * Paste clipboard content into the target topic with a stable insertion intent.
 * Returns the number of messages pasted (actual successfully inserted count).
 *
 * Authority: the renderer derives exactly one stable intent from target
 * semantics (selected target group → after-group-tail with that stable ID;
 * explicit no-target → topic-tail) and sends it to Main in ONE
 * `insertMessageGroups` call. No loaded-projection search ever produces a DB
 * index. A supplied target ID absent from the loaded projection is still
 * sent to Main unchanged (no loaded-tail fallback for persistence).
 * Local projection stays bounded: messages are spliced into the loaded list
 * only when the anchor/group is loaded (at its loaded group tail) or for a
 * topic-tail append; an outside-loaded anchor injects nothing and never
 * replaces the loaded list with an assumed whole topic.
 */
/**
 * Best-effort transactional rollback for a cut-paste whose source delete
 * failed after the target insert committed. Removes the fresh copies through
 * the existing plain authority delete path (same addressed target route),
 * including target segments created for the paste. Throws when the rollback
 * itself cannot complete; callers retain the staged clipboard and push no
 * undo in both cases.
 */
async function rollbackPastedCutCopies(
  dispatch: AppDispatch,
  getState: () => RootState,
  targetTopicId: string,
  targetBranchId: string | null,
  insertedMessageIds: string[],
  insertedBlockIds: string[],
  targetSegmentSnapshots: TopicSegment[]
): Promise<void> {
  if (targetSegmentSnapshots.length > 0) {
    await deleteSegmentsBySnapshots(dispatch, targetSegmentSnapshots, targetBranchId, getState)
  }
  if (insertedMessageIds.length > 0) {
    const cleanup = await deleteMessagesFromDB(targetTopicId, insertedMessageIds, targetBranchId)
    await consumeFileCleanupResult(cleanup)
    dispatch(newMessagesActions.removeMessages({ topicId: targetTopicId, messageIds: insertedMessageIds }))
    if (insertedBlockIds.length > 0) {
      dispatch(withClosureTopics(removeManyBlocks(insertedBlockIds), targetTopicId))
    }
    await syncSegmentsAfterMessageDeletion(dispatch, getState, targetTopicId, insertedMessageIds, targetBranchId)
  }
}
/**
 * Paste ONE tree clipboard capture: the entire opt-in copy/cut is a single
 * Main transaction (`chatdb:paste-clipboard-tree`).
 *
 * Authority: the target route is pinned explicitly here (never guessed, never
 * re-read after the command), the source route travels inside the capture, and
 * Main generates every fresh ID — the renderer pre-generates nothing, so the
 * returned snapshot and id map are the only truth about what was written.
 *
 * History: the whole command is ONE recorded action carrying Main's own
 * snapshot, never N ordinary operations. Ordering matters after Main commits:
 * file cleanup is consumed from the command's own affected set, the action is
 * recorded, a cut clears the clipboard, and only then does the projection
 * converge (so a convergence failure can never lose the recorded history or
 * resurrect a consumed cut payload). A Main-side failure happens before any of
 * that and leaves clipboard, selection, and history untouched.
 */
async function pasteTreeClipboard(
  dispatch: AppDispatch,
  getState: () => RootState,
  targetTopicId: string,
  targetMessageId: string,
  mode: ClipboardTreeMode | null
): Promise<number> {
  const state = getState()
  const capture = (state.clipboard as { tree?: ClipboardTreeCapture | null }).tree ?? null
  if (!capture) {
    logger.warn('[pasteTreeClipboard] No tree capture in the clipboard')
    return 0
  }
  if (mode !== 'copy' && mode !== 'cut') {
    logger.error('[pasteTreeClipboard] Tree capture without a mode; refusing paste before any write')
    throw new Error('[pasteTreeClipboard] Tree clipboard mode is missing')
  }

  // Pinned target route (null = main route). An unreadable store fails closed
  // instead of pasting into the main route by default.
  const targetBranchId = normalizeRouteId(requireActiveRouteOf(getState, targetTopicId))
  // Same stable intent shapes as the ordinary paste: the visually last selected
  // target group's tail, or the topic tail when nothing is selected.
  const intent: InsertMessageGroupIntent =
    typeof targetMessageId === 'string' && targetMessageId.length > 0
      ? { kind: 'after-group-tail', messageId: targetMessageId }
      : { kind: 'topic-tail' }

  let result: Awaited<ReturnType<typeof dbService.pasteClipboardTree>>
  try {
    result = await dbService.pasteClipboardTree({
      mode,
      payload: capture.payload,
      target: { topicId: targetTopicId, branchId: targetBranchId, intent }
    })
  } catch (error) {
    logger.error(
      '[pasteTreeClipboard] Main refused the tree paste; clipboard, selection and history untouched',
      error as Error
    )
    throw new Error(`[pasteTreeClipboard] Tree ${mode} failed: ${(error as Error)?.message ?? String(error)}`)
  }

  // File reference lifecycle from Main's own affected set: a copy insert never
  // deletes a physical file, a cut only after its source references are gone.
  await consumeFileCleanupResult(result)

  // ONE history action for the whole command (target insert + cut source
  // removal), replayable in both directions from Main's snapshot.
  const undoAction: ClipboardTreeUndoAction = {
    id: uuidv4(),
    type: 'clipboard_tree',
    timestamp: Date.now(),
    targetTopicId: result.targetTopicId,
    snapshot: result.snapshot
  }
  recordUndoAction(dispatch, undoAction)

  // A cut moved the source rows, so the staged payload is spent (current
  // semantics); a copy payload stays reusable.
  if (mode === 'cut') {
    dispatch(clearClipboard())
  }

  // Projection convergence for BOTH affected topics. Branch topology and the
  // segment catalog are re-read from Main; the message windows are committed
  // in place from the command's own transaction-scoped route deltas, so the
  // displayed route keeps every older page it already loaded instead of being
  // re-imaged by a whole-route reload.
  await convergeAfterClipboardTreeWrite(
    dispatch,
    getState,
    [result.targetTopicId, result.sourceTopicId],
    `pasteTreeClipboard:${mode}`,
    result.projections
  )

  logger.info(
    `[pasteTreeClipboard] ${mode}: ${result.insertedMessageIds.length} messages / ${result.insertedBranchIds.length} branches inserted, ${result.deletedSourceMessageIds.length} source messages removed`
  )
  return result.insertedMessageIds.length
}

export async function pasteMessages(
  dispatch: AppDispatch,
  getState: () => RootState,
  targetTopicId: string,
  targetMessageId: string
): Promise<number> {
  const state = getState()
  const { items: rawItems, mode, sourceTopicId, segmentSnapshots: clipboardSegmentSnapshots } = state.clipboard
  const stagedSourceBranchId = (state.clipboard as { sourceBranchId?: string | null }).sourceBranchId
  const stagedSourceProjection = (state.clipboard as { sourceProjection?: unknown }).sourceProjection as
    | StagedCutSourceProjection
    | null
    | undefined

  // Explicit tree content kind FIRST: a captured closure pastes through ONE
  // Main tree transaction even though it carries no ordinary `items`, so a tree
  // capture can never silently degrade into a single-route paste and an
  // ordinary copy can never be mistaken for a tree one.
  const treeCapture = (state.clipboard as { tree?: ClipboardTreeCapture | null }).tree ?? null
  if (treeCapture) {
    return pasteTreeClipboard(dispatch, getState, targetTopicId, targetMessageId, mode)
  }

  if (rawItems.length === 0) {
    logger.warn('[pasteMessages] Clipboard is empty')
    return 0
  }

  // Staged-cut provenance fail-closed BEFORE any paste write: the explicitly
  // staged source route + cut-time source projection eligibility address the
  // Main source delete independent of the current UI route, so a same-topic
  // branch switch (source branch != live route) must not refuse before
  // insertion. Missing legacy provenance (undefined), invalid route shapes,
  // and missing/mismatched source eligibility all reject with zero writes.
  // Ordinary copy paste skips this gate. Main owner guards stay final for
  // the staged addressed route.
  if (mode === 'cut' && sourceTopicId) {
    if (typeof stagedSourceBranchId === 'undefined') {
      logger.error('[pasteMessages] Missing staged cut route; refusing paste before any write')
      throw new Error('[pasteMessages] Missing staged cut route provenance')
    }
    if (
      stagedSourceBranchId !== null &&
      !(typeof stagedSourceBranchId === 'string' && stagedSourceBranchId.length > 0)
    ) {
      logger.error('[pasteMessages] Invalid staged cut route; refusing paste before any write')
      throw new Error('[pasteMessages] Invalid staged cut route provenance')
    }
    if (typeof stagedSourceProjection === 'undefined' || stagedSourceProjection === null) {
      logger.error('[pasteMessages] Missing staged cut source projection; refusing paste before any write')
      throw new Error('[pasteMessages] Missing staged cut source projection provenance')
    }
    if (
      typeof stagedSourceProjection !== 'object' ||
      stagedSourceProjection.sourceTopicId !== sourceTopicId ||
      stagedSourceProjection.sourceBranchId !== stagedSourceBranchId ||
      !Array.isArray(stagedSourceProjection.loadedMessageIds)
    ) {
      logger.error('[pasteMessages] Mismatched staged cut source projection; refusing paste before any write')
      throw new Error('[pasteMessages] Mismatched staged cut source projection provenance')
    }
  }

  // Sort items by their original position to preserve document order
  const items = [...rawItems].sort((a, b) => a.positionIndex - b.positionIndex)

  // Pre-batch ordered target loaded projection (captured BEFORE any DB or
  // Redux mutation; used ONLY for the bounded local projection commit, never
  // as an authority index).
  const targetMessages = (selectLoadedMessagesForTopic(state, targetTopicId) ?? []) as Message[]

  // Stable insertion intent for Main (authority). Never derived from loaded
  // positions: the supplied stable target ID travels unchanged even when it
  // is absent from the loaded projection.
  const stableIntent: InsertMessageGroupIntent =
    typeof targetMessageId === 'string' && targetMessageId.length > 0
      ? { kind: 'after-group-tail', messageId: targetMessageId }
      : { kind: 'topic-tail' }

  // Track file reference deltas for undo
  const fileReferenceDeltas: Array<{ fileId: string; delta: number }> = []
  const insertedMessageIds: string[] = []
  const allInsertedMessages: Message[] = []
  const allInsertedBlocks: MessageBlock[] = []

  // Cut source restoration material arrives from the single semantic delete
  // below (authority undo parts) — never from loaded-projection derivation,
  // so a straddling selection keeps its outside-loaded members for undo.
  // No pre-paste loaded read is needed: stable restore intents stay correct
  // for same-topic cut-paste because undo/redo resolve by stable anchor, not
  // by numeric position.
  let sourceGroupAnchors: GroupAnchor[] = []
  let sourceSegmentSnapshots: SegmentSnapshot[] = []
  // Inheritance boundaries the source delete moved (branch anchors of the
  // source topic, reference endpoints whose source route is the source topic).
  let sourceBoundarySnapshots: InheritanceBoundarySnapshot[] = []

  // ID mapping: original message ID → new message ID
  const idMapping = new Map<string, string>()

  // Ordered batch entries for the ONE `pasteMessagesToTopic` call.
  const entries: Array<{ message: Message; blocks: MessageBlock[] }> = []

  for (const item of items) {
    // First pass: generate new IDs for all messages in the group
    for (const originalMsg of item.messages) {
      idMapping.set(originalMsg.id, uuidv4())
    }

    // Second pass: create new messages and blocks with mapped IDs
    for (const originalMsg of item.messages) {
      const newMsgId = idMapping.get(originalMsg.id)!
      const clonedBlocksForMsg: MessageBlock[] = []

      // Create new block IDs and update references
      const newBlockIds: string[] = []
      for (const originalBlock of item.blocks) {
        if (originalBlock.messageId === originalMsg.id) {
          const newBlockId = uuidv4()
          const clonedBlock = {
            ...structuredClone(originalBlock),
            id: newBlockId,
            messageId: newMsgId
          }
          clonedBlocksForMsg.push(clonedBlock)
          newBlockIds.push(newBlockId)

          // Track file reference deltas
          if (clonedBlock.type === MessageBlockType.FILE || clonedBlock.type === MessageBlockType.IMAGE) {
            const file = (clonedBlock as FileMessageBlock | ImageMessageBlock).file
            if (file) {
              fileReferenceDeltas.push({ fileId: file.id, delta: 1 })
            }
          }
        }
      }

      // Create new message with updated IDs
      const newMessage: Message = {
        ...structuredClone(originalMsg),
        id: newMsgId,
        topicId: targetTopicId,
        blocks: newBlockIds
      }

      // Update askId for assistant messages
      if (newMessage.role === 'assistant' && originalMsg.askId) {
        const mappedAskId = idMapping.get(originalMsg.askId)
        if (mappedAskId) {
          newMessage.askId = mappedAskId
        } else {
          // Fallback: use the first message in this item as the group key
          const firstMsgInItem = item.messages[0]
          const mappedFirstId = idMapping.get(firstMsgInItem.id)
          newMessage.askId = mappedFirstId || newMsgId
        }
      }

      entries.push({ message: newMessage, blocks: clonedBlocksForMsg })
      allInsertedMessages.push(newMessage)
      allInsertedBlocks.push(...clonedBlocksForMsg)
      insertedMessageIds.push(newMsgId)
    }
  }

  // Addressed target route captured once for the whole paste (insert, segment
  // reconstruction, undo provenance, and cut-failure rollback share it). The
  // route is part of every group-mutation contract below, so an unresolvable
  // store fails closed instead of pasting into the main route by default.
  const liveTarget = requireActiveRouteOf(getState, targetTopicId)
  const targetBranchId: string | null = typeof liveTarget === 'string' && liveTarget.length > 0 ? liveTarget : null

  // DB-first (LOCK-001): ONE atomic stable insertion BEFORE any Redux commit.
  // If the batch fails, Redux is never touched and nothing is projected.
  // Main success publishes the exact final committed canonical wires plus
  // capability; the shared ack below installs rows+capability atomically.
  let insertAck: Awaited<ReturnType<typeof dbService.insertMessageGroups>>
  try {
    insertAck = await dbService.insertMessageGroups(
      targetTopicId,
      [{ entries: entries as unknown as MessageBlockEntry[], intent: stableIntent }],
      targetBranchId
    )
  } catch (error) {
    logger.error('[pasteMessages] Failed to persist paste batch to DB', error as Error)
    throw new Error(`[pasteMessages] DB batch write failed for ${entries.length} entries`)
  }

  // Bounded local projection via the shared Main acknowledgment: the ack's
  // stable neighbors decide placement against the current resident order;
  // pasted new rows enter only when the anchor is resident or the run is the
  // canonical topic-tail, otherwise nothing is injected. Capability comes
  // from Main only — never inferred from the request.
  publishInsertMessageGroupsAck(dispatch, targetTopicId, targetBranchId, insertAck, [insertedMessageIds])

  // Increment file reference counts for pasted content
  if (fileReferenceDeltas.length > 0) {
    for (const { fileId, delta } of fileReferenceDeltas) {
      await dbService.updateFileCount(fileId, delta, false)
    }
  }

  // Reconstruct segments from clipboard snapshots.
  // Post-commit bookkeeping coherence: the target insert above already
  // committed in Main. A convergence/upsert failure below must still retain
  // a usable undo entry for the persisted copies (no untracked commit), and
  // in cut mode the source must remain un-deleted when the target stage did
  // not fully complete. No new recovery subsystem: natural stage handling
  // with the existing postcommit-convergence conventions.
  const targetSegmentSnapshots: TopicSegment[] = []
  let targetStageError: unknown = null
  if (clipboardSegmentSnapshots && clipboardSegmentSnapshots.length > 0) {
    try {
      for (const clipSnap of clipboardSegmentSnapshots) {
        // Map original message IDs to new message IDs
        const newMessageIds: string[] = []
        let allMapped = true
        for (const origId of clipSnap.originalMessageIds) {
          const mappedId = idMapping.get(origId)
          if (mappedId) {
            newMessageIds.push(mappedId)
          } else {
            allMapped = false
            break
          }
        }

        // Skip if mapping is incomplete (some original IDs were not part of the paste)
        if (!allMapped || newMessageIds.length === 0) {
          logger.warn(
            `[pasteMessages] Skipping segment "${clipSnap.name}" — incomplete ID mapping (${newMessageIds.length}/${clipSnap.originalMessageIds.length})`
          )
          continue
        }

        // Create new segment with new ID in target topic.
        // DB-first: collect the Main wire mapping; Redux convergence happens
        // once below via a single list+replace so shifted siblings converge.
        const newId = uuidv4()
        const wire = await dbService.upsertSegment({
          segmentId: newId,
          topicId: targetTopicId,
          name: clipSnap.name,
          messageIds: newMessageIds,
          color: clipSnap.color,
          branchId: targetBranchId,
          folded: clipSnap.folded
        })
        const newSegment = mapSegmentWireToTopicSegment(wire)
        if (wire.name == null) newSegment.name = clipSnap.name
        targetSegmentSnapshots.push(newSegment)
      }

      // Batch convergence through the ONE preserving catalog publication:
      // exactly one authority list + atomic install with the resident target
      // window preserved (no transient blank). Superseded reads discard
      // silently inside converge (no throw); a real list failure throws and is
      // captured below for coherent undo bookkeeping.
      if (targetSegmentSnapshots.length > 0) {
        await convergeTopicSegmentCatalog(dispatch, targetTopicId, getState)
      }

      logger.info(
        `[pasteMessages] Reconstructed ${targetSegmentSnapshots.length} segments from ${clipboardSegmentSnapshots.length} clipboard snapshots`
      )
    } catch (error) {
      // Target stage did not fully complete: retain the wire snapshots
      // collected so far for undo (copies + committed segments stay tracked),
      // skip the source delete below, still push undo, then surface
      // truthfully. Never silently corrupt on retry: the pushed undo removes
      // exactly these copies/segments.
      targetStageError = error
      logger.error(
        '[pasteMessages] Target segment stage failed after insert commit; preserving copies with undo, source remains',
        error as Error
      )
    }
  }

  // If cut mode: remove COMPLETE stable source members through the staged-cut
  // authority transaction (cut-specific, no projection capability rerequire).
  // Stable member roots only — ALL complete clipboard member message IDs
  // (deduped, authority order), never just `originalAskId`. Main expands user
  // dependents, validates every root owner == staged addressed route with
  // all-owned atomicity, and returns the full authority undo snapshot. The
  // helper owns file cleanup, loaded-intersection removal, authority segment
  // convergence, and anchor transfer. Multi-group cuts stay one transaction.
  // Insert-first safety is preserved (source untouched when insertion fails).
  // Pre-commit source deletion failure rolls back the fresh copies through
  // the existing plain authority delete path (same addressed target route),
  // the staged clipboard is retained for retry, no cut_paste undo is pushed,
  // and the failure propagates (never swallowed as success).
  // Post-commit convergence failure (Main COMMITTED, typed committed marker):
  // the movement already happened — pasted copies are PRESERVED (no rollback),
  // the authoritative undo parts from the marker are retained, real cut
  // clipboard/undo bookkeeping finalizes below, and the convergence error is
  // surfaced truthfully only after that bookkeeping.
  let sourceRootIds: string[] = []
  let pendingPostCommitError: unknown = null
  // A failed target segment stage gates the cut source delete: the source
  // remains un-deleted and the staged clipboard is retained for retry. The
  // undo pushed below still tracks the persisted copies.
  const targetStageComplete = targetStageError === null
  if (mode === 'cut' && sourceTopicId && targetStageComplete) {
    const stableRoots = [
      ...new Set(
        items.flatMap((item) => item.messages.map((m) => m.id)).filter((id) => typeof id === 'string' && id.length > 0)
      )
    ]

    if (stableRoots.length > 0) {
      try {
        const result = await executeStagedCutSourceDelete(dispatch, getState, {
          sourceTopicId,
          sourceBranchId: stagedSourceBranchId as string | null,
          rootIds: stableRoots,
          sourceProjection: stagedSourceProjection as StagedCutSourceProjection
        })
        sourceGroupAnchors = result.undoParts.groupAnchors
        sourceSegmentSnapshots = result.undoParts.segmentSnapshots
        sourceBoundarySnapshots = result.undoParts.boundarySnapshots
        sourceRootIds = [...stableRoots]
      } catch (error) {
        if (isDeletePostCommitConvergenceError(error)) {
          // Committed: source rows are gone in Main. Never roll back the
          // surviving pasted copies and never claim a fake cut failure.
          sourceGroupAnchors = error.undoParts.groupAnchors
          sourceSegmentSnapshots = error.undoParts.segmentSnapshots
          sourceBoundarySnapshots = error.undoParts.boundarySnapshots
          sourceRootIds = [...stableRoots]
          pendingPostCommitError = error
          logger.error(
            '[pasteMessages] Cut source deleted but renderer convergence failed; preserving pasted copies with usable undo',
            error as Error
          )
        } else {
          logger.error('[pasteMessages] Cut source delete failed; rolling back pasted copies', error as Error)
          try {
            await rollbackPastedCutCopies(
              dispatch,
              getState,
              targetTopicId,
              targetBranchId,
              insertedMessageIds,
              allInsertedBlocks.map((b) => b.id),
              targetSegmentSnapshots
            )
          } catch (rollbackError) {
            logger.error('[pasteMessages] Cut rollback failed; clipboard retained without undo', rollbackError as Error)
            throw new Error(
              `[pasteMessages] Cut source delete failed and rollback incomplete for ${insertedMessageIds.length} copies: ${(error as Error)?.message ?? String(error)}`
            )
          }
          throw new Error(
            `[pasteMessages] Cut source delete failed; pasted copies rolled back: ${(error as Error)?.message ?? String(error)}`
          )
        }
      }
    }

    // LOCK-P5.3-1: No separate updateFileCount for source blocks here.
    // consumeFileCleanupResult inside the helper already handled physical
    // file cleanup via FileManager.deleteFile which decrements Dexie
    // files.count.

    // Clipboard clears only when the cut movement fully completed (target
    // stage complete + source delete attempted). A failed target stage
    // retains the staged clipboard for retry; a pre-commit source failure
    // above already threw after rollback with the clipboard retained.
    if (targetStageComplete) {
      dispatch(clearClipboard())
    }
  } else if (mode === 'cut' && sourceTopicId && !targetStageComplete) {
    // Target stage failed before any source write: source remains un-deleted
    // by construction (no delete attempted above); clipboard retained.
    logger.warn('[pasteMessages] Target stage incomplete; cut source untouched, clipboard retained')
  }

  // Create undo action
  // Calculate anchor: first non-pasted message after the published inserted
  // run in current loaded order when projected; otherwise null (tail). The
  // stable redo authority is `stableIntent` (never the numeric index).
  const finalTargetMessages = (selectLoadedMessagesForTopic(getState(), targetTopicId) ?? []) as Message[]
  const insertedIdSet = new Set(insertedMessageIds)
  let anchorMessageId: string | null = null
  {
    let firstInsertedIdx = -1
    for (let i = 0; i < finalTargetMessages.length; i++) {
      if (insertedIdSet.has(finalTargetMessages[i].id)) {
        firstInsertedIdx = i
        break
      }
    }
    if (firstInsertedIdx !== -1) {
      anchorMessageId = findAnchorAfterPosition(finalTargetMessages, firstInsertedIdx, insertedIdSet)
    }
  }
  const legacyPositionIndex = targetMessages.length

  if (mode === 'cut' && sourceTopicId) {
    const undoAction: CutPasteUndoAction = {
      id: uuidv4(),
      type: 'cut_paste',
      timestamp: Date.now(),
      targetTopicId: targetTopicId,
      insertedMessageIds,
      targetInsertPositionIndex: legacyPositionIndex,
      targetAnchorMessageId: anchorMessageId,
      targetInsertIntent: stableIntent,
      sourceTopicId,
      sourceBranchId: stagedSourceBranchId as string | null,
      targetBranchId,
      sourceRootIds,
      sourceProjection: stagedSourceProjection as StagedCutSourceProjection,
      sourceGroupAnchors,
      sourceSegmentSnapshots,
      sourceBoundarySnapshots,
      targetSegmentSnapshots,
      pastedMessagesSnapshot: allInsertedMessages,
      pastedBlocksSnapshot: allInsertedBlocks,
      fileReferenceDeltas
    }
    recordUndoAction(dispatch, undoAction)
  } else {
    const undoAction: PasteUndoAction = {
      id: uuidv4(),
      type: 'paste',
      timestamp: Date.now(),
      targetTopicId: targetTopicId,
      insertedMessageIds,
      targetInsertPositionIndex: legacyPositionIndex,
      targetAnchorMessageId: anchorMessageId,
      targetInsertIntent: stableIntent,
      // The route this paste actually wrote into: undo/redo address it instead
      // of whatever route happens to be active later.
      targetBranchId,
      targetSegmentSnapshots,
      pastedMessagesSnapshot: allInsertedMessages,
      pastedBlocksSnapshot: allInsertedBlocks,
      fileReferenceDeltas
    }
    recordUndoAction(dispatch, undoAction)
  }

  // Committed convergence failure surfaces AFTER real cut bookkeeping above
  // (clipboard cleared, usable cut_paste undo pushed, copies preserved).
  if (pendingPostCommitError !== null) {
    throw new Error(
      `[pasteMessages] Cut source deleted; renderer convergence failed after commit (pasted copies preserved): ${(pendingPostCommitError as Error)?.message ?? String(pendingPostCommitError)}`
    )
  }

  // Target segment stage failed AFTER the insert commit: the undo above
  // already tracks the persisted copies (+ committed wire snapshots), the cut
  // source remains un-deleted, and the clipboard is retained. Surface
  // truthfully so retry/undo stays explicit (never swallowed as success).
  if (targetStageError !== null) {
    throw new Error(
      `[pasteMessages] Target segment convergence failed after insert commit (copies preserved with undo): ${(targetStageError as Error)?.message ?? String(targetStageError)}`
    )
  }

  logger.info(
    `[pasteMessages] Pasted ${insertedMessageIds.length} messages from ${items.length} groups with stable intent ${stableIntent.kind}`
  )
  return insertedMessageIds.length
}

/**
 * Delete selected message groups WITH their child-branch subtrees in edit mode.
 * Returns the number of messages deleted (authority-expanded count).
 *
 * Same source scope as the tree cut (selected owned roots plus the
 * child-branch subtrees anchored on them) but with no target insert, no
 * clipboard write and no paste: ONE Main `chatdb:delete-clipboard-tree`
 * transaction. A Main refusal throws so the menu layer can toast, leaving
 * clipboard, selection and history untouched. On success the whole command is
 * ONE `clipboard_tree` history action replayable in both directions from
 * Main's delete snapshot, and the projection converges in place from the
 * command's own route deltas.
 */
export async function deleteTreeSelectedMessages(
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  selectedGroupIds: string[],
  branchId?: string | null
): Promise<number> {
  // Stable root IDs only (dedupe defense-in-depth; Main rejects duplicates).
  const rootIds = [...new Set(selectedGroupIds.filter((id) => typeof id === 'string' && id.length > 0))]
  if (rootIds.length === 0) {
    return 0
  }

  // Same permission gate as the tree cut: the whole selection must be writable
  // through the active route — one non-owned member blocks the entire batch
  // with zero IPC calls. Main stays final for expansion.
  try {
    const { requireEditSelectionMutable } = await import('@renderer/store/editSelection')
    requireEditSelectionMutable(getState(), topicId, rootIds)
  } catch (error) {
    logger.warn(
      '[deleteTreeSelectedMessages] Selection is immutable through this route; delete refused',
      error as Error
    )
    return 0
  }

  // Staged-delete route provenance: the addressed source route must still be
  // the active loaded route (same gate as the tree cut).
  const stagedBranchId = normalizeRouteId(branchId)
  let activeSourceRoute: string | null = null
  try {
    activeSourceRoute = selectActiveBranchId(getState(), topicId)
  } catch {
    activeSourceRoute = null
  }
  if (stagedBranchId !== activeSourceRoute) {
    logger.warn('[deleteTreeSelectedMessages] Staged source route differs from the active loaded route; delete refused')
    return 0
  }

  // ONE Main transaction: selected owned roots plus the child-branch subtrees
  // anchored on them. No clipboard write, no paste.
  let result: Awaited<ReturnType<typeof dbService.deleteClipboardTree>>
  try {
    result = await dbService.deleteClipboardTree({ topicId, branchId: stagedBranchId, groupIds: rootIds })
  } catch (error) {
    logger.error(
      '[deleteTreeSelectedMessages] Main refused the tree delete; clipboard, selection and history untouched',
      error as Error
    )
    throw new Error(`[deleteTreeSelectedMessages] Tree delete failed: ${(error as Error)?.message ?? String(error)}`)
  }

  await consumeFileCleanupResult(result)

  // ONE history action for the whole command, replayable in both directions
  // from Main's delete snapshot (undo restores, redo re-deletes).
  const undoAction: ClipboardTreeUndoAction = {
    id: uuidv4(),
    type: 'clipboard_tree',
    timestamp: Date.now(),
    targetTopicId: result.topicId,
    snapshot: result.snapshot
  }
  recordUndoAction(dispatch, undoAction)

  await convergeAfterClipboardTreeWrite(
    dispatch,
    getState,
    [result.topicId],
    'deleteTreeClipboard:delete',
    result.projections
  )

  logger.info(
    `[deleteTreeSelectedMessages] Deleted ${result.deletedMessageIds.length} messages / ${result.deletedBranchIds.length} branches from ${rootIds.length} groups`
  )
  return result.deletedMessageIds.length
}

/**
 * Delete selected message groups in edit mode.
 * Returns the number of messages deleted (authority-expanded count).
 *
 * Unified semantic path: stable selected group IDs are passed as root IDs
 * ONLY — Main expands user dependents, deletes atomically, and returns the
 * full authority undo snapshot. No loaded-projection cascade derivation, no
 * window-relative anchors, no loaded block/segment snapshots as undo source.
 * DB failure leaves Redux/anchors untouched and pushes no undo.
 */
export async function deleteSelectedMessages(
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  selectedGroupIds: string[]
): Promise<number> {
  // Stable root IDs only (dedupe defense-in-depth; Main rejects duplicates).
  const rootIds = [...new Set(selectedGroupIds.filter((id) => typeof id === 'string' && id.length > 0))]
  if (rootIds.length === 0) {
    return 0
  }

  // BRANCH-12: the whole selection must be writable through the
  // active route — one non-owned member blocks the entire batch with zero IPC
  // calls (no skip-and-partial-write). Main stays final for expansion.
  // The gate binds to the requested root IDs (never a stale store copy).
  try {
    const { requireEditSelectionMutable } = await import('@renderer/store/editSelection')
    requireEditSelectionMutable(getState(), topicId, rootIds)
  } catch (error) {
    logger.warn('[deleteSelectedMessages] Selection is immutable through this route; delete refused', error as Error)
    return 0
  }

  // Unified semantic delete: DB-first, then one converged projection update
  // (cleanup consume, loaded-intersection removal, full segment replace,
  // authority-key anchor transfer) inside the helper.
  let result: Awaited<ReturnType<typeof executeDeleteMessagesWithDependents>>
  try {
    result = await executeDeleteMessagesWithDependents(dispatch, getState, topicId, rootIds)
  } catch (error) {
    logger.error('[deleteSelectedMessages] Failed to delete from DB', error as Error)
    return 0
  }

  // LOCK-P5.3-1: No separate updateFileCount here. consumeFileCleanupResult
  // inside the helper already handled physical file cleanup via
  // FileManager.deleteFile which decrements Dexie files.count. A second
  // dbService.updateFileCount would double-decrement the same references.

  // Undo from the authority snapshot (never loaded projection).
  const undoAction: DeleteUndoAction = {
    id: uuidv4(),
    type: 'delete',
    timestamp: Date.now(),
    targetTopicId: topicId,
    rootMessageIds: rootIds,
    deletedBranchId: result.addressedRoute,
    insertedMessageIds: result.response.deletedMessageIds,
    pastedMessagesSnapshot: [],
    pastedBlocksSnapshot: [],
    fileReferenceDeltas: result.undoParts.fileReferenceDeltas,
    groupAnchors: result.undoParts.groupAnchors,
    segmentSnapshots: result.undoParts.segmentSnapshots,
    boundarySnapshots: result.undoParts.boundarySnapshots
  }

  recordUndoAction(dispatch, undoAction)

  logger.info(
    `[deleteSelectedMessages] Deleted ${result.response.deletedMessageIds.length} messages from ${rootIds.length} groups`
  )
  return result.response.deletedMessageIds.length
}

/**
 * Delete a single message with undo support.
 *
 * Unified semantic path: the message ID is passed as the single stable root
 * — Main resolves dependents (user + same-askId assistants, or single
 * non-user) and returns the authority undo snapshot. The menu confirm dialog
 * and trace cleanup stay at the Menu/hook layer; this function ends at the
 * semantic command. DB failure leaves Redux/anchors untouched and pushes no
 * undo.
 */
export async function deleteSingleMessage(
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  message: Message
): Promise<void> {
  const state = getState()
  const msg = state.messages.entities[message.id]
  if (!msg) return

  // Unified semantic delete: DB-first, then one converged projection update
  // inside the helper (cleanup consume, loaded-intersection removal, full
  // segment replace, authority-key anchor transfer).
  let result: Awaited<ReturnType<typeof executeDeleteMessagesWithDependents>>
  try {
    result = await executeDeleteMessagesWithDependents(dispatch, getState, topicId, [message.id])
  } catch (error) {
    // Main validation/not-found failures are never silent: unified toast.
    logger.error('[deleteSingleMessage] Failed to delete from DB', error as Error)
    window.toast.error(t('common.delete_failed'))
    return
  }

  // LOCK-P5.3-1: No separate updateFileCount here. consumeFileCleanupResult
  // inside the helper already handled physical file cleanup via
  // FileManager.deleteFile which decrements Dexie files.count. A second
  // dbService.updateFileCount would double-decrement the same references.

  // Undo from the authority snapshot (never loaded projection).
  const undoAction: DeleteUndoAction = {
    id: uuidv4(),
    type: 'delete',
    timestamp: Date.now(),
    targetTopicId: topicId,
    rootMessageIds: [message.id],
    deletedBranchId: result.addressedRoute,
    insertedMessageIds: result.response.deletedMessageIds,
    pastedMessagesSnapshot: [],
    pastedBlocksSnapshot: [],
    fileReferenceDeltas: result.undoParts.fileReferenceDeltas,
    groupAnchors: result.undoParts.groupAnchors,
    segmentSnapshots: result.undoParts.segmentSnapshots,
    boundarySnapshots: result.undoParts.boundarySnapshots
  }

  recordUndoAction(dispatch, undoAction)

  logger.info(
    `[deleteSingleMessage] Deleted ${result.response.deletedMessageIds.length} messages from topic ${topicId}`
  )
}
