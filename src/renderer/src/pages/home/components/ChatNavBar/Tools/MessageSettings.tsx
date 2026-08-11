import { useSettings } from '@renderer/hooks/useSettings'
import { SettingDivider, SettingRow, SettingRowTitle } from '@renderer/pages/settings'
import { useAppDispatch } from '@renderer/store'
import {
  setConfirmDeleteMessage,
  setConfirmRegenerateMessage,
  setFontSize,
  setInjectContextTimestamp,
  setMessageNavigation,
  setShowMessageOutline,
  setShowPrompt
} from '@renderer/store/settings'
import { Switch } from 'antd'
import { Minus, Plus } from 'lucide-react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

/**
 * LOCK-101/102/103: compact arrowless message-settings popover (≈272px wide),
 * opened from the navbar Settings2 button. Row order:
 *   1. message font size (stepper 12-22, step 1; clicking the value resets to 14)
 *   2. show prompt
 *   3. show message outline
 *   4. conversation navigation (boolean off/on)
 *   5. inject context timestamp
 *   6. confirm delete
 *   7. confirm regenerate
 * Boolean rows use small switches and changes apply immediately.
 */
const MessageSettings: FC = () => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()

  const {
    fontSize,
    showPrompt,
    showMessageOutline,
    messageNavigation,
    injectContextTimestamp,
    confirmDeleteMessage,
    confirmRegenerateMessage
  } = useSettings()

  const decreaseFontSize = () => dispatch(setFontSize(Math.max(12, fontSize - 1)))
  const increaseFontSize = () => dispatch(setFontSize(Math.min(22, fontSize + 1)))
  const resetFontSize = () => dispatch(setFontSize(14))

  return (
    <Container>
      <SettingRow>
        <SettingRowTitle>{t('settings.font_size.title')}</SettingRowTitle>
        <FontSizeStepper>
          <StepperButton type="button" onClick={decreaseFontSize} aria-label={t('common.decrease')}>
            <Minus size={12} />
          </StepperButton>
          <StepperValue
            type="button"
            onClick={resetFontSize}
            aria-label={t('common.default')}
            title={t('common.default')}>
            {fontSize}
          </StepperValue>
          <StepperButton type="button" onClick={increaseFontSize} aria-label={t('common.increase')}>
            <Plus size={12} />
          </StepperButton>
        </FontSizeStepper>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.messages.prompt')}</SettingRowTitle>
        <Switch size="small" checked={showPrompt} onChange={(checked) => dispatch(setShowPrompt(checked))} />
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.messages.show_message_outline')}</SettingRowTitle>
        <Switch
          size="small"
          checked={showMessageOutline}
          onChange={(checked) => dispatch(setShowMessageOutline(checked))}
        />
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.messages.navigation.label')}</SettingRowTitle>
        <Switch
          size="small"
          checked={messageNavigation}
          onChange={(checked) => dispatch(setMessageNavigation(checked))}
        />
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.messages.inject_context_timestamp')}</SettingRowTitle>
        <Switch
          size="small"
          checked={injectContextTimestamp}
          onChange={(checked) => dispatch(setInjectContextTimestamp(checked))}
        />
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.messages.input.confirm_delete_message')}</SettingRowTitle>
        <Switch
          size="small"
          checked={confirmDeleteMessage}
          onChange={(checked) => dispatch(setConfirmDeleteMessage(checked))}
        />
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.messages.input.confirm_regenerate_message')}</SettingRowTitle>
        <Switch
          size="small"
          checked={confirmRegenerateMessage}
          onChange={(checked) => dispatch(setConfirmRegenerateMessage(checked))}
        />
      </SettingRow>
    </Container>
  )
}

const Container = styled.div`
  width: 272px;
  padding: 8px 12px 12px;
  user-select: none;

  .ant-divider {
    margin: 8px 0;
  }
`

const FontSizeStepper = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 4px;
`

const StepperButton = styled.button`
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0.5px solid var(--color-border);
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-2);
  cursor: pointer;
  padding: 0;

  &:hover {
    background-color: var(--color-background-soft);
    color: var(--color-text-1);
  }
`

const StepperValue = styled.button`
  min-width: 28px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0.5px solid var(--color-border);
  border-radius: 6px;
  font-size: 12px;
  font-family: inherit;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-1);
  cursor: pointer;
  padding: 0;

  &:hover {
    background-color: var(--color-background-soft);
  }
`

export default MessageSettings
