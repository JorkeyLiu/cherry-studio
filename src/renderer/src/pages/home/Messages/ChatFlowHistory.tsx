import '@xyflow/react/dist/style.css'

import { RobotOutlined, UserOutlined } from '@ant-design/icons'
import EmojiAvatar from '@renderer/components/Avatar/EmojiAvatar'
import ModelAvatar from '@renderer/components/Avatar/ModelAvatar'
import { getModelLogo, getModelLogoById } from '@renderer/config/models'
import { useTheme } from '@renderer/context/ThemeProvider'
import useAvatar from '@renderer/hooks/useAvatar'
import { useSettings } from '@renderer/hooks/useSettings'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import type { RootState } from '@renderer/store'
import type { Model } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { isEmoji } from '@renderer/utils'
import { getMainTextSnapshotContent, type SnapshotBlockMap } from '@renderer/utils/messageUtils/snapshotBlocks'
import { loadWholeTopicSnapshot, type WholeTopicSnapshot } from '@renderer/utils/topicSnapshot'
import type { Edge, Node, NodeTypes } from '@xyflow/react'
import { Controls, Handle, MiniMap, ReactFlow, ReactFlowProvider } from '@xyflow/react'
import { Position, useEdgesState, useNodesState } from '@xyflow/react'
import { Avatar, Spin, Tooltip } from 'antd'
import type { FC } from 'react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSelector } from 'react-redux'
import styled from 'styled-components'

// 定义Tooltip相关样式组件
const TooltipContent = styled.div`
  max-width: 300px;
`

const TooltipTitle = styled.div`
  font-weight: bold;
  margin-bottom: 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.2);
  padding-bottom: 4px;
`

const TooltipBody = styled.div`
  max-height: 200px;
  overflow-y: auto;
  margin-bottom: 8px;
  white-space: pre-wrap;
`

const TooltipFooter = styled.div`
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
  font-style: italic;
`

// 自定义节点组件
// FIXME: no any plz...
const CustomNode: FC<{ data: any }> = ({ data }) => {
  const { t } = useTranslation()

  const nodeType = data.type
  let borderColor = 'var(--color-border)'
  let title = ''
  let backgroundColor = 'var(--bg-color)'
  let gradientColor = 'rgba(0, 0, 0, 0.03)'
  let avatar: React.ReactNode | null = null

  // 根据消息类型设置不同的样式和图标
  if (nodeType === 'user') {
    borderColor = 'var(--color-icon)'
    backgroundColor = 'rgba(var(--color-info-rgb), 0.03)'
    gradientColor = 'rgba(var(--color-info-rgb), 0.08)'
    title = data.userName || t('chat.history.user_node')

    // 用户头像
    if (data.userAvatar) {
      if (isEmoji(data.userAvatar)) {
        avatar = <EmojiAvatar size={32}>{data.userAvatar}</EmojiAvatar>
      } else {
        avatar = <Avatar src={data.userAvatar} alt={title} />
      }
    } else {
      avatar = <Avatar icon={<UserOutlined />} style={{ backgroundColor: 'var(--color-info)' }} />
    }
  } else if (nodeType === 'assistant') {
    borderColor = 'var(--color-primary)'
    backgroundColor = 'rgba(var(--color-primary-rgb), 0.03)'
    gradientColor = 'rgba(var(--color-primary-rgb), 0.08)'
    title = `${data.model || t('chat.history.assistant_node')}`

    // 模型头像
    if (data.modelInfo) {
      avatar = <ModelAvatar model={data.modelInfo} size={32} />
    } else if (data.modelId) {
      const modelLogo = getModelLogo(data.modelInfo) ?? getModelLogoById(data.modelId)
      avatar = (
        <Avatar
          src={modelLogo}
          icon={!modelLogo ? <RobotOutlined /> : undefined}
          style={{ backgroundColor: 'var(--color-primary)' }}
        />
      )
    } else {
      avatar = <Avatar icon={<RobotOutlined />} style={{ backgroundColor: 'var(--color-primary)' }} />
    }
  }

  // 处理节点点击事件，滚动到对应消息
  const handleNodeClick = () => {
    if (data.messageId) {
      void EventEmitter.emit(EVENT_NAMES.NAVIGATE_TO_MESSAGE, data.messageId)
    }
  }

  // 隐藏连接点的通用样式
  const handleStyle = {
    opacity: 0,
    width: '12px',
    height: '12px',
    background: 'transparent',
    border: 'none'
  }

  return (
    <Tooltip
      title={
        <TooltipContent>
          <TooltipTitle>{title}</TooltipTitle>
          <TooltipBody>{data.content}</TooltipBody>
          <TooltipFooter>{t('chat.history.click_to_navigate')}</TooltipFooter>
        </TooltipContent>
      }
      placement="top"
      color="rgba(0, 0, 0, 0.85)"
      mouseEnterDelay={0.3}
      mouseLeaveDelay={0.1}
      destroyOnHidden>
      <CustomNodeContainer
        style={{
          borderColor,
          background: `linear-gradient(135deg, ${backgroundColor} 0%, ${gradientColor} 100%)`,
          boxShadow: `0 4px 10px rgba(0, 0, 0, 0.1), 0 0 0 2px ${borderColor}40`
        }}
        onClick={handleNodeClick}>
        <Handle type="target" position={Position.Top} style={handleStyle} isConnectable={false} />
        <Handle type="target" position={Position.Left} style={handleStyle} isConnectable={false} />

        <NodeHeader>
          <NodeAvatar>{avatar}</NodeAvatar>
          <NodeTitle>{title}</NodeTitle>
        </NodeHeader>
        <NodeContent title={data.content}>{data.content}</NodeContent>

        <Handle type="source" position={Position.Bottom} style={handleStyle} isConnectable={false} />
        <Handle type="source" position={Position.Right} style={handleStyle} isConnectable={false} />
      </CustomNodeContainer>
    </Tooltip>
  )
}

// 创建自定义节点类型
export const nodeTypes: NodeTypes = { custom: CustomNode }

interface ChatFlowHistoryProps {
  conversationId?: string
}

// 定义节点和边的类型
// FIXME: No any plz
type FlowNode = Node<any>
type FlowEdge = Edge<any>

// 统一的边样式
const commonEdgeStyle = {
  stroke: 'var(--color-border)',
  strokeDasharray: '4,4',
  strokeWidth: 2
}

// 统一的边配置
const defaultEdgeOptions = {
  animated: true,
  style: commonEdgeStyle,
  type: 'step',
  markerEnd: undefined,
  zIndex: 5
}

export interface ChatFlowGraphDeps {
  userName?: string
  userAvatar?: string | null
  t: (key: string) => string
}

/**
 * Pure caller-local graph builder for the history drawer.
 *
 * Builds nodes/edges from an explicit whole-topic snapshot (complete ordered
 * messages + snapshot block map) — never from live Redux blocks or a windowed
 * projection — so old/window-outside messages still produce graph content.
 * Layout, chronological ordering, askId/model/orphan semantics and click
 * navigation payloads match the previous selector-backed builder exactly;
 * only the text source changed (`getMainTextSnapshotContent`).
 */
export const buildChatFlowGraph = (
  messages: Message[],
  blocksById: SnapshotBlockMap,
  deps: ChatFlowGraphDeps
): { nodes: FlowNode[]; edges: FlowEdge[] } => {
  const { userName, userAvatar, t } = deps
  if (!messages.length) return { nodes: [], edges: [] }

  const userMessages = messages.filter((msg) => msg.role === 'user')
  const assistantMessages = messages.filter((msg) => msg.role === 'assistant')

  // 创建节点和边
  const flowNodes: FlowNode[] = []
  const flowEdges: FlowEdge[] = []

  // 布局参数
  const verticalGap = 200
  const horizontalGap = 350
  const baseX = 150

  // 如果没有任何消息可以显示，返回空结果
  if (userMessages.length === 0 && assistantMessages.length === 0) {
    return { nodes: [], edges: [] }
  }

  // 为所有用户消息创建节点
  userMessages.forEach((message, index) => {
    const nodeId = `user-${message.id}`
    const yPosition = index * verticalGap * 2

    // 获取用户名
    const userNameValue = userName || t('chat.history.user_node')

    // 获取用户头像
    const msgUserAvatar = userAvatar || null

    flowNodes.push({
      id: nodeId,
      type: 'custom',
      data: {
        userName: userNameValue,
        content: getMainTextSnapshotContent(message, blocksById),
        type: 'user',
        messageId: message.id,
        userAvatar: msgUserAvatar
      },
      position: { x: baseX, y: yPosition },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top
    })

    // 找到用户消息之后的助手回复
    const userMsgTime = new Date(message.createdAt).getTime()
    const relatedAssistantMsgs = assistantMessages.filter((aMsg) => {
      const aMsgTime = new Date(aMsg.createdAt).getTime()
      return (
        aMsgTime > userMsgTime &&
        (index === userMessages.length - 1 || aMsgTime < new Date(userMessages[index + 1].createdAt).getTime())
      )
    })

    // 为相关的助手消息创建节点
    relatedAssistantMsgs.forEach((aMsg, aIndex) => {
      const assistantNodeId = `assistant-${aMsg.id}`
      const isMultipleResponses = relatedAssistantMsgs.length > 1
      const assistantX = baseX + (isMultipleResponses ? horizontalGap * aIndex : 0)
      const assistantY = yPosition + verticalGap

      // 根据位置确定连接点位置
      let sourcePos = Position.Bottom // 默认向下输出
      let targetPos = Position.Top // 默认从上方输入

      // 横向排列多个助手消息时调整连接点
      // 注意：现在所有助手节点都直接连接到用户节点，而不是相互连接
      if (isMultipleResponses) {
        // 所有助手节点都使用顶部作为输入点(从用户节点)
        targetPos = Position.Top

        // 所有助手节点都使用底部作为输出点(到下一个用户节点)
        sourcePos = Position.Bottom
      }

      const aMsgAny = aMsg as any

      // 获取模型名称
      const modelName = (aMsgAny.model && aMsgAny.model.name) || t('chat.history.assistant_node')

      // 获取模型ID
      const modelId = (aMsgAny.model && aMsgAny.model.id) || ''

      // 完整的模型信息
      const modelInfo = aMsgAny.model as Model | undefined

      flowNodes.push({
        id: assistantNodeId,
        type: 'custom',
        data: {
          model: modelName,
          content: getMainTextSnapshotContent(aMsg, blocksById),
          type: 'assistant',
          messageId: aMsg.id,
          modelId: modelId,
          modelInfo
        },
        position: { x: assistantX, y: assistantY },
        sourcePosition: sourcePos,
        targetPosition: targetPos
      })

      // 连接消息 - 将每个助手节点直接连接到用户节点
      if (aIndex === 0) {
        // 连接用户消息到第一个助手回复
        flowEdges.push({
          id: `edge-${nodeId}-to-${assistantNodeId}`,
          source: nodeId,
          target: assistantNodeId
        })
      } else {
        // 直接连接用户消息到所有其他助手回复
        flowEdges.push({
          id: `edge-${nodeId}-to-${assistantNodeId}`,
          source: nodeId,
          target: assistantNodeId
        })
      }
    })

    // 连接相邻的用户消息
    if (index > 0) {
      const prevUserNodeId = `user-${userMessages[index - 1].id}`
      const prevUserTime = new Date(userMessages[index - 1].createdAt).getTime()

      // 查找前一个用户消息的所有助手回复
      const prevAssistantMsgs = assistantMessages.filter((aMsg) => {
        const aMsgTime = new Date(aMsg.createdAt).getTime()
        return aMsgTime > prevUserTime && aMsgTime < userMsgTime
      })

      if (prevAssistantMsgs.length > 0) {
        // 所有前一个用户的助手消息都连接到当前用户消息
        prevAssistantMsgs.forEach((aMsg) => {
          const assistantId = `assistant-${aMsg.id}`
          flowEdges.push({
            id: `edge-${assistantId}-to-${nodeId}`,
            source: assistantId,
            target: nodeId
          })
        })
      } else {
        // 如果没有助手消息，直接连接两个用户消息
        flowEdges.push({
          id: `edge-${prevUserNodeId}-to-${nodeId}`,
          source: prevUserNodeId,
          target: nodeId
        })
      }
    }
  })

  // 处理孤立的助手消息（没有对应的用户消息）
  const orphanAssistantMsgs = assistantMessages.filter(
    (aMsg) => !flowNodes.some((node) => node.id === `assistant-${aMsg.id}`)
  )

  if (orphanAssistantMsgs.length > 0) {
    // 在图表顶部添加这些孤立消息
    const startY = flowNodes.length > 0 ? Math.min(...flowNodes.map((node) => node.position.y)) - verticalGap * 2 : 0

    orphanAssistantMsgs.forEach((aMsg, index) => {
      const assistantNodeId = `orphan-assistant-${aMsg.id}`

      // 获取模型数据
      // FIXME: No any plz
      const aMsgAny = aMsg as any

      // 获取模型名称
      const modelName = (aMsgAny.model && aMsgAny.model.name) || t('chat.history.assistant_node')

      // 获取模型ID
      const modelId = (aMsgAny.model && aMsgAny.model.id) || ''

      // 完整的模型信息
      const modelInfo = aMsgAny.model as Model | undefined

      flowNodes.push({
        id: assistantNodeId,
        type: 'custom',
        data: {
          model: modelName,
          content: getMainTextSnapshotContent(aMsg, blocksById),
          type: 'assistant',
          messageId: aMsg.id,
          modelId: modelId,
          modelInfo
        },
        position: { x: baseX, y: startY - index * verticalGap },
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top
      })

      // 连接相邻的孤立消息
      if (index > 0) {
        const prevNodeId = `orphan-assistant-${orphanAssistantMsgs[index - 1].id}`
        flowEdges.push({
          id: `edge-${prevNodeId}-to-${assistantNodeId}`,
          source: prevNodeId,
          target: assistantNodeId
        })
      }
    })
  }

  return { nodes: flowNodes, edges: flowEdges }
}

/** Coalescing window for authority-metadata + terminal-streaming refetches. */
export const CHAT_FLOW_SNAPSHOT_REFRESH_DEBOUNCE_MS = 250

const ChatFlowHistory: FC<ChatFlowHistoryProps> = ({ conversationId }) => {
  const { t } = useTranslation()
  // FIXME: no any plz
  const [nodes, setNodes, onNodesChange] = useNodesState<any>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<any>([])
  const [loading, setLoading] = useState(true)
  const [snapshot, setSnapshot] = useState<WholeTopicSnapshot | null>(null)
  const { userName } = useSettings()
  const { settedTheme } = useTheme()

  const topicId = conversationId

  // 获取用户头像
  const userAvatar = useAvatar()

  // Authority mutation metadata signal: subscribe to ONLY the current topic's
  // updatedAt (never messages/blocks). A change schedules a debounced
  // whole-topic snapshot refetch; the snapshot itself stays caller-local.
  const topicUpdatedAt = useSelector((state: RootState) =>
    topicId
      ? state.assistants.assistants.flatMap((a) => a.topics ?? []).find((topic) => topic.id === topicId)?.updatedAt
      : undefined
  )

  const generationRef = useRef(0)
  const activeTopicRef = useRef<string | undefined>(topicId)
  const mountedRef = useRef(true)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lastUpdatedAtRef = useRef<string | undefined>(undefined)
  // Tracks whether the current target topic already has a successful snapshot.
  // Background refetch failures must retain the last good snapshot/graph;
  // only the initial/topic-change load (no success yet) may leave null.
  const hasSnapshotRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      generationRef.current += 1
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = undefined
      }
    }
  }, [])

  const fetchSnapshot = useCallback(async (targetTopicId: string, gen: number) => {
    try {
      const snap = await loadWholeTopicSnapshot(targetTopicId)
      if (!mountedRef.current || gen !== generationRef.current || targetTopicId !== activeTopicRef.current) return
      hasSnapshotRef.current = true
      setSnapshot(snap)
    } catch {
      // Deleted/missing topic (NOT_FOUND) or transient read failure: the
      // initial/topic-change load may leave null with the existing empty
      // state, while a background refetch after a successful snapshot retains
      // the last good snapshot/graph and only clears loading (via finally).
      // Stale responses for a previous topic are ignored, never applied.
      if (!mountedRef.current || gen !== generationRef.current || targetTopicId !== activeTopicRef.current) return
      if (!hasSnapshotRef.current) {
        setSnapshot(null)
      }
    } finally {
      if (mountedRef.current && gen === generationRef.current && targetTopicId === activeTopicRef.current) {
        setLoading(false)
      }
    }
  }, [])

  const scheduleDebouncedRefetch = useCallback(() => {
    const target = activeTopicRef.current
    if (!target) return
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = undefined
      if (!mountedRef.current || activeTopicRef.current !== target) return
      const gen = generationRef.current + 1
      generationRef.current = gen
      void fetchSnapshot(target, gen)
    }, CHAT_FLOW_SNAPSHOT_REFRESH_DEBOUNCE_MS)
  }, [fetchSnapshot])

  // 1) mount / topic change: immediate whole-topic snapshot load.
  useEffect(() => {
    activeTopicRef.current = topicId
    lastUpdatedAtRef.current = undefined
    hasSnapshotRef.current = false
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = undefined
    }
    if (!topicId) {
      generationRef.current += 1
      setSnapshot(null)
      setNodes([])
      setEdges([])
      setLoading(false)
      return
    }
    const gen = generationRef.current + 1
    generationRef.current = gen
    // Drop the previous topic's graph immediately so a stale snapshot never
    // renders under the new topic while the fresh read is in flight.
    setSnapshot(null)
    setNodes([])
    setEdges([])
    setLoading(true)
    void fetchSnapshot(topicId, gen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicId, fetchSnapshot])

  // 2) authority mutation metadata: refetch when the current topic's updatedAt
  // changes. Baseline is established on mount/topic change (whose immediate
  // load already covers current state); no interval polling.
  useEffect(() => {
    if (!topicId) return
    if (lastUpdatedAtRef.current === undefined) {
      lastUpdatedAtRef.current = topicUpdatedAt
      return
    }
    if (topicUpdatedAt === lastUpdatedAtRef.current) return
    lastUpdatedAtRef.current = topicUpdatedAt
    scheduleDebouncedRefetch()
  }, [topicId, topicUpdatedAt, scheduleDebouncedRefetch])

  // 3) terminal streaming: final block writes may not update topic metadata,
  // so MESSAGE_COMPLETE (filtered by topicId) also schedules a coalesced
  // refetch sharing the same debounce timer as the updatedAt trigger.
  useEffect(() => {
    if (!topicId) return
    const handler = (payload: { topicId?: string } | undefined) => {
      if (!payload || payload.topicId !== topicId) return
      scheduleDebouncedRefetch()
    }
    const unsubscribe = EventEmitter.on(EVENT_NAMES.MESSAGE_COMPLETE, handler)
    return () => {
      unsubscribe()
    }
  }, [topicId, scheduleDebouncedRefetch])

  // Render the caller-local snapshot; settings-only changes rebuild without a
  // reread. Snapshot stays local — nothing is published to Redux.
  useEffect(() => {
    if (!snapshot) {
      setNodes([])
      setEdges([])
      return
    }
    const { nodes: flowNodes, edges: flowEdges } = buildChatFlowGraph(snapshot.messages, snapshot.blocksById, {
      userName: userName ?? undefined,
      userAvatar: userAvatar ?? null,
      t
    })
    setNodes([...flowNodes])
    setEdges([...flowEdges])
  }, [snapshot, userName, userAvatar, t, setNodes, setEdges])

  return (
    <FlowContainer>
      {loading ? (
        <LoadingContainer>
          <Spin size="large" />
        </LoadingContainer>
      ) : nodes.length > 0 ? (
        <ReactFlowProvider>
          <div style={{ width: '100%', height: '100%' }}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              nodeTypes={nodeTypes}
              nodesDraggable={false}
              nodesConnectable={false}
              edgesFocusable={true}
              zoomOnDoubleClick={true}
              preventScrolling={true}
              elementsSelectable={true}
              selectNodesOnDrag={false}
              nodesFocusable={true}
              zoomOnScroll={true}
              panOnScroll={false}
              minZoom={0.4}
              maxZoom={1}
              defaultEdgeOptions={defaultEdgeOptions}
              fitView={true}
              fitViewOptions={{
                padding: 0.3,
                includeHiddenNodes: false,
                minZoom: 0.4,
                maxZoom: 1
              }}
              proOptions={{ hideAttribution: true }}
              className="react-flow-container"
              colorMode={settedTheme}>
              <Controls showInteractive={false} />
              <MiniMap
                nodeStrokeWidth={3}
                zoomable
                pannable
                nodeColor={(node) => (node.data.type === 'user' ? 'var(--color-info)' : 'var(--color-primary)')}
              />
            </ReactFlow>
          </div>
        </ReactFlowProvider>
      ) : (
        <EmptyContainer>
          <EmptyText>{t('chat.history.no_messages')}</EmptyText>
        </EmptyContainer>
      )}
    </FlowContainer>
  )
}

// 样式组件定义
const FlowContainer = styled.div`
  width: 100%;
  height: 100%;
  min-height: 500px;
`

const LoadingContainer = styled.div`
  width: 100%;
  height: 100%;
  min-height: 500px;
  display: flex;
  justify-content: center;
  align-items: center;
`

const EmptyContainer = styled.div`
  width: 100%;
  height: 100%;
  min-height: 500px;
  display: flex;
  justify-content: center;
  align-items: center;
  color: var(--color-text-secondary);
`

const EmptyText = styled.div`
  font-size: 16px;
  margin-bottom: 8px;
  font-weight: bold;
`

const CustomNodeContainer = styled.div`
  padding: 12px;
  border-radius: 10px;
  border: 2px solid;
  width: 280px;
  height: 120px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s ease-in-out;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);

  &:hover {
    transform: translateY(-2px);
    box-shadow:
      0 6px 10px rgba(0, 0, 0, 0.1),
      0 0 0 2px ${(props) => props.style?.borderColor || 'var(--color-border)'}80 !important;
    filter: brightness(1.02);
  }

  /* 添加点击动画效果 */
  &:active {
    transform: scale(0.98);
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    transition: all 0.1s ease;
  }
`

const NodeHeader = styled.div`
  font-weight: bold;
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.2);
  color: var(--color-text);
  display: flex;
  align-items: center;
  min-height: 32px;
`

const NodeAvatar = styled.span`
  margin-right: 10px;
  display: flex;
  align-items: center;

  .ant-avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid rgba(0, 0, 0, 0.1);
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  }
`

const NodeTitle = styled.span`
  flex: 1;
  font-size: 16px;
  font-weight: bold;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const NodeContent = styled.div`
  margin: 2px 0;
  color: var(--color-text);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  line-height: 1.5;
  word-break: break-word;
  font-size: 14px;
  padding: 3px;
`

// 确保组件使用React.memo包装以减少不必要的重渲染
export default memo(ChatFlowHistory)
