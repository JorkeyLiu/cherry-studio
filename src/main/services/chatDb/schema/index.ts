import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// ---------------------------------------------------------------------------
// migration_state — tracks which migrations have been applied
// ---------------------------------------------------------------------------
export const migrationState = sqliteTable('migration_state', {
  key: text('key').primaryKey(),
  value: text('value'),
  updatedAt: text('updated_at')
})

// ---------------------------------------------------------------------------
// topics
// ---------------------------------------------------------------------------
export const topics = sqliteTable(
  'topics',
  {
    id: text('id').primaryKey(),
    assistantId: text('assistant_id'),
    name: text('name'),
    createdAt: text('created_at'),
    updatedAt: text('updated_at'),
    deletedAt: text('deleted_at'),
    extra: text('extra')
  },
  (table) => [index('topics_deleted_at_idx').on(table.deletedAt)]
)

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------
export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    topicId: text('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    role: text('role'),
    content: text('content'),
    status: text('status'),
    askId: text('ask_id'),
    model: text('model'),
    modelId: text('model_id'),
    assistantId: text('assistant_id'),
    createdAt: text('created_at'),
    updatedAt: text('updated_at'),
    sortOrder: integer('sort_order').notNull().default(0),
    extra: text('extra')
  },
  (table) => [
    index('messages_topic_id_sort_order_idx').on(table.topicId, table.sortOrder),
    index('messages_assistant_id_idx').on(table.assistantId)
  ]
)

// ---------------------------------------------------------------------------
// message_blocks
// ---------------------------------------------------------------------------
export const messageBlocks = sqliteTable(
  'message_blocks',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    type: text('type'),
    content: text('content'),
    status: text('status'),
    createdAt: text('created_at'),
    updatedAt: text('updated_at'),
    sortOrder: integer('sort_order').notNull().default(0),
    extra: text('extra')
  },
  (table) => [index('message_blocks_message_id_sort_order_idx').on(table.messageId, table.sortOrder)]
)

// ---------------------------------------------------------------------------
// topic_segments
// ---------------------------------------------------------------------------
export const topicSegments = sqliteTable(
  'topic_segments',
  {
    id: text('id').primaryKey(),
    topicId: text('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    name: text('name'),
    createdAt: text('created_at'),
    updatedAt: text('updated_at'),
    sortOrder: integer('sort_order').notNull().default(0),
    extra: text('extra')
  },
  (table) => [index('topic_segments_topic_id_sort_order_idx').on(table.topicId, table.sortOrder)]
)

// ---------------------------------------------------------------------------
// topic_segment_messages  (composite PK)
// ---------------------------------------------------------------------------
export const topicSegmentMessages = sqliteTable(
  'topic_segment_messages',
  {
    segmentId: text('segment_id')
      .notNull()
      .references(() => topicSegments.id, { onDelete: 'cascade' }),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0)
  },
  (table) => [
    primaryKey({ columns: [table.segmentId, table.messageId] }),
    index('topic_segment_messages_segment_id_sort_order_idx').on(table.segmentId, table.sortOrder),
    index('topic_segment_messages_message_id_idx').on(table.messageId)
  ]
)

// ---------------------------------------------------------------------------
// file_references
// ---------------------------------------------------------------------------
export const fileReferences = sqliteTable(
  'file_references',
  {
    id: text('id').primaryKey(),
    blockId: text('block_id')
      .notNull()
      .references(() => messageBlocks.id, { onDelete: 'cascade' }),
    fileId: text('file_id').notNull(),
    fileName: text('file_name'),
    filePath: text('file_path'),
    fileType: text('file_type'),
    count: integer('count'),
    extra: text('extra')
  },
  (table) => [
    index('file_references_block_id_idx').on(table.blockId),
    index('file_references_file_id_idx').on(table.fileId),
    uniqueIndex('file_references_block_id_file_id_uniq').on(table.blockId, table.fileId)
  ]
)

// ---------------------------------------------------------------------------
// sync metadata — additive, isolated (MVP 005)
// ---------------------------------------------------------------------------
export const syncOutbox = sqliteTable(
  'sync_outbox',
  {
    id: text('id').primaryKey(),
    entityType: text('entity_type').notNull(),
    op: text('op').notNull(),
    entityId: text('entity_id').notNull(),
    timestamp: integer('timestamp').notNull(),
    deviceId: text('device_id').notNull(),
    payloadJson: text('payload_json'),
    createdAt: text('created_at')
  },
  (table) => [
    index('sync_outbox_entity_id_idx').on(table.entityId),
    index('sync_outbox_timestamp_idx').on(table.timestamp)
  ]
)

export const syncApplied = sqliteTable('sync_applied', {
  operationId: text('operation_id').primaryKey(),
  appliedAt: text('applied_at')
})

export const syncState = sqliteTable('sync_state', {
  key: text('key').primaryKey(),
  value: text('value')
})

export const syncEntityClock = sqliteTable(
  'sync_entity_clock',
  {
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    timestamp: integer('timestamp').notNull(),
    operationId: text('operation_id').notNull()
  },
  (table) => [primaryKey({ columns: [table.entityType, table.entityId] })]
)

// ---------------------------------------------------------------------------
// sync field clocks + bounded conflict log — additive (MVP 006)
// Per-field LWW for independent scalar merges; same-field losers retained
// as bounded durable records for future recovery (no restore UI yet).
// ---------------------------------------------------------------------------
export const syncFieldClock = sqliteTable(
  'sync_field_clock',
  {
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    field: text('field').notNull(),
    timestamp: integer('timestamp').notNull(),
    operationId: text('operation_id').notNull()
  },
  (table) => [primaryKey({ columns: [table.entityType, table.entityId, table.field] })]
)

export const syncConflictLog = sqliteTable(
  'sync_conflict_log',
  {
    id: text('id').primaryKey(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    field: text('field').notNull(),
    loserValueJson: text('loser_value_json'),
    loserTimestamp: integer('loser_timestamp').notNull(),
    loserOperationId: text('loser_operation_id').notNull(),
    winnerTimestamp: integer('winner_timestamp').notNull(),
    winnerOperationId: text('winner_operation_id').notNull(),
    createdAt: text('created_at')
  },
  (table) => [index('sync_conflict_log_entity_idx').on(table.entityType, table.entityId)]
)

// ---------------------------------------------------------------------------
// sync device trust (007, superseded by 008_sync_channel_reset): the local
// trust mirror table is dropped by migration 008 for the SYNC-CC-*
// registration/channel protocol. No product code references this table;
// the declaration is intentionally removed (not kept as a zombie).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// sync parent-membership clock — additive, isolated (009)
// Dedicated parent-membership clock keyed by child entity type+id, storing
// parent id + creation timestamp + operationId. Restricted to message and
// message_block — never a substitute for entityClock/field clocks and never
// updated by ordinary edits. Clock is set only on true first creation (local
// or remote) atomically in the same transaction; existing rows without a
// trustworthy creation source remain absent (no backfill/guess). Tombstones
// retain clock metadata (smallest state — deterministic history preserved).
// ---------------------------------------------------------------------------
export const syncMembershipClock = sqliteTable(
  'sync_membership_clock',
  {
    childEntityType: text('child_entity_type').notNull(),
    childEntityId: text('child_entity_id').notNull(),
    parentId: text('parent_id').notNull(),
    timestamp: integer('timestamp').notNull(),
    operationId: text('operation_id').notNull()
  },
  (table) => [
    primaryKey({ columns: [table.childEntityType, table.childEntityId] }),
    index('sync_membership_clock_parent_id_idx').on(table.parentId)
  ]
)

// ---------------------------------------------------------------------------
// sync parent order frame — additive, isolated (010)
// Persistent per-parent winning-frame state for local SQLite mutation
// transactions only (SYNC-DATA-033..036/044). Frames only for
// topic→message (kind: topicMessage) and message→block (kind: messageBlock);
// topic ordering excluded. Each frame stores inventory-included live children
// in current local user-visible order; live zero-child parent may have empty
// []; deleted parent has no frame. Per-row sortOrder remains local
// projection. This is the local persistence prerequisite only — not remote
// wire/candidate integration, not baseline candidate/apply, not relay/network,
// not IPC/UI. See migration 010.
// ---------------------------------------------------------------------------
export const syncParentOrderFrame = sqliteTable(
  'sync_parent_order_frame',
  {
    kind: text('kind').notNull(),
    parentId: text('parent_id').notNull(),
    frameVersion: text('frame_version').notNull(),
    orderedChildIdsJson: text('ordered_child_ids_json').notNull(),
    timestamp: integer('timestamp').notNull(),
    operationId: text('operation_id').notNull()
  },
  (table) => [primaryKey({ columns: [table.kind, table.parentId] })]
)

// ---------------------------------------------------------------------------
// sync frame timestamp high-water — additive, isolated (012)
// Per-(kind, parent_id) monotonic guard for winning-frame clocks
// (SYNC-DATA-048 local implementation invariant): invalidation deletes the
// winning frame row but MUST NOT lower this mark, so a later re-mint always
// allocates strictly above every previously persisted winner timestamp for
// the same parent — even when membership clocks alone would reuse an old
// timestamp with a fresh random operationId (which could otherwise lose LWW
// remotely to the invalidated winner). Only a max timestamp is stored (no
// operationId): local mints always advance strictly +1 above the max.
// Never on wire; never affects candidate completeness/authority.
// See migration 012.
// ---------------------------------------------------------------------------
export const syncFrameHighWater = sqliteTable(
  'sync_frame_high_water',
  {
    kind: text('kind').notNull(),
    parentId: text('parent_id').notNull(),
    maxTimestamp: integer('max_timestamp').notNull()
  },
  (table) => [primaryKey({ columns: [table.kind, table.parentId] })]
)
