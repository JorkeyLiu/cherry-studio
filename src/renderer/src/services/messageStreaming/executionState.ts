import { loggerService } from '@logger'
import type { Message, MessageBlock } from '@renderer/types/newMessage'

const logger = loggerService.withContext('ExecutionState')

function deepCopy<T>(value: T): T {
  try {
    if (typeof structuredClone === 'function') {
      return structuredClone(value)
    }
  } catch {
    // fall through to JSON copy
  }
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * Request-local assistant execution state.
 *
 * Every generation (ordinary/loaded or semantic/detached) owns one instance.
 * It holds the execution fact for this request: the assistant message snapshot,
 * the latest block per id, and the ordered `message.blocks` reference list.
 * Redux is only an optional mirror; Main remains the DB authority and the
 * resend attempt remains the stale fence.
 */
export class AssistantExecutionState {
  private message: Message
  private blocks = new Map<string, MessageBlock>()

  constructor(initialMessage: Message, initialBlocks: MessageBlock[] = []) {
    this.message = deepCopy(initialMessage)
    if (!Array.isArray((this.message as { blocks?: unknown }).blocks)) {
      this.message.blocks = []
    } else {
      this.message.blocks = [...(this.message.blocks ?? [])]
    }
    for (const block of initialBlocks) {
      if (block && typeof (block as { id?: unknown }).id === 'string' && (block as { id: string }).id.length > 0) {
        this.blocks.set((block as { id: string }).id, deepCopy(block))
      }
    }
  }

  /** Live execution message (mutable only via patch APIs). */
  getMessage(): Message {
    return this.message
  }

  getBlock(id: string): MessageBlock | undefined {
    return this.blocks.get(id)
  }

  /** Ordered block ids as held by `message.blocks`. */
  getBlockIds(): string[] {
    return [...(this.message.blocks ?? [])]
  }

  /** Latest blocks in `message.blocks` order (missing refs omitted). */
  getOrderedBlocks(): MessageBlock[] {
    const out: MessageBlock[] = []
    for (const id of this.message.blocks ?? []) {
      const block = this.blocks.get(id)
      if (block) {
        out.push(block)
      }
    }
    return out
  }

  getMissingBlockIds(): string[] {
    const ids = this.message.blocks ?? []
    return ids.filter((id) => !this.blocks.has(id))
  }

  applyMessagePatch(patch: Partial<Message>): Message {
    const safe = deepCopy(patch)
    const prevId = this.message.id
    const prevTopicId = this.message.topicId
    this.message = { ...this.message, ...safe }
    // Identity is execution-scoped and never rewritten by streaming patches.
    this.message.id = prevId
    this.message.topicId = prevTopicId
    if (!Array.isArray(this.message.blocks)) {
      this.message.blocks = []
    }
    return this.message
  }

  upsertBlock(block: MessageBlock): void {
    if (!block || typeof (block as { id?: unknown }).id !== 'string') {
      logger.warn('[ExecutionState] upsertBlock skipped: missing id.')
      return
    }
    this.blocks.set(block.id, deepCopy(block))
  }

  applyBlockPatch(id: string, patch: Partial<MessageBlock>): MessageBlock | undefined {
    const current = this.blocks.get(id)
    if (!current) {
      return undefined
    }
    const safe = deepCopy(patch)
    // Union spread needs an explicit re-narrow: the merged value is still the
    // same variant as `current` (patches never change the discriminant).
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-type-assertion
    const next = { ...current, ...safe } as MessageBlock
    next.id = current.id
    next.messageId = current.messageId
    this.blocks.set(id, next)
    return next
  }

  /** Append a block reference with dedup (mirrors the Redux blockInstruction reducer). */
  appendBlockReference(blockId: string): void {
    if (!blockId) return
    if (!Array.isArray(this.message.blocks)) {
      this.message.blocks = []
    }
    if (!this.message.blocks.includes(blockId)) {
      this.message.blocks.push(blockId)
    }
  }

  snapshot(): { message: Message; blocks: MessageBlock[]; orderedIds: string[] } {
    return {
      message: deepCopy(this.message),
      blocks: this.getOrderedBlocks().map((b) => deepCopy(b)),
      orderedIds: [...(this.message.blocks ?? [])]
    }
  }
}

/**
 * Build the execution snapshot for one generation.
 * `initialMessage` is the authority execution snapshot (semantic reset message)
 * or the ordinary stub. Initial blocks resolve from the matching Redux entities
 * when present; detached semantic resets are usually empty and never injected.
 */
export function createAssistantExecutionState(
  initialMessage: Message,
  getState?: () => { messageBlocks?: { entities?: Record<string, MessageBlock> } }
): AssistantExecutionState {
  const ids = [...(initialMessage?.blocks ?? [])]
  const initialBlocks: MessageBlock[] = []
  if (ids.length > 0) {
    try {
      const entities = getState?.()?.messageBlocks?.entities
      if (entities) {
        for (const id of ids) {
          const block = entities[id]
          if (block) {
            initialBlocks.push(block)
          }
        }
      }
    } catch (error) {
      logger.warn('[ExecutionState] initial block lookup failed, starting empty.', error as Error)
    }
  }
  return new AssistantExecutionState(initialMessage, initialBlocks)
}
