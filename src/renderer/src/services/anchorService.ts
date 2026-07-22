import type { RootState } from '@renderer/store'
import { updateAssistantSettings } from '@renderer/store/assistants'
import type { TopicAnchor } from '@renderer/types'
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
 * 状态机：开启 fixed 模式（undefined → vacant）。
 * 若已经是 active 或 vacant，保持不变（幂等）。
 */
export function enableAnchor(currentAnchor: TopicAnchor | undefined): TopicAnchor {
  return currentAnchor ?? { kind: 'vacant' }
}

/**
 * 状态机：关闭 fixed 模式（任意 → undefined）。本函数返回 undefined 给调用方存。
 */
export function disableAnchor(): undefined {
  return undefined
}

/**
 * 状态机：设置/转移锚点到指定消息所属的组。
 * 若 message 不属于任何组（assistant 无 askId），返回原 anchor（保持不变）。
 * vacant/active 均可转入 active(groupKey)。
 */
export function setAnchorByMessage(
  currentAnchor: TopicAnchor | undefined,
  message: Pick<Message, 'role' | 'id' | 'askId'>
): TopicAnchor {
  const key = resolveGroupKey(message)
  if (key === null) {
    return currentAnchor ?? { kind: 'vacant' }
  }
  return { kind: 'active', groupKey: key }
}

/**
 * 状态机：首条 user 消息进入时，vacant → active(firstGroupKey)。
 * 若 already active 或非 vacant，返回原值。
 * 若 groupList 为空，返回原值（仍 vacant）。
 */
export function onFirstUserMessage(currentAnchor: TopicAnchor, groupList: string[]): TopicAnchor {
  if (currentAnchor.kind !== 'vacant') {
    return currentAnchor
  }
  if (groupList.length === 0) {
    return currentAnchor
  }
  return { kind: 'active', groupKey: groupList[0] }
}

/**
 * 状态机：消息删除后转移锚点。
 * oldGroupList = 删除前的 buildGroupList
 * newGroupList = 删除后的 buildGroupList
 * 规则：
 *   - 若 anchor 不是 active（vacant），返回原值（vacant 不动）
 *   - 若 anchor.groupKey 仍在 newGroupList 中，返回原 active（不动）
 *   - 若 anchor.groupKey 已被删除：
 *       - oldGroupList 中找不到 groupKey → 返回原 anchor（异常保护）
 *       - newIndex = oldIndex - 1（落到更旧的组）
 *       - newGroupList 为空 → vacant
 *       - newIndex < 0（删首组）且 newGroupList 非空 → active(newGroupList[0])
 *       - newIndex >= 0 → active(newGroupList[newIndex])
 * 本函数不读 redux，纯函数。
 */
export function transferAnchorOnDeletion(
  oldAnchor: TopicAnchor,
  oldGroupList: string[],
  newGroupList: string[]
): TopicAnchor {
  if (oldAnchor.kind !== 'active') {
    return oldAnchor
  }

  const { groupKey } = oldAnchor

  // anchor.groupKey 仍在 newGroupList 中，不动
  if (newGroupList.includes(groupKey)) {
    return oldAnchor
  }

  // 异常：oldGroupList 不含 groupKey（理论上不可能），返回原值
  const oldIndex = oldGroupList.indexOf(groupKey)
  if (oldIndex === -1) {
    return oldAnchor
  }

  // newGroupList 为空 → vacant
  if (newGroupList.length === 0) {
    return { kind: 'vacant' }
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
 * 在已 filter 后的 messages（oldest-first）中定位 anchor group 起点索引。
 * 查找逻辑：
 *   1. 先找 role==='user' && id===groupKey 的消息
 *   2. 若找不到（user 被 filter 剔除），退找 askId===groupKey 的 assistant
 *   3. 都找不到 → 返回 -1（表示"全量不截断"，等同 vacant 行为）
 */
export function resolveAnchorSliceStart(messages: Pick<Message, 'id' | 'role' | 'askId'>[], groupKey: string): number {
  // 1. 先找 user 消息
  const userIdx = messages.findIndex((m) => m.id === groupKey && m.role === 'user')
  if (userIdx >= 0) return userIdx

  // 2. 退找 assistant
  const assistantIdx = messages.findIndex((m) => m.askId === groupKey && m.role === 'assistant')
  if (assistantIdx >= 0) return assistantIdx

  // 3. 整组被过滤
  return -1
}

/**
 * 删除后对所有 assistant 的 active anchor 进行转移（集成胶水函数）。
 * 遍历 assistants.assistants，对每个有 fixedWindowAnchor[topicId]: active 的，
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
    const oldAnchor = asst.settings?.fixedWindowAnchor?.[topicId]
    if (!oldAnchor || oldAnchor.kind !== 'active') continue

    const newAnchor = transferAnchorOnDeletion(oldAnchor, oldGroupList, newGroupList)
    if (newAnchor === oldAnchor) continue

    dispatch(
      updateAssistantSettings({
        assistantId: asst.id,
        settings: {
          fixedWindowAnchor: {
            ...asst.settings?.fixedWindowAnchor,
            [topicId]: newAnchor
          }
        }
      })
    )
  }
}
