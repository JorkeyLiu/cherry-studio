import { loggerService } from '@logger'
import { copyMessages, cutMessages, deleteSelectedMessages, pasteMessages } from '@renderer/services/ClipboardService'
import { executeRedo, executeUndo } from '@renderer/services/UndoService'

const logger = loggerService.withContext('useEditMode')
import store, { useAppDispatch, useAppSelector, useAppStore } from '@renderer/store'
import {
  clearSelection,
  extendSelectionRange,
  finishProcessing,
  moveFocusSelection,
  setAnchorGroupId,
  setFocusedGroupId,
  setFocusedIndex,
  setLastSelectedIndex,
  setSelectedGroupIds,
  startProcessing,
  toggleEditMode as toggleEditModeAction
} from '@renderer/store/editMode'
import { requireEditSelectionMutable, selectIsEditSelectionMutable } from '@renderer/store/editSelection'
import { selectLoadedMessagesForTopic } from '@renderer/store/newMessage'
import { selectActiveBranchId } from '@renderer/store/topicBranch'
import type { EditSelectionBoundaryPageRequest } from '@renderer/types/editMode'
import type { Message } from '@renderer/types/newMessage'
import { loadWholeTopicSnapshot, type WholeTopicSnapshot } from '@renderer/utils/topicSnapshot'
import i18n from 'i18next'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { getGroupIndex, getMessageGroups, type MessageGroup, useMessageGroups } from './useMessageGroup'

/** Stable empty overlay map (keeps memo identities while no range view is held). */
const EMPTY_GROUP_MAP: ReadonlyMap<string, MessageGroup> = new Map()

function sameGroupIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function useCreateEditMode(
  topicId: string,
  scrollToGroup?: (askId: string) => void,
  visibleGroupIds?: Set<string>,
  requestBoundaryPage?: EditSelectionBoundaryPageRequest
) {
  const dispatch = useAppDispatch()

  // State — precise selectors
  const isEnabled = useAppSelector((state) => state.editMode.enabled)
  const isProcessing = useAppSelector((state) => state.editMode.isProcessing)
  const selectedGroupIds = useAppSelector((state) => state.editMode.selectedGroupIds)
  const lastSelectedIndex = useAppSelector((state) => state.editMode.lastSelectedIndex)
  const anchorGroupId = useAppSelector((state) => state.editMode.anchorGroupId)
  const focusedGroupId = useAppSelector((state) => state.editMode.focusedGroupId)
  const focusedIndex = useAppSelector((state) => state.editMode.focusedIndex)
  const clipboard = useAppSelector((state) => state.clipboard)
  const undoStack = useAppSelector((state) => state.undoStack)
  // Bounded loaded projection: resident topic only. The `?? []` fallback is
  // memoized so the edit-group memo keeps a stable identity while non-resident
  // (`undefined` stays at the API boundary).
  const loadedMessages = useAppSelector((state) => selectLoadedMessagesForTopic(state, topicId))
  const activeBranchId = useAppSelector((state) => selectActiveBranchId(state, topicId))
  const messages = useMemo(() => (loadedMessages ?? []) as Message[], [loadedMessages])

  // 消息组
  const allGroups = useMessageGroups(messages)
  // 使用已渲染的组（分页可见），若未传则使用全部。这个更窄的集合只限定
  // 点击/键盘导航的落点范围，不代表选择集本身。
  const groups = useMemo(() => {
    if (!visibleGroupIds) return allGroups
    return allGroups.filter((g) => visibleGroupIds.has(g.askId))
  }, [allGroups, visibleGroupIds])

  const appStore = useAppStore()
  // 当前 route 标识 — 跨窗口范围读取绑定到发起请求时的那一条 route。
  const routeKey = `${topicId}::${activeBranchId ?? 'main'}`
  // 跨窗口 Shift 范围的渲染层视图：只为让选区展示/工具栏计数覆盖窗口外
  // 的组成员，永不写回普通 Redux 消息/块投影（投影完备性不因此改变）。
  const [rangeOverlay, setRangeOverlay] = useState<{ routeKey: string; byAskId: Map<string, MessageGroup> }>({
    routeKey: '',
    byAskId: new Map()
  })
  const rangeOverlayByAskId = rangeOverlay.routeKey === routeKey ? rangeOverlay.byAskId : EMPTY_GROUP_MAP
  // 发起时状态快照 + 单飞令牌：迟到结果只允许落到发起请求时的那一份意图上。
  const rangeRequestTokenRef = useRef(0)
  // 选择意图令牌：范围请求之间的先后由 rangeRequestTokenRef 表达，但"范围请求
  // 之后发生的其它选择交互"无法靠比较状态区分 —— 用户清空后又选回同一 anchor
  // 时，旧请求的基线快照与新意图的状态恰好相等，迟到的完整快照会把旧范围重新
  // 盖上去。因此每个会真正改变选区的同步入口都推进本令牌，让在途范围请求失效。
  const selectionIntentTokenRef = useRef(0)
  const liveRef = useRef({ topicId, branchId: activeBranchId })
  liveRef.current = { topicId, branchId: activeBranchId }

  // W3: 切换 topic 时清空选择
  useEffect(() => {
    dispatch(clearSelection())
    setRangeOverlay({ routeKey: '', byAskId: new Map() })
  }, [topicId, dispatch])

  // BRANCH-12: route 切换清空选择 — 避免残留计数误导写门禁；
  // 能力 route 不匹配本身也会使写 fail-closed（双保险）。
  useEffect(() => {
    dispatch(clearSelection())
    setRangeOverlay({ routeKey: '', byAskId: new Map() })
  }, [activeBranchId, dispatch])

  // BRANCH-12: 当前选集是否可写 — 每个选中组的全部 loaded 消息都
  // 在当前 route mutableMessageIds 中；未知/残留/不完整 fail-closed。
  // Copy 保持允许（authority 读取），不经此门禁。
  const isSelectionMutable = useAppSelector((state) => selectIsEditSelectionMutable(state, topicId))

  // 选中的消息组 — 从 loaded projection 解析，与写能力（editSelection 的
  // 解析投影）保持一致。滚动/跳转导航（例如“回到底部”）只会改变渲染窗口，
  // 不会改变选择本身：若用 visibleGroupIds 过滤，已选组一旦移出渲染窗口就
  // 会被展示成“0 selected”，而 authority 层的选择仍然存在 —— 选择看起来
  // 被清除但写操作仍指向它。
  // 跨窗口 Shift 范围的组不在已加载投影里，若只按 loaded 投影解析，工具栏
  // 会把它们显示成“未选中”。顺序跟随选择自身（范围本身即权威顺序）；已加载
  // 组优先，窗口外的组由本次范围读取的渲染层视图补齐。
  const selectedGroups = useMemo(() => {
    if (selectedGroupIds.length === 0) return []
    const loadedByAskId = new Map(allGroups.map((group) => [group.askId, group]))
    const resolved: MessageGroup[] = []
    for (const askId of selectedGroupIds) {
      const group = loadedByAskId.get(askId) ?? rangeOverlayByAskId.get(askId)
      if (group) resolved.push(group)
    }
    return resolved
  }, [allGroups, selectedGroupIds, rangeOverlayByAskId])

  // Toggle 编辑模式
  const toggleEditMode = useCallback(
    (enabled: boolean) => {
      dispatch(toggleEditModeAction(enabled))
    },
    [dispatch]
  )

  /**
   * 标记一次新的选择意图：推进令牌，使在途的跨窗口范围请求在落地时失效。
   * 只在本 hook 的选择入口调用（点击/清空/键盘选区），不引入跨进程状态。
   */
  const noteSelectionIntent = useCallback(() => {
    selectionIntentTokenRef.current += 1
  }, [])

  /**
   * Shift 范围的跨窗口解析。
   *
   * 锚点与目标都是稳定组 ID；已渲染窗口只能给它们提供一个不相交的落点视图，
   * 一旦锚点已被导航移出渲染窗口，同步 slice 就只能看到窗口内的组，中间未
   * 加载的组会被静默丢掉。这里按需读一次调用者本地完整 route 快照（含当前
   * route 的完整顺序），用两端稳定 ID 解析真实闭区间，绝不按显示
   * 索引或 ID 字符串排序猜测范围。
   *
   * 快照是短生命周期读取：结果只用于选择组 ID 列表与渲染层计数视图，不写回
   * 普通 Redux 消息/块投影。迟到结果只允许落到发起请求时的那一份意图上 ——
   * 退出编辑模式、切换 topic/route、或期间发生任何普通选择/清空，都必须保持
   * 现状；端点缺失或读取失败则保持旧选择，不发布任何部分范围。
   */
  const requestCompleteRange = useCallback(
    (targetAskId: string, anchorId: string, isCtrl: boolean) => {
      const token = rangeRequestTokenRef.current + 1
      rangeRequestTokenRef.current = token
      const requestedTopicId = liveRef.current.topicId
      const requestedBranchId = liveRef.current.branchId
      const requestedRouteKey = `${requestedTopicId}::${requestedBranchId ?? 'main'}`
      const baselineSelection = [...(appStore.getState().editMode.selectedGroupIds ?? [])]
      // 发起时的选择意图代际：之后任何选择交互都会推进它，本请求随即作废。
      const intentToken = selectionIntentTokenRef.current

      void (async () => {
        let snapshot: WholeTopicSnapshot
        try {
          snapshot = await loadWholeTopicSnapshot(requestedTopicId, requestedBranchId)
        } catch (error) {
          if (token !== rangeRequestTokenRef.current) return
          if (intentToken !== selectionIntentTokenRef.current) return
          logger.warn('[handleGroupClick] Complete route snapshot unavailable; shift range not applied', error as Error)
          return
        }

        // Superseded by a newer range request: that one owns the selection.
        if (token !== rangeRequestTokenRef.current) return
        // Superseded by a later selection interaction (click / clear / keyboard
        // selection): the newer intent owns the selection even when its state
        // happens to equal this request's baseline.
        if (intentToken !== selectionIntentTokenRef.current) return

        const editState = appStore.getState().editMode
        if (!editState.enabled) return
        if (liveRef.current.topicId !== requestedTopicId || liveRef.current.branchId !== requestedBranchId) return
        if (editState.anchorGroupId !== anchorId) return
        if (!sameGroupIds(editState.selectedGroupIds ?? [], baselineSelection)) return

        const completeGroups = getMessageGroups(snapshot.messages)
        const anchorIndex = getGroupIndex(completeGroups, anchorId)
        const targetIndex = getGroupIndex(completeGroups, targetAskId)
        if (anchorIndex < 0 || targetIndex < 0) {
          logger.warn(
            `[handleGroupClick] Shift range endpoints missing from route ${requestedRouteKey}; selection unchanged`
          )
          return
        }

        const start = Math.min(anchorIndex, targetIndex)
        const end = Math.max(anchorIndex, targetIndex)
        const rangeGroups = completeGroups.slice(start, end + 1)
        const rangeAskIds = rangeGroups.map((group) => group.askId)
        const nextSelection = isCtrl ? [...new Set([...baselineSelection, ...rangeAskIds])] : rangeAskIds

        setRangeOverlay((previous) => {
          const byAskId =
            previous.routeKey === requestedRouteKey ? new Map(previous.byAskId) : new Map<string, MessageGroup>()
          for (const group of rangeGroups) byAskId.set(group.askId, group)
          return { routeKey: requestedRouteKey, byAskId }
        })
        dispatch(setSelectedGroupIds(nextSelection))
      })()
    },
    [appStore, dispatch]
  )

  // 点击选择消息组
  const handleGroupClick = useCallback(
    (askId: string, isCtrl: boolean, isShift: boolean) => {
      if (!isEnabled) return
      // Every click is a fresh selection intent: a click invalidates any range
      // request still in flight, including one whose baseline looks identical.
      noteSelectionIntent()

      if (isShift) {
        // Shift 区域选。两端都在渲染窗口内时保持既有同步 slice 语义；任何
        // 一端在窗口外，就由完整 route 快照解析闭区间（见 requestCompleteRange）。
        if (!anchorGroupId) return
        const anchorGroupIndex = getGroupIndex(groups, anchorGroupId)
        const targetGroupIndex = getGroupIndex(groups, askId)
        if (anchorGroupIndex < 0 || targetGroupIndex < 0) {
          requestCompleteRange(askId, anchorGroupId, isCtrl)
          return
        }

        const start = Math.min(anchorGroupIndex, targetGroupIndex)
        const end = Math.max(anchorGroupIndex, targetGroupIndex)
        const rangeAskIds = groups.slice(start, end + 1).map((g) => g.askId)

        if (isCtrl) {
          // Ctrl+Shift: 并集
          const newSelection = [...new Set([...selectedGroupIds, ...rangeAskIds])]
          dispatch(setSelectedGroupIds(newSelection))
        } else {
          // Shift only: 替换
          dispatch(setSelectedGroupIds(rangeAskIds))
        }
        return
      }

      const groupIndex = getGroupIndex(groups, askId)
      if (groupIndex === -1) return

      if (isCtrl) {
        // Ctrl 点选：切换
        const index = selectedGroupIds.indexOf(askId)
        if (index >= 0) {
          dispatch(setSelectedGroupIds(selectedGroupIds.filter((id) => id !== askId)))
          if (anchorGroupId === askId) dispatch(setAnchorGroupId(null))
          if (focusedGroupId === askId) dispatch(setFocusedGroupId(null))
        } else {
          dispatch(setSelectedGroupIds([...selectedGroupIds, askId]))
        }
      } else {
        // 普通点击
        const isSelected = selectedGroupIds.includes(askId)
        if (isSelected && selectedGroupIds.length === 1) {
          // 点击唯一选中的 → 取消选中
          dispatch(clearSelection())
        } else {
          // 单选
          dispatch(setSelectedGroupIds([askId]))
        }
      }

      dispatch(setLastSelectedIndex(groupIndex))
      dispatch(setFocusedIndex(groupIndex))
      dispatch(setAnchorGroupId(askId))
      dispatch(setFocusedGroupId(askId))
    },
    [
      dispatch,
      groups,
      selectedGroupIds,
      anchorGroupId,
      focusedGroupId,
      isEnabled,
      requestCompleteRange,
      noteSelectionIntent
    ]
  )

  // 复制
  const handleCopy = useCallback(() => {
    if (isProcessing) return
    if (!isEnabled || selectedGroupIds.length === 0) return
    dispatch(startProcessing())
    // Authority-complete clipboard read (caller-local whole-topic snapshot).
    // Fire-and-forget: copy is read-only apart from the clipboard publication
    // and reports expected snapshot failures as a zero count
    // (no success toast), matching the existing zero-selection semantics.
    // Unexpected rejections are logged via loggerService (never console).
    // The lock always releases in finally.
    void (async () => {
      try {
        const count = await copyMessages(dispatch, topicId, selectedGroupIds, activeBranchId)
        if (count > 0) {
          window.toast.success(i18n.t('chat.edit.copied', { count }))
        }
      } catch (error) {
        logger.error('[handleCopy] Unexpected copy failure', error as Error)
      } finally {
        dispatch(finishProcessing())
      }
    })()
  }, [dispatch, isEnabled, isProcessing, topicId, selectedGroupIds, activeBranchId])

  // 剪切
  const handleCut = useCallback(() => {
    if (isProcessing) return
    if (!isEnabled || selectedGroupIds.length === 0) return
    // BRANCH-12: 选集不可变时零 clipboard cut、零 Main mutation、零 Redux
    // 变化。Copy 保持允许；cut 的 clipboard 发布本身即写意图，故同样阻断。
    try {
      requireEditSelectionMutable(store.getState(), topicId, selectedGroupIds)
    } catch (error) {
      logger.warn('[handleCut] Selection is immutable through this route; cut refused', error as Error)
      return
    }
    dispatch(startProcessing())
    // Same authority-complete publication as copy (mode `cut`); the source
    // deletion itself happens at paste time. Failure semantics as handleCopy.
    void (async () => {
      try {
        const count = await cutMessages(dispatch, store.getState, topicId, selectedGroupIds, activeBranchId)
        if (count > 0) {
          window.toast.success(i18n.t('chat.edit.cut', { count }))
        }
      } catch (error) {
        logger.error('[handleCut] Unexpected cut failure', error as Error)
      } finally {
        dispatch(finishProcessing())
      }
    })()
  }, [dispatch, isEnabled, isProcessing, topicId, selectedGroupIds, activeBranchId])

  // 粘贴
  const handlePaste = useCallback(async () => {
    if (isProcessing) return
    if (!isEnabled) return
    dispatch(startProcessing())
    try {
      if (clipboard.items.length === 0) {
        window.toast.info(i18n.t('chat.edit.clipboardEmpty'))
        return
      }
      // Find the visually last selected group (highest position in topic)
      let lastSelectedAskId = ''
      if (selectedGroupIds.length > 0) {
        let maxIndex = -1
        for (const askId of selectedGroupIds) {
          const groupIndex = groups.findIndex((g) => g.askId === askId)
          if (groupIndex > maxIndex) {
            maxIndex = groupIndex
            lastSelectedAskId = askId
          }
        }
        if (!lastSelectedAskId) {
          lastSelectedAskId = selectedGroupIds[selectedGroupIds.length - 1]
        }
      }
      const count = await pasteMessages(dispatch, store.getState, topicId, lastSelectedAskId)
      if (count > 0) {
        window.toast.success(i18n.t('chat.edit.pasted', { count }))
      }
      dispatch(clearSelection())
    } finally {
      dispatch(finishProcessing())
    }
  }, [dispatch, isEnabled, isProcessing, topicId, clipboard, selectedGroupIds, groups])

  // 删除
  const handleDelete = useCallback(async () => {
    if (isProcessing) return
    if (!isEnabled || selectedGroupIds.length === 0) return
    // BRANCH-12: 选集不可变时零 Main mutation、零 Redux 变化。
    // 含一个 non-owned 即整体阻断（require 内逐成员验证，不跳过）。
    try {
      requireEditSelectionMutable(store.getState(), topicId, selectedGroupIds)
    } catch (error) {
      logger.warn('[handleDelete] Selection is immutable through this route; delete refused', error as Error)
      return
    }
    dispatch(startProcessing())
    try {
      const count = await deleteSelectedMessages(dispatch, store.getState, topicId, selectedGroupIds)
      if (count > 0) {
        window.toast.success(i18n.t('chat.edit.deleted', { count }))
      }
      dispatch(clearSelection())
    } finally {
      dispatch(finishProcessing())
    }
  }, [dispatch, isEnabled, isProcessing, topicId, selectedGroupIds])

  // 撤销
  const handleUndo = useCallback(async () => {
    if (isProcessing) return
    dispatch(startProcessing())
    try {
      const action = await executeUndo(dispatch, store.getState)
      if (action) {
        window.toast.success(i18n.t('chat.edit.undone'))
      }
    } finally {
      dispatch(finishProcessing())
    }
  }, [dispatch, isProcessing])

  // 重做
  const handleRedo = useCallback(async () => {
    if (isProcessing) return
    dispatch(startProcessing())
    try {
      const action = await executeRedo(dispatch, store.getState)
      if (action) {
        window.toast.success(i18n.t('chat.edit.redone'))
      }
    } finally {
      dispatch(finishProcessing())
    }
  }, [dispatch, isProcessing])

  // 移动焦点（单选光标）
  const handleMoveFocus = useCallback(
    (direction: 'up' | 'down') => {
      if (groups.length === 0) return
      const resolvedFocusIndex = focusedGroupId ? getGroupIndex(groups, focusedGroupId) : -1
      const currentIndex = resolvedFocusIndex >= 0 ? resolvedFocusIndex : (focusedIndex ?? lastSelectedIndex ?? -1)
      const maxIndex = groups.length - 1

      let newIndex: number
      if (direction === 'up') {
        // groups 按时间正序：索引越小越旧（视觉越靠上），Up 键向更早消息移动
        newIndex = Math.max(currentIndex - 1, 0)
      } else {
        // Down 键向更新消息移动（索引增大）
        newIndex = Math.min(currentIndex + 1, maxIndex)
      }

      if (newIndex === currentIndex) return

      const targetGroup = groups[newIndex]
      if (targetGroup) {
        // Keyboard single-selection is a selection intent of its own.
        noteSelectionIntent()
        dispatch(moveFocusSelection({ groupId: targetGroup.askId, index: newIndex }))
        scrollToGroup?.(targetGroup.askId)
      }
    },
    [dispatch, groups, lastSelectedIndex, focusedIndex, focusedGroupId, scrollToGroup, noteSelectionIntent]
  )

  // 扩展选区（Shift+箭头）
  const handleExtendSelection = useCallback(
    (direction: 'up' | 'down') => {
      if (groups.length === 0) return
      const resolvedAnchorIndex = anchorGroupId ? getGroupIndex(groups, anchorGroupId) : -1
      const resolvedFocusIndex = focusedGroupId ? getGroupIndex(groups, focusedGroupId) : -1
      if ((anchorGroupId && resolvedAnchorIndex < 0) || (focusedGroupId && resolvedFocusIndex < 0)) return
      const anchorIndex = resolvedAnchorIndex >= 0 ? resolvedAnchorIndex : (lastSelectedIndex ?? 0)
      const currentFocus = resolvedFocusIndex >= 0 ? resolvedFocusIndex : (focusedIndex ?? anchorIndex)

      let newFocus: number
      if (direction === 'up') {
        newFocus = Math.max(currentFocus - 1, 0)
      } else {
        newFocus = Math.min(currentFocus + 1, groups.length - 1)
      }

      if (newFocus === currentFocus) {
        // 端点已到已显示窗口边界：无法继续推进。把选择自身的编辑方向表达为
        // 一次有界窗口分页请求（方向本身即意图，不合成 scroll、不伪造用户
        // 手势），下一次真实按键重复再推进。分页结果不驱动任何后续选区写入，
        // 因此松开按键 / 反向 / 焦点转入输入框都不会事后篡改选区；按键自动
        // 重复期间的在途请求由分页通道的 single-flight 认领合并。
        if (!requestBoundaryPage) return
        try {
          void requestBoundaryPage(direction === 'up' ? 'older' : 'newer').catch(() => {})
        } catch {
          // fail-closed：分页是选区边界的增强能力，请求失败不得中断按键处理
        }
        return
      }

      // 从 anchor 到新焦点的范围
      const start = Math.min(anchorIndex, newFocus)
      const end = Math.max(anchorIndex, newFocus)
      const rangeAskIds = groups.slice(start, end + 1).map((g) => g.askId)

      // One atomic range step: a repeat key must not publish an intermediate
      // selection (old endpoint id with the new range) to context consumers —
      // the arrangement reads only ever observe one consistent step.
      noteSelectionIntent()
      dispatch(
        extendSelectionRange({
          rangeGroupIds: rangeAskIds,
          anchorGroupId: groups[anchorIndex]?.askId ?? null,
          focusedGroupId: groups[newFocus]?.askId ?? null,
          anchorIndex,
          focusedIndex: newFocus
        })
      )

      // 滚动到新扩展的边界
      const boundaryGroup = groups[newFocus]
      if (boundaryGroup) {
        scrollToGroup?.(boundaryGroup.askId)
      }
    },
    [
      dispatch,
      groups,
      anchorGroupId,
      lastSelectedIndex,
      focusedIndex,
      focusedGroupId,
      scrollToGroup,
      requestBoundaryPage,
      noteSelectionIntent
    ]
  )

  // 清除选区（不退出编辑模式）
  const handleClearSelection = useCallback(() => {
    noteSelectionIntent()
    dispatch(clearSelection())
  }, [dispatch, noteSelectionIntent])

  // stable clearSelection
  const stableClearSelection = useCallback(() => {
    noteSelectionIntent()
    dispatch(clearSelection())
  }, [dispatch, noteSelectionIntent])

  return useMemo(
    () => ({
      // State
      isEnabled,
      selectedGroupIds,
      selectedGroups,
      groups,
      hasClipboard: clipboard.items.length > 0,
      canUndo: undoStack.undoStack.length > 0,
      canRedo: undoStack.redoStack.length > 0,
      // BRANCH-12: 选集写能力 — Cut/Delete/segment 写操作 disabled 门禁；
      // Copy/Paste 意图不受此门禁限制（paste 源删除由 Main 最终校验）。
      isSelectionMutable,

      // Actions
      toggleEditMode,
      handleGroupClick,
      handleCopy,
      handleCut,
      handlePaste,
      handleDelete,
      handleMoveFocus,
      handleExtendSelection,
      handleClearSelection,
      handleUndo,
      handleRedo,
      clearSelection: stableClearSelection
    }),
    [
      isEnabled,
      selectedGroupIds,
      selectedGroups,
      groups,
      clipboard.items.length,
      undoStack.undoStack.length,
      undoStack.redoStack.length,
      isSelectionMutable,
      toggleEditMode,
      handleGroupClick,
      handleCopy,
      handleCut,
      handlePaste,
      handleDelete,
      handleMoveFocus,
      handleExtendSelection,
      handleClearSelection,
      handleUndo,
      handleRedo,
      stableClearSelection
    ]
  )
}
