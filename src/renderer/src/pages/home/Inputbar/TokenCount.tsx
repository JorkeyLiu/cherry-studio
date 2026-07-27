import { HStack, VStack } from '@renderer/components/Layout'
import MaxContextCount from '@renderer/components/MaxContextCount'
import { useSettings } from '@renderer/hooks/useSettings'
import type { ContextWindowMode } from '@renderer/types'
import { Divider, Popover } from 'antd'
import { ArrowUp, MenuIcon } from 'lucide-react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

type Props = {
  estimateTokenCount: number
  contextCount: { current: number; max: number | null }
  contextWindowMode?: ContextWindowMode
  effectiveMode?: ContextWindowMode
  onUpdateAnchor?: () => void
} & React.HTMLAttributes<HTMLDivElement>

const TokenCount: FC<Props> = ({
  estimateTokenCount,
  contextCount,
  contextWindowMode,
  effectiveMode,
  onUpdateAnchor
}) => {
  const { t } = useTranslation()
  const { showInputEstimatedTokens } = useSettings()

  if (!showInputEstimatedTokens) {
    return null
  }

  const PopoverContent = () => {
    return (
      <VStack w="185px" background="100%">
        <HStack justifyContent="space-between" w="100%">
          <Text>{t('chat.input.context_count.tip')}</Text>
          <Text>
            <HStack style={{ alignItems: 'center' }}>
              {contextCount.current}
              <SlashSeparatorSpan>/</SlashSeparatorSpan>
              <MaxContextCount maxContext={contextCount.max} />
            </HStack>
          </Text>
        </HStack>
        <Divider style={{ margin: '5px 0' }} />
        <HStack justifyContent="space-between" w="100%">
          <Text>{t('chat.input.estimated_tokens.tip')}</Text>
          <Text>{estimateTokenCount}</Text>
        </HStack>
      </VStack>
    )
  }

  const contextCountBlock = (() => {
    if (contextWindowMode === 'fixed') {
      // Assistant supports fixed mode → always clickable (toggle per-topic mode)
      if (effectiveMode === 'fixed') {
        // Topic is fixed: show current / ∞, click to switch to sliding
        return (
          <HStack style={{ alignItems: 'center', cursor: 'pointer' }} onClick={onUpdateAnchor}>
            <MenuIcon size={12} className="icon" />
            {contextCount.current}
            <SlashSeparatorSpan>/</SlashSeparatorSpan>
            <MaxContextCount maxContext={contextCount.max} style={{ color: 'var(--color-primary)' }} />
          </HStack>
        )
      }
      // Topic is sliding: show current / max, click to switch to fixed
      return (
        <HStack style={{ alignItems: 'center', cursor: 'pointer' }} onClick={onUpdateAnchor}>
          <MenuIcon size={12} className="icon" />
          {contextCount.current}
          <SlashSeparatorSpan>/</SlashSeparatorSpan>
          <MaxContextCount maxContext={contextCount.max} />
        </HStack>
      )
    }
    // Assistant doesn't support fixed mode: not clickable
    return (
      <HStack style={{ alignItems: 'center' }}>
        <MenuIcon size={12} className="icon" />
        {contextCount.current}
        <SlashSeparatorSpan>/</SlashSeparatorSpan>
        <MaxContextCount maxContext={contextCount.max} />
      </HStack>
    )
  })()

  return (
    <Container>
      <Popover content={PopoverContent} arrow={false}>
        <HStack>
          {contextCountBlock}
          <Divider type="vertical" style={{ marginTop: 3, marginLeft: 5, marginRight: 3 }} />
          <HStack style={{ alignItems: 'center' }}>
            <ArrowUp size={12} className="icon" />
            {estimateTokenCount}
          </HStack>
        </HStack>
      </Popover>
    </Container>
  )
}

const Container = styled.div`
  font-size: 11px;
  line-height: 16px;
  color: var(--color-text-2);
  z-index: 10;
  padding: 3px 10px;
  user-select: text;
  border-radius: 20px;
  display: flex;
  align-items: center;
  cursor: pointer;
  .icon {
    margin-right: 3px;
  }
  @media (max-width: 800px) {
    display: none;
  }
`

const Text = styled.div`
  font-size: 12px;
  color: var(--color-text-1);
`

const SlashSeparatorSpan = styled.span`
  margin-left: 2px;
  margin-right: 2px;
`

export default TokenCount
