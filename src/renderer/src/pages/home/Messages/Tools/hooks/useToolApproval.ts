import type { ToolMessageBlock } from '@renderer/types/newMessage'

import { useMcpToolApproval } from './useMcpToolApproval'

/**
 * Unified tool approval state
 */
export interface ToolApprovalState {
  /** Whether the tool is waiting for user confirmation */
  isWaiting: boolean
  /** Whether the tool is currently executing after approval */
  isExecuting: boolean
  /** Whether a submission is in progress */
  isSubmitting: boolean
}

/**
 * Unified tool approval actions
 */
export interface ToolApprovalActions {
  /** Confirm/approve the tool execution */
  confirm: () => void | Promise<void>
  /** Cancel/deny the tool execution */
  cancel: () => void | Promise<void>
  /** Auto-approve this tool for future calls (if available) */
  autoApprove?: () => void | Promise<void>
}

/**
 * Unified hook for tool approval for MCP tool blocks.
 *
 * @param block - The tool message block
 * @returns Unified approval state and actions
 */
export function useToolApproval(block: ToolMessageBlock): ToolApprovalState & ToolApprovalActions {
  const mcpApproval = useMcpToolApproval(block)

  return mcpApproval
}

/**
 * Determine if a block needs MCP approval
 */
export function isBlockWaitingApproval(block: ToolMessageBlock): boolean {
  return block.metadata?.rawMcpToolResponse?.status === 'pending'
}

export { useMcpToolApproval } from './useMcpToolApproval'
