import { Icon } from '@iconify/react'
import type { ActionTool } from '@renderer/components/ActionTools'
import {
  CodeToolbar,
  useCopyTool,
  useDownloadTool,
  useExpandTool,
  useSplitViewTool,
  useViewSourceTool
} from '@renderer/components/CodeToolbar'
import CodeViewer from '@renderer/components/CodeViewer'
import type { BasicPreviewHandles } from '@renderer/components/Preview'
import { MAX_COLLAPSED_CODE_HEIGHT } from '@renderer/config/constant'
import { getExtensionByLanguage } from '@renderer/utils/code-language'
import { getFileIconName } from '@renderer/utils/fileIconName'
import { extractHtmlTitle, getFileNameFromHtmlTitle } from '@renderer/utils/formats'
import dayjs from 'dayjs'
import React, { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled, { css } from 'styled-components'

import { SPECIAL_VIEW_COMPONENTS, SPECIAL_VIEWS } from './constants'
import type { ViewMode } from './types'

interface Props {
  children: string
  language: string
}

/**
 * 代码块视图
 *
 * LOCK-107: code blocks use a simplified fixed baseline — automatic viewer
 * theme, line numbers enabled, tall code blocks collapsible, wrapping disabled,
 * image preview tools disabled, read-only viewer only. Code execution and the
 * editable CodeMirror path are removed.
 *
 * 视图模式：
 * - source: 源代码视图模式
 * - special: 特殊视图模式（Mermaid、PlantUML、SVG）
 * - split: 分屏模式（源代码和特殊视图并排显示）
 *
 * 顶部 sticky 工具栏：
 * - quick 工具
 * - core 工具
 */
export const CodeBlockView: React.FC<Props> = memo(({ children, language }) => {
  const { t } = useTranslation()

  const [viewState, setViewState] = useState({
    mode: 'special' as ViewMode,
    previousMode: 'special' as ViewMode
  })
  const { mode: viewMode } = viewState

  const setViewMode = useCallback((newMode: ViewMode) => {
    setViewState((current) => ({
      mode: newMode,
      // 当新模式不是 'split' 时才更新
      previousMode: newMode !== 'split' ? newMode : current.previousMode
    }))
  }, [])

  const toggleSplitView = useCallback(() => {
    setViewState((current) => {
      // 如果当前是 split 模式，恢复到上一个模式
      if (current.mode === 'split') {
        return { ...current, mode: current.previousMode }
      }
      return { mode: 'split', previousMode: current.mode }
    })
  }, [])

  const [tools, setTools] = useState<ActionTool[]>([])

  const specialViewRef = useRef<BasicPreviewHandles>(null)

  const hasSpecialView = useMemo(() => SPECIAL_VIEWS.includes(language), [language])

  const isInSpecialView = useMemo(() => {
    return hasSpecialView && viewMode === 'special'
  }, [hasSpecialView, viewMode])

  // LOCK-107 fixed baseline: tall code blocks are collapsible by default and
  // the user can expand/collapse per block via the toolbar toggle.
  const codeCollapsible = true
  const [expandOverride, setExpandOverride] = useState(!codeCollapsible)

  // 重置用户操作
  useEffect(() => {
    setExpandOverride(!codeCollapsible)
  }, [codeCollapsible])

  const shouldExpand = useMemo(() => !codeCollapsible || expandOverride, [codeCollapsible, expandOverride])

  const [sourceScrollHeight, setSourceScrollHeight] = useState(0)
  const expandable = useMemo(() => {
    return codeCollapsible && sourceScrollHeight > MAX_COLLAPSED_CODE_HEIGHT
  }, [codeCollapsible, sourceScrollHeight])

  const handleHeightChange = useCallback((height: number) => {
    startTransition(() => {
      setSourceScrollHeight((prev) => (prev === height ? prev : height))
    })
  }, [])

  const handleCopySource = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(children.trimEnd())
      window.toast.success(t('code_block.copy.success'))
    } catch (error) {
      window.toast.error(t('code_block.copy.failed'))
    }
  }, [children, t])

  const handleDownloadSource = useCallback(() => {
    let fileName = ''

    // 尝试提取 HTML 标题
    if (language === 'html') {
      fileName = getFileNameFromHtmlTitle(extractHtmlTitle(children)) || ''
    }

    // 默认使用日期格式命名
    if (!fileName) {
      fileName = `${dayjs().format('YYYYMMDDHHmm')}`
    }

    const ext = getExtensionByLanguage(language)
    void window.api.file.save(`${fileName}${ext}`, children)
  }, [children, language])

  const showPreviewTools = useMemo(() => {
    return viewMode !== 'source' && hasSpecialView
  }, [hasSpecialView, viewMode])

  // 复制按钮
  useCopyTool({
    showPreviewTools,
    previewRef: specialViewRef,
    onCopySource: handleCopySource,
    setTools
  })

  // 下载按钮
  useDownloadTool({
    showPreviewTools,
    previewRef: specialViewRef,
    onDownloadSource: handleDownloadSource,
    setTools
  })

  // 特殊视图的查看源码按钮（只读，LOCK-107: 无编辑路径），在分屏模式下不可用
  useViewSourceTool({
    enabled: hasSpecialView,
    editable: false,
    viewMode,
    onViewModeChange: setViewMode,
    setTools
  })

  // 特殊视图存在时的分屏按钮
  useSplitViewTool({
    enabled: hasSpecialView,
    viewMode,
    onToggleSplitView: toggleSplitView,
    setTools
  })

  // 源代码视图的展开/折叠按钮（LOCK-107: collapsible 基线）
  useExpandTool({
    enabled: !isInSpecialView,
    expanded: shouldExpand,
    expandable,
    toggle: useCallback(() => setExpandOverride((prev) => !prev), []),
    setTools
  })

  // 源代码视图组件（LOCK-107: 只读 viewer，行号固定开启，不换行）
  const sourceView = useMemo(
    () => (
      <CodeViewer
        className="source-view"
        value={children}
        language={language}
        onHeightChange={handleHeightChange}
        expanded={shouldExpand}
        wrapped={false}
        maxHeight={`${MAX_COLLAPSED_CODE_HEIGHT}px`}
        options={{ lineNumbers: true }}
        onRequestExpand={codeCollapsible ? () => setExpandOverride(true) : undefined}
      />
    ),
    [children, codeCollapsible, handleHeightChange, language, shouldExpand]
  )

  // 特殊视图组件映射（LOCK-107: image preview tools disabled）
  const specialView = useMemo(() => {
    const SpecialView = SPECIAL_VIEW_COMPONENTS[language as keyof typeof SPECIAL_VIEW_COMPONENTS]

    if (!SpecialView) return null

    return (
      <SpecialView ref={specialViewRef} enableToolbar={false}>
        {children}
      </SpecialView>
    )
  }, [children, language])

  const renderHeader = useMemo(() => {
    if (isInSpecialView) {
      return <CodeHeader $isInSpecialView>{''}</CodeHeader>
    }
    const ext = getExtensionByLanguage(language)
    const iconName = getFileIconName(`file${ext}`)
    return (
      <CodeHeader $isInSpecialView={false}>
        <Icon icon={`material-icon-theme:${iconName}`} style={{ fontSize: '1.1em', marginRight: 6 }} />
        {language.charAt(0).toUpperCase() + language.slice(1)}
      </CodeHeader>
    )
  }, [isInSpecialView, language])

  // 根据视图模式和语言选择组件，优先展示特殊视图，fallback是源代码视图
  const renderContent = useMemo(() => {
    const showSpecialView = !!specialView && ['special', 'split'].includes(viewMode)
    const showSourceView = !specialView || viewMode !== 'special'

    return (
      <SplitViewWrapper
        className="split-view-wrapper"
        $isSpecialView={showSpecialView && !showSourceView}
        $isSplitView={showSpecialView && showSourceView}>
        {showSpecialView && specialView}
        {showSourceView && sourceView}
      </SplitViewWrapper>
    )
  }, [specialView, sourceView, viewMode])

  return (
    <CodeBlockWrapper className="code-block" $isInSpecialView={isInSpecialView}>
      {renderHeader}
      <CodeToolbar tools={tools} />
      {renderContent}
    </CodeBlockWrapper>
  )
})

const CodeBlockWrapper = styled.div<{ $isInSpecialView: boolean }>`
  position: relative;
  width: 100%;
  /* FIXME: 最小宽度用于解决两个问题。
   * 一是 CodeViewer 在气泡样式下的用户消息中无法撑开气泡，
   * 二是 代码块内容过少时 toolbar 会和 title 重叠。
   */
  min-width: 35ch;

  .code-toolbar {
    background-color: ${(props) => (props.$isInSpecialView ? 'transparent' : 'var(--color-background-mute)')};
    border-radius: ${(props) => (props.$isInSpecialView ? '0' : '4px')};
    opacity: 0;
    transition: opacity 0.2s ease;
    transform: translateZ(0);
    will-change: opacity;
    &.show {
      opacity: 1;
    }
  }
  &:hover {
    .code-toolbar {
      opacity: 1;
    }
  }
`

const CodeHeader = styled.div<{ $isInSpecialView?: boolean }>`
  display: flex;
  align-items: center;
  color: var(--color-text);
  font-size: 14px;
  line-height: 1;
  font-weight: bold;
  padding: 0 10px;
  border-top-left-radius: 8px;
  border-top-right-radius: 8px;
  margin-top: ${(props) => (props.$isInSpecialView ? '6px' : '0')};
  height: ${(props) => (props.$isInSpecialView ? '16px' : '34px')};
  background-color: ${(props) => (props.$isInSpecialView ? 'transparent' : 'var(--color-background-mute)')};
  user-select: none;
`

const SplitViewWrapper = styled.div<{ $isSpecialView: boolean; $isSplitView: boolean }>`
  display: flex;

  > * {
    flex: 1 1 auto;
    width: 100%;
  }

  &:not(:has(+ [class*='Container'])) {
    // 特殊视图的 header 会隐藏，所以全都使用圆角
    border-radius: ${(props) => (props.$isSpecialView ? '8px' : '0 0 8px 8px')};
    // FIXME: 滚动条边缘会溢出，可以考虑增加 padding，但是要保证代码主题颜色铺满容器。
    // overflow: hidden;
    .code-viewer {
      border-radius: inherit;
    }
  }

  // 在 split 模式下添加中间分隔线
  ${(props) =>
    props.$isSplitView &&
    css`
      position: relative;

      &:before {
        content: '';
        position: absolute;
        top: 0;
        bottom: 0;
        left: 50%;
        width: 1px;
        background-color: var(--color-background-mute);
        transform: translateX(-50%);
        z-index: 1;
      }
    `}
`
