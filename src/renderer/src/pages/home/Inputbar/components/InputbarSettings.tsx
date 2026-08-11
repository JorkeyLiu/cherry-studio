import EditableNumber from '@renderer/components/EditableNumber'
import Selector from '@renderer/components/Selector'
import { useSettings } from '@renderer/hooks/useSettings'
import { SettingDivider, SettingRow, SettingRowTitle } from '@renderer/pages/settings'
import { useAppDispatch } from '@renderer/store'
import type { SendMessageShortcut } from '@renderer/store/settings'
import {
  setEnableQuickPanelTriggers,
  setPasteLongTextAsFile,
  setPasteLongTextThreshold,
  setRenderInputMessageAsMarkdown
} from '@renderer/store/settings'
import { getSendMessageShortcutLabel } from '@renderer/utils/input'
import { Popover, Switch } from 'antd'
import { Settings2 } from 'lucide-react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

/**
 * LOCK-109: input-toolbar divider + settings icon/button opening an upward
 * Popover containing, in order:
 *   1. paste long text as file
 *   2. threshold (conditionally, when paste-long-text is enabled)
 *   3. render input as Markdown
 *   4. enable '/' and '@' quick-menu triggers
 *   5. send shortcut
 * All changes apply immediately. These controls were previously part of the
 * removed quick-settings drawer.
 */
const InputbarSettings: FC = () => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()

  const {
    pasteLongTextAsFile,
    pasteLongTextThreshold,
    renderInputMessageAsMarkdown,
    enableQuickPanelTriggers,
    sendMessageShortcut,
    setSendMessageShortcut
  } = useSettings()

  const content = (
    <PopoverContent>
      <SettingRow>
        <SettingRowTitle>{t('settings.messages.input.paste_long_text_as_file')}</SettingRowTitle>
        <Switch
          size="small"
          checked={pasteLongTextAsFile}
          onChange={(checked) => dispatch(setPasteLongTextAsFile(checked))}
        />
      </SettingRow>
      {pasteLongTextAsFile && (
        <>
          <SettingDivider />
          <SettingRow>
            <SettingRowTitle>{t('settings.messages.input.paste_long_text_threshold')}</SettingRowTitle>
            <EditableNumber
              size="small"
              min={500}
              max={10000}
              step={100}
              value={pasteLongTextThreshold}
              onChange={(value) => dispatch(setPasteLongTextThreshold(value ?? 500))}
              style={{ width: 80 }}
            />
          </SettingRow>
        </>
      )}
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.messages.markdown_rendering_input_message')}</SettingRowTitle>
        <Switch
          size="small"
          checked={renderInputMessageAsMarkdown}
          onChange={(checked) => dispatch(setRenderInputMessageAsMarkdown(checked))}
        />
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.messages.input.enable_quick_triggers')}</SettingRowTitle>
        <Switch
          size="small"
          checked={enableQuickPanelTriggers}
          onChange={(checked) => dispatch(setEnableQuickPanelTriggers(checked))}
        />
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.messages.input.send_shortcuts')}</SettingRowTitle>
        <Selector
          size={14}
          value={sendMessageShortcut}
          onChange={(value) => setSendMessageShortcut(value as SendMessageShortcut)}
          options={[
            { value: 'Enter', label: getSendMessageShortcutLabel('Enter') },
            { value: 'Ctrl+Enter', label: getSendMessageShortcutLabel('Ctrl+Enter') },
            { value: 'Alt+Enter', label: getSendMessageShortcutLabel('Alt+Enter') },
            { value: 'Command+Enter', label: getSendMessageShortcutLabel('Command+Enter') },
            { value: 'Shift+Enter', label: getSendMessageShortcutLabel('Shift+Enter') }
          ]}
        />
      </SettingRow>
    </PopoverContent>
  )

  return (
    <Popover placement="top" trigger="click" arrow={false} content={content}>
      <SettingsIconButton aria-label={t('settings.title')}>
        <Settings2 size={15} />
      </SettingsIconButton>
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

const SettingsIconButton = styled.button`
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--color-icon);
  cursor: pointer;
  padding: 0;
  transition: all 0.3s ease;

  &:hover {
    background-color: var(--color-background-soft);
    color: var(--color-text-1);
  }
`

export default InputbarSettings
