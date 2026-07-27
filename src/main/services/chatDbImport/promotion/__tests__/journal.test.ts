/**
 * Promotion journal v1 codec tests (LOCK-4404).
 *
 * Covers:
 * - Strict bounded schema: exactly version/sessionId/candidateId/phase
 * - Runtime ID + enum validation (strict allowlist — no path smuggling)
 * - Extra/missing key rejection; unsupported version rejection
 * - Pure round-trip codec (deterministic bytes, no side effects)
 * - Fixed owned filenames (LOCK-4403 naming — no caller-supplied paths)
 */

import { describe, expect, it } from 'vitest'

import {
  decodePromotionJournal,
  encodePromotionJournal,
  isPromotionJournalPhase,
  isValidPromotionJournalId,
  PROMOTION_JOURNAL_FILENAME,
  PROMOTION_JOURNAL_PHASES,
  PROMOTION_JOURNAL_VERSION,
  type PromotionJournalV1,
  ROLLBACK_SNAPSHOT_FILENAME,
  ROLLBACK_SNAPSHOT_STAGING_FILENAME
} from '../journal'

const VALID: PromotionJournalV1 = {
  version: 1,
  sessionId: 'import-abc123-xyz',
  candidateId: 'candidate-import-abc123-xyz',
  phase: 'snapshot-ready'
}

describe('promotion journal codec (LOCK-4404)', () => {
  describe('constants', () => {
    it('journal v1 has exactly the three documented phases in operation order', () => {
      expect(PROMOTION_JOURNAL_PHASES).toEqual(['snapshot-ready', 'candidate-installed', 'replacement-verified'])
      expect(PROMOTION_JOURNAL_VERSION).toBe(1)
    })

    it('owned filenames are fixed and never caller-supplied paths', () => {
      // Fixed names, no separators — the OWNER resolves the directory.
      for (const name of [PROMOTION_JOURNAL_FILENAME, ROLLBACK_SNAPSHOT_FILENAME, ROLLBACK_SNAPSHOT_STAGING_FILENAME]) {
        expect(name).not.toContain('/')
        expect(name).not.toContain('\\')
        expect(name).not.toContain('..')
      }
      // One-retained ordering (LOCK-4403): staging name derives from the
      // fixed snapshot name so the atomic publish is a same-dir rename.
      expect(ROLLBACK_SNAPSHOT_STAGING_FILENAME.startsWith(ROLLBACK_SNAPSHOT_FILENAME)).toBe(true)
      expect(ROLLBACK_SNAPSHOT_STAGING_FILENAME).not.toBe(ROLLBACK_SNAPSHOT_FILENAME)
    })
  })

  describe('ID and phase validation', () => {
    it('accepts strict-allowlist IDs', () => {
      expect(isValidPromotionJournalId('import-abc_123-XYZ')).toBe(true)
      expect(isValidPromotionJournalId('a')).toBe(true)
      expect(isValidPromotionJournalId('x'.repeat(128))).toBe(true)
    })

    it('rejects IDs that could encode paths or unsafe tokens', () => {
      expect(isValidPromotionJournalId('')).toBe(false)
      expect(isValidPromotionJournalId('a/b')).toBe(false)
      expect(isValidPromotionJournalId('..')).toBe(false)
      expect(isValidPromotionJournalId('a.b')).toBe(false)
      expect(isValidPromotionJournalId('a\\b')).toBe(false)
      expect(isValidPromotionJournalId('x'.repeat(129))).toBe(false)
      expect(isValidPromotionJournalId(42)).toBe(false)
      expect(isValidPromotionJournalId(null)).toBe(false)
    })

    it('accepts exactly the three phases', () => {
      for (const phase of PROMOTION_JOURNAL_PHASES) {
        expect(isPromotionJournalPhase(phase)).toBe(true)
      }
      expect(isPromotionJournalPhase('promoting')).toBe(false)
      expect(isPromotionJournalPhase('promoted')).toBe(false)
      expect(isPromotionJournalPhase('')).toBe(false)
      expect(isPromotionJournalPhase(1)).toBe(false)
    })
  })

  describe('encode', () => {
    it('encodes a valid journal with deterministic canonical key order', () => {
      const encoded = encodePromotionJournal(VALID)
      expect(encoded).toBe(
        '{"version":1,"sessionId":"import-abc123-xyz","candidateId":"candidate-import-abc123-xyz","phase":"snapshot-ready"}'
      )
    })

    it('throws on invalid version, IDs, or phase (programming errors)', () => {
      expect(() => encodePromotionJournal({ ...VALID, version: 2 as any })).toThrow(/unsupported version/)
      expect(() => encodePromotionJournal({ ...VALID, sessionId: '../etc' })).toThrow(/sessionId/)
      expect(() => encodePromotionJournal({ ...VALID, candidateId: 'a/b' })).toThrow(/candidateId/)
      expect(() => encodePromotionJournal({ ...VALID, phase: 'installing' as any })).toThrow(/phase/)
    })
  })

  describe('decode', () => {
    it('round-trips every phase', () => {
      for (const phase of PROMOTION_JOURNAL_PHASES) {
        const doc: PromotionJournalV1 = { ...VALID, phase }
        const result = decodePromotionJournal(encodePromotionJournal(doc))
        expect(result).toEqual({ ok: true, journal: doc })
      }
    })

    it('returns a frozen journal on success', () => {
      const result = decodePromotionJournal(encodePromotionJournal(VALID))
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(Object.isFrozen(result.journal)).toBe(true)
      }
    })

    it('rejects non-JSON input without throwing', () => {
      expect(decodePromotionJournal('not json {')).toEqual({ ok: false, code: 'NOT_JSON' })
    })

    it('rejects non-object roots', () => {
      expect(decodePromotionJournal('42')).toEqual({ ok: false, code: 'NOT_OBJECT' })
      expect(decodePromotionJournal('"str"')).toEqual({ ok: false, code: 'NOT_OBJECT' })
      expect(decodePromotionJournal('null')).toEqual({ ok: false, code: 'NOT_OBJECT' })
      expect(decodePromotionJournal('[1,2]')).toEqual({ ok: false, code: 'NOT_OBJECT' })
    })

    it('rejects extra keys (strict bounded schema — no arbitrary paths)', () => {
      const withPath = JSON.stringify({ ...VALID, dbPath: '/tmp/evil/chat.db' })
      expect(decodePromotionJournal(withPath)).toEqual({ ok: false, code: 'UNEXPECTED_KEY' })
    })

    it('rejects missing keys', () => {
      for (const key of ['version', 'sessionId', 'candidateId', 'phase'] as const) {
        const partial: Record<string, unknown> = { ...VALID }
        delete partial[key]
        expect(decodePromotionJournal(JSON.stringify(partial))).toEqual({ ok: false, code: 'MISSING_KEY' })
      }
    })

    it('rejects unsupported versions (including "1" as string)', () => {
      expect(decodePromotionJournal(JSON.stringify({ ...VALID, version: 2 }))).toEqual({
        ok: false,
        code: 'UNSUPPORTED_VERSION'
      })
      expect(decodePromotionJournal(JSON.stringify({ ...VALID, version: '1' }))).toEqual({
        ok: false,
        code: 'UNSUPPORTED_VERSION'
      })
    })

    it('rejects invalid IDs at runtime (path-shaped IDs refused)', () => {
      expect(decodePromotionJournal(JSON.stringify({ ...VALID, sessionId: '../../Data' }))).toEqual({
        ok: false,
        code: 'INVALID_SESSION_ID'
      })
      expect(decodePromotionJournal(JSON.stringify({ ...VALID, candidateId: 'c/../x' }))).toEqual({
        ok: false,
        code: 'INVALID_CANDIDATE_ID'
      })
      expect(decodePromotionJournal(JSON.stringify({ ...VALID, sessionId: 7 }))).toEqual({
        ok: false,
        code: 'INVALID_SESSION_ID'
      })
    })

    it('rejects unknown phases at runtime', () => {
      expect(decodePromotionJournal(JSON.stringify({ ...VALID, phase: 'promoted' }))).toEqual({
        ok: false,
        code: 'INVALID_PHASE'
      })
      expect(decodePromotionJournal(JSON.stringify({ ...VALID, phase: null }))).toEqual({
        ok: false,
        code: 'INVALID_PHASE'
      })
    })
  })
})
