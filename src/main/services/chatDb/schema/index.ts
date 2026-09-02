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
