import { LoadingOutlined } from '@ant-design/icons'
import { loggerService } from '@logger'
import Selector from '@renderer/components/Selector'
import { UNKNOWN } from '@renderer/config/translate'
import { useSettings } from '@renderer/hooks/useSettings'
import useTranslate from '@renderer/hooks/useTranslate'
import { SettingDivider, SettingRow, SettingRowTitle } from '@renderer/pages/settings'
import { translateText } from '@renderer/services/TranslateService'
import { useAppDispatch } from '@renderer/store'
import { setShowTranslateConfirm } from '@renderer/store/settings'
import { Button, Popover, Switch, Tooltip } from 'antd'
import { Languages } from 'lucide-react'
import type { FC } from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface Props {
  text?: string
  onTranslated: (translatedText: string) => void
  disabled?: boolean
  style?: React.CSSProperties
  isLoading?: boolean
}

const logger = loggerService.withContext('TranslateButton')

/**
 * LOCK-110: the target-language and translate-confirm controls live in the
 * translation button's popover. Both read the existing global settings state,
 * so the inputbar, message, and text-edit translation flows all share the same
 * target language and confirmation preference. Translation execution semantics
 * are unchanged.
 */
const TranslateButton: FC<Props> = ({ text, onTranslated, disabled, style, isLoading }) => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const [isTranslating, setIsTranslating] = useState(false)
  const [open, setOpen] = useState(false)
  const { targetLanguage, showTranslateConfirm, setTargetLanguage } = useSettings()
  const { translateLanguages, getLanguageByLangcode } = useTranslate()

  const translateConfirm = () => {
    if (!showTranslateConfirm) {
      return Promise.resolve(true)
    }
    return window?.modal?.confirm({
      title: t('translate.confirm.title'),
      content: t('translate.confirm.content'),
      centered: true
    })
  }

  const handleTranslate = async () => {
    if (!text?.trim()) return

    if (!(await translateConfirm())) {
      return
    }

    // 先复制原文到剪贴板
    await navigator.clipboard.writeText(text)

    setIsTranslating(true)
    try {
      const translatedText = await translateText(text, getLanguageByLangcode(targetLanguage))
      onTranslated(translatedText)
      setOpen(false)
    } catch (error) {
      logger.error('Translation failed:', error as Error)
      window.toast.error(t('translate.error.failed'))
    } finally {
      setIsTranslating(false)
    }
  }

  useEffect(() => {
    setIsTranslating(isLoading ?? false)
  }, [isLoading])

  const popoverContent = (
    <PopoverContent>
      <SettingRow>
        <SettingRowTitle>{t('settings.input.target_language.label')}</SettingRowTitle>
        <Selector
          size={14}
          value={targetLanguage}
          onChange={(value) => setTargetLanguage(value)}
          placeholder={UNKNOWN.emoji + ' ' + UNKNOWN.label()}
          options={translateLanguages.map((item) => {
            return { value: item.langCode, label: item.emoji + ' ' + item.label() }
          })}
          style={{ maxWidth: 150 }}
        />
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.input.show_translate_confirm')}</SettingRowTitle>
        <Switch
          size="small"
          checked={showTranslateConfirm}
          onChange={(checked) => dispatch(setShowTranslateConfirm(checked))}
        />
      </SettingRow>
      <SettingDivider />
      <TranslateActionButton type="primary" size="small" block onClick={() => void handleTranslate()}>
        {isTranslating ? <LoadingOutlined spin /> : <Languages size={14} />}
        <span style={{ marginLeft: 6 }}>{t('chat.translate')}</span>
      </TranslateActionButton>
    </PopoverContent>
  )

  return (
    <Popover
      placement="top"
      trigger="click"
      arrow={false}
      open={open}
      onOpenChange={(next) => {
        if (isTranslating) return
        setOpen(next)
      }}
      content={popoverContent}>
      <Tooltip
        placement="top"
        title={t('chat.input.translate', { target_language: getLanguageByLangcode(targetLanguage).label() })}
        mouseLeaveDelay={0}
        arrow>
        <ToolbarButton onClick={() => setOpen(true)} disabled={disabled || isTranslating} style={style} type="text">
          {isTranslating ? <LoadingOutlined spin /> : <Languages size={18} />}
        </ToolbarButton>
      </Tooltip>
    </Popover>
  )
}

const PopoverContent = styled.div`
  width: 272px;
  padding: 4px 12px 12px;
  user-select: none;

  .ant-divider {
    margin: 8px 0;
  }
`

const TranslateActionButton = styled(Button)`
  display: flex;
  align-items: center;
  justify-content: center;
`

const ToolbarButton = styled(Button)`
  min-width: 30px;
  height: 30px;
  font-size: 16px;
  border-radius: 50%;
  transition: all 0.3s ease;
  color: var(--color-icon);
  display: flex;
  flex-direction: row;
  justify-content: center;
  align-items: center;
  padding: 0;
  &.anticon,
  &.iconfont {
    transition: all 0.3s ease;
    color: var(--color-icon);
  }
  &:hover {
    background-color: var(--color-background-soft);
    .anticon,
    .iconfont {
      color: var(--color-text-1);
    }
  }
  &.active {
    background-color: var(--color-primary) !important;
    .anticon,
    .iconfont {
      color: var(--color-white-soft);
    }
    &:hover {
      background-color: var(--color-primary);
    }
  }
`

export default TranslateButton
