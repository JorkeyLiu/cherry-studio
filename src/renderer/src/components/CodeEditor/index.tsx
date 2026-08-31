import { Alert, Spin } from 'antd'
import React, { Suspense } from 'react'
import { ErrorBoundary } from 'react-error-boundary'
import { useTranslation } from 'react-i18next'

import type { CodeEditorProps } from './types'

export type { CodeEditorHandles, CodeEditorProps } from './types'

const LazyCodeEditor = React.lazy(() => import('./CodeEditorImpl'))

const CodeEditorShell: React.FC<{
  layout: Pick<CodeEditorProps, 'height' | 'minHeight' | 'maxHeight' | 'style' | 'className' | 'expanded'>
  testId: string
  children: React.ReactNode
}> = ({ layout, testId, children }) => {
  const shellStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    ...(layout.expanded === false && layout.height ? { height: layout.height } : {}),
    ...(layout.minHeight ? { minHeight: layout.minHeight } : {}),
    ...(layout.expanded === false && layout.maxHeight ? { maxHeight: layout.maxHeight } : {}),
    ...layout.style
  }
  const shellClass = `code-editor ${layout.className ?? ''}`.trim()
  return (
    <div data-testid={testId} style={shellStyle} className={shellClass}>
      {children}
    </div>
  )
}

const CodeEditorLoadingFallback: React.FC<{
  layout: Pick<CodeEditorProps, 'height' | 'minHeight' | 'maxHeight' | 'style' | 'className' | 'expanded'>
}> = ({ layout }) => {
  const { t } = useTranslation()
  return (
    <CodeEditorShell layout={layout} testId="code-editor-loading">
      <div aria-busy="true" aria-label={t('common.loading')}>
        <Spin tip={t('common.loading')} size="default">
          <div style={{ padding: 16 }} />
        </Spin>
      </div>
    </CodeEditorShell>
  )
}

// Wrapper preserves layout props in fallback/error shell without altering successful editor styling.
const CodeEditorWrapper = ({
  ref,
  height,
  minHeight,
  maxHeight,
  style,
  className,
  expanded,
  ...rest
}: CodeEditorProps) => {
  const { t } = useTranslation()
  const layout = { height, minHeight, maxHeight, style, className, expanded }
  const editorProps = { ...rest, height, minHeight, maxHeight, style, className, expanded, ref } as CodeEditorProps

  return (
    <ErrorBoundary
      fallbackRender={({ error }) => {
        void error
        return (
          <CodeEditorShell layout={layout} testId="code-editor-error">
            <Alert type="error" showIcon message={t('common.error')} description={t('common.error')} />
          </CodeEditorShell>
        )
      }}>
      <Suspense fallback={<CodeEditorLoadingFallback layout={layout} />}>
        <LazyCodeEditor {...editorProps} />
      </Suspense>
    </ErrorBoundary>
  )
}

CodeEditorWrapper.displayName = 'CodeEditor'

export default React.memo(CodeEditorWrapper)
