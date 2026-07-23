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
 * 状态机：关闭 fixed 模式（任意 → undefined）。本函数返回 undefined 给调用方存。
 */
export function disableAnchor(): undefined {
  return undefined
}

/**
 * 状态机：消息删除后转移锚点。
 * oldGroupList = 删除前的 buildGroupList
 * newGroupList = 删除后的 buildGroupList
 * 规则：
 *   - 若 anchor 不是 active，返回原值
 *   - 若 anchor.groupKey 仍在 newGroupList 中，返回原 active（不动）
 *   - 若 anchor.groupKey 已被删除：
 *       - oldGroupList 中找不到 groupKey → 返回原 anchor（异常保护）
 *       - newIndex = oldIndex - 1（落到更旧的组）
 *       - newGroupList 为空 → undefined（等待 useEffect 守卫自动修复）
 *       - newIndex < 0（删首组）且 newGroupList 非空 → active(newGroupList[0])
 *       - newIndex >= 0 → active(newGroupList[newIndex])
 * 本函数不读 redux，纯函数。
 */
export function transferAnchorOnDeletion(
  oldAnchor: TopicAnchor,
  oldGroupList: string[],
  newGroupList: string[]
): TopicAnchor | undefined {
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

  // newGroupList 为空 → undefined（等待 useEffect 守卫自动修复）
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

    const updatedAnchors = { ...asst.settings?.fixedWindowAnchor }
    if (newAnchor) {
      updatedAnchors[topicId] = newAnchor
    } else {
      delete updatedAnchors[topicId]
    }

    dispatch(
      updateAssistantSettings({
        assistantId: asst.id,
        settings: {
          fixedWindowAnchor: updatedAnchors
        }
      })
    )
  }
}
