/**
 * S6.2c-2: MessageMenubar primary insert path — anchor-based
 *
 * Verifies:
 * - Insert path dispatches insertMessagesThunk with stable afterMessageId (no numeric index)
 * - Does not call legacy positional append path directly
 */
import { describe, expect, it } from 'vitest'

describe('MessageMenubar insert anchor — S6.2c-2', () => {
  it('MessageMenubar dispatches insertMessagesThunk with stable afterMessageId', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync('src/renderer/src/pages/home/Messages/MessageMenubar.tsx', 'utf8')
    expect(src).toContain('insertMessagesThunk')
    expect(src).toContain('insertMessagesThunk(topic.id, message.id, assistant.id)')
    // Ensure no direct appendMessage for insert path
    expect(src).not.toMatch(/appendMessage\(topic\.id,\s*message/)
    // Verify thunk source is anchor-based
    const thunkSrc = fs.readFileSync('src/renderer/src/store/thunk/messageThunk.ts', 'utf8')
    const primary = thunkSrc.slice(
      thunkSrc.indexOf('export const insertMessagesThunk'),
      thunkSrc.indexOf('export const insertMessagesThunkLegacy')
    )
    expect(primary).toContain('insertMessagesAfterAnchor')
    expect(primary).not.toMatch(/saveMessageAndBlocksToDB\(topicId,\s*userMessage,\s*\[userBlock\],\s*insertIndex/)
  })
})
