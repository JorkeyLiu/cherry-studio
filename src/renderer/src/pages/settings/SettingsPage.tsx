import Scrollbar from '@renderer/components/Scrollbar'
import { Divider as AntDivider } from 'antd'
import { Cloud, Command, HardDrive, Info, MonitorCog, Package, Server, Settings2 } from 'lucide-react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Route, Routes, useLocation } from 'react-router-dom'
import styled from 'styled-components'

import AboutSettings from './AboutSettings'
import DataSettings from './DataSettings/DataSettings'
import DisplaySettings from './DisplaySettings/DisplaySettings'
import GeneralSettings from './GeneralSettings'
import ModelSettings from './ModelSettings/ModelSettings'
import { ProviderList } from './ProviderSettings'
import ShortcutSettings from './ShortcutSettings'
import { ApiServerSettings } from './ToolSettings/ApiServerSettings'

/**
 * Settings body for the task dialog: a compact category rail plus one content
 * area. The page owns no window chrome and no viewport-sized layout — it fills
 * the dialog body and every scroll region is bounded by that body.
 */
const SettingsPage: FC = () => {
  const { pathname } = useLocation()
  const { t } = useTranslation()

  const isRoute = (path: string): string => (pathname.startsWith(path) ? 'active' : '')

  return (
    <Container data-testid="settings-page">
      <ContentContainer id="content-container">
        <SettingMenus aria-label={t('settings.title')}>
          <MenuItemLink to="/settings/provider">
            <MenuItem className={isRoute('/settings/provider')}>
              <Cloud size={16} />
              {t('settings.provider.title')}
            </MenuItem>
          </MenuItemLink>
          <MenuItemLink to="/settings/model">
            <MenuItem className={isRoute('/settings/model')}>
              <Package size={16} />
              {t('settings.model')}
            </MenuItem>
          </MenuItemLink>
          <Divider />
          <MenuItemLink to="/settings/general">
            <MenuItem className={isRoute('/settings/general')}>
              <Settings2 size={16} />
              {t('settings.general.label')}
            </MenuItem>
          </MenuItemLink>
          <MenuItemLink to="/settings/display">
            <MenuItem className={isRoute('/settings/display')}>
              <MonitorCog size={16} />
              {t('settings.display.title')}
            </MenuItem>
          </MenuItemLink>
          <MenuItemLink to="/settings/data">
            <MenuItem className={isRoute('/settings/data')}>
              <HardDrive size={16} />
              {t('settings.data.title')}
            </MenuItem>
          </MenuItemLink>
          <Divider />
          <MenuItemLink to="/settings/api-server">
            <MenuItem className={isRoute('/settings/api-server')}>
              <Server size={16} />
              {t('apiServer.title')}
            </MenuItem>
          </MenuItemLink>
          <MenuItemLink to="/settings/shortcut">
            <MenuItem className={isRoute('/settings/shortcut')}>
              <Command size={16} />
              {t('settings.shortcuts.title')}
            </MenuItem>
          </MenuItemLink>
          <Divider />
          <MenuItemLink to="/settings/about">
            <MenuItem className={isRoute('/settings/about')}>
              <Info size={16} />
              {t('settings.about.label')}
            </MenuItem>
          </MenuItemLink>
        </SettingMenus>
        <SettingContent>
          <Routes>
            <Route path="provider" element={<ProviderList />} />
            <Route path="model" element={<ModelSettings />} />
            <Route path="api-server" element={<ApiServerSettings />} />
            <Route path="general/*" element={<GeneralSettings />} />
            <Route path="display" element={<DisplaySettings />} />
            <Route path="shortcut" element={<ShortcutSettings />} />
            <Route path="data" element={<DataSettings />} />
            <Route path="about" element={<AboutSettings />} />
          </Routes>
        </SettingContent>
      </ContentContainer>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  height: 100%;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
`

const ContentContainer = styled.div`
  display: flex;
  flex: 1;
  flex-direction: row;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
`

const SettingMenus = styled(Scrollbar)`
  display: flex;
  flex-direction: column;
  flex: 0 0 auto;
  width: 176px;
  min-width: 176px;
  max-width: 176px;
  min-height: 0;
  padding: 10px 8px;
  gap: 2px;
  overflow-y: auto;
  border-right: 0.5px solid var(--color-border);
  user-select: none;
  box-sizing: border-box;
`

const MenuItemLink = styled(Link)`
  display: block;
  flex: 0 0 auto;
  text-decoration: none;
  color: var(--color-text-1);
`

const MenuItem = styled.li`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  width: 100%;
  box-sizing: border-box;
  cursor: pointer;
  border-radius: var(--list-item-border-radius);
  font-weight: 500;
  font-size: 13px;
  /* The row owns its text color: its wrapping link is an anchor element, and
     antd's global anchor reset (emitted unhashed) makes the anchor hover and
     active rules outrank the link's own class color, which would paint the
     label blue. Keeping the neutral color on the row leaves hover and active
     background-only, as the rest of the list items. */
  color: var(--color-text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: all 0.2s ease-in-out;
  border: 0.5px solid transparent;
  svg {
    flex: 0 0 auto;
    opacity: 0.8;
  }
  &:hover {
    background: var(--color-background-soft);
  }
  &.active {
    background: var(--color-background-soft);
    border: 0.5px solid var(--color-border);
  }
`

const SettingContent = styled.div`
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
`

const Divider = styled(AntDivider)`
  margin: 4px 0;
  flex: 0 0 auto;
`

export default SettingsPage
