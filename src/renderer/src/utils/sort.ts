/**
 * 用于 dnd 列表的元素重新排序方法。支持多元素"拖动"排序。
 * @template {T} 列表元素的类型
 * @param {T[]} list 要重新排序的列表
 * @param {number} sourceIndex 起始元素索引
 * @param {number} destIndex 目标元素索引
 * @param {number} [len=1] 要移动的元素数量，默认为 1
 * @returns {T[]} 重新排序后的列表
 */
export function droppableReorder<T>(list: T[], sourceIndex: number, destIndex: number, len: number = 1): T[] {
  const result = Array.from(list)
  const removed = result.splice(sourceIndex, len)

  if (sourceIndex < destIndex) {
    result.splice(destIndex - len + 1, 0, ...removed)
  } else {
    result.splice(destIndex, 0, ...removed)
  }
  return result
}

/**
 * 首字母为英文的字符串排在前面。
 * @param {string} a 字符串
 * @param {string} b 字符串
 * @returns {number} 排序后的字符串
 */
export function sortByEnglishFirst(a: string, b: string): number {
  const isAEnglish = /^[a-zA-Z]/.test(a)
  const isBEnglish = /^[a-zA-Z]/.test(b)
  if (isAEnglish && !isBEnglish) return -1
  if (!isAEnglish && isBEnglish) return 1
  return a.localeCompare(b)
}

/**
 * LOCK-002: pinned topics always sort/stay at the top. Stable within each
 * group (pinned and unpinned keep their original relative order).
 * @template {T} 列表元素类型（需含可选的 pinned 字段）
 */
export function sortTopicsPinnedFirst<T extends { pinned?: boolean }>(topics: T[]): T[] {
  return [...topics].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1
    if (!a.pinned && b.pinned) return 1
    return 0
  })
}

/**
 * LOCK-002: reorder the topic list after a pin/unpin toggle. The updated topic
 * (with its new `pinned` flag) is placed at the top of its target group, and
 * every other topic keeps its relative order. The updated topic is excluded
 * from both stale source groups so it can never appear twice in the result.
 * @template {T} 列表元素类型（需含 id 与可选的 pinned 字段）
 */
export function reorderTopicsForPin<T extends { id: string; pinned?: boolean }>(topics: T[], updatedTopic: T): T[] {
  const others = topics.filter((topic) => topic.id !== updatedTopic.id)
  const pinnedTopics = others.filter((topic) => topic.pinned)
  const unpinnedTopics = others.filter((topic) => !topic.pinned)

  if (updatedTopic.pinned) {
    return [updatedTopic, ...pinnedTopics, ...unpinnedTopics]
  }
  return [...pinnedTopics, updatedTopic, ...unpinnedTopics]
}
