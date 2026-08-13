import { getAssistantSettings } from '@renderer/services/AssistantService'
import { buildContextTurns } from '@renderer/services/contextTurnService'
import type { ContextWindowAnchorMap } from '@renderer/services/contextWindowService'
import { resolveAnchorEstablishDecision } from '@renderer/services/contextWindowService'
import type { RootState } from '@renderer/store'
import { updateAssistantSettings } from '@renderer/store/assistants'
import { selectMessagesForTopic } from '@renderer/store/newMessage'
import type { ContextWindowAnchor } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'

/**
 * 从 oldest-first 的 messageIds 数组派生有序"组键列表"（仅取 role==='user' 的 id）。
 * messageIds 是 messageIdsByTopic[topicId]，entityLookup 用于按 id 查 message.role。
 * 返回值 oldest-first。删除组后此列表自然前移——这是组粒度 index 继承的物理基础。
 */
export function buildGroupList(messageIds: string[], entityLookup: (id: string) => Message | undefined): string[] {
  const result: string[] = []
  for (const id of messageIds) {
    const msg = entityLookup(id)
    if (msg?.role === 'user') {
      result.push(id)
    }
  }
  return result
}

/**
 * 给定一条消息，返回它所属"组"的组键（user 消息的 id）。
 * - user 消息 → 返回自身 id
 * - assistant 消息 → 返回其 askId（若 askId 缺失则返回 null，意味着不属于任何问答组）
 */
export function resolveGroupKey(message: Pick<Message, 'role' | 'id' | 'askId'>): string | null {
  if (message.role === 'user') {
    return message.id
  }
  return message.askId ?? null
}

/**
 * 状态机：消息删除后转移 topic 锚点（`contextWindowAnchor[topicId]`）。
 * oldGroupList = 删除前的 buildGroupList
 * newGroupList = 删除后的 buildGroupList
 * 规则（docs/context-window.md §9，确定性契约）：
 *   - 若锚点不是 active，返回原值
 *   - 若锚点 groupKey 仍在 newGroupList 中，返回原 active（不动）
 *   - 若锚点 groupKey 已被删除：
 *       - oldGroupList 中找不到 groupKey → 返回原锚点（异常保护）
 *       - newIndex = oldIndex - 1（落到更旧的组）
 *       - newGroupList 为空（topic 变空）→ undefined（空 topic 无锚点，I-1）
 *       - newIndex < 0（删首组）且 newGroupList 非空 → active(newGroupList[0])
 *       - newIndex >= 0 → active(newGroupList[newIndex])
 * 本函数不读 redux，纯函数。
 */
export function transferAnchorOnDeletion(
  oldAnchor: ContextWindowAnchor,
  oldGroupList: string[],
  newGroupList: string[]
): ContextWindowAnchor | undefined {
  if (oldAnchor.kind !== 'active') {
    return oldAnchor
  }

  const { groupKey } = oldAnchor

  // 锚点 groupKey 仍在 newGroupList 中，不动
  if (newGroupList.includes(groupKey)) {
    return oldAnchor
  }

  // 异常：oldGroupList 不含 groupKey（理论上不可能），返回原值
  const oldIndex = oldGroupList.indexOf(groupKey)
  if (oldIndex === -1) {
    return oldAnchor
  }

  // newGroupList 为空（topic 变空）→ undefined（空 topic 无锚点）
  if (newGroupList.length === 0) {
    return undefined
  }

  // 落到更旧的组（oldIndex - 1）
  const newIndex = oldIndex - 1
  if (newIndex < 0) {
    // 删的是首组，没有更旧的组，落到新首组
    return { kind: 'active', groupKey: newGroupList[0] }
  }
  return { kind: 'active', groupKey: newGroupList[newIndex] }
}

/**
 * 删除后对所有 assistant 的 active topic 锚点进行转移（集成胶水函数）。
 * 遍历 assistants.assistants，对每个有 contextWindowAnchor[topicId]: active 的，
 * 调 transferAnchorOnDeletion，diff 则 dispatch updateAssistantSettings。
 *
 * 注意：此函数含 side-effect（dispatch），放在此文件底部作为集成辅助。
 */
export function transferAnchorsAfterDeletion(
  dispatch: (action: { type: string; payload?: unknown }) => void,
  getState: () => RootState,
  topicId: string,
  oldGroupList: string[],
  newGroupList: string[]
): void {
  const state = getState()
  const allAssistants = state.assistants.assistants

  for (const asst of allAssistants) {
    const oldAnchor = asst.settings?.contextWindowAnchor?.[topicId]
    if (!oldAnchor || oldAnchor.kind !== 'active') continue

    const newAnchor = transferAnchorOnDeletion(oldAnchor, oldGroupList, newGroupList)
    if (newAnchor === oldAnchor) continue

    const updatedAnchors: ContextWindowAnchorMap = { ...asst.settings?.contextWindowAnchor }
    if (newAnchor) {
      updatedAnchors[topicId] = newAnchor
    } else {
      delete updatedAnchors[topicId]
    }

    dispatch(
      updateAssistantSettings({
        assistantId: asst.id,
        settings: {
          contextWindowAnchor: updatedAnchors
        }
      })
    )
  }
}

/**
 * Branch anchor inheritance (docs/context-window.md §9, CW-4 · 分支继承):
 * deterministically maps the parent topic's persisted anchor into a new
 * branch by position (group-list index transfer), never by recomputing from
 * `contextCount`.
 *
 * Rules:
 *   - Source anchor missing or not active → `undefined` (nothing to inherit).
 *   - Source anchor groupKey absent from `sourceGroupList` (invalid source
 *     anchor) → `undefined`.
 *   - Empty branch group list → `undefined` (empty topics have no anchor,
 *     I-1).
 *   - In-range index (`sourceIndex < branchGroupList.length`) → maps the
 *     parent position into the branch by index.
 *   - Out-of-range index (`sourceIndex >= branchGroupList.length`, the branch
 *     is a strict prefix of the source) → clamped to the branch's LAST
 *     available group — the nearest available predecessor (CW-FIX-1). A
 *     non-empty branch always receives a persisted anchor; it never silently
 *     stays anchorless.
 *
 * Pure function: no store access, no dispatch.
 */
export function inheritAnchorForBranch(
  sourceAnchor: ContextWindowAnchor | undefined,
  sourceGroupList: string[],
  branchGroupList: string[]
): ContextWindowAnchor | undefined {
  if (sourceAnchor?.kind !== 'active') {
    return undefined
  }
  if (branchGroupList.length === 0) {
    return undefined
  }
  const sourceIndex = sourceGroupList.indexOf(sourceAnchor.groupKey)
  if (sourceIndex === -1) {
    return undefined
  }
  if (sourceIndex < branchGroupList.length) {
    return { kind: 'active', groupKey: branchGroupList[sourceIndex] }
  }
  // Out-of-range: clamp to the branch's last available group (nearest
  // available predecessor).
  return { kind: 'active', groupKey: branchGroupList[branchGroupList.length - 1] }
}

/**
 * First-establishment / compatibility-repair dispatch glue (idempotent,
 * exactly-once per topic).
 *
 * Reads the topic's current real turns and the assistant's current
 * `contextCount` from the store, resolves the establish/repair decision, and
 * dispatches `updateAssistantSettings` only when the anchor was missing or
 * unresolvable. A valid persisted anchor is never recalculated, and an empty
 * topic never receives an anchor. Ordinary startup with a valid anchor
 * dispatches nothing.
 *
 * This is the bounded hook for:
 *   - first establishment in `sendMessage` (after the user message is
 *     persisted + added to Redux), and
 *   - compatibility repair after a successful topic message load/import into
 *     Redux (`loadTopicMessagesThunk`) — on BOTH the fetch path (after
 *     `messagesReceived`) and the cached path (a non-empty cached topic whose
 *     messages are already in Redux, e.g. a fresh branch pre-populated by
 *     `cloneMessagesToNewTopicThunk`).
 *
 * Note: contains a side-effect (dispatch); it is the integration glue kept
 * separate from the pure decision helpers in `contextWindowService`.
 */
export function ensureTopicAnchorEstablished(
  dispatch: (action: { type: string; payload?: unknown }) => void,
  getState: () => RootState,
  assistantId: string,
  topicId: string
): void {
  const state = getState()
  const assistant = state.assistants.assistants.find((asst) => asst.id === assistantId)
  if (!assistant) {
    return
  }
  const settings = getAssistantSettings(assistant)
  const turns = buildContextTurns(selectMessagesForTopic(state, topicId))
  const decision = resolveAnchorEstablishDecision(settings.contextWindowAnchor, topicId, turns, settings.contextCount)
  if (decision.changed) {
    dispatch(
      updateAssistantSettings({
        assistantId,
        settings: { contextWindowAnchor: decision.anchorMap }
      })
    )
  }
}
