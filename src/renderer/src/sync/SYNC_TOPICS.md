# Topics Sync & Soft Delete

## Overview

The `topics` table supports **soft delete** via a `deletedAt` field (ISO 8601 timestamp string or `null`). This document describes how the sync layer handles soft-delete operations, the conflict resolution rules, and the interaction with topic purging.

## Soft Delete Semantics

| State | `deletedAt` value | Meaning |
|---|---|---|
| Active | `null` (or absent) | Topic is visible and usable |
| Deleted | ISO 8601 string | Topic is soft-deleted (hidden from normal views) |
| Restored | `null` (explicitly set) | Previously deleted topic brought back |

## How the Sync Layer Captures Deletes

The `ChangeCollector` registers Dexie `updating` hooks on the `topics` table. When a topic is soft-deleted or restored, the hook captures the modification and logs a descriptive event:

- **Soft delete**: `modifications.deletedAt` is a truthy string → log as soft-delete
- **Restore**: `modifications.deletedAt` is `null` → log as restore

Both generate a standard `UPDATE` change in the `ChangeQueue`. The sync layer does **not** emit a `DELETE` change for soft deletes — the record still exists in the database.

## Conflict Resolution Rules

The `ConflictResolver` has special priority-based handling for the `deletedAt` field in the `topics` table. The resolution follows a three-tier priority system:

### Priority Order

| Priority | Action | `deletedAt` in mods | Example `newValue` |
|---|---|---|---|
| **3 (highest)** | Restore | Key present, value is `null` | `{ deletedAt: null, name: '...' }` |
| **2** | Soft delete | Key present, value is a string | `{ deletedAt: '2026-06-01T00:00:00Z' }` |
| **1 (lowest)** | Regular update | Key **not** present | `{ name: '...' }` |

### Resolution Table

| Local action | Remote action | Winner | Rationale |
|---|---|---|---|
| Restore (3) | Delete (2) | Local | Higher priority wins |
| Delete (2) | Restore (3) | Remote | Higher priority wins |
| Delete (2) | Regular (1) | Local | Higher priority wins even if older |
| Regular (1) | Delete (2) | Remote | Higher priority wins |
| Restore (3) | Restore (3) | LWW | Same priority → last-writer-wins |
| Delete (2) | Delete (2) | LWW | Same priority → last-writer-wins |
| Regular (1) | Regular (1) | LWW | No deletedAt conflict → standard LWW |

### Important Distinctions

- **Restore vs. Regular Update**: A restore explicitly sets `deletedAt: null` in the modifications. A regular update does not touch `deletedAt` at all. The old code conflated these two cases; the current implementation correctly distinguishes them.
- **Hard Delete vs. Soft Delete**: Hard `DELETE` operations (the Dexie `deleting` hook) are never routed through the `deletedAt` priority logic — only `UPDATE` operations are. Hard deletes follow standard LWW.

## Interaction with `purgeExpiredTopics`

The `purgeExpiredTopics` function removes topics that have been soft-deleted beyond a retention window. It operates as a **local maintenance task** and should **not** trigger sync events.

### Implementation Guidance

1. **Use Dexie bulk operations that bypass hooks** — or temporarily disable the ChangeCollector.
2. **Perform purge as a batch `delete()` call** — this triggers the `deleting` hook (hard delete). To avoid syncing purge deletes:
   - Option A: Set a flag (`skipSync = true`) on the transaction scope that ChangeCollector checks.
   - Option B: Use `db.table('topics').toCollection().delete()` and suppress the hook by temporarily removing the ChangeCollector registration.
   - Option C: Mark purge-sourced `SyncChange` entries with a special tag and filter them out in `SyncEngine.push()`.

### Recommended Approach (Option A)

```typescript
import db from '@renderer/databases'
import { getChangeCollector } from './ChangeCollector'

export async function purgeExpiredTopics(retentionDays: number): Promise<number> {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - retentionDays)
  const cutoffStr = cutoff.toISOString()

  // Disable sync hooks during purge
  const collector = getChangeCollector()
  await collector.suspend()  // hypothetical — implement as a flag check in hooks

  try {
    const expired = await db.topics
      .where('deletedAt')
      .below(cutoffStr)
      .and(topic => topic.deletedAt != null)
      .toArray()

    const ids = expired.map(t => t.id!)
    await db.topics.bulkDelete(ids)
    return ids.length
  } finally {
    await collector.resume()
  }
}
```

## Testing

Test coverage is in `__tests__/ConflictResolver.test.ts` under the `deletedAt — restore wins & priority ordering` describe block. Key scenarios:

1. Restore vs. delete → restore wins
2. Soft delete vs. regular update → soft delete wins
3. Both restore → LWW
4. Both soft delete → LWW
5. Regular topics update (no `deletedAt`) → LWW (standard path)

## Future Considerations

- When the topic-trash UI feature is merged, verify that the restore operation uses `{ deletedAt: null }` (not `{ deletedAt: undefined }`) so that `structuredClone` preserves the key in the hook's modifications object.
- If batch restore/delete operations are added, ensure the ChangeCollector handles them without flooding the ChangeQueue.
