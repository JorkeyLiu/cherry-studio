import { CloudServerOutlined, CloudSyncOutlined } from '@ant-design/icons'
import DividerWithText from '@renderer/components/DividerWithText'
import ListItem from '@renderer/components/ListItem'
import Scrollbar from '@renderer/components/Scrollbar'
import { useTheme } from '@renderer/context/ThemeProvider'
import { FileText, FolderCog } from 'lucide-react'
import type { FC, ReactNode } from 'react'
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

/**
 * Data settings inside the bounded settings dialog: a compact section rail
 * (data/backup/sync/webdav/s3/export preserved) plus the selected section's
 * content next to it. The rail and the content are visible at once; the rail
 * never becomes a full-width page and no scroll region is sized by the
 * viewport.
 */
type DataSectionKey = 'data' | 'sync' | 'local_backup' | 'webdav' | 's3' | 'export_options'

type DataNavItem =
  | { kind: 'divider'; key: string; text: string }
  | { kind: 'section'; key: DataSectionKey; title: string; icon: ReactNode }

const DataSettings: FC = () => {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const [menu, setMenu] = useState<DataSectionKey>('data')

  const menuItems: DataNavItem[] = [
    { kind: 'divider', key: 'divider_basic', text: t('settings.data.divider.basic') },
    { kind: 'section', key: 'data', title: t('settings.data.data.title'), icon: <FolderCog size={16} /> },
    { kind: 'divider', key: 'divider_cloud_storage', text: t('settings.data.divider.cloud_storage') },
    {
      kind: 'section',
      key: 'sync',
      title: t('settings.sync.title', 'Data Sync'),
      icon: <CloudSyncOutlined style={{ fontSize: 16 }} />
    },
    { kind: 'section', key: 'local_backup', title: t('settings.data.local.title'), icon: <FolderCog size={16} /> },
    {
      kind: 'section',
      key: 'webdav',
      title: t('settings.data.webdav.title'),
      icon: <CloudSyncOutlined style={{ fontSize: 16 }} />
    },
    {
      kind: 'section',
      key: 's3',
      title: t('settings.data.s3.title.label'),
      icon: <CloudServerOutlined style={{ fontSize: 16 }} />
    },
    { kind: 'divider', key: 'divider_export_settings', text: t('settings.data.divider.export_settings') },
    {
      kind: 'section',
      key: 'export_options',
      title: t('settings.data.export_options.title'),
      icon: <FileText size={16} />
    }
  ]

  return (
    <Container data-testid="data-settings">
      <DataMenu role="navigation" aria-label={t('settings.data.title')} data-testid="data-settings-nav">
        {menuItems.map((item) =>
          item.kind === 'divider' ? (
            <NavDivider key={item.key}>
              <DividerWithText text={item.text} style={{ margin: '8px 0' }} />
            </NavDivider>
          ) : (
            <ListItem
              key={item.key}
              title={item.title}
              icon={item.icon}
              titleStyle={{ fontWeight: 500 }}
              active={menu === item.key}
              onClick={() => setMenu(item.key)}
              testId={item.key === 'sync' ? 'data-menu-sync' : `data-section-${item.key}`}
            />
          )
        )}
      </DataMenu>
      <Pane theme={theme}>
        {menu === 'data' && <BasicDataSettings />}
        {menu === 'sync' && <SyncSettings />}
        {menu === 'webdav' && <WebDavSettings />}
        {menu === 's3' && <S3Settings />}
        {menu === 'export_options' && <ExportOptionsSettings />}
        {menu === 'local_backup' && <LocalBackupSettings />}
      </Pane>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex-direction: row;
  flex: 1;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
`

const DataMenu = styled(Scrollbar)`
  display: flex;
  flex-direction: column;
  flex: 0 0 160px;
  gap: 2px;
  width: 160px;
  max-width: 160px;
  min-width: 0;
  min-height: 0;
  padding: 10px 8px 16px;
  box-sizing: border-box;
  overflow-x: hidden;
  user-select: none;
  border-right: 0.5px solid var(--color-border);
`

const NavDivider = styled.div`
  flex: 0 0 auto;
  padding: 0 4px;
  overflow: hidden;
  font-size: 12px;
  white-space: nowrap;

  & > div > span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
`

const Pane = styled(SettingContainer)`
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-x: hidden;
`

export default DataSettings
