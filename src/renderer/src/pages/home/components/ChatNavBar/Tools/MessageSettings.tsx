import { useSettings } from '@renderer/hooks/useSettings'
import { SettingDivider, SettingRow, SettingRowTitle } from '@renderer/pages/settings'
import { useAppDispatch } from '@renderer/store'
import {
  setConfirmDeleteMessage,
  setConfirmRegenerateMessage,
  setFontSize,
  setInjectContextTimestamp,
  setMessageNavigation,
  setShowMessageOutline
} from '@renderer/store/settings'
import { Switch } from 'antd'
import { Minus, Plus } from 'lucide-react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

/**
 * Compact arrowless message-settings popover (≈272px wide, owned by the Popover
 * root), opened from the navbar Settings2 button. Row order:
 *   1. show message outline
 *   2. conversation navigation (boolean off/on)
 *   3. inject context timestamp
 *   4. confirm delete
 *   5. confirm regenerate
 *   6. message font size (stepper 12-22, step 1; clicking the value resets to 14)
 * Boolean rows use small switches and changes apply immediately. The show-prompt
 * row is removed; the persisted `showPrompt` setting stays inert for data
 * compatibility.
 */
const MessageSettings: FC = () => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()

  const {
    fontSize,
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
        <RowTitle>{t('settings.messages.show_message_outline')}</RowTitle>
        <Switch
          size="small"
          checked={showMessageOutline}
          onChange={(checked) => dispatch(setShowMessageOutline(checked))}
        />
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <RowTitle>{t('settings.messages.navigation.label')}</RowTitle>
        <Switch
          size="small"
          checked={messageNavigation}
          onChange={(checked) => dispatch(setMessageNavigation(checked))}
        />
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <RowTitle>{t('settings.messages.inject_context_timestamp')}</RowTitle>
        <Switch
          size="small"
          checked={injectContextTimestamp}
          onChange={(checked) => dispatch(setInjectContextTimestamp(checked))}
        />
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <RowTitle>{t('settings.messages.input.confirm_delete_message')}</RowTitle>
        <Switch
          size="small"
          checked={confirmDeleteMessage}
          onChange={(checked) => dispatch(setConfirmDeleteMessage(checked))}
        />
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <RowTitle>{t('settings.messages.input.confirm_regenerate_message')}</RowTitle>
        <Switch
          size="small"
          checked={confirmRegenerateMessage}
          onChange={(checked) => dispatch(setConfirmRegenerateMessage(checked))}
        />
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <RowTitle>{t('settings.font_size.title')}</RowTitle>
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
    </Container>
  )
}

const Container = styled.div`
  /* Fill the popover inner content (root width 272px minus antd inner
     padding/border) instead of forcing a wider fixed box that would overflow
     into a horizontal scrollbar. max-width guards against any outer width
     change; width: 100% governs. */
  width: 100%;
  max-width: 272px;
  box-sizing: border-box;
  padding: 8px 12px 12px;
  user-select: none;
  overflow-x: clip;

  .ant-divider {
    margin: 8px 0;
  }

  /* Controls keep their natural size when a long localized title wraps; the
     title absorbs the shrink (RowTitle below). */
  & .ant-switch {
    flex-shrink: 0;
  }
`

/* Scoped title wrapper — flex-grows into the row, may shrink below its content,
   and breaks long unbroken localized tokens (`overflow-wrap: anywhere` also
   lowers the min-content intrinsic size so wrapping actually happens inside the
   flex row) instead of pushing the popup wider. */
const RowTitle = styled(SettingRowTitle)`
  flex: 1;
  min-width: 0;
  margin-right: 8px;
  overflow-wrap: anywhere;
`

const FontSizeStepper = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
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
