import { loggerService } from '@logger'
import { type Assistant, type Model, TopicType } from '@renderer/types'
import type { InputBarToolType } from '@renderer/types/chat'
import type { TFunction } from 'i18next'
import React from 'react'

import type { InputbarToolsContextValue } from './context/InputbarToolsProvider'

export { TopicType }

const logger = loggerService.withContext('InputbarToolsRegistry')

// LOCK-006: the mini window (and its 'mini-window' inputbar scope) is removed.
export type InputbarScope = TopicType

export interface InputbarScopeConfig {
  placeholder?: string
  minRows?: number
  maxRows?: number
  showTokenCount?: boolean
  showTools?: boolean
  toolsCollapsible?: boolean
  enableDragDrop?: boolean
}

type ReadableKeys<T> = {
  [K in keyof T]: T[K] extends (...args: any[]) => any ? never : K
}[keyof T]

type ActionKeys<T> = {
  [K in keyof T]: T[K] extends (...args: any[]) => any ? K : never
}[keyof T]

type ToolStateKeys = Exclude<ReadableKeys<InputbarToolsContextValue>, never>
type ToolActionKeys = Exclude<ActionKeys<InputbarToolsContextValue>, never>

export type ToolStateMap = Pick<InputbarToolsContextValue, ToolStateKeys>
export type ToolActionMap = Pick<InputbarToolsContextValue, ToolActionKeys>

export type ToolStateKey = keyof ToolStateMap
export type ToolActionKey = keyof ToolActionMap

/**
 * Tool dependencies configuration
 */
export interface ToolDependencies {
  state?: ToolStateKeys[]
  actions?: ToolActionKeys[]
}

export interface ToolContext {
  scope: InputbarScope
  assistant: Assistant
  /** May be explicitly unconfigured (undefined). Tools must tolerate it. */
  model?: Model
}

/**
 * Tool render context with injected dependencies
 */
export type ToolRenderContext<S extends readonly ToolStateKey[], A extends readonly ToolActionKey[]> = ToolContext & {
  state: Pick<ToolStateMap, S[number]>
  actions: Pick<ToolActionMap, A[number]>
  t: TFunction
}

/**
 * Tool definition with full type inference for dependencies
 */
export interface ToolDefinition<
  S extends readonly ToolStateKey[] = readonly ToolStateKey[],
  A extends readonly ToolActionKey[] = readonly ToolActionKey[]
> {
  key: string
  label: string | ((t: TFunction) => string)

  // Visibility and conditions
  condition?: (context: ToolContext) => boolean
  visibleInScopes?: InputbarScope[]
  defaultHidden?: boolean

  // Dependencies
  dependencies?: {
    state?: S
    actions?: A
  }

  // Render function (receives context with injected dependencies)
  render: ((context: ToolRenderContext<S, A>) => React.ReactNode) | null
}

/**
 * Helper function to define a tool with full type inference
 */
export const defineTool = <S extends readonly ToolStateKey[], A extends readonly ToolActionKey[]>(
  tool: ToolDefinition<S, A>
): ToolDefinition<S, A> => tool

// Tool registry (use any for generics to accept all tool definitions)
const toolRegistry = new Map<string, ToolDefinition<any, any>>()

export const registerTool = (tool: ToolDefinition<any, any>): void => {
  if (toolRegistry.has(tool.key)) {
    logger.warn(`Tool with key "${tool.key}" is already registered. Overwriting.`)
  }
  toolRegistry.set(tool.key, tool)
}

export const getTool = (key: string): ToolDefinition<any, any> | undefined => {
  return toolRegistry.get(key)
}

export const getAllTools = (): ToolDefinition<any, any>[] => {
  return Array.from(toolRegistry.values())
}

export const getToolsForScope = (
  scope: InputbarScope,
  context: Omit<ToolContext, 'scope'>
): ToolDefinition<any, any>[] => {
  const fullContext: ToolContext = { ...context, scope }

  return getAllTools().filter((tool) => {
    // Check scope visibility
    if (tool.visibleInScopes && !tool.visibleInScopes.includes(scope)) {
      return false
    }

    // Check custom condition
    if (tool.condition && !tool.condition(fullContext)) {
      return false
    }

    return true
  })
}

// Tool order configuration
export interface ToolOrderConfig {
  visible: InputBarToolType[]
  hidden: InputBarToolType[]
}
