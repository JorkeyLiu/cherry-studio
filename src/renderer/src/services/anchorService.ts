import { getAssistantSettings } from '@renderer/services/AssistantService'
import type { ContextWindowAnchorMap } from '@renderer/services/contextWindowService'
import { dbService } from '@renderer/services/db'
import type { RootState } from '@renderer/store'
import { updateAssistantSettings } from '@renderer/store/assistants'
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
 * Authority group-key anchor transfer (cross-process deletion path).
 *
 * Deterministic transfer driven DIRECTLY by Main-authoritative ordered user
 * group keys — no loaded message entity lookup. `previousUserMessageIds`
 * is the pre-delete authority order, `remainingUserMessageIds` the
 * post-delete authority order. Semantics are exactly
 * `transferAnchorOnDeletion` (CW-9): anchor still present stays; deleted
 * anchor falls to the previous group, first-group deletion falls to the new
 * first, empty topic clears. Pure except the dispatch glue.
 */
export function transferAnchorsWithAuthorityGroupKeys(
  dispatch: (action: { type: string; payload?: unknown }) => void,
  getState: () => RootState,
  topicId: string,
  previousUserMessageIds: string[],
  remainingUserMessageIds: string[]
): void {
  transferAnchorsAfterDeletion(dispatch, getState, topicId, previousUserMessageIds, remainingUserMessageIds)
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
 * First-establishment / compatibility-repair dispatch glue via the authority resolver.
 *
 * Single authority path: one metadata-only `chatdb:resolve-context-closure`
 * (intent `establish`, `detail: 'anchor'`) call resolves the anchor in Main
 * via point lookups + bounded tail scans — no closure messages/blocks are
 * materialized, hydrated, or serialized. Main never persists settings; this
 * helper persists only the non-stale returned anchor (removing the key on empty).
 *
 * No loaded-viewport authority decisions: no `selectLoadedMessagesForTopic`, no
 * `buildContextTurns`, no viewport resolvability check. A persisted anchor
 * outside the loaded viewport is never treated invalid or moved — validity is
 * decided by Main against the full topic. Transport failures and NOT_FOUND
 * (missing topic) preserve current settings with no dispatch.
 *
 * Resolver messages/blocks are caller-local and never enter normal Redux.
 * In-flight deduplication coalesces overlapping calls per assistant/topic;
 * the post-await re-read is the stale guard: if the persisted anchor changed
 * during the call, the stale result is dropped without dispatch.
 */
// In-flight deduplication: coalesce overlapping establishment calls for the same assistant/topic.
// The guard is local to anchorService; it does not change public anchor semantics.
// The post-await re-read guard below is the required stale-repair protection — this
// in-flight map is the smallest additional mechanism to make overlapping ghosts at-most-once.
const inFlightRepairs = new Map<string, Promise<void>>()

type E2EAnchorGate = {
  blocked?: boolean
  entered?: number
  enteredByTopic?: Record<string, number>
  waiters?: Array<() => void>
}

function getE2EAnchorGate(): E2EAnchorGate | null {
  try {
    const scoped = globalThis as { window?: { __e2eAnchorGate?: unknown } }
    const gate = scoped.window?.__e2eAnchorGate
    if (gate && typeof gate === 'object') return gate as E2EAnchorGate
    return null
  } catch {
    return null
  }
}

/**
 * E2E-only deterministic anchor gate (test-scoped).
 *
 * Activated only when the E2E spec sets `window.__e2eAnchorGate.blocked = true`
 * inside the disposable renderer context. Production never creates this key,
 * so the check is a single inert property lookup with no behavior change.
 * When armed, establishment waits on the spec-controlled waiter list until the
 * spec releases it — no wall-clock delays, no timeouts.
 */
async function awaitE2EAnchorGateIfArmed(topicId: string): Promise<void> {
  const gate = getE2EAnchorGate()
  if (!gate || gate.blocked !== true) return
  try {
    gate.entered = (typeof gate.entered === 'number' ? gate.entered : 0) + 1
    const byTopic = (gate.enteredByTopic ??= {})
    byTopic[topicId] = (typeof byTopic[topicId] === 'number' ? byTopic[topicId] : 0) + 1
  } catch {
    // best-effort gate accounting; never break establishment
  }
  await new Promise<void>((resolve) => {
    try {
      if (!Array.isArray(gate.waiters)) gate.waiters = []
      gate.waiters.push(resolve)
    } catch {
      resolve()
    }
  })
}

export async function ensureTopicAnchorEstablished(
  dispatch: (action: { type: string; payload?: unknown }) => void,
  getState: () => RootState,
  assistantId: string,
  topicId: string
): Promise<void> {
  const key = `${assistantId}:${topicId}`
  const existing = inFlightRepairs.get(key)
  if (existing) {
    return existing
  }
  const task = (async (): Promise<void> => {
    const state = getState()
    const assistant = state.assistants.assistants.find((asst) => asst.id === assistantId)
    if (!assistant) {
      return
    }
    const settings = getAssistantSettings(assistant)
    const preAnchor = settings.contextWindowAnchor?.[topicId] as unknown as ContextWindowAnchor | undefined
    const preKey = preAnchor?.kind === 'active' ? preAnchor.groupKey : null
    const contextCount = settings.contextCount ?? null
    let resolved: string | null | undefined
    try {
      await awaitE2EAnchorGateIfArmed(topicId)
      const response = await dbService.resolveContextClosure({
        topicId,
        intent: 'establish',
        contextCount,
        currentAnchorGroupKey: preKey,
        detail: 'anchor'
      })
      // Metadata-only anchor response carries no messages/blocks/closure;
      // nothing enters normal Redux.
      resolved = response.resolvedAnchorGroupKey
    } catch {
      // Transport failures and NOT_FOUND (missing topic) preserve settings.
      return
    }
    // Stale guard: if the persisted anchor changed during the call, drop the
    // stale result without dispatch.
    const freshState = getState()
    const freshAssistant = freshState.assistants.assistants.find((asst) => asst.id === assistantId)
    if (!freshAssistant) {
      return
    }
    const freshSettings = getAssistantSettings(freshAssistant)
    const freshAnchor = freshSettings.contextWindowAnchor?.[topicId] as unknown as ContextWindowAnchor | undefined
    const freshKey = freshAnchor?.kind === 'active' ? freshAnchor.groupKey : null
    if (freshKey !== preKey) {
      return
    }
    if (resolved === freshKey) {
      return
    }
    const updatedAnchors: ContextWindowAnchorMap = { ...freshSettings.contextWindowAnchor }
    if (resolved === null || resolved === undefined) {
      delete updatedAnchors[topicId]
      // Removing a key when nothing was persisted is a no-op shape change;
      // dispatch only when a key actually existed.
      if (freshAnchor === undefined) {
        return
      }
    } else {
      updatedAnchors[topicId] = { kind: 'active', groupKey: resolved }
    }
    dispatch(
      updateAssistantSettings({
        assistantId,
        settings: { contextWindowAnchor: updatedAnchors }
      })
    )
  })()
  inFlightRepairs.set(key, task)
  try {
    await task
  } finally {
    if (inFlightRepairs.get(key) === task) {
      inFlightRepairs.delete(key)
    }
  }
}
