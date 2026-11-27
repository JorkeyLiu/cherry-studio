import EmojiAvatar from '@renderer/components/Avatar/EmojiAvatar'
import UserPopup from '@renderer/components/Popups/UserPopup'
import { UserAvatar } from '@renderer/config/env'
import { useTheme } from '@renderer/context/ThemeProvider'
import useAvatar from '@renderer/hooks/useAvatar'
import { useFullscreen } from '@renderer/hooks/useFullscreen'
import useNavBackgroundColor from '@renderer/hooks/useNavBackgroundColor'
import { modelGenerating } from '@renderer/hooks/useRuntime'
import { useSettings } from '@renderer/hooks/useSettings'
import { getSidebarIconLabel, getThemeModeLabel } from '@renderer/i18n/label'
import { ThemeMode } from '@renderer/types'
import { isEmoji } from '@renderer/utils'
import { Avatar, Tooltip } from 'antd'
import { BookOpen, FileText, Monitor, Moon, Settings, Sun, User } from 'lucide-react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import styled from 'styled-components'

/**
 * Bottom app entries of the unified workspace sidebar: the navigation group
 * (knowledge/files entries, theme toggle, settings entry) sits left while
 * the user avatar stays rightmost, its right edge aligned with the panel
 * padding. Reuses the former root-rail app entries without the removed 50px
 * visible shell. The topic recycle bin stays in the topic area (Topics owns
 * TopicTrashPanel) and is intentionally not part of this app icon group.
 */
const WorkspaceSidebarFooter: FC = () => {
  const { pathname } = useLocation()
  const navigate = useNavigate()

  const { theme, settedTheme, toggleTheme } = useTheme()
  const avatar = useAvatar()
  const { t } = useTranslation()

  const onEditUser = () => UserPopup.show()

  const backgroundColor = useNavBackgroundColor()

  const to = async (path: string) => {
    await modelGenerating()
    navigate(path)
  }

  const isFullscreen = useFullscreen()

  return (
    <Container $isFullscreen={isFullscreen} style={{ backgroundColor }}>
      <Menus>
        <LeadingGroup>
          <AppMenus />
          <Tooltip title={t('settings.theme.title') + ': ' + getThemeModeLabel(settedTheme)} placement="top">
            <Icon theme={theme} onClick={toggleTheme}>
              {settedTheme === ThemeMode.dark ? (
                <Moon size={16} className="icon" />
              ) : settedTheme === ThemeMode.light ? (
                <Sun size={16} className="icon" />
              ) : (
                <Monitor size={16} className="icon" />
              )}
            </Icon>
          </Tooltip>
          <Tooltip title={t('settings.title')} mouseEnterDelay={0.8} placement="top">
            <StyledLink
              data-testid="sidebar-nav-settings"
              onClick={async () => {
                await to('/settings/provider')
              }}>
              <Icon theme={theme} className={pathname.startsWith('/settings') ? 'active' : ''}>
                <Settings size={16} className="icon" />
              </Icon>
            </StyledLink>
          </Tooltip>
        </LeadingGroup>
        <AvatarWrap>
          {isEmoji(avatar) ? (
            <EmojiAvatar onClick={onEditUser} className="sidebar-avatar" size={28} fontSize={16}>
              {avatar}
            </EmojiAvatar>
          ) : avatar && avatar !== UserAvatar ? (
            <AvatarImg src={avatar} draggable={false} className="nodrag" onClick={onEditUser} />
          ) : (
            <DefaultAvatarFallback data-testid="sidebar-default-avatar" onClick={onEditUser} title={t('common.avatar')}>
              <User size={16} />
            </DefaultAvatarFallback>
          )}
        </AvatarWrap>
      </Menus>
    </Container>
  )
}

const AppMenus: FC = () => {
  const { pathname } = useLocation()
  // The assistant entry ('/') is owned by the workspace header switcher, so
  // the footer only carries the remaining app destinations.
  const { sidebarIcons } = useSettings()
  const navigate = useNavigate()
  const { theme } = useTheme()

  const isRoutes = (path: string): string => (pathname.startsWith(path) && path !== '/' ? 'active' : '')

  const iconMap = {
    knowledge: <BookOpen size={16} className="icon" />,
    files: <FileText size={16} className="icon" />
  }

  const pathMap = {
    knowledge: '/knowledge',
    files: '/files'
  }

  return (
    <>
      {sidebarIcons.visible.map((icon) => {
        if (icon === 'assistants') return null
        const path = pathMap[icon]
        if (!path) return null
        const isActive = isRoutes(path)

        return (
          <Tooltip key={icon} title={getSidebarIconLabel(icon)} mouseEnterDelay={0.8} placement="top">
            <StyledLink
              data-testid={`sidebar-nav-${icon}`}
              onClick={async () => {
                await modelGenerating()
                navigate(path)
              }}>
              <Icon theme={theme} className={isActive}>
                {iconMap[icon]}
              </Icon>
            </StyledLink>
          </Tooltip>
        )
      })}
    </>
  )
}

const Container = styled.div<{ $isFullscreen: boolean }>`
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  padding: 6px 10px;
  border-top: 0.5px solid var(--color-border);
  -webkit-app-region: no-drag;

  .sidebar-avatar {
    -webkit-app-region: no-drag;
  }
`

const Menus = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  flex: 1;
  min-width: 0;
  gap: 4px;
`

const LeadingGroup = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 4px;
`

const AvatarWrap = styled.div`
  display: flex;
  align-items: center;
  margin-left: auto;
`

const Icon = styled.div<{ theme: string }>`
  width: 28px;
  height: 28px;
  display: flex;
  justify-content: center;
  align-items: center;
  border-radius: 50%;
  box-sizing: border-box;
  -webkit-app-region: no-drag;
  border: 0.5px solid transparent;
  .icon {
    color: var(--color-icon);
  }
  &:hover {
    background-color: ${({ theme }) => (theme === 'dark' ? 'var(--color-black)' : 'var(--color-white)')};
    opacity: 0.8;
    cursor: pointer;
    .icon {
      color: var(--color-icon-white);
    }
  }
  &.active {
    background-color: ${({ theme }) => (theme === 'dark' ? 'var(--color-black)' : 'var(--color-white)')};
    border: 0.5px solid var(--color-border);
    .icon {
      color: var(--color-primary);
    }
  }
`

const StyledLink = styled.div`
  text-decoration: none;
  -webkit-app-region: no-drag;
  &* {
    user-select: none;
  }
`

const AvatarImg = styled(Avatar)`
   width: 28px;
   height: 28px;
   background-color: var(--color-background-soft);
   -webkit-app-region: no-drag;
   cursor: pointer;
 `

// Neutral default avatar (this footer only): a User outline on a subtle
// neutral surface instead of the bundled green image. Custom user avatars
// keep rendering through AvatarImg above; no other Avatar is touched.
const DefaultAvatarFallback = styled.button`
   display: flex;
   align-items: center;
   justify-content: center;
   width: 28px;
   height: 28px;
   padding: 0;
   border: none;
   border-radius: 50%;
   background-color: var(--color-background-soft);
   color: var(--color-icon);
   -webkit-app-region: no-drag;
   cursor: pointer;
   &:hover {
     background-color: var(--color-background-mute);
     color: var(--color-icon-white);
   }
 `

export default WorkspaceSidebarFooter
