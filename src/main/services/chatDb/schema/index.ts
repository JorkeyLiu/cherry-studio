import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

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
export const topics = sqliteTable('topics', {
  id: text('id').primaryKey(),
  assistantId: text('assistant_id'),
  name: text('name'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
  deletedAt: text('deleted_at'),
  extra: text('extra')
})

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------
export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    topicId: text('topic_id')
      .notNull()
      .references(() => topics.id),
    role: text('role'),
    content: text('content'),
    status: text('status'),
    askId: text('ask_id'),
    model: text('model'),
    createdAt: text('created_at'),
    sortOrder: integer('sort_order'),
    extra: text('extra')
  },
  (table) => [index('messages_topic_id_sort_order_idx').on(table.topicId, table.sortOrder)]
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
      .references(() => messages.id),
    type: text('type'),
    content: text('content'),
    sortOrder: integer('sort_order'),
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
      .references(() => topics.id),
    sortOrder: integer('sort_order'),
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
      .references(() => topicSegments.id),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id),
    sortOrder: integer('sort_order')
  },
  (table) => [primaryKey({ columns: [table.segmentId, table.messageId] })]
)

// ---------------------------------------------------------------------------
// file_references
// ---------------------------------------------------------------------------
export const fileReferences = sqliteTable(
  'file_references',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id').references(() => messages.id),
    fileId: text('file_id').notNull(),
    fileName: text('file_name'),
    filePath: text('file_path'),
    fileType: text('file_type'),
    count: integer('count'),
    extra: text('extra')
  },
  (table) => [
    index('file_references_message_id_idx').on(table.messageId),
    index('file_references_file_id_idx').on(table.fileId)
  ]
)
