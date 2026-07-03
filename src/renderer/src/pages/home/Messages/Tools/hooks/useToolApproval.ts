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
  /** Whether a submission is in progress (Agent only) */
  isSubmitting: boolean
  /** Tool input from permission request (Agent only) */
  input?: Record<string, unknown>
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

export interface UseToolApprovalOptions {
  /** Force a specific approval type */
  forceType?: 'mcp' | 'agent'
}

/**
 * Unified hook for tool approval - automatically selects between MCP and Agent approval
 * based on the tool type in the block metadata.
 *
 * @param block - The tool message block
 * @param options - Optional configuration
 * @returns Unified approval state and actions
 */
export function useToolApproval(
  block: ToolMessageBlock,
  _options: UseToolApprovalOptions = {}
): ToolApprovalState & ToolApprovalActions {
  const mcpApproval = useMcpToolApproval(block)

  return mcpApproval
}

/**
 * Determine if a block needs approval (either MCP or Agent)
 */
export function isBlockWaitingApproval(block: ToolMessageBlock): boolean {
  return block.metadata?.rawMcpToolResponse?.status === 'pending'
}

export { useMcpToolApproval } from './useMcpToolApproval'
