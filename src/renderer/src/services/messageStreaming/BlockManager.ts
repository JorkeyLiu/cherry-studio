import { loggerService } from '@logger'
import type { AppDispatch, RootState } from '@renderer/store'
import { updateOneBlock, upsertOneBlock } from '@renderer/store/messageBlock'
import { newMessagesActions } from '@renderer/store/newMessage'
import type { MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'

import type { WriteBarrier } from './writeBarrier'

const logger = loggerService.withContext('BlockManager')

/**
 * Legacy/test save mocks may return nothing instead of a promise. Treat only
 * genuine thenables as trackable persistence — anything else means there is
 * no in-flight write to drain.
 */
function isThenable(value: unknown): value is Promise<void> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

interface ActiveBlockInfo {
  id: string
  type: MessageBlockType
}

interface BlockManagerDependencies {
  dispatch: AppDispatch
  getState: () => RootState
  saveUpdatedBlockToDB: (
    blockId: string | null,
    messageId: string,
    topicId: string,
    getState: () => RootState,
    resendAttemptId?: string
  ) => Promise<void>
  saveUpdatesToDB: (
    messageId: string,
    topicId: string,
    messageUpdates: Partial<any>,
    blocksToUpdate: MessageBlock[],
    resendAttemptId?: string
  ) => Promise<void>
  assistantMsgId: string
  topicId: string
  /**
   * Immutable execution attempt for resend/regenerate (SYNC-DATA-055, F1):
   * every DB write produced by this execution carries exactly this id.
   * Absent for ordinary executions (carrier omitted).
   */
  resendAttemptId?: string
  /** Execution write barrier for F2 finalization quiescence (optional). */
  barrier?: WriteBarrier
  // 节流器管理从外部传入
  throttledBlockUpdate: (id: string, blockUpdate: any, resendAttemptId?: string, barrier?: WriteBarrier) => void
  /**
   * Flush (never drop) a block's pending throttled trailing write, preserving
   * the last state. Falls back to cancel only when no flush fn is provided
   * (legacy/test contexts without F2 wiring).
   */
  flushThrottledBlockUpdate?: (id: string) => void
  cancelThrottledBlockUpdate: (id: string) => void
}

export class BlockManager {
  private deps: BlockManagerDependencies
  /** Block ids this execution sent to the throttler (F2 flush scope). */
  private readonly touchedThrottledBlocks = new Set<string>()

  // 简化后的状态管理
  private _activeBlockInfo: ActiveBlockInfo | null = null
  private _lastBlockType: MessageBlockType | null = null // 保留用于错误处理

  constructor(dependencies: BlockManagerDependencies) {
    this.deps = dependencies
  }

  /**
   * Track an execution persistence promise on the barrier when present.
   *
   * Legacy/test save mocks may return nothing instead of a promise (the
   * pre-F2 call sites were plain `void` fire-and-forget). Only thenables are
   * tracked — there is nothing to drain otherwise, and calling `.catch` on
   * a non-promise would synchronously abort the streaming callback chain.
   */
  private trackSave(promise: Promise<void> | void): void {
    if (!isThenable(promise)) {
      return
    }
    if (this.deps.barrier) {
      this.deps.barrier.track(promise)
    }
    void promise.catch(() => {
      // Save helpers log internally; the barrier observes settlement only.
    })
  }

  /** Flush a block's pending trailing write without dropping last state. */
  private flushBlock(id: string): void {
    if (this.deps.flushThrottledBlockUpdate) {
      try {
        this.deps.flushThrottledBlockUpdate(id)
      } catch (error) {
        logger.warn(`[flushBlock] Failed to flush throttled update for block ${id}:`, error as Error)
      }
    } else {
      this.deps.cancelThrottledBlockUpdate(id)
    }
  }

  // Getters
  get activeBlockInfo() {
    return this._activeBlockInfo
  }

  get lastBlockType() {
    return this._lastBlockType
  }

  get hasInitialPlaceholder() {
    return this._activeBlockInfo?.type === MessageBlockType.UNKNOWN
  }

  get initialPlaceholderBlockId() {
    return this.hasInitialPlaceholder ? this._activeBlockInfo?.id || null : null
  }

  // Setters
  set lastBlockType(value: MessageBlockType | null) {
    this._lastBlockType = value
  }

  set activeBlockInfo(value: ActiveBlockInfo | null) {
    this._activeBlockInfo = value
  }

  /**
   * 智能更新策略：根据块类型连续性自动判断使用节流还是立即更新
   *
   * F2: completion/type-change paths flush (never cancel-drop) the pending
   * throttled trailing write so the last streaming state always persists;
   * every produced DB write is tracked on the execution barrier when present.
   */
  smartBlockUpdate(
    blockId: string,
    changes: Partial<MessageBlock>,
    blockType: MessageBlockType,
    isComplete: boolean = false
  ) {
    const isBlockTypeChanged = this._lastBlockType !== null && this._lastBlockType !== blockType
    if (isBlockTypeChanged || isComplete) {
      // 如果块类型改变，则排空上一个块的节流更新（保留最后状态）
      if (isBlockTypeChanged && this._activeBlockInfo) {
        this.flushBlock(this._activeBlockInfo.id)
      }
      // 如果当前块完成，则排空当前块的节流更新（保留最后状态）
      if (isComplete) {
        this.flushBlock(blockId)
        this._activeBlockInfo = null // 块完成时清空activeBlockInfo
      } else {
        this._activeBlockInfo = { id: blockId, type: blockType } // 更新活跃块信息
      }
      this.deps.dispatch(updateOneBlock({ id: blockId, changes }))
      this.trackSave(
        this.deps.saveUpdatedBlockToDB(
          blockId,
          this.deps.assistantMsgId,
          this.deps.topicId,
          this.deps.getState,
          this.deps.resendAttemptId
        )
      )
      this._lastBlockType = blockType
    } else {
      this._activeBlockInfo = { id: blockId, type: blockType } // 更新活跃块信息
      this.touchedThrottledBlocks.add(blockId)
      this.deps.throttledBlockUpdate(blockId, changes, this.deps.resendAttemptId, this.deps.barrier)
    }
  }

  /**
   * 处理块转换
   */
  async handleBlockTransition(newBlock: MessageBlock, newBlockType: MessageBlockType) {
    logger.debug('handleBlockTransition', { newBlock, newBlockType })
    this._lastBlockType = newBlockType
    this._activeBlockInfo = { id: newBlock.id, type: newBlockType } // 设置新的活跃块信息

    this.deps.dispatch(
      newMessagesActions.updateMessage({
        topicId: this.deps.topicId,
        messageId: this.deps.assistantMsgId,
        updates: { blockInstruction: { id: newBlock.id } }
      })
    )
    this.deps.dispatch(upsertOneBlock(newBlock))
    this.deps.dispatch(
      newMessagesActions.upsertBlockReference({
        messageId: this.deps.assistantMsgId,
        blockId: newBlock.id,
        status: newBlock.status,
        blockType: newBlock.type
      })
    )

    const currentState = this.deps.getState()
    const updatedMessage = currentState.messages.entities[this.deps.assistantMsgId]
    if (updatedMessage) {
      this.touchedThrottledBlocks.add(newBlock.id)
      const save = this.deps.saveUpdatesToDB(
        this.deps.assistantMsgId,
        this.deps.topicId,
        { blocks: updatedMessage.blocks },
        [newBlock],
        this.deps.resendAttemptId
      )
      if (this.deps.barrier && isThenable(save)) {
        await this.deps.barrier.track(save)
      } else {
        await save
      }
    } else {
      logger.error(
        `[handleBlockTransition] Failed to get updated message ${this.deps.assistantMsgId} from state for DB save.`
      )
    }
  }

  /**
   * F2 finalization quiescence: flush every throttled trailing write this
   * execution produced, then resolve after all tracked DB writes settle.
   * Never rejects. Scoped to this execution's touched blocks — no global
   * wait, no cross-message blocking.
   */
  async quiesceWrites(): Promise<void> {
    for (const id of this.touchedThrottledBlocks) {
      this.flushBlock(id)
    }
    if (this.deps.barrier) {
      await this.deps.barrier.quiesce()
    }
  }
}
