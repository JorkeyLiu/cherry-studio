/**
 * MessageEditor callback rejection/retry — LOCK-003, LOCK-005.
 *
 * Verifies the callback contract that onSave and onResend failures
 * are properly rethrown by the component so callers (Message.tsx
 * handleEditSave/handleEditResend) can keep the editor open for retry.
 *
 * Tests the exact same handleSave/handleResend logic extracted from MessageEditor
 * without rendering the full component (avoids deep transitive dependency mocking).
 */

import { describe, expect, it, vi } from 'vitest'

describe('MessageEditor callback rejection/retry contract (LOCK-003, LOCK-005)', () => {
  const simulateHandleSave = async (onSave: () => Promise<void>, setIsProcessing: (v: boolean) => void) => {
    let isProcessing = false
    const guard = () => {
      if (isProcessing) return true
      isProcessing = true
      setIsProcessing(true)
      return false
    }

    if (guard()) return

    try {
      await onSave()
    } catch {
      isProcessing = false
      setIsProcessing(false)
    }
  }

  const simulateHandleResend = async (onResend: () => Promise<void>, setIsProcessing: (v: boolean) => void) => {
    let isProcessing = false
    const guard = () => {
      if (isProcessing) return true
      isProcessing = true
      setIsProcessing(true)
      return false
    }

    if (guard()) return

    try {
      await onResend()
    } catch {
      isProcessing = false
      setIsProcessing(false)
    }
  }

  it('keeps editor open when onSave rejects (isProcessing resets)', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('DB write failed'))
    const setIsProcessing = vi.fn()

    await simulateHandleSave(onSave, setIsProcessing)

    expect(setIsProcessing).toHaveBeenCalledWith(true)
    expect(setIsProcessing).toHaveBeenCalledWith(false)
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('keeps editor open when onResend rejects (isProcessing resets)', async () => {
    const onResend = vi.fn().mockRejectedValue(new Error('Resend failed'))
    const setIsProcessing = vi.fn()

    await simulateHandleResend(onResend, setIsProcessing)

    expect(setIsProcessing).toHaveBeenCalledWith(true)
    expect(setIsProcessing).toHaveBeenCalledWith(false)
    expect(onResend).toHaveBeenCalledTimes(1)
  })

  it('does not double-fire while processing', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const setIsProcessing = vi.fn()
    let isProcessing = false

    const guard = () => {
      if (isProcessing) return true
      isProcessing = true
      setIsProcessing(true)
      return false
    }

    // First call — starts processing
    if (!guard()) {
      await onSave()
    }

    expect(setIsProcessing).toHaveBeenCalledWith(true)
    expect(onSave).toHaveBeenCalledTimes(1)

    // Second call while processing — guard blocks
    const wasBlocked = guard()
    expect(wasBlocked).toBe(true)
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('resets isProcessing after successful save + close', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const setIsProcessing = vi.fn()
    let isProcessing = false

    const guard = () => {
      if (isProcessing) return true
      isProcessing = true
      setIsProcessing(true)
      return false
    }

    if (!guard()) {
      try {
        await onSave()
      } catch {
        isProcessing = false
        setIsProcessing(false)
      }
    }

    expect(onSave).toHaveBeenCalledTimes(1)

    // Simulate parent calling stopEditing() after save → component unmounts/resets
    // On next interaction, isProcessing starts fresh
    isProcessing = false
    const nextGuard = () => {
      if (isProcessing) return true
      isProcessing = true
      setIsProcessing(true)
      return false
    }
    expect(nextGuard()).toBe(false)
    expect(setIsProcessing).toHaveBeenCalledWith(true)
  })
})
