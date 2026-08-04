/**
 * Unit tests for the E2E path/stack redaction surface (LOCK-REAL2/LOCK-PRIV-2).
 *
 * LOCK-PRIV-2: the secret source path must be redacted in BOTH the error
 * message and the error stack; the unredacted stack is never preserved. A
 * decoy stack (an Error whose stack embeds the secret path) must come out
 * fully redacted.
 */
import { describe, expect, it } from 'vitest'

import { redactPathText, redactSourcePath } from './redact-path'

const SECRET = '/private/var/users/synthetic/Backups/CherryStudio-Backup-2026-08-04.zip'

function errorWithSecretInStack(): Error {
  // The message embeds SECRET; the synthetic stack of the resulting Error
  // also carries this file path + line.
  return new Error(`failed to read archive ${SECRET}: EACCES permission denied`)
}

/** Serialize an Error including its (non-enumerable) message/stack. */
function serializeError(error: Error): string {
  return JSON.stringify({ message: error.message, stack: error.stack })
}

describe('redactPathText (LOCK-REAL2)', () => {
  it('redacts the secret path from an Error message', () => {
    const message = redactPathText(errorWithSecretInStack(), SECRET)
    expect(message).not.toContain(SECRET)
    expect(message).toContain('<redacted>')
  })

  it('redacts the secret path from a plain string', () => {
    expect(redactPathText(`open ${SECRET}: no such file`, SECRET)).toBe('open <redacted>: no such file')
  })
})

describe('redactSourcePath (LOCK-PRIV-2)', () => {
  it('redacts the secret path from BOTH the message and the stack', () => {
    const original = errorWithSecretInStack()
    const redacted = redactSourcePath(original, SECRET)

    expect(redacted.message).not.toContain(SECRET)
    expect(redacted.message).toContain('<redacted>')

    const serialized = serializeError(redacted)
    expect(serialized).not.toContain(SECRET)
    expect(serialized).toContain('<redacted>')

    // The unredacted stack must never be preserved.
    expect(redacted.stack).toBeDefined()
    expect(redacted.stack!).not.toContain(SECRET)
    expect(redacted.stack).not.toBe(original.stack)
  })

  it('redacts a secret that appears only inside the stack (decoy frame)', () => {
    // An Error whose message is benign but whose stack embeds the secret via a
    // synthetic frame source — the redaction must still cover the stack.
    const synthetic = new Error('benign message')
    synthetic.stack = `Error: benign message
    at readArchive (/repo/tests/e2e/specs/settings/import-cherrystudio-real-backup.spec.ts:123:17)
    at evaluate (${SECRET}:1:1)
    at async main (/repo/tests/e2e/main.js:45:9)`
    const redacted = redactSourcePath(synthetic, SECRET)
    const serialized = serializeError(redacted)
    expect(serialized).not.toContain(SECRET)
    expect(serialized).toContain('<redacted>')
    expect(redacted.stack).not.toContain(SECRET)
    expect(redacted.message).toBe('benign message')
  })

  it('never preserves the unredacted stack on the wrapped error', () => {
    const original = errorWithSecretInStack()
    const redacted = redactSourcePath(original, SECRET)
    // serializeError includes stack — equality with the original would be a
    // privacy leak even without an explicit `.stack` assertion.
    expect(serializeError(redacted)).not.toBe(serializeError(original))
    expect(serializeError(redacted)).not.toContain(SECRET)
  })

  it('handles non-Error values by stringifying and redacting', () => {
    const redacted = redactSourcePath(`read ${SECRET} failed`, SECRET)
    expect(redacted.message).not.toContain(SECRET)
    expect(redacted.message).toContain('<redacted>')
  })

  it('does not leak the secret when the original had no stack', () => {
    const bare = new Error(`lstat ${SECRET}`)
    bare.stack = undefined
    const redacted = redactSourcePath(bare, SECRET)
    expect(redacted.message).not.toContain(SECRET)
    expect(redacted.message).toContain('<redacted>')
    // The wrapped error's own fresh stack is secret-free.
    expect(serializeError(redacted)).not.toContain(SECRET)
  })

  it('leaves an error without the secret untouched in content', () => {
    const redacted = redactSourcePath(new Error('unrelated failure'), SECRET)
    expect(redacted.message).toBe('unrelated failure')
    expect(serializeError(redacted)).not.toContain(SECRET)
  })
})
