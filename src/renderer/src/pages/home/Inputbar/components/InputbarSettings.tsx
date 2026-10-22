import ComposerIconButton from '@renderer/components/Buttons/ComposerIconButton'
import EditableNumber from '@renderer/components/EditableNumber'
import Selector from '@renderer/components/Selector'
import { HelpTooltip } from '@renderer/components/TooltipIcons'
import { useSettings } from '@renderer/hooks/useSettings'
import { SettingDivider, SettingRow, SettingRowTitle } from '@renderer/pages/settings'
import { useAppDispatch } from '@renderer/store'
import type { SendMessageShortcut } from '@renderer/store/settings'
import {
  setIncludeHistoryMediaContext,
  setPasteLongTextAsFile,
  setPasteLongTextThreshold,
  setRenderInputMessageAsMarkdown
} from '@renderer/store/settings'
import { getSendMessageShortcutLabel } from '@renderer/utils/input'
import { Popover, Switch, Tooltip } from 'antd'
import { Settings2 } from 'lucide-react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

const InputbarSettings: FC = () => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()

  const {
    pasteLongTextAsFile,
    pasteLongTextThreshold,
    renderInputMessageAsMarkdown,
    includeHistoryMediaContext,
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
        <SettingRowTitle>
          <span>{t('settings.messages.input.include_history_media_context')}</span>
          {/* Visible help affordance: the switch scope (history-only omission,
              the current turn always sent, ON restoring normal history) is not
              derivable from the label alone. */}
          <HelpTooltip
            title={t('settings.messages.input.include_history_media_context_tooltip')}
            placement="left"
            mouseLeaveDelay={0}
            iconStyle={{ marginLeft: 4, cursor: 'help' }}
          />
        </SettingRowTitle>
        <Switch
          size="small"
          checked={includeHistoryMediaContext !== false}
          onChange={(checked) => dispatch(setIncludeHistoryMediaContext(checked))}
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
    <Popover
      placement="top"
      trigger="click"
      arrow={false}
      content={content}
      styles={{
        root: { width: 297 }
      }}>
      <Tooltip placement="top" title={t('chat.input.input_settings')} mouseLeaveDelay={0} arrow>
        <ComposerIconButton aria-label={t('chat.input.input_settings')} data-testid="inputbar-settings-button">
          <Settings2 size={16} />
        </ComposerIconButton>
      </Tooltip>
    </Popover>
  )
}

const PopoverContent = styled.div`
  width: 100%;
  box-sizing: border-box;
  padding: 4px 12px 12px;
  user-select: none;

  .ant-divider {
    margin: 8px 0;
  }
`

export default InputbarSettings
