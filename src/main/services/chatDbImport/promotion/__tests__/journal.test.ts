/**
 * Promotion journal codec tests (LOCK-4404 + Phase 2 LOCK-PROMO-2/10/12).
 *
 * Covers:
 * - v1 schema: exactly version/sessionId/candidateId/phase, the original
 *   chat.db-only phases (LOCK-PROMO-10 backward compatibility).
 * - v2 schema: the three-artifact phases + aggregate receipts (LOCK-PROMO-12:
 *   counts + digests ONLY — no private filenames/paths/content/raw IDs).
 * - Strict runtime ID + phase + receipts validation (no path smuggling).
 * - Extra/missing key rejection; unsupported version rejection.
 * - Pure round-trip codec (deterministic bytes, no side effects).
 * - Fixed owned filenames (LOCK-4403/4404 naming — no caller-supplied paths).
 */

import { describe, expect, it } from 'vitest'

import {
  artifactReceiptsEqual,
  catalogReceiptsEqual,
  dbReceiptsEqual,
  decodePromotionJournal,
  encodePromotionJournal,
  FILES_CATALOG_SNAPSHOT_FILENAME,
  FILES_PROMOTE_STAGING_DIRNAME,
  FILES_ROLLBACK_SNAPSHOT_DIRNAME,
  FILES_ROLLBACK_SNAPSHOT_STAGING_DIRNAME,
  filesReceiptsEqual,
  isPromotionJournalPhase,
  isPromotionJournalPhaseV1,
  isPromotionJournalPhaseV2,
  isValidPromotionJournalId,
  PROMOTION_JOURNAL_FILENAME,
  PROMOTION_JOURNAL_PHASES,
  PROMOTION_JOURNAL_PHASES_V1,
  PROMOTION_JOURNAL_PHASES_V2,
  PROMOTION_JOURNAL_VERSION,
  PROMOTION_JOURNAL_VERSION_V1,
  PROMOTION_JOURNAL_VERSION_V2,
  type PromotionJournalV1,
  type PromotionJournalV2,
  ROLLBACK_SNAPSHOT_FILENAME,
  ROLLBACK_SNAPSHOT_STAGING_FILENAME
} from '../journal'

const VALID: PromotionJournalV1 = {
  version: 1,
  sessionId: 'import-abc123-xyz',
  candidateId: 'candidate-import-abc123-xyz',
  phase: 'snapshot-ready'
}

const CANDIDATE_RECEIPTS = {
  db: { sha256: 'a'.repeat(64), size: 100 },
  files: { count: 1, totalBytes: 50, sha256: 'b'.repeat(64) },
  catalog: { count: 1, sha256: 'c'.repeat(64) }
}

const VALID_V2: PromotionJournalV2 = {
  version: 2,
  sessionId: 'import-abc123-xyz',
  candidateId: 'candidate-import-abc123-xyz',
  phase: 'candidates-ready',
  receipts: { candidate: CANDIDATE_RECEIPTS, old: { db: null, files: null, catalog: null } }
}

describe('promotion journal codec (LOCK-4404 / LOCK-PROMO-2/10/12)', () => {
  describe('constants', () => {
    it('v1 keeps exactly the three original chat.db-only phases (LOCK-PROMO-10)', () => {
      expect(PROMOTION_JOURNAL_PHASES_V1).toEqual(['snapshot-ready', 'candidate-installed', 'replacement-verified'])
      expect(PROMOTION_JOURNAL_PHASES).toEqual(PROMOTION_JOURNAL_PHASES_V1)
      expect(PROMOTION_JOURNAL_VERSION_V1).toBe(1)
    })

    it('v2 carries the seven three-artifact phases in operation order (LOCK-PROMO-2)', () => {
      expect(PROMOTION_JOURNAL_PHASES_V2).toEqual([
        'candidates-ready',
        'snapshots-ready',
        'db-installed',
        'files-installed',
        'catalog-pending',
        'catalog-applied',
        'replacement-verified'
      ])
      expect(PROMOTION_JOURNAL_VERSION).toBe(2)
      expect(PROMOTION_JOURNAL_VERSION_V2).toBe(2)
    })

    it('owned filenames are fixed and never caller-supplied paths', () => {
      for (const name of [
        PROMOTION_JOURNAL_FILENAME,
        ROLLBACK_SNAPSHOT_FILENAME,
        ROLLBACK_SNAPSHOT_STAGING_FILENAME,
        FILES_ROLLBACK_SNAPSHOT_DIRNAME,
        FILES_ROLLBACK_SNAPSHOT_STAGING_DIRNAME,
        FILES_CATALOG_SNAPSHOT_FILENAME,
        FILES_PROMOTE_STAGING_DIRNAME
      ]) {
        expect(name).not.toContain('/')
        expect(name).not.toContain('\\')
        expect(name).not.toContain('..')
      }
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

    it('phase guards match the v1/v2 phase sets with replacement-verified shared (LOCK-STAB-2)', () => {
      const v1Only = PROMOTION_JOURNAL_PHASES_V1.filter(
        (phase) => !(PROMOTION_JOURNAL_PHASES_V2 as readonly string[]).includes(phase)
      )
      const v2Only = PROMOTION_JOURNAL_PHASES_V2.filter(
        (phase) => !(PROMOTION_JOURNAL_PHASES_V1 as readonly string[]).includes(phase)
      )
      const shared = PROMOTION_JOURNAL_PHASES_V1.filter((phase) =>
        (PROMOTION_JOURNAL_PHASES_V2 as readonly string[]).includes(phase)
      )
      // `replacement-verified` is intentionally valid in both versions.
      expect(shared).toEqual(['replacement-verified'])
      for (const phase of v1Only) {
        expect(isPromotionJournalPhaseV1(phase)).toBe(true)
        expect(isPromotionJournalPhaseV2(phase)).toBe(false)
      }
      for (const phase of v2Only) {
        expect(isPromotionJournalPhaseV2(phase)).toBe(true)
        expect(isPromotionJournalPhaseV1(phase)).toBe(false)
      }
      for (const phase of shared) {
        expect(isPromotionJournalPhaseV1(phase)).toBe(true)
        expect(isPromotionJournalPhaseV2(phase)).toBe(true)
      }
      expect(isPromotionJournalPhase('promoting')).toBe(false)
      expect(isPromotionJournalPhase('promoted')).toBe(false)
      expect(isPromotionJournalPhase('')).toBe(false)
      expect(isPromotionJournalPhase(1)).toBe(false)
    })
  })

  describe('encode — v1', () => {
    it('encodes a valid journal with deterministic canonical key order', () => {
      expect(encodePromotionJournal(VALID)).toBe(
        '{"version":1,"sessionId":"import-abc123-xyz","candidateId":"candidate-import-abc123-xyz","phase":"snapshot-ready"}'
      )
    })

    it('throws on invalid IDs or phases (programming errors)', () => {
      expect(() => encodePromotionJournal({ ...VALID, sessionId: '../etc' })).toThrow(/sessionId/)
      expect(() => encodePromotionJournal({ ...VALID, candidateId: 'a/b' })).toThrow(/candidateId/)
      expect(() => encodePromotionJournal({ ...VALID, phase: 'installing' as any })).toThrow(/phase/)
    })
  })

  describe('encode — v2', () => {
    it('encodes a valid v2 journal with deterministic canonical key order', () => {
      const encoded = encodePromotionJournal(VALID_V2)
      const parsed = JSON.parse(encoded) as Record<string, unknown>
      expect(Object.keys(parsed)).toEqual(['version', 'sessionId', 'candidateId', 'phase', 'receipts'])
      expect(parsed.version).toBe(2)
      expect(parsed.phase).toBe('candidates-ready')
    })

    it('rejects a v2 phase in a v1 document and vice versa', () => {
      expect(() => encodePromotionJournal({ ...VALID, phase: 'db-installed' as never })).toThrow(/phase/)
      expect(() =>
        encodePromotionJournal({
          version: 2 as never,
          sessionId: 'import-s',
          candidateId: 'candidate-import-s',
          phase: 'snapshot-ready' as never,
          receipts: { candidate: CANDIDATE_RECEIPTS, old: { db: null, files: null, catalog: null } }
        } as PromotionJournalV2)
      ).toThrow(/phase/)
    })

    it('rejects malformed receipts (aggregate receipts only, LOCK-PROMO-12)', () => {
      const base = { ...VALID_V2 }
      expect(() =>
        encodePromotionJournal({
          ...base,
          receipts: {
            candidate: { db: { sha256: 'not-a-hash', size: 1 }, files: null, catalog: null },
            old: { db: null, files: null, catalog: null }
          }
        })
      ).toThrow(/receipts/)
      expect(() =>
        encodePromotionJournal({
          ...base,
          receipts: {
            candidate: { db: null, files: null, catalog: { count: -1, sha256: 'c'.repeat(64) } },
            old: { db: null, files: null, catalog: null }
          }
        })
      ).toThrow(/receipts/)
    })
  })

  describe('decode', () => {
    it('round-trips every v1 phase', () => {
      for (const phase of PROMOTION_JOURNAL_PHASES_V1) {
        const doc: PromotionJournalV1 = { ...VALID, phase }
        expect(decodePromotionJournal(encodePromotionJournal(doc))).toEqual({ ok: true, journal: doc })
      }
    })

    it('round-trips every v2 phase with immutable receipts', () => {
      for (const phase of PROMOTION_JOURNAL_PHASES_V2) {
        const doc: PromotionJournalV2 = { ...VALID_V2, phase }
        const result = decodePromotionJournal(encodePromotionJournal(doc))
        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(result.journal).toEqual(doc)
          expect(Object.isFrozen(result.journal)).toBe(true)
        }
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
      const v2WithPath = JSON.stringify({ ...VALID_V2, sourcePath: '/tmp/evil' })
      expect(decodePromotionJournal(v2WithPath)).toEqual({ ok: false, code: 'UNEXPECTED_KEY' })
    })

    it('rejects missing keys', () => {
      for (const key of ['version', 'sessionId', 'candidateId', 'phase'] as const) {
        const partial: Record<string, unknown> = { ...VALID }
        delete partial[key]
        expect(decodePromotionJournal(JSON.stringify(partial))).toEqual({ ok: false, code: 'MISSING_KEY' })
      }
      const v2Partial: Record<string, unknown> = { ...VALID_V2 }
      delete v2Partial.receipts
      expect(decodePromotionJournal(JSON.stringify(v2Partial))).toEqual({ ok: false, code: 'MISSING_KEY' })
    })

    it('rejects unsupported versions (including strings)', () => {
      expect(decodePromotionJournal(JSON.stringify({ ...VALID, version: 3 }))).toEqual({
        ok: false,
        code: 'UNSUPPORTED_VERSION'
      })
      expect(decodePromotionJournal(JSON.stringify({ ...VALID, version: '1' }))).toEqual({
        ok: false,
        code: 'UNSUPPORTED_VERSION'
      })
      expect(decodePromotionJournal(JSON.stringify({ ...VALID_V2, version: 0 }))).toEqual({
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
      // A v1 phase in a v2 document is rejected (LOCK-PROMO-10 boundary).
      expect(decodePromotionJournal(JSON.stringify({ ...VALID_V2, phase: 'snapshot-ready' }))).toEqual({
        ok: false,
        code: 'INVALID_PHASE'
      })
    })

    it('rejects malformed v2 receipts (LOCK-PROMO-12 aggregate-receipt-only)', () => {
      const bad = JSON.stringify({
        ...VALID_V2,
        receipts: { candidate: { db: null, files: null, catalog: null }, old: { db: null, files: null } }
      })
      expect(decodePromotionJournal(bad)).toEqual({ ok: false, code: 'INVALID_RECEIPTS' })
      const privatePayload = JSON.stringify({
        ...VALID_V2,
        receipts: {
          candidate: { db: null, files: null, catalog: null },
          old: { db: null, files: null, catalog: null }
        },
        privatePath: '/Users/me/chat.db'
      })
      expect(decodePromotionJournal(privatePayload)).toEqual({ ok: false, code: 'UNEXPECTED_KEY' })
    })

    it('v2 receipts carry ONLY aggregate counts/digests — never filenames or content', () => {
      const result = decodePromotionJournal(encodePromotionJournal(VALID_V2))
      expect(result.ok).toBe(true)
      if (result.ok && result.journal.version === 2) {
        const receipts = result.journal.receipts.candidate
        expect(receipts.db?.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(receipts.files?.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(receipts.catalog?.sha256).toMatch(/^[0-9a-f]{64}$/)
        const raw = JSON.stringify(result.journal)
        expect(raw).not.toContain('filename')
        expect(raw).not.toContain('path')
      }
    })
  })

  describe('v2 codec edge cases (LOCK-PROMO-2/12)', () => {
    it('rejects a v1 document that smuggles a receipts key (exact key sets per version)', () => {
      const v1WithReceipts = JSON.stringify({ ...VALID, receipts: { candidate: {}, old: {} } })
      expect(decodePromotionJournal(v1WithReceipts)).toEqual({ ok: false, code: 'UNEXPECTED_KEY' })
    })

    it('rejects a v2 receipts block missing the candidate/old sub-objects', () => {
      for (const receipts of [
        {},
        { candidate: { db: null, files: null, catalog: null } },
        { old: { db: null, files: null, catalog: null } }
      ]) {
        const doc = JSON.stringify({ ...VALID_V2, receipts })
        expect(decodePromotionJournal(doc)).toEqual({ ok: false, code: 'INVALID_RECEIPTS' })
      }
    })

    it('rejects an artifact receipt block with extra or missing keys', () => {
      const base = JSON.parse(encodePromotionJournal(VALID_V2)) as Record<string, unknown>
      const receipts = base.receipts as Record<string, unknown>
      const extraKey = { ...(receipts.candidate as object), leakedPath: '/tmp/x' }
      expect(
        decodePromotionJournal(JSON.stringify({ ...base, receipts: { ...receipts, candidate: extraKey } }))
      ).toEqual({ ok: false, code: 'INVALID_RECEIPTS' })
      const missingKey = { db: (receipts.candidate as { db: unknown }).db }
      expect(
        decodePromotionJournal(JSON.stringify({ ...base, receipts: { ...receipts, candidate: missingKey } }))
      ).toEqual({ ok: false, code: 'INVALID_RECEIPTS' })
    })

    it('rejects non-safe-integer and negative sizes/counts in every receipt kind', () => {
      const base = JSON.parse(encodePromotionJournal(VALID_V2)) as Record<string, unknown>
      const receipts = base.receipts as Record<string, unknown>
      const candidate = receipts.candidate as Record<string, unknown>
      const badSizes: unknown[] = [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '100', null]
      for (const size of badSizes) {
        const doc = JSON.stringify({
          ...base,
          receipts: {
            ...receipts,
            candidate: { ...candidate, db: { sha256: 'a'.repeat(64), size } }
          }
        })
        expect(decodePromotionJournal(doc)).toEqual({ ok: false, code: 'INVALID_RECEIPTS' })
      }
      for (const count of badSizes) {
        const doc = JSON.stringify({
          ...base,
          receipts: {
            ...receipts,
            candidate: { ...candidate, catalog: { count, sha256: 'c'.repeat(64) } }
          }
        })
        expect(decodePromotionJournal(doc)).toEqual({ ok: false, code: 'INVALID_RECEIPTS' })
      }
    })

    it('rejects non-hex and non-64-hex digests in every receipt kind', () => {
      const base = JSON.parse(encodePromotionJournal(VALID_V2)) as Record<string, unknown>
      const receipts = base.receipts as Record<string, unknown>
      const candidate = receipts.candidate as Record<string, unknown>
      for (const sha256 of ['xyz', 'A'.repeat(64), 'a'.repeat(63), '', 123]) {
        const doc = JSON.stringify({
          ...base,
          receipts: {
            ...receipts,
            candidate: { ...candidate, db: { sha256, size: 10 } }
          }
        })
        expect(decodePromotionJournal(doc)).toEqual({ ok: false, code: 'INVALID_RECEIPTS' })
      }
    })

    it('encodes deterministically — identical documents produce identical bytes', () => {
      const a = encodePromotionJournal(VALID_V2)
      const b = encodePromotionJournal({ ...VALID_V2, phase: 'candidates-ready' })
      expect(a).toBe(b)
      // Order independence of the JSON stringify: same key order every time.
      expect(Object.keys(JSON.parse(a))).toEqual(['version', 'sessionId', 'candidateId', 'phase', 'receipts'])
    })

    it('decoded receipts are frozen recursively and deeply equal to the source', () => {
      const result = decodePromotionJournal(encodePromotionJournal(VALID_V2))
      expect(result.ok).toBe(true)
      if (result.ok && result.journal.version === 2) {
        expect(Object.isFrozen(result.journal.receipts.candidate)).toBe(true)
        expect(Object.isFrozen(result.journal.receipts.candidate.db)).toBe(true)
        expect(Object.isFrozen(result.journal.receipts.old)).toBe(true)
        expect(result.journal).toEqual(VALID_V2)
      }
    })
  })

  describe('canonical deep encoding + key-order-independent equality (LOCK-CLOSE-2)', () => {
    /** VALID_V2 with every nested receipt field order reversed. */
    function reversedKeyOrderDoc(): PromotionJournalV2 {
      return {
        version: 2,
        sessionId: VALID_V2.sessionId,
        candidateId: VALID_V2.candidateId,
        phase: VALID_V2.phase,
        receipts: {
          candidate: {
            catalog: { sha256: 'c'.repeat(64), count: 1 },
            files: { sha256: 'b'.repeat(64), totalBytes: 50, count: 1 },
            db: { size: 100, sha256: 'a'.repeat(64) }
          },
          old: { catalog: null, files: null, db: null }
        }
      }
    }

    it('reversed nested receipt key order encodes to the identical canonical bytes', () => {
      const canonical = encodePromotionJournal(VALID_V2)
      const reversed = encodePromotionJournal(reversedKeyOrderDoc())
      expect(reversed).toBe(canonical)
      // The canonical writer order is preserved byte-for-byte.
      expect(canonical).toContain(`"db":{"sha256":"${'a'.repeat(64)}","size":100}`)
      const parsed = JSON.parse(canonical) as {
        receipts: { candidate: { db: Record<string, unknown> } }
      }
      expect(Object.keys(parsed.receipts.candidate)).toEqual(['db', 'files', 'catalog'])
      expect(Object.keys(parsed.receipts.candidate.db)).toEqual(['sha256', 'size'])
    })

    it('reversed key order round-trips: decode → encode reproduces canonical bytes', () => {
      const onDisk = JSON.stringify(reversedKeyOrderDoc())
      const decoded = decodePromotionJournal(onDisk)
      expect(decoded.ok).toBe(true)
      if (decoded.ok) {
        expect(encodePromotionJournal(decoded.journal)).toBe(encodePromotionJournal(VALID_V2))
      }
    })

    it('identical documents with different key insertion orders encode identically', () => {
      const a = encodePromotionJournal(VALID_V2)
      const b = encodePromotionJournal(reversedKeyOrderDoc())
      expect(b).toBe(a)
      // Every top-level key order is also fixed regardless of writer order.
      expect(Object.keys(JSON.parse(a))).toEqual(['version', 'sessionId', 'candidateId', 'phase', 'receipts'])
    })

    it('artifactReceiptsEqual is key-order independent and null-correct', () => {
      const canonical = VALID_V2.receipts.candidate
      const reversed = {
        catalog: { sha256: 'c'.repeat(64), count: 1 },
        files: { sha256: 'b'.repeat(64), totalBytes: 50, count: 1 },
        db: { size: 100, sha256: 'a'.repeat(64) }
      }
      expect(artifactReceiptsEqual(canonical, reversed)).toBe(true)
      expect(artifactReceiptsEqual(canonical, canonical)).toBe(true)
      // Null vs value and value-vs-different-value are unequal.
      expect(
        artifactReceiptsEqual(
          { db: null, files: null, catalog: null },
          { db: { sha256: 'a'.repeat(64), size: 100 }, files: null, catalog: null }
        )
      ).toBe(false)
      expect(artifactReceiptsEqual(canonical, { ...reversed, db: { size: 101, sha256: 'a'.repeat(64) } })).toBe(false)
    })

    it('per-receipt equality helpers are key-order independent and null-correct', () => {
      expect(dbReceiptsEqual({ sha256: 'a'.repeat(64), size: 100 }, { size: 100, sha256: 'a'.repeat(64) })).toBe(true)
      expect(dbReceiptsEqual(null, null)).toBe(true)
      expect(dbReceiptsEqual(null, { sha256: 'a'.repeat(64), size: 100 })).toBe(false)
      expect(dbReceiptsEqual({ sha256: 'a'.repeat(64), size: 100 }, null)).toBe(false)
      expect(
        filesReceiptsEqual(
          { count: 1, totalBytes: 50, sha256: 'b'.repeat(64) },
          { sha256: 'b'.repeat(64), totalBytes: 50, count: 1 }
        )
      ).toBe(true)
      expect(catalogReceiptsEqual({ count: 1, sha256: 'c'.repeat(64) }, { sha256: 'c'.repeat(64), count: 1 })).toBe(
        true
      )
    })

    it('canonical encoding does not change the established writer-order bytes', () => {
      // The canonical writer order (db → files → catalog; sha256 → size) is
      // byte-identical to the pre-fix encoder for normally-ordered writers.
      const canonical = encodePromotionJournal(VALID_V2)
      expect(canonical).toBe(
        '{"version":2,"sessionId":"import-abc123-xyz","candidateId":"candidate-import-abc123-xyz",' +
          '"phase":"candidates-ready","receipts":{"candidate":{"db":{"sha256":"' +
          'a'.repeat(64) +
          '","size":100},"files":{"count":1,"totalBytes":50,"sha256":"' +
          'b'.repeat(64) +
          '"},"catalog":{"count":1,"sha256":"' +
          'c'.repeat(64) +
          '"}},"old":{"db":null,"files":null,"catalog":null}}}'
      )
    })
  })
})
