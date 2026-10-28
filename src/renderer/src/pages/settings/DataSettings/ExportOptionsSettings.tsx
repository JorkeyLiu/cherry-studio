import { DeleteOutlined, FolderOpenOutlined } from '@ant-design/icons'
import { HStack } from '@renderer/components/Layout'
import { useTheme } from '@renderer/context/ThemeProvider'
import type { RootState } from '@renderer/store'
import { useAppDispatch } from '@renderer/store'
import {
  setExcludeCitationsInExport,
  setExportIncludeThinking,
  setExportPath,
  setStandardizeCitationsInExport
} from '@renderer/store/settings'
import { Button, Switch } from 'antd'
import Input from 'antd/es/input/Input'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
import { useSelector } from 'react-redux'

import { SettingDivider, SettingGroup, SettingHelpText, SettingRow, SettingRowTitle, SettingTitle } from '..'

/**
 * Export options shared by every file export (Markdown / JSON / image).
 *
 * The export menu itself is always available, so there is nothing to enable
 * here; this page only carries per-user defaults.
 */
const ExportOptionsSettings: FC = () => {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const dispatch = useAppDispatch()

  const exportPath = useSelector((state: RootState) => state.settings.exportPath)
  const exportIncludeThinking = useSelector((state: RootState) => state.settings.exportIncludeThinking)
  const excludeCitationsInExport = useSelector((state: RootState) => state.settings.excludeCitationsInExport)
  const standardizeCitationsInExport = useSelector((state: RootState) => state.settings.standardizeCitationsInExport)

  const handleSelectFolder = async () => {
    const path = await window.api.file.selectFolder()
    if (path) {
      dispatch(setExportPath(path))
    }
  }

  const handleClearPath = () => {
    dispatch(setExportPath(null))
  }

  const handleToggleIncludeThinking = (checked: boolean) => {
    dispatch(setExportIncludeThinking(checked))
  }

  const handleToggleExcludeCitations = (checked: boolean) => {
    dispatch(setExcludeCitationsInExport(checked))
  }

  const handleToggleStandardizeCitations = (checked: boolean) => {
    dispatch(setStandardizeCitationsInExport(checked))
  }

  return (
    <SettingGroup theme={theme}>
      <SettingTitle>{t('settings.data.export_options.title')}</SettingTitle>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.export_options.path')}</SettingRowTitle>
        <HStack alignItems="center" gap="5px" style={{ width: 315 }}>
          <Input
            type="text"
            value={exportPath || ''}
            readOnly
            style={{ width: 250 }}
            placeholder={t('settings.data.export_options.path_placeholder')}
            suffix={
              exportPath ? (
                <DeleteOutlined onClick={handleClearPath} style={{ color: 'var(--color-error)', cursor: 'pointer' }} />
              ) : null
            }
          />
          <Button onClick={handleSelectFolder} icon={<FolderOpenOutlined />}>
            {t('settings.data.export_options.select')}
          </Button>
        </HStack>
      </SettingRow>
      <SettingRow>
        <SettingHelpText>{t('settings.data.export_options.help')}</SettingHelpText>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.export_options.include_thinking.title')}</SettingRowTitle>
        <Switch checked={exportIncludeThinking} onChange={handleToggleIncludeThinking} />
      </SettingRow>
      <SettingRow>
        <SettingHelpText>{t('settings.data.export_options.include_thinking.help')}</SettingHelpText>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.export_options.exclude_citations.title')}</SettingRowTitle>
        <Switch checked={excludeCitationsInExport} onChange={handleToggleExcludeCitations} />
      </SettingRow>
      <SettingRow>
        <SettingHelpText>{t('settings.data.export_options.exclude_citations.help')}</SettingHelpText>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.export_options.standardize_citations.title')}</SettingRowTitle>
        <Switch checked={standardizeCitationsInExport} onChange={handleToggleStandardizeCitations} />
      </SettingRow>
      <SettingRow>
        <SettingHelpText>{t('settings.data.export_options.standardize_citations.help')}</SettingHelpText>
      </SettingRow>
    </SettingGroup>
  )
}

export default ExportOptionsSettings
