import { CloudServerOutlined, CloudSyncOutlined } from '@ant-design/icons'
import DividerWithText from '@renderer/components/DividerWithText'
import { HStack } from '@renderer/components/Layout'
import ListItem from '@renderer/components/ListItem'
import { useTheme } from '@renderer/context/ThemeProvider'
import ImportMenuOptions from '@renderer/pages/settings/DataSettings/ImportMenuSettings'
import { FileText, FolderCog, FolderOpen } from 'lucide-react'
import type { FC } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { SettingContainer } from '..'
import BasicDataSettings from './BasicDataSettings'
import ExportOptionsSettings from './ExportOptionsSettings'
import LocalBackupSettings from './LocalBackupSettings'
import S3Settings from './S3Settings'
import SyncSettings from './SyncSettings'
import WebDavSettings from './WebDavSettings'

const DataSettings: FC = () => {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const [menu, setMenu] = useState<string>('data')

  const menuItems = [
    { key: 'divider_0', isDivider: true, text: t('settings.data.divider.basic') },
    { key: 'data', title: t('settings.data.data.title'), icon: <FolderCog size={16} /> },
    { key: 'divider_1', isDivider: true, text: t('settings.data.divider.cloud_storage') },
    {
      key: 'sync',
      title: t('settings.sync.title', 'Data Sync'),
      icon: <CloudSyncOutlined style={{ fontSize: 16 }} />
    },
    { key: 'local_backup', title: t('settings.data.local.title'), icon: <FolderCog size={16} /> },
    { key: 'webdav', title: t('settings.data.webdav.title'), icon: <CloudSyncOutlined style={{ fontSize: 16 }} /> },
    { key: 's3', title: t('settings.data.s3.title.label'), icon: <CloudServerOutlined style={{ fontSize: 16 }} /> },
    { key: 'divider_2', isDivider: true, text: t('settings.data.divider.import_settings') },
    {
      key: 'import_settings',
      title: t('settings.data.import_settings.title'),
      icon: <FolderOpen size={16} />
    },
    { key: 'divider_3', isDivider: true, text: t('settings.data.divider.export_settings') },
    {
      key: 'export_options',
      title: t('settings.data.export_options.title'),
      icon: <FileText size={16} />
    }
  ]

  return (
    <Container>
      <MenuList>
        {menuItems.map((item) =>
          item.isDivider ? (
            <DividerWithText key={item.key} text={item.text || ''} style={{ margin: '8px 0' }} /> // 动态传递分隔符文字
          ) : (
            <ListItem
              key={item.key}
              title={item.title}
              active={menu === item.key}
              onClick={() => setMenu(item.key)}
              titleStyle={{ fontWeight: 500 }}
              icon={item.icon}
              testId={item.key === 'sync' ? 'data-menu-sync' : undefined}
            />
          )
        )}
      </MenuList>
      <SettingContainer theme={theme} style={{ display: 'flex', flex: 1, height: '100%' }}>
        {menu === 'data' && <BasicDataSettings />}
        {menu === 'sync' && <SyncSettings />}
        {menu === 'webdav' && <WebDavSettings />}
        {menu === 's3' && <S3Settings />}
        {menu === 'import_settings' && <ImportMenuOptions />}
        {menu === 'export_options' && <ExportOptionsSettings />}
        {menu === 'local_backup' && <LocalBackupSettings />}
      </SettingContainer>
    </Container>
  )
}

const Container = styled(HStack)`
  flex: 1;
`

const MenuList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: var(--settings-width);
  padding: 12px;
  padding-bottom: 48px;
  border-right: 0.5px solid var(--color-border);
  height: 100vh;
  overflow: auto;
  box-sizing: border-box;
  min-height: 0;
`

export default DataSettings
