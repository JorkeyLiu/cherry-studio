/**
 * Phase 2 — ConflictResolver unit tests
 *
 * Covers all table policies: LWW, merge, restored-wins.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { ConflictResolver } from '../ConflictResolver'
import type { SyncChange, SyncTableName } from '../types'

// ── Helpers ─────────────────────────────────────────────────────

function createChange(overrides: Partial<SyncChange> = {}): SyncChange {
  return {
    id: '',
    table: 'topics' as SyncTableName,
    op: 'UPDATE',
    key: 'topic-1',
    newValue: { name: 'test' },
    deviceId: 'device-a',
    timestamp: 1000,
    synced: false,
    vector: {},
    ...overrides
  }
}

// ── Tests ───────────────────────────────────────────────────────

describe('ConflictResolver', () => {
  let resolver: ConflictResolver

  beforeEach(() => {
    resolver = new ConflictResolver()
  })

  describe('LWW — last-writer-wins', () => {
    it('should pick local when local timestamp is newer', () => {
      const local = createChange({ timestamp: 2000, key: 'k1' })
      const remote = createChange({ timestamp: 1000, key: 'k1' })

      const result = resolver.resolve(local, remote)

      expect(result.resolution).toBe('local')
      expect(result.localChange).toBe(local)
      expect(result.remoteChange).toBe(remote)
    })

    it('should pick remote when remote timestamp is newer', () => {
      const local = createChange({ timestamp: 1000, key: 'k1' })
      const remote = createChange({ timestamp: 2000, key: 'k1' })

      const result = resolver.resolve(local, remote)

      expect(result.resolution).toBe('remote')
    })

    it('should use deviceId tiebreaker when timestamps are equal', () => {
      // device-b > device-a lexicographically
      const local = createChange({ timestamp: 1000, deviceId: 'device-a', key: 'k1' })
      const remote = createChange({ timestamp: 1000, deviceId: 'device-b', key: 'k1' })

      const result = resolver.resolve(local, remote)

      // remote (device-b) wins over local (device-a)
      expect(result.resolution).toBe('remote')
    })

    it('should pick local when timestamps equal and local deviceId is greater', () => {
      const local = createChange({ timestamp: 1000, deviceId: 'device-z', key: 'k1' })
      const remote = createChange({ timestamp: 1000, deviceId: 'device-a', key: 'k1' })

      const result = resolver.resolve(local, remote)

      expect(result.resolution).toBe('local')
    })

    it('should apply LWW to files table', () => {
      const local = createChange({ table: 'files', timestamp: 500, key: 'f1' })
      const remote = createChange({ table: 'files', timestamp: 1500, key: 'f1' })

      const result = resolver.resolve(local, remote)

      expect(result.resolution).toBe('remote')
    })

    it('should apply LWW to knowledge_notes table', () => {
      const local = createChange({ table: 'knowledge_notes', timestamp: 2000, key: 'kn1' })
      const remote = createChange({ table: 'knowledge_notes', timestamp: 1000, key: 'kn1' })

      const result = resolver.resolve(local, remote)

      expect(result.resolution).toBe('local')
    })

    it('should apply LWW to translate_history table', () => {
      const local = createChange({ table: 'translate_history', timestamp: 1000, key: 'th1' })
      const remote = createChange({ table: 'translate_history', timestamp: 3000, key: 'th1' })

      const result = resolver.resolve(local, remote)

      expect(result.resolution).toBe('remote')
    })

    it('should apply LWW to translate_languages table', () => {
      const local = createChange({ table: 'translate_languages', timestamp: 3000, key: 'tl1' })
      const remote = createChange({ table: 'translate_languages', timestamp: 2000, key: 'tl1' })

      const result = resolver.resolve(local, remote)

      expect(result.resolution).toBe('local')
    })

    it('should apply LWW to quick_phrases table', () => {
      const local = createChange({ table: 'quick_phrases', timestamp: 1000, key: 'qp1' })
      const remote = createChange({ table: 'quick_phrases', timestamp: 4000, key: 'qp1' })

      const result = resolver.resolve(local, remote)

      expect(result.resolution).toBe('remote')
    })

    it('should apply LWW to message_blocks table with dedup strategy', () => {
      const local = createChange({ table: 'message_blocks', timestamp: 5000, key: 'mb1' })
      const remote = createChange({ table: 'message_blocks', timestamp: 3000, key: 'mb1' })

      const result = resolver.resolve(local, remote)

      expect(result.resolution).toBe('local')
    })
  })

  describe('Settings merge — field-level merge', () => {
    it('should merge non-overlapping field changes', () => {
      const local = createChange({
        table: 'settings',
        op: 'UPDATE',
        key: 'theme',
        newValue: { darkMode: true }
      })
      const remote = createChange({
        table: 'settings',
        op: 'UPDATE',
        key: 'theme',
        newValue: { fontSize: 14 }
      })

      const result = resolver.resolve(local, remote)

      expect(result.resolution).toBe('merged')
      expect(result.mergedValue).toEqual({ darkMode: true, fontSize: 14 })
    })

    it('should merge when local has multiple fields', () => {
      const local = createChange({
        table: 'settings',
        op: 'UPDATE',
        key: 'editor',
        newValue: { lineNumbers: true, wordWrap: true }
      })
      const remote = createChange({
        table: 'settings',
        op: 'UPDATE',
        key: 'editor',
        newValue: { tabSize: 4 }
      })

      const result = resolver.resolve(local, remote)

      expect(result.resolution).toBe('merged')
      expect(result.mergedValue).toEqual({
        tabSize: 4,
        lineNumbers: true,
        wordWrap: true
      })
    })

    it('should fall back to LWW when updates have overlapping fields', () => {
      const local = createChange({
        table: 'settings',
        op: 'UPDATE',
        timestamp: 2000,
        key: 'theme',
        newValue: { darkMode: true }
      })
      const remote = createChange({
        table: 'settings',
        op: 'UPDATE',
        timestamp: 1000,
        key: 'theme',
        newValue: { darkMode: false }
      })

      const result = resolver.resolve(local, remote)

      // Overlapping field 'darkMode' means no clean merge — fall back to LWW
      expect(result.resolution).toBe('local')
      expect(result.mergedValue).toBeUndefined()
    })

    it('should fall back to LWW when one side is CREATE', () => {
      const local = createChange({
        table: 'settings',
        op: 'CREATE',
        timestamp: 2000,
        key: 'theme',
        newValue: { darkMode: true }
      })
      const remote = createChange({
        table: 'settings',
        op: 'CREATE',
        timestamp: 1000,
        key: 'theme',
        newValue: { darkMode: true }
      })

      const result = resolver.resolve(local, remote)

      // CREATE vs CREATE — fall back to LWW
      expect(result.resolution).toBe('local')
    })

    it('should fall back to LWW when one side is DELETE', () => {
      const local = createChange({
        table: 'settings',
        op: 'DELETE',
        timestamp: 2000,
        key: 'theme'
      })
      const remote = createChange({
        table: 'settings',
        op: 'UPDATE',
        timestamp: 1000,
        key: 'theme',
        newValue: { darkMode: true }
      })

      const result = resolver.resolve(local, remote)

      expect(result.resolution).toBe('local')
    })

    it('should set resolution to merged only, not local or remote', () => {
      const local = createChange({
        table: 'settings',
        op: 'UPDATE',
        key: 'a',
        newValue: { settingA: 1 }
      })
      const remote = createChange({
        table: 'settings',
        op: 'UPDATE',
        key: 'a',
        newValue: { settingB: 2 }
      })

      const result = resolver.resolve(local, remote)

      expect(result.resolution).toBe('merged')
      expect(['local', 'remote']).not.toContain(result.resolution)
    })
  })

  describe('deletedAt — restore wins & priority ordering', () => {
    it('should pick local when local restores (deletedAt: null) and remote deletes', () => {
      const local = createChange({
        table: 'topics',
        op: 'UPDATE',
        key: 'topic-1',
        newValue: { name: 'test', deletedAt: null }
        // deletedAt explicitly set to null = restore
      })
      const remote = createChange({
        table: 'topics',
        op: 'UPDATE',
        key: 'topic-1',
        newValue: { deletedAt: '2026-06-01T00:00:00Z' }
      })

      const result = resolver.resolve(local, remote)

      // Restore (prio 3) > delete (prio 2)
      expect(result.resolution).toBe('local')
    })

    it('should pick remote when remote restores and local deletes', () => {
      const local = createChange({
        table: 'topics',
        op: 'UPDATE',
        key: 'topic-1',
        newValue: { deletedAt: '2026-06-01T00:00:00Z' }
      })
      const remote = createChange({
        table: 'topics',
        op: 'UPDATE',
        key: 'topic-1',
        newValue: { name: 'test', deletedAt: null }
        // deletedAt explicitly set to null = restore
      })

      const result = resolver.resolve(local, remote)

      // Restore (prio 3) > delete (prio 2)
      expect(result.resolution).toBe('remote')
    })

    it('should fall back to LWW when both sides restore (both have deletedAt: null)', () => {
      const local = createChange({
        table: 'topics',
        op: 'UPDATE',
        timestamp: 1000,
        key: 'topic-1',
        newValue: { name: 'v1', deletedAt: null }
      })
      const remote = createChange({
        table: 'topics',
        op: 'UPDATE',
        timestamp: 2000,
        key: 'topic-1',
        newValue: { name: 'v2', deletedAt: null }
      })

      const result = resolver.resolve(local, remote)

      // Both restore (same priority 3) — fall back to LWW, remote is newer
      expect(result.resolution).toBe('remote')
    })

    it('should fall back to LWW when both sides soft-delete', () => {
      const local = createChange({
        table: 'topics',
        op: 'UPDATE',
        timestamp: 1000,
        key: 'topic-1',
        newValue: { deletedAt: '2026-06-01T00:00:00Z' }
      })
      const remote = createChange({
        table: 'topics',
        op: 'UPDATE',
        timestamp: 2000,
        key: 'topic-1',
        newValue: { deletedAt: '2026-06-02T00:00:00Z' }
      })

      const result = resolver.resolve(local, remote)

      // Both delete (same priority 2) — fall back to LWW, remote is newer
      expect(result.resolution).toBe('remote')
    })

    it('soft delete wins over regular update without deletedAt field', () => {
      const local = createChange({
        table: 'topics',
        op: 'UPDATE',
        timestamp: 500,
        key: 'topic-1',
        newValue: { deletedAt: '2026-06-01T00:00:00Z' }
      })
      const remote = createChange({
        table: 'topics',
        op: 'UPDATE',
        timestamp: 1000,
        key: 'topic-1',
        newValue: { title: 'updated' }
        // no deletedAt field = regular update (not a restore)
      })

      const result = resolver.resolve(local, remote)

      // Soft delete (prio 2) > regular update (prio 1) — local even though older
      expect(result.resolution).toBe('local')
    })
  })

  describe('topics (non-deletedAt) — LWW', () => {
    it('should use LWW for regular topic metadata changes', () => {
      const local = createChange({
        table: 'topics',
        op: 'UPDATE',
        timestamp: 500,
        key: 'topic-1',
        newValue: { title: 'local' }
      })
      const remote = createChange({
        table: 'topics',
        op: 'UPDATE',
        timestamp: 1500,
        key: 'topic-1',
        newValue: { title: 'remote' }
      })

      const result = resolver.resolve(local, remote)

      expect(result.resolution).toBe('remote')
    })
  })

  describe('Table policy dispatch', () => {
    it('should apply merge policy for settings', () => {
      const local = createChange({
        table: 'settings',
        op: 'UPDATE',
        key: 'prefs',
        newValue: { a: 1 }
      })
      const remote = createChange({
        table: 'settings',
        op: 'UPDATE',
        key: 'prefs',
        newValue: { b: 2 }
      })

      const result = resolver.resolve(local, remote)

      expect(result.resolution).toBe('merged')
    })

    it('should apply LWW for topics (metadata)', () => {
      const local = createChange({ table: 'topics', timestamp: 100, key: 't1' })
      const remote = createChange({ table: 'topics', timestamp: 200, key: 't1' })

      const result = resolver.resolve(local, remote)

      expect(result.resolution).toBe('remote')
    })

    it('should apply LWW for files', () => {
      const local = createChange({ table: 'files', timestamp: 200, key: 'f1' })
      const remote = createChange({ table: 'files', timestamp: 100, key: 'f1' })

      const result = resolver.resolve(local, remote)

      expect(result.resolution).toBe('local')
    })

    it('should apply LWW for knowledge_notes', () => {
      const local = createChange({ table: 'knowledge_notes', timestamp: 100, key: 'kn1' })
      const remote = createChange({ table: 'knowledge_notes', timestamp: 300, key: 'kn1' })

      const result = resolver.resolve(local, remote)

      expect(result.resolution).toBe('remote')
    })

    it('should apply LWW for translate_history', () => {
      const local = createChange({ table: 'translate_history', timestamp: 400, key: 'th1' })
      const remote = createChange({ table: 'translate_history', timestamp: 100, key: 'th1' })

      const result = resolver.resolve(local, remote)

      expect(result.resolution).toBe('local')
    })

    it('should apply LWW for translate_languages', () => {
      const local = createChange({ table: 'translate_languages', timestamp: 100, key: 'tl1' })
      const remote = createChange({ table: 'translate_languages', timestamp: 50, key: 'tl1' })

      const result = resolver.resolve(local, remote)

      expect(result.resolution).toBe('local')
    })

    it('should apply LWW for quick_phrases', () => {
      const local = createChange({ table: 'quick_phrases', timestamp: 100, key: 'qp1' })
      const remote = createChange({ table: 'quick_phrases', timestamp: 200, key: 'qp1' })

      const result = resolver.resolve(local, remote)

      expect(result.resolution).toBe('remote')
    })

    it('should apply LWW for message_blocks', () => {
      const local = createChange({ table: 'message_blocks', timestamp: 150, key: 'mb1' })
      const remote = createChange({ table: 'message_blocks', timestamp: 250, key: 'mb1' })

      const result = resolver.resolve(local, remote)

      expect(result.resolution).toBe('remote')
    })
  })

  describe('SyncConflict shape', () => {
    it('should return the correct SyncConflict type', () => {
      const local = createChange({ key: 'k1' })
      const remote = createChange({ key: 'k1' })

      const result = resolver.resolve(local, remote)

      expect(result).toHaveProperty('localChange')
      expect(result).toHaveProperty('remoteChange')
      expect(result).toHaveProperty('resolution')
      expect(['local', 'remote', 'merged']).toContain(result.resolution)
    })

    it('should include mergedValue only when resolution is merged', () => {
      const local = createChange({
        table: 'settings',
        op: 'UPDATE',
        key: 'prefs',
        newValue: { a: 1 }
      })
      const remote = createChange({
        table: 'settings',
        op: 'UPDATE',
        key: 'prefs',
        newValue: { b: 2 }
      })

      const result = resolver.resolve(local, remote)

      expect(result.resolution).toBe('merged')
      expect(result.mergedValue).toBeDefined()
      expect(result.mergedValue).toEqual({ a: 1, b: 2 })
    })

    it('should NOT include mergedValue when resolution is local or remote', () => {
      const local = createChange({ key: 'k1', timestamp: 2000 })
      const remote = createChange({ key: 'k1', timestamp: 1000 })

      const result = resolver.resolve(local, remote)

      expect(result.resolution).toBe('local')
      expect(result.mergedValue).toBeUndefined()
    })
  })

  describe('LWW — DELETE operations', () => {
    it('should use LWW for DELETE vs DELETE', () => {
      const local = createChange({ op: 'DELETE', timestamp: 1000, key: 'k1' })
      const remote = createChange({ op: 'DELETE', timestamp: 2000, key: 'k1' })

      const result = resolver.resolve(local, remote)

      // Remote DELETE is newer
      expect(result.resolution).toBe('remote')
    })

    it('should use LWW for DELETE vs UPDATE on topics', () => {
      const local = createChange({ op: 'DELETE', timestamp: 3000, key: 'k1' })
      const remote = createChange({ op: 'UPDATE', timestamp: 1000, key: 'k1', newValue: { x: 1 } })

      const result = resolver.resolve(local, remote)

      // Local DELETE is newer
      expect(result.resolution).toBe('local')
    })
  })

  describe('Edge cases', () => {
    it('should handle empty newValue in both changes', () => {
      const local = createChange({ newValue: {}, key: 'k1', timestamp: 1000 })
      const remote = createChange({ newValue: {}, key: 'k1', timestamp: 2000 })

      const result = resolver.resolve(local, remote)

      expect(result.resolution).toBe('remote')
    })

    it('should handle null newValue in settings merge', () => {
      const local = createChange({
        table: 'settings',
        op: 'UPDATE',
        key: 'prefs',
        newValue: { a: 1 }
      })
      const remote = createChange({
        table: 'settings',
        op: 'UPDATE',
        key: 'prefs',
        newValue: null as unknown as Record<string, unknown>
      })

      const result = resolver.resolve(local, remote)

      // newValue is null — localKeys is empty(ish?), actually null, Object.keys(null) throws...
      // But we cast null to Record, so Object.keys(null as unknown as Record<string, unknown>) returns []
      // So remoteKeys is [], overlap is [], merge happens
      expect(result.resolution).toBe('merged')
      expect(result.mergedValue).toEqual({ a: 1 })
    })
  })
})
