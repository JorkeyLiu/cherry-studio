import { CheckOutlined } from '@ant-design/icons'
import { loggerService } from '@logger'
import ThinkingEffect from '@renderer/components/ThinkingEffect'
import { useSettings } from '@renderer/hooks/useSettings'
import { useTemporaryValue } from '@renderer/hooks/useTemporaryValue'
import { MessageBlockStatus, type ThinkingMessageBlock } from '@renderer/types/newMessage'
import { Collapse, Tooltip } from 'antd'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import Markdown from '../../Markdown/Markdown'

const logger = loggerService.withContext('ThinkingBlock')
interface Props {
  block: ThinkingMessageBlock
}

const ThinkingBlock: React.FC<Props> = ({ block }) => {
  const [copied, setCopied] = useTemporaryValue(false, 2000)
  const { t } = useTranslation()
  // LOCK-104: messages use the system font (fontSize remains user-configurable).
  const { fontSize, thoughtAutoCollapse } = useSettings()
  const [activeKey, setActiveKey] = useState<'thought' | ''>(thoughtAutoCollapse ? '' : 'thought')

  const isThinking = useMemo(() => block.status === MessageBlockStatus.STREAMING, [block.status])

  useEffect(() => {
    if (thoughtAutoCollapse) {
      setActiveKey('')
    } else {
      setActiveKey('thought')
    }
  }, [isThinking, thoughtAutoCollapse])

  const copyThought = useCallback(() => {
    if (block.content) {
      navigator.clipboard
        .writeText(block.content)
        .then(() => {
          window.toast.success({ title: t('message.copied'), key: 'copy-message' })
          setCopied(true)
        })
        .catch((error) => {
          logger.error('Failed to copy text:', error)
          window.toast.error({ title: t('message.copy.failed'), key: 'copy-message-error' })
        })
    }
  }, [block.content, setCopied, t])

  if (!block.content && block.status !== MessageBlockStatus.STREAMING) {
    return null
  }

  return (
    <CollapseContainer
      activeKey={activeKey}
      size="small"
      onChange={() => setActiveKey((key) => (key ? '' : 'thought'))}
      className="message-thought-container"
      ghost
      items={[
        {
          key: 'thought',
          label: (
            <ThinkingEffect
              expanded={activeKey === 'thought'}
              isThinking={isThinking}
              thinkingTimeText={
                <ThinkingTimeSeconds blockThinkingTime={block.thinking_millsec} isThinking={isThinking} />
              }
              content={block.content}
            />
          ),
          children: (
            //  FIXME: 临时兼容
            <ThinkingContent
              style={{
                fontSize
              }}>
              {!isThinking && (
                <Tooltip title={t('common.copy')} mouseEnterDelay={0.8}>
                  <ActionButton
                    className="message-action-button"
                    onClick={(e) => {
                      e.stopPropagation()
                      copyThought()
                    }}
                    aria-label={t('common.copy')}>
                    {!copied && <i className="iconfont icon-copy"></i>}
                    {copied && <CheckOutlined style={{ color: 'var(--color-primary)' }} />}
                  </ActionButton>
                </Tooltip>
              )}
              <Markdown block={block} />
            </ThinkingContent>
          ),
          showArrow: false
        }
      ]}
    />
  )
}

const normalizeThinkingTime = (value?: number) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

const splitThinkingLabel = (label: string) => {
  const match = label.match(/^(.*?)(\s*[\uFF08(].*[\uFF09)])$/)
  return match ? { title: match[1], meta: match[2] } : { title: label, meta: '' }
}

const ThinkingTimeSeconds = memo(
  ({ blockThinkingTime, isThinking }: { blockThinkingTime: number; isThinking: boolean }) => {
    const { t } = useTranslation()
    const anchorRef = useRef<number | null>(null)
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const [tick, setTick] = useState(0)

    // Capture natural wall-clock anchor once per STREAMING session; rapid prop updates must not reset
    useEffect(() => {
      if (isThinking) {
        if (anchorRef.current === null) {
          anchorRef.current = performance.now() - normalizeThinkingTime(blockThinkingTime)
        }
        if (intervalRef.current === null) {
          intervalRef.current = setInterval(() => setTick((v) => v + 1), 100)
        }
      } else {
        if (intervalRef.current) {
          clearInterval(intervalRef.current)
          intervalRef.current = null
        }
        anchorRef.current = null
      }
      return () => {
        if (intervalRef.current) {
          clearInterval(intervalRef.current)
          intervalRef.current = null
        }
      }
    }, [isThinking, blockThinkingTime])

    // Synchronously ensure anchor exists on first STREAMING render before effect runs (for fake timers)
    if (isThinking && anchorRef.current === null) {
      anchorRef.current = performance.now() - normalizeThinkingTime(blockThinkingTime)
    }
    if (!isThinking && anchorRef.current !== null) {
      anchorRef.current = null
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }

    const displayMs = useMemo(() => {
      const authoritative = normalizeThinkingTime(blockThinkingTime)
      if (!isThinking) {
        return authoritative
      }
      // trigger recompute on tick
      void tick
      const elapsed = anchorRef.current !== null ? performance.now() - anchorRef.current : 0
      // authoritative baseline is live max between wall-clock and chunk-provided value
      return Math.max(authoritative, elapsed)
    }, [isThinking, blockThinkingTime, tick])

    const thinkingTimeSeconds = useMemo(() => {
      const safeTime = normalizeThinkingTime(displayMs)
      return (safeTime / 1000).toFixed(1)
    }, [displayMs])

    const label = isThinking
      ? t('chat.thinking', {
          seconds: thinkingTimeSeconds
        })
      : t('chat.deeply_thought', {
          seconds: thinkingTimeSeconds
        })
    const { title, meta } = splitThinkingLabel(label)

    if (!meta) {
      return label
    }

    return (
      <>
        <span className="thinking-title-main">{title}</span>
        {meta && <span className="thinking-title-meta">{meta}</span>}
      </>
    )
  }
)

const CollapseContainer = styled(Collapse)`
  margin-bottom: 15px;
  .ant-collapse-header {
    padding: 0 !important;
  }
  .ant-collapse-content-box {
    padding: 16px !important;
    border-width: 0 0.5px 0.5px 0.5px;
    border-style: solid;
    border-color: var(--color-border);
    border-radius: 0 0 12px 12px;
  }
`

const ThinkingContent = styled.div`
  position: relative;
`

const ActionButton = styled.button`
  background: none;
  border: none;
  color: var(--color-text-2);
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-left: auto;
  opacity: 0.6;
  transition: all 0.3s;
  position: absolute;
  right: -12px;
  top: -12px;

  &:hover {
    opacity: 1;
    color: var(--color-text);
  }

  &:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  .iconfont {
    font-size: 14px;
  }
`

export default memo(ThinkingBlock)
