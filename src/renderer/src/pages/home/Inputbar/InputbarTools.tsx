import '@renderer/pages/home/Inputbar/tools'

import type { DropResult } from '@hello-pangea/dnd'
import { DragDropContext, Draggable, Droppable } from '@hello-pangea/dnd'
import { ActionIconButton } from '@renderer/components/Buttons'
import { useInputbarTools } from '@renderer/pages/home/Inputbar/context/InputbarToolsProvider'
import type {
  InputbarScope,
  ToolActionKey,
  ToolActionMap,
  ToolDefinition,
  ToolOrderConfig,
  ToolRenderContext,
  ToolStateKey,
  ToolStateMap
} from '@renderer/pages/home/Inputbar/types'
import { getToolsForScope } from '@renderer/pages/home/Inputbar/types'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { selectToolOrder, setIsCollapsed, setToolOrder } from '@renderer/store/inputTools'
import type { Assistant, Model } from '@renderer/types'
import type { InputBarToolType } from '@renderer/types/chat'
import { classNames } from '@renderer/utils'
import { Divider, Dropdown } from 'antd'
import type { ItemType } from 'antd/es/menu/interface'
import { Check, CircleChevronRight } from 'lucide-react'
import React, { useCallback, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

export interface InputbarToolsNewProps {
  scope: InputbarScope
  assistant: Assistant
  /** May be explicitly unconfigured (undefined). */
  model?: Model
}

interface ToolConfig {
  key: InputBarToolType
  label: string
  tool: ToolDefinition
  visible: boolean
}

const DraggablePortal = ({ children, isDragging }: { children: React.ReactNode; isDragging: boolean }) => {
  return isDragging ? createPortal(children, document.body) : children
}

const InputbarTools = ({ scope, assistant, model }: InputbarToolsNewProps) => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const toolsContext = useInputbarTools()

  const reduxToolOrder = useAppSelector((state) => selectToolOrder(state))
  const isCollapse = useAppSelector((state) => state.inputTools.isCollapsed)
  const [targetTool, setTargetTool] = useState<ToolConfig | null>(null)

  // Get tools for current scope
  const availableTools = useMemo(() => {
    return getToolsForScope(scope, { assistant, model })
  }, [scope, assistant, model])

  // Get tool order for current scope
  const toolOrder = useMemo(() => {
    return reduxToolOrder
  }, [reduxToolOrder])

  // Build render context for tools
  const buildRenderContext = useCallback(
    <S extends readonly ToolStateKey[], A extends readonly ToolActionKey[]>(
      tool: ToolDefinition<S, A>
    ): ToolRenderContext<S, A> => {
      const deps = tool.dependencies

      const state = (deps?.state || ([] as unknown as S)).reduce(
        (acc, key) => {
          acc[key] = toolsContext[key]
          return acc
        },
        {} as Pick<ToolStateMap, S[number]>
      )

      const actions = (deps?.actions || ([] as unknown as A)).reduce(
        (acc, key) => {
          const actionValue = toolsContext[key]
          if (actionValue) {
            acc[key] = actionValue
          }
          return acc
        },
        {} as Pick<ToolActionMap, A[number]>
      )

      return {
        scope,
        assistant,
        model,
        state,
        actions,
        t
      } as ToolRenderContext<S, A>
    },
    [assistant, model, scope, t, toolsContext]
  )

  // Build tool metadata (without rendering)
  const toolMetadata = useMemo(() => {
    return availableTools.map((tool) => ({
      key: tool.key as InputBarToolType,
      label: typeof tool.label === 'function' ? tool.label(t) : tool.label,
      tool
    }))
  }, [availableTools, t])

  // Filter visible tools (only those with render functions)
  const visibleTools = useMemo(() => {
    const explicitlyVisible = toolOrder.visible
      .map((key) => {
        const meta = toolMetadata.find((item) => item.key === key)
        if (!meta || meta.tool.render === null) return null
        return {
          key: meta.key,
          label: meta.label,
          tool: meta.tool,
          visible: true
        }
      })
      .filter(Boolean) as ToolConfig[]

    const knownToolKeys = new Set([...toolOrder.visible, ...toolOrder.hidden])
    const newTools = toolMetadata
      .filter((meta) => !knownToolKeys.has(meta.key) && meta.tool.render !== null)
      .map((meta) => ({
        key: meta.key,
        label: meta.label,
        tool: meta.tool,
        visible: true
      }))

    return [...explicitlyVisible, ...newTools]
  }, [toolMetadata, toolOrder.visible, toolOrder.hidden])

  const hiddenTools = useMemo(() => {
    return toolOrder.hidden
      .map((key) => {
        const meta = toolMetadata.find((item) => item.key === key)
        if (!meta || meta.tool.render === null) return null
        return {
          key: meta.key,
          label: meta.label,
          tool: meta.tool,
          visible: false
        }
      })
      .filter(Boolean) as ToolConfig[]
  }, [toolMetadata, toolOrder.hidden])

  const showDivider = useMemo(() => {
    return hiddenTools.length > 0 && visibleTools.length > 0
  }, [hiddenTools, visibleTools])

  const showCollapseButton = useMemo(() => {
    return hiddenTools.length > 0
  }, [hiddenTools])

  const toggleToolVisibility = useCallback(
    (toolKey: InputBarToolType, isVisible: boolean | undefined) => {
      const newToolOrder: ToolOrderConfig = {
        visible: [...toolOrder.visible],
        hidden: [...toolOrder.hidden]
      }

      if (isVisible === true) {
        newToolOrder.visible = newToolOrder.visible.filter((key) => key !== toolKey)
        newToolOrder.hidden.push(toolKey)
      } else {
        newToolOrder.hidden = newToolOrder.hidden.filter((key) => key !== toolKey)
        newToolOrder.visible.push(toolKey)
      }

      dispatch(setToolOrder({ toolOrder: newToolOrder }))
      setTargetTool(null)
    },
    [dispatch, toolOrder]
  )

  const handleDragEnd = (result: DropResult) => {
    const { source, destination } = result
    if (!destination) return

    const sourceId = source.droppableId
    const destinationId = destination.droppableId

    const visibleKeys = visibleTools.map((t) => t.key)
    const hiddenKeys = hiddenTools.map((t) => t.key)

    const newToolOrder: ToolOrderConfig = {
      visible: [...visibleKeys],
      hidden: [...hiddenKeys]
    }

    const sourceArray = sourceId === 'inputbar-tools-visible' ? 'visible' : 'hidden'
    const destArray = destinationId === 'inputbar-tools-visible' ? 'visible' : 'hidden'

    if (sourceArray === destArray) {
      const items = newToolOrder[sourceArray]
      const [removed] = items.splice(source.index, 1)
      items.splice(destination.index, 0, removed)
    } else {
      const removed = newToolOrder[sourceArray][source.index]
      newToolOrder[sourceArray].splice(source.index, 1)
      newToolOrder[destArray].splice(destination.index, 0, removed)
    }

    dispatch(setToolOrder({ toolOrder: newToolOrder }))
  }

  const getMenuItems = useMemo(() => {
    const baseItems: ItemType[] = [...visibleTools, ...hiddenTools].map((tool) => ({
      label: tool.label,
      key: tool.key,
      icon: (
        <div style={{ width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {tool.visible ? <Check size={16} /> : undefined}
        </div>
      ),
      onClick: () => toggleToolVisibility(tool.key, tool.visible)
    }))

    if (targetTool) {
      baseItems.push({ type: 'divider' })
      baseItems.push({
        label: `${targetTool.visible ? t('chat.input.tools.collapse_in') : t('chat.input.tools.collapse_out')} "${targetTool.label}"`,
        key: 'selected_' + targetTool.key,
        icon: <div style={{ width: 20, height: 20 }}></div>,
        onClick: () => toggleToolVisibility(targetTool.key, targetTool.visible)
      })
    }

    return baseItems
  }, [hiddenTools, t, targetTool, toggleToolVisibility, visibleTools])

  return (
    <Dropdown menu={{ items: getMenuItems }} trigger={['contextMenu']}>
      <ToolsContainer
        onContextMenu={(e) => {
          const target = e.target as HTMLElement
          const isToolButton = target.closest('[data-key]')
          if (!isToolButton) {
            setTargetTool(null)
          }
        }}>
        <DragDropContext onDragEnd={handleDragEnd}>
          <Droppable droppableId="inputbar-tools-visible" direction="horizontal">
            {(provided) => (
              <VisibleTools ref={provided.innerRef} {...provided.droppableProps}>
                {visibleTools.map((toolConfig, index) => {
                  const context = buildRenderContext(toolConfig.tool)
                  return (
                    <Draggable key={toolConfig.key} draggableId={toolConfig.key} index={index}>
                      {(provided, snapshot) => (
                        <DraggablePortal isDragging={snapshot.isDragging}>
                          <ToolWrapper
                            data-key={toolConfig.key}
                            onContextMenu={() => setTargetTool(toolConfig)}
                            ref={provided.innerRef}
                            {...provided.draggableProps}
                            {...provided.dragHandleProps}
                            style={provided.draggableProps.style}>
                            {toolConfig.tool.render?.(context)}
                          </ToolWrapper>
                        </DraggablePortal>
                      )}
                    </Draggable>
                  )
                })}
                {provided.placeholder}
              </VisibleTools>
            )}
          </Droppable>

          {showDivider && <Divider type="vertical" style={{ margin: '0 4px' }} />}

          <Droppable droppableId="inputbar-tools-hidden" direction="horizontal">
            {(provided) => (
              <HiddenTools ref={provided.innerRef} {...provided.droppableProps}>
                {hiddenTools.map((toolConfig, index) => {
                  const context = buildRenderContext(toolConfig.tool)
                  return (
                    <Draggable key={toolConfig.key} draggableId={toolConfig.key} index={index}>
                      {(provided, snapshot) => (
                        <DraggablePortal isDragging={snapshot.isDragging}>
                          <ToolWrapper
                            data-key={toolConfig.key}
                            className={classNames({ 'is-collapsed': isCollapse })}
                            onContextMenu={() => setTargetTool(toolConfig)}
                            ref={provided.innerRef}
                            {...provided.draggableProps}
                            {...provided.dragHandleProps}
                            style={{
                              ...provided.draggableProps.style,
                              transitionDelay: `${index * 0.02}s`
                            }}>
                            {toolConfig.tool.render?.(context)}
                          </ToolWrapper>
                        </DraggablePortal>
                      )}
                    </Draggable>
                  )
                })}
                {provided.placeholder}
              </HiddenTools>
            )}
          </Droppable>
        </DragDropContext>

        {showCollapseButton && (
          <ActionIconButton
            onClick={() => dispatch(setIsCollapsed(!isCollapse))}
            title={isCollapse ? t('chat.input.tools.expand') : t('chat.input.tools.collapse')}>
            <CircleChevronRight size={18} style={{ transform: isCollapse ? 'scaleX(1)' : 'scaleX(-1)' }} />
          </ActionIconButton>
        )}
      </ToolsContainer>
    </Dropdown>
  )
}

InputbarTools.displayName = 'InputbarTools'

const ToolsContainer = styled.div`
  min-width: 0;
  display: flex;
  align-items: center;
  position: relative;
`

const VisibleTools = styled.div`
  height: 30px;
  display: flex;
  align-items: center;
  overflow-x: auto;
  &::-webkit-scrollbar {
    display: none;
  }
  -ms-overflow-style: none;
  scrollbar-width: none;
`

const HiddenTools = styled.div`
  height: 30px;
  display: flex;
  align-items: center;
  overflow-x: auto;
  &::-webkit-scrollbar {
    display: none;
  }
  -ms-overflow-style: none;
  scrollbar-width: none;
`

const ToolWrapper = styled.div`
  width: 30px;
  margin-right: 6px;
  transition:
    width 0.2s,
    margin-right 0.2s,
    opacity 0.2s;
  &.is-collapsed {
    width: 0px;
    margin-right: 0px;
    overflow: hidden;
    opacity: 0;
  }
`

export default InputbarTools
