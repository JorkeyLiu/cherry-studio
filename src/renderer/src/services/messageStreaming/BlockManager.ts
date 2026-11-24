import { loggerService } from '@logger'
import type { AppDispatch, RootState } from '@renderer/store'
import { withClosureTopics } from '@renderer/store/closureOwnership'
import { updateOneBlock, upsertOneBlock } from '@renderer/store/messageBlock'
import { newMessagesActions } from '@renderer/store/newMessage'
import type { MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'

import type { AssistantExecutionState } from './executionState'
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
    resendAttemptId?: string,
    localBlock?: MessageBlock
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
  /**
   * Request-local execution state. Every generation owns one instance and the
   * caller passes it in; Redux is only an optional mirror, never a fallback.
   */
  executionState: AssistantExecutionState
  // 节流器管理从外部传入
  throttledBlockUpdate: (
    id: string,
    blockUpdate: any,
    resendAttemptId?: string,
    barrier?: WriteBarrier,
    shouldMirrorToRedux?: () => boolean
  ) => void
  /**
   * Flush (never drop) a block's pending throttled trailing write, preserving
   * the last state. Always wired to the execution scheduler.
   */
  flushThrottledBlockUpdate: (id: string) => void
  cancelThrottledBlockUpdate: (id: string) => void
  /**
   * Run pending Redux-mirror callbacks inline without touching DB writes.
   * Wired to the execution scheduler drain; called by terminal paths after
   * quiescence so the final projection publishes complete text.
   */
  drainMirrors: () => void
}

export class BlockManager {
  private deps: BlockManagerDependencies
  private readonly exec: AssistantExecutionState
  /** Block ids this execution sent to the throttler (F2 flush scope). */
  private readonly touchedThrottledBlocks = new Set<string>()
  /**
   * Terminal settlement for this execution. The first terminal callback
   * (onComplete/onError) to run claims the slot; later terminals are
   * no-ops so success is never overwritten by a trailing error (or the
   * reverse) and the final publish happens exactly once.
   */
  private terminalClaimed = false
  /** Guarded terminal settlement: resolves when settled, never rejects. */
  private terminalDone: Promise<void> | null = null

  // 简化后的状态管理
  private _activeBlockInfo: ActiveBlockInfo | null = null
  private _lastBlockType: MessageBlockType | null = null // 保留用于错误处理

  constructor(dependencies: BlockManagerDependencies) {
    this.deps = dependencies
    this.exec = dependencies.executionState
  }

  /** Request-local execution fact for this generation (never the Redux mirror). */
  get executionState(): AssistantExecutionState {
    return this.exec
  }

  /** Live loaded check: the message may be evicted mid-generation, so never cache. */
  private isLoaded(): boolean {
    try {
      return !!this.deps.getState()?.messages?.entities?.[this.deps.assistantMsgId]
    } catch {
      return false
    }
  }

  /** Runtime mirror gate for throttled trailing writes (DB always runs). */
  liveLoaded = (): boolean => this.isLoaded()

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
    try {
      this.deps.flushThrottledBlockUpdate(id)
    } catch (error) {
      logger.warn(`[flushBlock] Failed to flush throttled update for block ${id}:`, error as Error)
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
    // Local-first: the execution state is updated before any Redux mirror.
    const existing = this.exec.getBlock(blockId)
    let localAfter: MessageBlock | undefined
    if (existing) {
      localAfter = this.exec.applyBlockPatch(blockId, changes) ?? existing
    } else {
      const stub = { id: blockId, messageId: this.deps.assistantMsgId, type: blockType, ...changes } as MessageBlock
      this.exec.upsertBlock(stub)
      localAfter = this.exec.getBlock(blockId)
    }
    const isBlockTypeChanged = this._lastBlockType !== null && this._lastBlockType !== blockType
    // Safely narrow existing MessageBlock and incoming changes to THINKING/content-bearing shapes before reading content
    const isExistingThinkingEmpty = (() => {
      if (!existing || existing.type !== MessageBlockType.THINKING) return false
      const thinkingBlock = existing
      const existingContent = thinkingBlock.content
      return existingContent == null || (typeof existingContent === 'string' && existingContent.trim() === '')
    })()
    const hasIncomingContentString = (c: Partial<MessageBlock>): c is Partial<MessageBlock> & { content: string } => {
      return 'content' in c && typeof (c as { content?: unknown }).content === 'string'
    }
    const isIncomingNonEmpty = hasIncomingContentString(changes) && changes.content.trim() !== ''
    const isFirstThinkingChunk =
      blockType === MessageBlockType.THINKING &&
      isExistingThinkingEmpty &&
      isIncomingNonEmpty &&
      this._lastBlockType === blockType &&
      !isBlockTypeChanged &&
      !isComplete
    if (isBlockTypeChanged || isComplete || isFirstThinkingChunk) {
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
      if (this.isLoaded()) {
        this.deps.dispatch(withClosureTopics(updateOneBlock({ id: blockId, changes }), this.deps.topicId))
      }
      this.trackSave(
        this.deps.saveUpdatedBlockToDB(
          blockId,
          this.deps.assistantMsgId,
          this.deps.topicId,
          this.deps.getState,
          this.deps.resendAttemptId,
          localAfter
        )
      )
      this._lastBlockType = blockType
    } else {
      this._activeBlockInfo = { id: blockId, type: blockType } // 更新活跃块信息
      this.touchedThrottledBlocks.add(blockId)
      this.deps.throttledBlockUpdate(blockId, changes, this.deps.resendAttemptId, this.deps.barrier, () =>
        this.isLoaded()
      )
      // Throttled streaming chunks also advance the local execution fact
      // immediately; the throttler only mirrors to Redux/DB on its cadence.
      void localAfter
    }
  }

  /**
   * 处理块转换
   */
  async handleBlockTransition(newBlock: MessageBlock, newBlockType: MessageBlockType) {
    logger.debug('handleBlockTransition', { newBlock, newBlockType })
    this._lastBlockType = newBlockType
    this._activeBlockInfo = { id: newBlock.id, type: newBlockType } // 设置新的活跃块信息

    // Local-first: execution fact owns the ordered reference.
    this.exec.upsertBlock(newBlock)
    this.exec.appendBlockReference(newBlock.id)
    const localBlock = this.exec.getBlock(newBlock.id) ?? newBlock
    const orderedIds = this.exec.getBlockIds()

    // Redux is an optional live mirror: only when the message is still loaded.
    // Never inject a window-outside/detached message or orphan blocks.
    if (this.isLoaded()) {
      this.deps.dispatch(
        newMessagesActions.updateMessage({
          topicId: this.deps.topicId,
          messageId: this.deps.assistantMsgId,
          updates: { blockInstruction: { id: newBlock.id } }
        })
      )
      this.deps.dispatch(withClosureTopics(upsertOneBlock(localBlock), this.deps.topicId))
      this.deps.dispatch(
        newMessagesActions.upsertBlockReference({
          messageId: this.deps.assistantMsgId,
          blockId: newBlock.id,
          status: newBlock.status,
          blockType: newBlock.type
        })
      )
    }

    // DB streaming writes use the local execution fact, never the Redux entity.
    this.touchedThrottledBlocks.add(newBlock.id)
    const save = this.deps.saveUpdatesToDB(
      this.deps.assistantMsgId,
      this.deps.topicId,
      { blocks: orderedIds },
      [localBlock],
      this.deps.resendAttemptId
    )
    if (this.deps.barrier && isThenable(save)) {
      await this.deps.barrier.track(save)
    } else {
      await save
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
  /**
   * Synchronously claim the execution terminal slot. Returns false when a
   * terminal already claimed it, in which case the caller must skip its
   * terminal body (no second publish, no second persist).
   */
  tryStartTerminal(): boolean {
    if (this.terminalClaimed) {
      return false
    }
    this.terminalClaimed = true
    return true
  }
  /**
   * Register the claimed terminal promise. First registration wins; later
   * ones are ignored. Attaches observed handlers synchronously so a
   * dispatcher-dropped terminal never surfaces as an unhandled rejection,
   * and stores a guarded copy that resolves when settled but never rejects
   * (terminal failures are logged here; the original promise still carries
   * its own outcome to its direct caller per the existing contract).
   */
  trackTerminal(promise: Promise<void> | void): void {
    if (!this.terminalClaimed || this.terminalDone) {
      return
    }
    if (!isThenable(promise)) {
      this.terminalDone = Promise.resolve()
      return
    }
    this.terminalDone = promise.then(
      () => {},
      (error: unknown) => {
        logger.error('[terminal] Terminal processing rejected:', error as Error)
      }
    )
  }
  /**
   * Resolve after the registered terminal settles. Never rejects; a
   * terminal that never fired resolves immediately. Owners await this before
   * disposing scheduler ownership so no pending terminal write is lost.
   */
  async awaitTerminal(): Promise<void> {
    const done = this.terminalDone
    if (!done) {
      return
    }
    await done
  }
  /**
   * Run pending Redux-mirror callbacks inline (DB writes untouched). Called
   * by terminal paths after quiescence so the final projection publishes
   * complete text even when a frame was withheld and the owner is about to
   * dispose (which cancels RAF).
   */
  drainMirrors(): void {
    try {
      this.deps.drainMirrors()
    } catch (error) {
      logger.warn('[drainMirrors] Failed to drain pending mirrors:', error as Error)
    }
  }
}
