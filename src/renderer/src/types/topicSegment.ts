import type { SegmentRouteQualification } from '@shared/chatDb'

export interface TopicSegment {
  id: string
  topicId: string
  name: string
  messageIds: string[] // 连续的消息 ID 列表（有序，完整成员，用于本地编辑/兼容包含判断）
  color?: string // 连线颜色（可选，默认 primary color）
  /**
   * WIRE-COMPAT ONLY — never written or read as live state.
   *
   * Group-level fold is retired: context participation is decided per MESSAGE
   * (`Message.folded`). The persisted Main column and the wire field stay in the
   * compatibility contract so old databases/imports keep loading, but the
   * renderer no longer produces, projects or consults a group fold.
   */
  folded?: boolean
  createdAt: string
  updatedAt: string
  /** Authority catalog order from Main SQLite (dense 0..n-1). Never fabricated locally. */
  sortOrder: number
  /** Authority first message ID; stable navigation target (null when empty). */
  firstMessageId: string | null
  /** Authority last message ID (null when empty). */
  lastMessageId: string | null
  /** Authority membership size; always equals messageIds.length. */
  messageCount: number
  /**
   * Stable identity of the group head: the member that was first when the group
   * was created (Main `header_message_id`, never re-derived from a renderer
   * window). `null` only for the authority wire of a group that does not exist.
   * Absent on legacy payloads that predate the Main stable-header contract.
   */
  headerMessageId?: string | null
  /**
   * Owner of the group head, resolved by Main from the head row: the logical
   * topic the head message belongs to. Group metadata/membership mutations are
   * authorized by comparing this against the addressed route — never against a
   * loaded first member or `isSelectionMutable`. Absent on legacy payloads.
   */
  ownerTopicId?: string
  /** Owner route of the group head; null = that topic's main route. Absent on legacy payloads. */
  ownerBranchId?: string | null
  /**
   * Route-qualified view, present only when the list request addressed a route
   * (`ListSegmentsRequest.branchId`). The groups own `messageIds` stay the
   * unqualified authority; this block is the route projection and never rewrites
   * the catalog. Absent when Main has not yet provided route qualification
   * (see renderer `DbService.listSegments` interface gap).
   */
  route?: SegmentRouteQualification
}
