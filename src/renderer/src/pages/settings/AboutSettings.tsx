import IndicatorLight from '@renderer/components/IndicatorLight'
import UpdateDialogPopup from '@renderer/components/Popups/UpdateDialogPopup'
import { APP_NAME, AppLogo } from '@renderer/config/env'
import { useTheme } from '@renderer/context/ThemeProvider'
import { useRuntime } from '@renderer/hooks/useRuntime'
import { useSettings } from '@renderer/hooks/useSettings'
import { useAppDispatch } from '@renderer/store'
import { setUpdateState } from '@renderer/store/runtime'
import { runAsyncFunction } from '@renderer/utils'
import { UpgradeChannel } from '@shared/config/constant'
import { Avatar, Button, Progress, Radio, Row, Switch, Tag, Tooltip } from 'antd'
import { debounce } from 'lodash'
import { Bug } from 'lucide-react'
import type { FC } from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Markdown from 'react-markdown'
import styled from 'styled-components'

import { SettingContainer, SettingDivider, SettingGroup, SettingRow, SettingTitle } from '.'

const AboutSettings: FC = () => {
  const [version, setVersion] = useState('')
  const [buildId, setBuildId] = useState('')
  const [buildVersion, setBuildVersion] = useState('')
  const [isPortable, setIsPortable] = useState(false)
  const { t } = useTranslation()
  const { autoCheckUpdate, setAutoCheckUpdate, testPlan, setTestPlan, testChannel, setTestChannel } = useSettings()
  const { theme } = useTheme()
  const dispatch = useAppDispatch()
  const { update } = useRuntime()

  const onCheckUpdate = debounce(
    async () => {
      if (update.checking || update.downloading) {
        return
      }

      if (update.downloaded) {
        // Open update dialog directly in renderer
        void UpdateDialogPopup.show({ releaseInfo: update.info || null })
        return
      }

      dispatch(setUpdateState({ checking: true, manualCheck: true }))

      try {
        await window.api.checkForUpdate()
      } catch (error) {
        dispatch(setUpdateState({ manualCheck: false }))
        window.toast.error(t('settings.about.updateError'))
      }

      dispatch(setUpdateState({ checking: false }))
    },
    2000,
    { leading: true, trailing: false }
  )

  const debug = async () => {
    await window.api.devTools.toggle()
  }

  const currentChannelByVersion =
    [
      { pattern: `-${UpgradeChannel.BETA}.`, channel: UpgradeChannel.BETA },
      { pattern: `-${UpgradeChannel.RC}.`, channel: UpgradeChannel.RC }
    ].find(({ pattern }) => version.includes(pattern))?.channel || UpgradeChannel.LATEST

  const handleTestChannelChange = async (value: UpgradeChannel) => {
    if (testPlan && currentChannelByVersion !== UpgradeChannel.LATEST && value !== currentChannelByVersion) {
      window.toast.warning(t('settings.general.test_plan.version_channel_not_match'))
    }
    setTestChannel(value)
    // Clear update info when switching upgrade channel
    dispatch(
      setUpdateState({
        available: false,
        info: null,
        downloaded: false,
        checking: false,
        downloading: false,
        downloadProgress: 0
      })
    )
  }

  // Get available test version options based on current version
  const getAvailableTestChannels = () => {
    return [
      {
        tooltip: t('settings.general.test_plan.rc_version_tooltip'),
        label: t('settings.general.test_plan.rc_version'),
        value: UpgradeChannel.RC
      },
      {
        tooltip: t('settings.general.test_plan.beta_version_tooltip'),
        label: t('settings.general.test_plan.beta_version'),
        value: UpgradeChannel.BETA
      }
    ]
  }

  const handleSetTestPlan = (value: boolean) => {
    setTestPlan(value)
    dispatch(
      setUpdateState({
        available: false,
        info: null,
        downloaded: false,
        checking: false,
        downloading: false,
        downloadProgress: 0
      })
    )

    if (value === true) {
      setTestChannel(getTestChannel())
    }
  }

  const getTestChannel = () => {
    if (testChannel === UpgradeChannel.LATEST) {
      return UpgradeChannel.RC
    }
    return testChannel
  }

  useEffect(() => {
    void runAsyncFunction(async () => {
      const appInfo = await window.api.getAppInfo()
      setVersion(appInfo.version)
      setBuildId(appInfo.buildId || '')
      setBuildVersion(appInfo.buildVersion || '')
      setIsPortable(appInfo.isPortable)
    })
    setAutoCheckUpdate(autoCheckUpdate)
  }, [autoCheckUpdate, setAutoCheckUpdate])

  return (
    <SettingContainer theme={theme}>
      <SettingGroup theme={theme}>
        <SettingTitle>{t('settings.about.title')}</SettingTitle>
        <SettingDivider />
        <AboutHeader>
          <Row align="middle">
            <AvatarWrapper>
              {update.downloadProgress > 0 && (
                <ProgressCircle
                  type="circle"
                  size={84}
                  percent={update.downloadProgress}
                  showInfo={false}
                  strokeLinecap="butt"
                  strokeColor="#67ad5b"
                />
              )}
              <Avatar src={AppLogo} size={80} style={{ minHeight: 80 }} />
            </AvatarWrapper>
            <VersionWrapper>
              <Title>{APP_NAME}</Title>
              <Description>{t('settings.about.description')}</Description>
              {/* LOCK-RELEASE-FREEZE: the version badge is static — it no longer
                  links to the Cherry Studio release feed. */}
              <Tag color="cyan" style={{ marginTop: 8 }}>
                v{version}
              </Tag>
              {buildId && (
                <BuildIdentityText>
                  <span>
                    {t('settings.about.build_id')}: {buildId}
                  </span>
                  {buildVersion && (
                    <span>
                      {t('settings.about.build_version')}: {buildVersion}
                    </span>
                  )}
                </BuildIdentityText>
              )}
            </VersionWrapper>
          </Row>
          {!isPortable && (
            <CheckUpdateButton
              onClick={onCheckUpdate}
              loading={update.checking}
              disabled={update.downloading || update.checking}>
              {update.downloading
                ? t('settings.about.downloading')
                : update.available
                  ? t('settings.about.checkUpdate.available')
                  : t('settings.about.checkUpdate.label')}
            </CheckUpdateButton>
          )}
        </AboutHeader>
        {!isPortable && (
          <>
            <SettingDivider />
            <SettingRow>
              <SettingRowTitle>{t('settings.general.auto_check_update.title')}</SettingRowTitle>
              <Switch value={autoCheckUpdate} onChange={(v) => setAutoCheckUpdate(v)} />
            </SettingRow>
            <SettingDivider />
            <SettingRow>
              <SettingRowTitle>{t('settings.general.test_plan.title')}</SettingRowTitle>
              <Tooltip title={t('settings.general.test_plan.tooltip')} trigger={['hover', 'focus']}>
                <Switch value={testPlan} onChange={(v) => handleSetTestPlan(v)} />
              </Tooltip>
            </SettingRow>
            {testPlan && (
              <>
                <SettingDivider />
                <SettingRow>
                  <SettingRowTitle>{t('settings.general.test_plan.version_options')}</SettingRowTitle>
                  <Radio.Group
                    size="small"
                    buttonStyle="solid"
                    value={getTestChannel()}
                    onChange={(e) => handleTestChannelChange(e.target.value)}>
                    {getAvailableTestChannels().map((option) => (
                      <Tooltip key={option.value} title={option.tooltip}>
                        <Radio.Button value={option.value}>{option.label}</Radio.Button>
                      </Tooltip>
                    ))}
                  </Radio.Group>
                </SettingRow>
              </>
            )}
          </>
        )}
      </SettingGroup>
      {update.info && update.available && (
        <SettingGroup theme={theme}>
          <SettingRow>
            <SettingRowTitle>
              {t('settings.about.updateAvailable', { version: update.info.version })}
              <IndicatorLight color="green" />
            </SettingRowTitle>
          </SettingRow>
          <UpdateNotesWrapper className="markdown">
            <Markdown>
              {typeof update.info.releaseNotes === 'string'
                ? update.info.releaseNotes.replace(/\n/g, '\n\n')
                : update.info.releaseNotes?.map((note) => note.note).join('\n')}
            </Markdown>
          </UpdateNotesWrapper>
        </SettingGroup>
      )}
      <SettingGroup theme={theme}>
        <SettingRow>
          <SettingRowTitle>
            <Bug size={18} />
            {t('settings.about.debug.title')}
          </SettingRowTitle>
          <Button onClick={debug}>{t('settings.about.debug.open')}</Button>
        </SettingRow>
      </SettingGroup>
    </SettingContainer>
  )
}

const AboutHeader = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 5px 0;
`

const VersionWrapper = styled.div`
  display: flex;
  flex-direction: column;
  min-height: 80px;
  justify-content: center;
  align-items: flex-start;
`

const Title = styled.div`
  font-size: 20px;
  font-weight: bold;
  color: var(--color-text-1);
  margin-bottom: 5px;
`

const Description = styled.div`
  font-size: 14px;
  color: var(--color-text-2);
  text-align: center;
`

const CheckUpdateButton = styled(Button)``

const BuildIdentityText = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 12px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--color-text-2);
`

const AvatarWrapper = styled.div`
  position: relative;
  cursor: pointer;
  margin-right: 15px;
`

const ProgressCircle = styled(Progress)`
  position: absolute;
  top: -2px;
  left: -2px;
`

export const SettingRowTitle = styled.div`
  font-size: 14px;
  line-height: 18px;
  color: var(--color-text-1);
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 10px;
  .anticon {
    font-size: 16px;
    color: var(--color-text-1);
  }
`

const UpdateNotesWrapper = styled.div`
  padding: 12px 0;
  margin: 8px 0;
  background-color: var(--color-bg-2);
  border-radius: 6px;
  color: var(--color-text-2);
  font-size: 14px;

  p {
    margin: 0;
  }
`

export default AboutSettings
